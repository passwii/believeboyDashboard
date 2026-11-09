package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_inspection"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type AgentInspectionStore struct {
	db FullDB
}

func NewAgentInspectionStore(db FullDB) *AgentInspectionStore {
	return &AgentInspectionStore{db: db}
}

func (s *AgentInspectionStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, agent_inspection.Store) error,
) error {
	if s == nil || s.db == nil {
		return errors.New("agent inspection database is nil")
	}
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &AgentInspectionStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (s *AgentInspectionStore) ListPeriods(
	ctx context.Context,
	filter agent_inspection.PeriodListFilter,
) (agent_inspection.PeriodPage, error) {
	if s == nil || s.db == nil {
		return agent_inspection.PeriodPage{}, errors.New("agent inspection database is nil")
	}
	var total int64
	if err := s.db.QueryRow(
		ctx,
		`select count(*) from public.inspection_periods`,
	).Scan(&total); err != nil {
		return agent_inspection.PeriodPage{}, err
	}
	rows, err := s.db.Query(
		ctx,
		`select id, week_start, week_end, deadline
		 from public.inspection_periods
		 order by week_start desc
		 limit $1 offset $2`,
		filter.Limit,
		filter.Offset,
	)
	if err != nil {
		return agent_inspection.PeriodPage{}, err
	}
	defer rows.Close()

	items := make([]agent_inspection.Period, 0)
	periodIDs := make([]int64, 0)
	for rows.Next() {
		period, err := scanAgentInspectionPeriod(rows)
		if err != nil {
			return agent_inspection.PeriodPage{}, err
		}
		items = append(items, period)
		periodIDs = append(periodIDs, period.ID)
	}
	if err := rows.Err(); err != nil {
		return agent_inspection.PeriodPage{}, err
	}

	counts := make(map[int64]int)
	if len(periodIDs) > 0 {
		countries := filter.Countries
		if countries == nil {
			countries = []string{}
		}
		countRows, err := s.db.Query(
			ctx,
			`select r.period_id, count(*)::int
			 from public.inspection_reports r
			 join public.projects p on p.id = r.project_id
			 where r.period_id = any($1::bigint[])
			   and r.status = 'submitted'
			   and (coalesce(cardinality($2::text[]), 0) = 0 or upper(p.country) = any($2::text[]))
			 group by r.period_id`,
			periodIDs,
			countries,
		)
		if err != nil {
			return agent_inspection.PeriodPage{}, err
		}
		defer countRows.Close()
		for countRows.Next() {
			var periodID int64
			var count int
			if err := countRows.Scan(&periodID, &count); err != nil {
				return agent_inspection.PeriodPage{}, err
			}
			counts[periodID] = count
		}
		if err := countRows.Err(); err != nil {
			return agent_inspection.PeriodPage{}, err
		}
	}
	for index := range items {
		count := counts[items[index].ID]
		items[index].SubmittedCount = &count
	}
	return agent_inspection.PeriodPage{Items: items, Total: total}, nil
}

func (s *AgentInspectionStore) GetCurrentPeriod(
	ctx context.Context,
	now time.Time,
) (*agent_inspection.Period, error) {
	if now.IsZero() {
		now = time.Now()
	}
	weekStart := agentInspectionWeekStart(now)
	row := s.db.QueryRow(
		ctx,
		`select id, week_start, week_end, deadline
		 from public.inspection_periods
		 where week_start = $1::date
		 limit 1`,
		weekStart.Format("2006-01-02"),
	)
	period, err := scanAgentInspectionPeriod(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &period, nil
}

func (s *AgentInspectionStore) GetPeriod(
	ctx context.Context,
	periodID int64,
) (*agent_inspection.Period, error) {
	row := s.db.QueryRow(
		ctx,
		`select id, week_start, week_end, deadline
		 from public.inspection_periods
		 where id = $1
		 limit 1`,
		periodID,
	)
	period, err := scanAgentInspectionPeriod(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &period, nil
}

func (s *AgentInspectionStore) GetProject(
	ctx context.Context,
	projectID int64,
) (*agent_inspection.Project, error) {
	var project agent_inspection.Project
	err := s.db.QueryRow(
		ctx,
		`select id, project_name, coalesce(country, 'US')
		 from public.projects
		 where id = $1
		 limit 1`,
		projectID,
	).Scan(&project.ID, &project.Name, &project.Country)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	project.Country = strings.ToUpper(strings.TrimSpace(project.Country))
	if project.Country == "" {
		project.Country = "US"
	}
	return &project, nil
}

func (s *AgentInspectionStore) GetOverview(
	ctx context.Context,
	filter agent_inspection.OverviewFilter,
) (*agent_inspection.OverviewResult, error) {
	period, err := s.GetPeriod(ctx, filter.PeriodID)
	if err != nil {
		return nil, err
	}
	if period == nil {
		return nil, agent_inspection.ErrPeriodNotFound
	}

	projectRows, err := s.db.Query(
		ctx,
		`select p.id, p.project_name, upper(coalesce(p.country, 'US'))
		 from public.projects p
		 where coalesce(p.is_active, true)
		   and ($1::boolean or p.id = any($2::bigint[]))
		   and (coalesce(cardinality($3::text[]), 0) = 0 or upper(p.country) = any($3::text[]))
		 order by p.sort_order asc, p.id asc`,
		filter.AllProjects,
		filter.ProjectIDs,
		nonNilStrings(filter.Countries),
	)
	if err != nil {
		return nil, err
	}
	defer projectRows.Close()
	projects := make([]agent_inspection.Project, 0)
	for projectRows.Next() {
		var project agent_inspection.Project
		if err := projectRows.Scan(&project.ID, &project.Name, &project.Country); err != nil {
			return nil, err
		}
		if project.Country == "" {
			project.Country = "US"
		}
		projects = append(projects, project)
	}
	if err := projectRows.Err(); err != nil {
		return nil, err
	}

	reportRows, err := s.db.Query(
		ctx,
		`select r.id, r.project_id, upper(r.country), r.status,
		        r.health_data::text, r.compliance_data::text,
		        r.submitted_at,
		        (select count(*)::int
		         from public.inspection_screenshots s
		         where s.report_id = r.id) as screenshot_count
		 from public.inspection_reports r
		 join public.projects p on p.id = r.project_id
		 where r.period_id = $1
		   and upper(r.country) = upper(coalesce(p.country, 'US'))
		 order by r.project_id asc, r.updated_at desc, r.id desc`,
		filter.PeriodID,
	)
	if err != nil {
		return nil, err
	}
	defer reportRows.Close()
	reports := make(map[int64]*agent_inspection.Report)
	for reportRows.Next() {
		report, err := scanAgentInspectionOverviewReport(reportRows)
		if err != nil {
			return nil, err
		}
		if _, exists := reports[report.ProjectID]; !exists {
			reports[report.ProjectID] = report
		}
	}
	if err := reportRows.Err(); err != nil {
		return nil, err
	}

	now := filter.Now
	if now.IsZero() {
		now = time.Now()
	}
	deadline, err := parseAgentInspectionTimestamp(period.Deadline)
	if err != nil {
		return nil, err
	}
	pastDeadline := !now.Before(deadline)
	items := make([]agent_inspection.AccountHealthRow, 0, len(projects))
	submittedCount := 0
	overdueCount := 0
	for _, project := range projects {
		report := reports[project.ID]
		if report != nil && report.Country != project.Country {
			report = nil
		}
		status := "pending"
		if report != nil {
			switch report.Status {
			case "submitted":
				status = "submitted"
			case "overdue":
				status = "overdue"
			default:
				status = "draft"
			}
			if pastDeadline && report.Status != "submitted" {
				status = "overdue"
			}
		} else if pastDeadline {
			status = "overdue"
		}
		if status == "submitted" {
			submittedCount++
		}
		if status == "overdue" {
			overdueCount++
		}
		row := agentInspectionAccountHealthRow(*period, project, report)
		row.Status = status
		items = append(items, row)
	}
	return &agent_inspection.OverviewResult{
		Period:         *period,
		Items:          items,
		TotalProjects:  len(items),
		SubmittedCount: submittedCount,
		OverdueCount:   overdueCount,
	}, nil
}

func (s *AgentInspectionStore) GetReport(
	ctx context.Context,
	periodID int64,
	projectID int64,
	country string,
) (*agent_inspection.Report, error) {
	row := s.db.QueryRow(
		ctx,
		agentInspectionReportSelectSQL+`
		 where r.period_id = $1
		   and r.project_id = $2
		   and upper(r.country) = upper($3)
		 limit 1`,
		periodID,
		projectID,
		country,
	)
	report, err := scanAgentInspectionReport(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &report, nil
}

func (s *AgentInspectionStore) getReportByID(
	ctx context.Context,
	reportID int64,
) (*agent_inspection.Report, error) {
	row := s.db.QueryRow(
		ctx,
		agentInspectionReportSelectSQL+`
		 where r.id = $1
		 limit 1`,
		reportID,
	)
	report, err := scanAgentInspectionReport(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &report, nil
}

func (s *AgentInspectionStore) UpsertReport(
	ctx context.Context,
	input agent_inspection.UpsertReportInput,
) (*agent_inspection.Report, error) {
	healthJSON, err := agentInspectionJSONArgument(
		input.Patch.HealthDataSet, input.Patch.HealthData,
	)
	if err != nil {
		return nil, err
	}
	complianceJSON, err := agentInspectionJSONArgument(
		input.Patch.ComplianceDataSet, input.Patch.ComplianceData,
	)
	if err != nil {
		return nil, err
	}
	var reportID int64
	err = s.db.QueryRow(
		ctx,
		`insert into public.inspection_reports (
		   period_id, project_id, country, status,
		   health_data, compliance_data, status_summary,
		   created_at, updated_at
		 )
		 values ($1, $2, $3, 'draft', $4::json, $5::json, $6, now(), now())
		 on conflict (period_id, project_id, country) do update
		 set health_data = case
		       when $7::boolean then excluded.health_data
		       else public.inspection_reports.health_data
		     end,
		     compliance_data = case
		       when $8::boolean then excluded.compliance_data
		       else public.inspection_reports.compliance_data
		     end,
		     status_summary = case
		       when $9::boolean then excluded.status_summary
		       else public.inspection_reports.status_summary
		     end,
		     updated_at = now()
		 returning id`,
		input.PeriodID,
		input.ProjectID,
		input.Country,
		healthJSON,
		complianceJSON,
		input.Patch.StatusSummary,
		input.Patch.HealthDataSet,
		input.Patch.ComplianceDataSet,
		input.Patch.StatusSummarySet,
	).Scan(&reportID)
	if err != nil {
		return nil, mapAgentInspectionConstraintError(err)
	}
	report, err := s.getReportByID(ctx, reportID)
	if err != nil {
		return nil, err
	}
	if report == nil {
		return nil, agent_inspection.ErrReportNotFound
	}
	return report, nil
}

func (s *AgentInspectionStore) SubmitReport(
	ctx context.Context,
	reportID int64,
	agentID string,
	now time.Time,
) (*agent_inspection.Report, []agent_inspection.ThresholdWarning, error) {
	if now.IsZero() {
		now = time.Now()
	}
	var updatedID int64
	err := s.db.QueryRow(
		ctx,
		`update public.inspection_reports
		 set status = 'submitted',
		     submitted_by = $2,
		     submitted_at = $3,
		     updated_at = $3
		 where id = $1
		   and status in ('draft', 'overdue')
		 returning id`,
		reportID,
		agentID,
		now,
	).Scan(&updatedID)
	if errors.Is(err, pgx.ErrNoRows) {
		report, lookupErr := s.getReportByID(ctx, reportID)
		if lookupErr != nil {
			return nil, nil, lookupErr
		}
		if report == nil {
			return nil, nil, agent_inspection.ErrReportNotFound
		}
		if report.Status == "submitted" {
			return report, agent_inspection.ThresholdWarnings(report), nil
		}
		return nil, nil, agent_inspection.ErrReportState
	}
	if err != nil {
		return nil, nil, err
	}
	report, err := s.getReportByID(ctx, updatedID)
	if err != nil {
		return nil, nil, err
	}
	if report == nil {
		return nil, nil, agent_inspection.ErrReportNotFound
	}
	return report, agent_inspection.ThresholdWarnings(report), nil
}

func (s *AgentInspectionStore) ListHistory(
	ctx context.Context,
	filter agent_inspection.HistoryFilter,
) (agent_inspection.HistoryPage, error) {
	args := make([]any, 0, 8)
	conditions := make([]string, 0, 5)
	addArg := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if filter.PeriodID != nil {
		conditions = append(conditions, "r.period_id = "+addArg(*filter.PeriodID))
	}
	if filter.ProjectID != nil {
		conditions = append(conditions, "r.project_id = "+addArg(*filter.ProjectID))
	}
	if len(filter.Countries) > 0 {
		conditions = append(conditions, "upper(p.country) = any("+addArg(filter.Countries)+"::text[])")
	}
	if !filter.AllProjects {
		if len(filter.ProjectIDs) == 0 {
			return agent_inspection.HistoryPage{
				Items: []agent_inspection.HistoryItem{},
				Total: 0,
			}, nil
		}
		conditions = append(conditions, "r.project_id = any("+addArg(filter.ProjectIDs)+"::bigint[])")
	}
	where := ""
	if len(conditions) > 0 {
		where = " where " + strings.Join(conditions, " and ")
	}

	var total int64
	if err := s.db.QueryRow(
		ctx,
		`select count(*)
		 from public.inspection_reports r
		 join public.inspection_periods ip on ip.id = r.period_id
		 join public.projects p on p.id = r.project_id`+where,
		args...,
	).Scan(&total); err != nil {
		return agent_inspection.HistoryPage{}, err
	}

	orderExpression := agentInspectionHistoryOrderExpression(filter.OrderBy)
	order := "desc"
	if strings.EqualFold(filter.OrderDir, "asc") {
		order = "asc"
	}
	limitPlaceholder := addArg(filter.Limit)
	offsetPlaceholder := addArg(filter.Offset)
	rows, err := s.db.Query(
		ctx,
		`select r.id, r.period_id, ip.week_start, ip.week_end,
		        r.project_id, p.project_name, upper(coalesce(p.country, 'US')),
		        r.status, r.health_data::text, r.compliance_data::text,
		        r.submitted_at,
		        (select count(*)::int
		         from public.inspection_screenshots s
		         where s.report_id = r.id) as screenshot_count
		 from public.inspection_reports r
		 join public.inspection_periods ip on ip.id = r.period_id
		 join public.projects p on p.id = r.project_id`+
			where+`
		 order by `+orderExpression+` `+order+`, ip.week_start desc, p.sort_order asc, r.id asc
		 limit `+limitPlaceholder+` offset `+offsetPlaceholder,
		args...,
	)
	if err != nil {
		return agent_inspection.HistoryPage{}, err
	}
	defer rows.Close()

	items := make([]agent_inspection.HistoryItem, 0)
	for rows.Next() {
		var (
			id              int64
			periodID        int64
			weekStart       time.Time
			weekEnd         time.Time
			projectID       int64
			projectName     string
			country         string
			status          string
			healthText      *string
			complianceText  *string
			submittedAt     *time.Time
			screenshotCount int
		)
		if err := rows.Scan(
			&id, &periodID, &weekStart, &weekEnd,
			&projectID, &projectName, &country, &status,
			&healthText, &complianceText, &submittedAt, &screenshotCount,
		); err != nil {
			return agent_inspection.HistoryPage{}, err
		}
		health, err := decodeAgentInspectionMap(healthText)
		if err != nil {
			return agent_inspection.HistoryPage{}, err
		}
		compliance, err := decodeAgentInspectionMap(complianceText)
		if err != nil {
			return agent_inspection.HistoryPage{}, err
		}
		items = append(items, agent_inspection.HistoryItem{
			PeriodID:            periodID,
			WeekStart:           weekStart.Format("2006-01-02"),
			WeekEnd:             weekEnd.Format("2006-01-02"),
			ProjectID:           projectID,
			ProjectName:         projectName,
			Country:             country,
			Status:              status,
			AccountHealthRating: agentInspectionStringValue(health["account_health_rating"]),
			ComplianceTotal:     agentInspectionComplianceTotal(compliance),
			SubmittedAt:         httpapi.OptionalTimestamp(submittedAt),
			ScreenshotCount:     screenshotCount,
		})
	}
	if err := rows.Err(); err != nil {
		return agent_inspection.HistoryPage{}, err
	}
	return agent_inspection.HistoryPage{Items: items, Total: total}, nil
}

const agentInspectionReportSelectSQL = `
	select r.id, r.period_id, r.project_id, p.project_name,
	       upper(coalesce(p.country, 'US')), upper(r.country), r.status,
	       r.health_data::text, r.compliance_data::text,
	       r.status_summary, r.submitted_by, r.submitted_at,
	       r.created_at, r.updated_at,
	       (select count(*)::int
	        from public.inspection_screenshots s
	        where s.report_id = r.id) as screenshot_count
	from public.inspection_reports r
	join public.projects p on p.id = r.project_id`

func scanAgentInspectionPeriod(row interface{ Scan(...any) error }) (agent_inspection.Period, error) {
	var (
		id        int64
		weekStart time.Time
		weekEnd   time.Time
		deadline  time.Time
	)
	if err := row.Scan(&id, &weekStart, &weekEnd, &deadline); err != nil {
		return agent_inspection.Period{}, err
	}
	return agent_inspection.Period{
		ID:        id,
		WeekStart: weekStart.Format("2006-01-02"),
		WeekEnd:   weekEnd.Format("2006-01-02"),
		Deadline:  httpapi.Timestamp(deadline),
	}, nil
}

func scanAgentInspectionReport(row interface{ Scan(...any) error }) (agent_inspection.Report, error) {
	var (
		report         agent_inspection.Report
		healthText     *string
		complianceText *string
		statusSummary  *string
		submittedBy    *string
		submittedAt    *time.Time
	)
	err := row.Scan(
		&report.ID, &report.PeriodID, &report.ProjectID,
		&report.ProjectName, &report.ProjectCountry,
		&report.Country, &report.Status,
		&healthText, &complianceText,
		&statusSummary, &submittedBy, &submittedAt,
		&report.CreatedAt, &report.UpdatedAt, &report.ScreenshotCount,
	)
	if err != nil {
		return agent_inspection.Report{}, err
	}
	report.HealthData, err = decodeAgentInspectionMap(healthText)
	if err != nil {
		return agent_inspection.Report{}, err
	}
	report.ComplianceData, err = decodeAgentInspectionMap(complianceText)
	if err != nil {
		return agent_inspection.Report{}, err
	}
	report.StatusSummary = statusSummary
	report.SubmittedBy = submittedBy
	report.SubmittedAt = submittedAt
	return report, nil
}

func scanAgentInspectionOverviewReport(
	row interface{ Scan(...any) error },
) (*agent_inspection.Report, error) {
	var (
		report         agent_inspection.Report
		healthText     *string
		complianceText *string
		submittedAt    *time.Time
	)
	if err := row.Scan(
		&report.ID, &report.ProjectID, &report.Country, &report.Status,
		&healthText, &complianceText, &submittedAt,
		&report.ScreenshotCount,
	); err != nil {
		return nil, err
	}
	report.SubmittedAt = submittedAt
	var err error
	report.HealthData, err = decodeAgentInspectionMap(healthText)
	if err != nil {
		return nil, err
	}
	report.ComplianceData, err = decodeAgentInspectionMap(complianceText)
	if err != nil {
		return nil, err
	}
	return &report, nil
}

func decodeAgentInspectionMap(value *string) (map[string]any, error) {
	if value == nil || strings.TrimSpace(*value) == "" || strings.EqualFold(strings.TrimSpace(*value), "null") {
		return nil, nil
	}
	decoder := json.NewDecoder(strings.NewReader(*value))
	decoder.UseNumber()
	var result map[string]any
	if err := decoder.Decode(&result); err != nil {
		return nil, fmt.Errorf("decode inspection JSON: %w", err)
	}
	return result, nil
}

func agentInspectionJSONArgument(set bool, value any) (any, error) {
	if !set || value == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return string(encoded), nil
}

func mapAgentInspectionConstraintError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23503":
		if strings.Contains(pgErr.ConstraintName, "period_id") {
			return agent_inspection.ErrPeriodNotFound
		}
		if strings.Contains(pgErr.ConstraintName, "project_id") {
			return agent_inspection.ErrProjectNotFound
		}
	case "23505":
		return agent_inspection.ErrIdempotencyConflict
	}
	return err
}

func agentInspectionWeekStart(now time.Time) time.Time {
	location := inspectionShanghaiLocation()
	local := now.In(location)
	daysSinceMonday := (int(local.Weekday()) + 6) % 7
	return time.Date(
		local.Year(), local.Month(), local.Day()-daysSinceMonday,
		0, 0, 0, 0, location,
	)
}

func parseAgentInspectionTimestamp(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse inspection period deadline: %w", err)
	}
	return parsed, nil
}

func agentInspectionAccountHealthRow(
	period agent_inspection.Period,
	project agent_inspection.Project,
	report *agent_inspection.Report,
) agent_inspection.AccountHealthRow {
	row := agent_inspection.AccountHealthRow{
		PeriodID:    period.ID,
		WeekStart:   period.WeekStart,
		WeekEnd:     period.WeekEnd,
		ProjectID:   project.ID,
		ProjectName: project.Name,
		Country:     project.Country,
	}
	if report == nil {
		return row
	}
	row.Status = report.Status
	row.SubmittedAt = httpapi.OptionalTimestamp(report.SubmittedAt)
	row.ScreenshotCount = report.ScreenshotCount
	row.ComplianceTotal = agentInspectionComplianceTotal(report.ComplianceData)
	health := report.HealthData
	row.AccountHealthRating = agentInspectionStringValue(health["account_health_rating"])
	row.NegativeFeedback = agentInspectionIntValue(health["negative_feedback"])
	row.A2ZClaims = agentInspectionIntValue(health["a2z_claims"])
	row.ChargebackClaims = agentInspectionIntValue(health["chargeback_claims"])
	row.LateShipmentRate = agentInspectionFloatValue(health["late_shipment_rate"])
	row.PreFulfillmentCancelRate = agentInspectionFloatValue(health["pre_fulfillment_cancel_rate"])
	row.ValidTrackingRate = agentInspectionFloatValue(health["valid_tracking_rate"])
	row.OnTimeDeliveryRate = agentInspectionFloatValue(health["on_time_delivery_rate"])
	compliance := report.ComplianceData
	row.IPInfringement = agentInspectionIntValue(compliance["ip_infringement"])
	row.IPComplaints = agentInspectionIntValue(compliance["ip_complaints"])
	row.ProductAuthenticityComplaints = agentInspectionIntValue(compliance["product_authenticity_complaints"])
	row.ProductConditionComplaints = agentInspectionIntValue(compliance["product_condition_complaints"])
	row.FoodProductSafety = agentInspectionIntValue(compliance["food_product_safety"])
	row.ListingPolicyViolations = agentInspectionIntValue(compliance["listing_policy_violations"])
	row.RestrictedProductViolations = agentInspectionIntValue(compliance["restricted_product_violations"])
	row.ReviewPolicyViolations = agentInspectionIntValue(compliance["review_policy_violations"])
	row.OtherPolicyViolations = agentInspectionIntValue(compliance["other_policy_violations"])
	row.RegulatoryCompliance = agentInspectionIntValue(compliance["regulatory_compliance"])
	return row
}

func agentInspectionComplianceTotal(data map[string]any) *int {
	if len(data) == 0 {
		return nil
	}
	total := 0
	for _, key := range []string{
		"ip_infringement", "ip_complaints", "product_authenticity_complaints",
		"product_condition_complaints", "food_product_safety",
		"listing_policy_violations", "restricted_product_violations",
		"review_policy_violations", "other_policy_violations", "regulatory_compliance",
	} {
		total += agentInspectionIntScalar(data[key])
	}
	return &total
}

func agentInspectionStringValue(value any) *string {
	if text, ok := value.(string); ok {
		return &text
	}
	return nil
}

func agentInspectionIntValue(value any) *int {
	if value == nil {
		return nil
	}
	number := agentInspectionIntScalar(value)
	return &number
}

func agentInspectionIntScalar(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		number, _ := typed.Int64()
		return int(number)
	default:
		return 0
	}
}

func agentInspectionFloatValue(value any) *float64 {
	if value == nil {
		return nil
	}
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	case int:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case json.Number:
		number, _ = typed.Float64()
	default:
		return nil
	}
	return &number
}

func agentInspectionHistoryOrderExpression(orderBy string) string {
	switch orderBy {
	case "project_name":
		return "lower(p.project_name)"
	case "account_health_rating":
		return "coalesce(r.health_data->>'account_health_rating', '')"
	case "compliance_total":
		return "(" + agentInspectionComplianceTotalSQL + ")"
	case "submitted_at":
		return "coalesce(r.submitted_at, '-infinity'::timestamptz)"
	case "week_start":
		return "ip.week_start"
	case "late_shipment_rate", "pre_fulfillment_cancel_rate",
		"valid_tracking_rate", "on_time_delivery_rate":
		return "coalesce((r.health_data->>'" + orderBy + "')::numeric, 0)"
	case "negative_feedback", "a2z_claims", "chargeback_claims":
		return "coalesce((r.health_data->>'" + orderBy + "')::numeric, 0)"
	case "ip_infringement", "ip_complaints", "product_authenticity_complaints",
		"product_condition_complaints", "food_product_safety",
		"listing_policy_violations", "restricted_product_violations",
		"review_policy_violations", "other_policy_violations", "regulatory_compliance":
		return "coalesce((r.compliance_data->>'" + orderBy + "')::numeric, 0)"
	default:
		return "ip.week_start"
	}
}

const agentInspectionComplianceTotalSQL = `
	coalesce((r.compliance_data->>'ip_infringement')::numeric, 0) +
	coalesce((r.compliance_data->>'ip_complaints')::numeric, 0) +
	coalesce((r.compliance_data->>'product_authenticity_complaints')::numeric, 0) +
	coalesce((r.compliance_data->>'product_condition_complaints')::numeric, 0) +
	coalesce((r.compliance_data->>'food_product_safety')::numeric, 0) +
	coalesce((r.compliance_data->>'listing_policy_violations')::numeric, 0) +
	coalesce((r.compliance_data->>'restricted_product_violations')::numeric, 0) +
	coalesce((r.compliance_data->>'review_policy_violations')::numeric, 0) +
	coalesce((r.compliance_data->>'other_policy_violations')::numeric, 0) +
	coalesce((r.compliance_data->>'regulatory_compliance')::numeric, 0)
`

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
