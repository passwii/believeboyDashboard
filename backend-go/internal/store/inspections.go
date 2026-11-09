package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inspections"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const inspectionReportSelectColumns = `
	r.id, r.period_id, r.project_id, r.status,
	r.health_data::text, r.compliance_data::text, r.status_summary,
	r.submitted_by, r.submitted_at, r.created_at, r.updated_at,
	p.project_name`

const inspectionScreenshotSelectColumns = `
	s.id, s.report_id, s.r2_key, s.thumbnail_key, s.filename,
	s.content_type, s.file_size, s.caption, s.sort_order, s.created_at`

const inspectionScreenshotReturningColumns = `
	id, report_id, r2_key, thumbnail_key, filename,
	content_type, file_size, caption, sort_order, created_at`

type InspectionStore struct {
	db FullDB
}

func NewInspectionStore(db FullDB) *InspectionStore {
	return &InspectionStore{db: db}
}

func (s *InspectionStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, inspections.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &InspectionStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (s *InspectionStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	var projectOperator, assistantOperator *string
	err := s.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator
		 from public.projects
		 where id = $1
		 limit 1`,
		projectID,
	).Scan(&projectOperator, &assistantOperator)
	if errors.Is(err, pgx.ErrNoRows) {
		return inspections.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return inspections.ErrProjectForbidden
	}
	if inspectionTextContainsName(projectOperator, operator) ||
		inspectionTextContainsName(assistantOperator, operator) {
		return nil
	}
	return inspections.ErrProjectForbidden
}

func (s *InspectionStore) ListPeriods(
	ctx context.Context,
	limit int,
	offset int,
) (inspections.PeriodListResponse, error) {
	var total int64
	if err := s.db.QueryRow(
		ctx,
		`select count(*) from public.inspection_periods`,
	).Scan(&total); err != nil {
		return inspections.PeriodListResponse{}, err
	}

	rows, err := s.db.Query(
		ctx,
		`select id, week_start, week_end, deadline, created_at
		 from public.inspection_periods
		 order by week_start desc
		 limit $1 offset $2`,
		limit,
		offset,
	)
	if err != nil {
		return inspections.PeriodListResponse{}, err
	}
	defer rows.Close()

	items := make([]inspections.Period, 0)
	for rows.Next() {
		item, scanErr := scanInspectionPeriod(rows)
		if scanErr != nil {
			return inspections.PeriodListResponse{}, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return inspections.PeriodListResponse{}, err
	}
	return inspections.PeriodListResponse{Items: items, Total: total}, nil
}

func (s *InspectionStore) GetOrCreateCurrentPeriod(
	ctx context.Context,
) (inspections.Period, error) {
	now := time.Now().In(inspectionShanghaiLocation())
	daysSinceMonday := (int(now.Weekday()) + 6) % 7
	weekStart := time.Date(
		now.Year(), now.Month(), now.Day()-daysSinceMonday,
		0, 0, 0, 0, now.Location(),
	)
	weekEnd := weekStart.AddDate(0, 0, 6)
	deadline := time.Date(
		weekEnd.Year(), weekEnd.Month(), weekEnd.Day()+1,
		9, 0, 0, 0, now.Location(),
	)

	row := s.db.QueryRow(
		ctx,
		`insert into public.inspection_periods (
		   week_start, week_end, deadline
		 )
		 values ($1::date, $2::date, $3::timestamptz)
		 on conflict (week_start) do update
		 set week_start = excluded.week_start
		 returning id, week_start, week_end, deadline, created_at`,
		weekStart.Format("2006-01-02"),
		weekEnd.Format("2006-01-02"),
		deadline,
	)
	return scanInspectionPeriod(row)
}

func (s *InspectionStore) GetPeriod(
	ctx context.Context,
	periodID int64,
) (*inspections.Period, error) {
	row := s.db.QueryRow(
		ctx,
		`select id, week_start, week_end, deadline, created_at
		 from public.inspection_periods
		 where id = $1
		 limit 1`,
		periodID,
	)
	item, err := scanInspectionPeriod(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *InspectionStore) GetOverview(
	ctx context.Context,
	periodID int64,
	operator string,
	isAdmin bool,
) (*inspections.OverviewResponse, error) {
	period, err := s.GetPeriod(ctx, periodID)
	if err != nil {
		return nil, err
	}
	if period == nil {
		return nil, nil
	}

	deadline, deadlineErr := time.Parse(time.RFC3339, period.Deadline)
	if deadlineErr != nil {
		return nil, fmt.Errorf("parse inspection period deadline: %w", deadlineErr)
	}
	now := time.Now().In(inspectionShanghaiLocation())
	if !now.Before(deadline) {
		if err := s.markInspectionReportsOverdue(ctx, periodID); err != nil {
			return nil, err
		}
	}

	operator = strings.TrimSpace(operator)
	if !isAdmin && operator == "" {
		return &inspections.OverviewResponse{
			Period: *period,
			Items:  []inspections.OverviewItem{},
		}, nil
	}

	projectRows, err := s.db.Query(
		ctx,
		`select id, project_name
		 from public.projects
		 where coalesce(is_active, true)
		   and (
		     $1::boolean
		     or (
		       $2::text <> ''
		       and (
		         exists (
		           select 1
		           from unnest(regexp_split_to_array(
		             coalesce(project_operator, ''),
		             '[、,，;' || chr(10) || ']+'
		           )) as names(value)
		           where btrim(names.value) = $2
		         )
		         or exists (
		           select 1
		           from unnest(regexp_split_to_array(
		             coalesce(assistant_operator, ''),
		             '[、,，;' || chr(10) || ']+'
		           )) as names(value)
		           where btrim(names.value) = $2
		         )
		       )
		     )
		   )
		 order by sort_order asc, id asc`,
		isAdmin,
		operator,
	)
	if err != nil {
		return nil, err
	}
	defer projectRows.Close()

	type overviewProject struct {
		id   int64
		name string
	}
	projects := make([]overviewProject, 0)
	for projectRows.Next() {
		var project overviewProject
		if err := projectRows.Scan(&project.id, &project.name); err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	if err := projectRows.Err(); err != nil {
		return nil, err
	}
	projectRows.Close()

	reportRows, err := s.db.Query(
		ctx,
		`select r.id, r.project_id, r.status, r.health_data::text,
		        r.compliance_data::text, r.status_summary, r.submitted_by,
		        r.submitted_at
		 from public.inspection_reports r
		 where r.period_id = $1 and r.country = 'US'`,
		periodID,
	)
	if err != nil {
		return nil, err
	}
	defer reportRows.Close()

	type overviewReport struct {
		id            int64
		projectID     int64
		status        string
		health        *inspections.HealthData
		compliance    *inspections.ComplianceData
		statusSummary *string
		submittedBy   *string
		submittedAt   *string
	}
	reports := make(map[int64]overviewReport)
	reportIDs := make([]int64, 0)
	for reportRows.Next() {
		var (
			id             int64
			projectID      int64
			status         string
			healthText     *string
			complianceText *string
			statusSummary  *string
			submittedBy    *string
			submittedAt    *time.Time
		)
		if err := reportRows.Scan(
			&id,
			&projectID,
			&status,
			&healthText,
			&complianceText,
			&statusSummary,
			&submittedBy,
			&submittedAt,
		); err != nil {
			return nil, err
		}
		health, err := decodeInspectionHealthData(healthText)
		if err != nil {
			return nil, err
		}
		compliance, err := decodeInspectionComplianceData(complianceText)
		if err != nil {
			return nil, err
		}
		reports[projectID] = overviewReport{
			id:            id,
			projectID:     projectID,
			status:        status,
			health:        health,
			compliance:    compliance,
			statusSummary: statusSummary,
			submittedBy:   submittedBy,
			submittedAt:   httpapi.OptionalTimestamp(submittedAt),
		}
		reportIDs = append(reportIDs, id)
	}
	if err := reportRows.Err(); err != nil {
		return nil, err
	}
	reportRows.Close()

	screenshots, err := s.loadInspectionScreenshots(ctx, reportIDs)
	if err != nil {
		return nil, err
	}

	items := make([]inspections.OverviewItem, 0, len(projects))
	submittedCount := 0
	overdueCount := 0
	for _, project := range projects {
		report, exists := reports[project.id]
		status := "pending"
		health := (*inspections.HealthData)(nil)
		compliance := (*inspections.ComplianceData)(nil)
		var statusSummary, submittedBy, submittedAt *string
		if exists {
			health = report.health
			compliance = report.compliance
			statusSummary = report.statusSummary
			submittedBy = report.submittedBy
			submittedAt = report.submittedAt
			switch report.status {
			case "submitted":
				status = "submitted"
			case "overdue":
				status = "overdue"
			default:
				status = "draft"
			}
		} else if !now.Before(deadline) {
			status = "overdue"
		}
		if status == "submitted" {
			submittedCount++
		}
		if status == "overdue" {
			overdueCount++
		}

		item := inspections.OverviewItem{
			ProjectID:       project.id,
			ProjectName:     project.name,
			Status:          status,
			ComplianceTotal: inspectionComplianceTotal(compliance),
			StatusSummary:   statusSummary,
			SubmittedBy:     submittedBy,
			SubmittedAt:     submittedAt,
			Screenshots:     inspectionOverviewScreenshots(screenshots[report.id]),
		}
		if health != nil {
			item.AccountHealthRating = health.AccountHealthRating
			item.NegativeFeedback = health.NegativeFeedback
			item.A2ZClaims = health.A2ZClaims
			item.ChargebackClaims = health.ChargebackClaims
			item.LateShipmentRate = health.LateShipmentRate
			item.ValidTrackingRate = health.ValidTrackingRate
			item.OnTimeDeliveryRate = health.OnTimeDeliveryRate
		}
		items = append(items, item)
	}
	return &inspections.OverviewResponse{
		Period:         *period,
		Items:          items,
		TotalProjects:  len(items),
		SubmittedCount: submittedCount,
		OverdueCount:   overdueCount,
	}, nil
}

func (s *InspectionStore) markInspectionReportsOverdue(
	ctx context.Context,
	periodID int64,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &InspectionStore{db: NewTxDB(tx)}
		_, err := txStore.db.Exec(
			ctx,
			`insert into public.inspection_reports (
			   period_id, project_id, country, status, created_at, updated_at
			 )
			 select $1, p.id, 'US', 'overdue', now(), now()
			 from public.projects p
			 where coalesce(p.is_active, true)
			 on conflict (period_id, project_id, country) do update
			 set status = 'overdue',
			     updated_at = now()
			 where inspection_reports.status <> 'submitted'`,
			periodID,
		)
		return err
	})
}

func (s *InspectionStore) GetReport(
	ctx context.Context,
	periodID int64,
	projectID int64,
) (*inspections.Report, error) {
	row := s.db.QueryRow(
		ctx,
		`select `+inspectionReportSelectColumns+`
		 from public.inspection_reports r
		 join public.projects p on p.id = r.project_id
		 where r.period_id = $1
		   and r.project_id = $2
		   and r.country = 'US'
		 limit 1`,
		periodID,
		projectID,
	)
	report, err := scanInspectionReport(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	screenshots, err := s.loadInspectionScreenshots(ctx, []int64{report.ID})
	if err != nil {
		return nil, err
	}
	report.Screenshots = inspectionReportScreenshots(screenshots[report.ID])
	return &report, nil
}

func (s *InspectionStore) GetReportByID(
	ctx context.Context,
	reportID int64,
) (*inspections.Report, error) {
	row := s.db.QueryRow(
		ctx,
		`select `+inspectionReportSelectColumns+`
		 from public.inspection_reports r
		 join public.projects p on p.id = r.project_id
		 where r.id = $1
		 limit 1`,
		reportID,
	)
	report, err := scanInspectionReport(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	screenshots, err := s.loadInspectionScreenshots(ctx, []int64{report.ID})
	if err != nil {
		return nil, err
	}
	report.Screenshots = inspectionReportScreenshots(screenshots[report.ID])
	return &report, nil
}

func (s *InspectionStore) CreateOrUpdateReport(
	ctx context.Context,
	periodID int64,
	projectID int64,
	input inspections.ReportWriteInput,
) (*inspections.Report, error) {
	healthJSON, err := inspectionJSONArgument(input.HealthDataSet, input.HealthData)
	if err != nil {
		return nil, err
	}
	complianceJSON, err := inspectionJSONArgument(input.ComplianceDataSet, input.ComplianceData)
	if err != nil {
		return nil, err
	}

	var reportID int64
	err = s.db.QueryRow(
		ctx,
		`insert into public.inspection_reports (
		   period_id, project_id, country, status,
		   health_data, compliance_data, status_summary, created_at, updated_at
		 )
		 values ($1, $2, 'US', 'draft', $3::json, $4::json, $5, now(), now())
		 on conflict (period_id, project_id, country) do update
		 set health_data = case
		       when $6::boolean then excluded.health_data
		       else inspection_reports.health_data
		     end,
		     compliance_data = case
		       when $7::boolean then excluded.compliance_data
		       else inspection_reports.compliance_data
		     end,
		     status_summary = case
		       when $8::boolean then excluded.status_summary
		       else inspection_reports.status_summary
		     end,
		     updated_at = now()
		 returning id`,
		periodID,
		projectID,
		healthJSON,
		complianceJSON,
		input.StatusSummary,
		input.HealthDataSet,
		input.ComplianceDataSet,
		input.StatusSummarySet,
	).Scan(&reportID)
	if err != nil {
		return nil, mapInspectionConstraintError(err)
	}
	report, err := s.GetReportByID(ctx, reportID)
	if err != nil {
		return nil, err
	}
	if report == nil {
		return nil, inspections.ErrReportNotFound
	}
	return report, nil
}

func (s *InspectionStore) SubmitReport(
	ctx context.Context,
	reportID int64,
	operator *string,
) (*inspections.Report, []inspections.ThresholdWarning, error) {
	row := s.db.QueryRow(
		ctx,
		`update public.inspection_reports
		 set status = 'submitted',
		     submitted_by = $2,
		     submitted_at = now(),
		     updated_at = now()
		 where id = $1
		 returning id`,
		reportID,
		operator,
	)
	var updatedID int64
	if err := row.Scan(&updatedID); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, inspections.ErrReportNotFound
	} else if err != nil {
		return nil, nil, err
	}
	report, err := s.GetReportByID(ctx, updatedID)
	if err != nil {
		return nil, nil, err
	}
	if report == nil {
		return nil, nil, inspections.ErrReportNotFound
	}
	return report, inspectionThresholdWarnings(report.HealthData, report.ComplianceData), nil
}

func (s *InspectionStore) GetScreenshot(
	ctx context.Context,
	screenshotID int64,
) (*inspections.ScreenshotRecord, error) {
	row := s.db.QueryRow(
		ctx,
		`select `+inspectionScreenshotSelectColumns+`, r.project_id
		 from public.inspection_screenshots s
		 join public.inspection_reports r on r.id = s.report_id
		 where s.id = $1
		 limit 1`,
		screenshotID,
	)
	record, err := scanInspectionScreenshotRecordWithProject(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (s *InspectionStore) InsertScreenshot(
	ctx context.Context,
	input inspections.InsertScreenshotInput,
) (*inspections.ScreenshotRecord, error) {
	if !inspectionSafeStorageKey(input.R2Key) ||
		(input.ThumbnailKey != nil && !inspectionSafeStorageKey(*input.ThumbnailKey)) ||
		!inspectionSafeFilename(input.Filename) ||
		input.FileSize <= 0 ||
		input.FileSize > int64(1<<31-1) {
		return nil, errors.New("unsafe inspection screenshot path")
	}
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select project_id
		 from public.inspection_reports
		 where id = $1
		 for update`,
		input.ReportID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, inspections.ErrReportNotFound
	}
	if err != nil {
		return nil, err
	}

	row := s.db.QueryRow(
		ctx,
		`insert into public.inspection_screenshots (
		   report_id, r2_key, thumbnail_key, filename, content_type,
		   file_size, caption, sort_order, created_at
		 )
		 values (
		   $1, $2, $3, $4, $5, $6, $7,
		   (
		     select coalesce(max(sort_order), -1) + 1
		     from public.inspection_screenshots
		     where report_id = $1
		   ),
		   now()
		 )
		 returning `+inspectionScreenshotReturningColumns,
		input.ReportID,
		input.R2Key,
		input.ThumbnailKey,
		input.Filename,
		input.ContentType,
		int(input.FileSize),
		input.Caption,
	)
	record, err := scanInspectionScreenshotRecord(row)
	if err != nil {
		return nil, err
	}
	record.ProjectID = projectID
	return &record, nil
}

func (s *InspectionStore) DeleteScreenshot(
	ctx context.Context,
	screenshotID int64,
) (bool, error) {
	execer, ok := s.db.(Execer)
	if !ok {
		return false, errors.New("database does not support Exec")
	}
	tag, err := execer.Exec(
		ctx,
		`delete from public.inspection_screenshots where id = $1`,
		screenshotID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *InspectionStore) ListHistory(
	ctx context.Context,
	filter inspections.HistoryFilter,
) (inspections.HistoryResponse, error) {
	operator := strings.TrimSpace(filter.Operator)
	if !filter.IsAdmin && operator == "" {
		return inspections.HistoryResponse{Items: []inspections.HistoryItem{}, Total: 0}, nil
	}

	args := []any{
		filter.PeriodID,
		filter.ProjectID,
		filter.IsAdmin,
		operator,
	}
	where := `
		where ($1::bigint is null or r.period_id = $1)
		  and ($2::bigint is null or r.project_id = $2)
		  and (
		    $3::boolean
		    or (
		      $4::text <> ''
		      and (
		        exists (
		          select 1
		          from unnest(regexp_split_to_array(
		            coalesce(p.project_operator, ''),
		            '[、,，;' || chr(10) || ']+'
		          )) as names(value)
		          where btrim(names.value) = $4
		        )
		        or exists (
		          select 1
		          from unnest(regexp_split_to_array(
		            coalesce(p.assistant_operator, ''),
		            '[、,，;' || chr(10) || ']+'
		          )) as names(value)
		          where btrim(names.value) = $4
		        )
		      )
		    )
		  )`

	var total int64
	if err := s.db.QueryRow(
		ctx,
		`select count(*)
		 from public.inspection_reports r
		 join public.inspection_periods ip on ip.id = r.period_id
		 join public.projects p on p.id = r.project_id
		 `+where,
		args...,
	).Scan(&total); err != nil {
		return inspections.HistoryResponse{}, err
	}

	queryArgs := append(args, filter.Limit, filter.Offset)
	rows, err := s.db.Query(
		ctx,
		`select r.id, r.period_id, ip.week_start, ip.week_end,
		        r.project_id, p.project_name, r.status,
		        r.health_data::text, r.compliance_data::text,
		        r.status_summary, r.submitted_by, r.submitted_at
		 from public.inspection_reports r
		 join public.inspection_periods ip on ip.id = r.period_id
		 join public.projects p on p.id = r.project_id
		 `+where+`
		 order by ip.week_start desc, p.sort_order asc
		 limit $5 offset $6`,
		queryArgs...,
	)
	if err != nil {
		return inspections.HistoryResponse{}, err
	}
	defer rows.Close()

	items := make([]inspections.HistoryItem, 0)
	reportIDs := make([]int64, 0)
	for rows.Next() {
		var (
			id             int64
			periodID       int64
			weekStart      time.Time
			weekEnd        time.Time
			projectID      int64
			projectName    string
			status         string
			healthText     *string
			complianceText *string
			statusSummary  *string
			submittedBy    *string
			submittedAt    *time.Time
		)
		if err := rows.Scan(
			&id,
			&periodID,
			&weekStart,
			&weekEnd,
			&projectID,
			&projectName,
			&status,
			&healthText,
			&complianceText,
			&statusSummary,
			&submittedBy,
			&submittedAt,
		); err != nil {
			return inspections.HistoryResponse{}, err
		}
		health, err := decodeInspectionHealthData(healthText)
		if err != nil {
			return inspections.HistoryResponse{}, err
		}
		compliance, err := decodeInspectionComplianceData(complianceText)
		if err != nil {
			return inspections.HistoryResponse{}, err
		}
		var rating *string
		if health != nil {
			rating = health.AccountHealthRating
		}
		items = append(items, inspections.HistoryItem{
			ID:                  id,
			PeriodID:            periodID,
			WeekStart:           weekStart.Format("2006-01-02"),
			WeekEnd:             weekEnd.Format("2006-01-02"),
			ProjectID:           projectID,
			ProjectName:         projectName,
			Status:              status,
			AccountHealthRating: rating,
			ComplianceTotal:     inspectionComplianceTotal(compliance),
			StatusSummary:       statusSummary,
			SubmittedBy:         submittedBy,
			SubmittedAt:         httpapi.OptionalTimestamp(submittedAt),
			Screenshots:         []inspections.HistoryScreenshot{},
		})
		reportIDs = append(reportIDs, id)
	}
	if err := rows.Err(); err != nil {
		return inspections.HistoryResponse{}, err
	}
	rows.Close()

	screenshots, err := s.loadInspectionScreenshots(ctx, reportIDs)
	if err != nil {
		return inspections.HistoryResponse{}, err
	}
	for index := range items {
		items[index].Screenshots = inspectionHistoryScreenshots(screenshots[items[index].ID])
	}
	return inspections.HistoryResponse{Items: items, Total: total}, nil
}

func (s *InspectionStore) loadInspectionScreenshots(
	ctx context.Context,
	reportIDs []int64,
) (map[int64][]inspections.ScreenshotRecord, error) {
	result := make(map[int64][]inspections.ScreenshotRecord)
	if len(reportIDs) == 0 {
		return result, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select `+inspectionScreenshotSelectColumns+`
		 from public.inspection_screenshots s
		 where s.report_id = any($1::bigint[])
		 order by s.report_id asc, s.id asc`,
		reportIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		record, err := scanInspectionScreenshotRecord(rows)
		if err != nil {
			return nil, err
		}
		result[record.ReportID] = append(result[record.ReportID], record)
	}
	return result, rows.Err()
}

func scanInspectionPeriod(row interface{ Scan(dest ...any) error }) (inspections.Period, error) {
	var (
		id        int64
		weekStart time.Time
		weekEnd   time.Time
		deadline  time.Time
		createdAt time.Time
	)
	if err := row.Scan(&id, &weekStart, &weekEnd, &deadline, &createdAt); err != nil {
		return inspections.Period{}, err
	}
	return inspections.Period{
		ID:        id,
		WeekStart: weekStart.Format("2006-01-02"),
		WeekEnd:   weekEnd.Format("2006-01-02"),
		Deadline:  httpapi.Timestamp(deadline),
		CreatedAt: httpapi.Timestamp(createdAt),
	}, nil
}

func scanInspectionReport(row interface{ Scan(dest ...any) error }) (inspections.Report, error) {
	var (
		report         inspections.Report
		healthText     *string
		complianceText *string
		statusSummary  *string
		submittedBy    *string
		submittedAt    *time.Time
		createdAt      time.Time
		updatedAt      time.Time
	)
	err := row.Scan(
		&report.ID,
		&report.PeriodID,
		&report.ProjectID,
		&report.Status,
		&healthText,
		&complianceText,
		&statusSummary,
		&submittedBy,
		&submittedAt,
		&createdAt,
		&updatedAt,
		&report.ProjectName,
	)
	if err != nil {
		return inspections.Report{}, err
	}
	report.HealthData, err = decodeInspectionHealthData(healthText)
	if err != nil {
		return inspections.Report{}, err
	}
	report.ComplianceData, err = decodeInspectionComplianceData(complianceText)
	if err != nil {
		return inspections.Report{}, err
	}
	report.StatusSummary = statusSummary
	report.SubmittedBy = submittedBy
	report.SubmittedAt = httpapi.OptionalTimestamp(submittedAt)
	report.CreatedAt = httpapi.Timestamp(createdAt)
	report.UpdatedAt = httpapi.Timestamp(updatedAt)
	report.Screenshots = []inspections.ScreenshotItem{}
	return report, nil
}

func scanInspectionScreenshotRecord(
	row interface{ Scan(dest ...any) error },
) (inspections.ScreenshotRecord, error) {
	var (
		record    inspections.ScreenshotRecord
		fileSize  int
		createdAt time.Time
	)
	err := row.Scan(
		&record.ID,
		&record.ReportID,
		&record.R2Key,
		&record.ThumbnailKey,
		&record.Filename,
		&record.ContentType,
		&fileSize,
		&record.Caption,
		&record.SortOrder,
		&createdAt,
	)
	if err != nil {
		return inspections.ScreenshotRecord{}, err
	}
	record.FileSize = int64(fileSize)
	record.CreatedAt = httpapi.Timestamp(createdAt)
	return record, nil
}

func scanInspectionScreenshotRecordWithProject(
	row interface{ Scan(dest ...any) error },
) (inspections.ScreenshotRecord, error) {
	var (
		record    inspections.ScreenshotRecord
		fileSize  int
		createdAt time.Time
	)
	err := row.Scan(
		&record.ID,
		&record.ReportID,
		&record.R2Key,
		&record.ThumbnailKey,
		&record.Filename,
		&record.ContentType,
		&fileSize,
		&record.Caption,
		&record.SortOrder,
		&createdAt,
		&record.ProjectID,
	)
	if err != nil {
		return inspections.ScreenshotRecord{}, err
	}
	record.FileSize = int64(fileSize)
	record.CreatedAt = httpapi.Timestamp(createdAt)
	return record, nil
}

func decodeInspectionHealthData(value *string) (*inspections.HealthData, error) {
	if value == nil || strings.TrimSpace(*value) == "" || strings.TrimSpace(*value) == "null" {
		return nil, nil
	}
	var data inspections.HealthData
	if err := json.Unmarshal([]byte(*value), &data); err != nil {
		return nil, fmt.Errorf("decode inspection health_data: %w", err)
	}
	return &data, nil
}

func decodeInspectionComplianceData(value *string) (*inspections.ComplianceData, error) {
	if value == nil || strings.TrimSpace(*value) == "" || strings.TrimSpace(*value) == "null" {
		return nil, nil
	}
	var data inspections.ComplianceData
	if err := json.Unmarshal([]byte(*value), &data); err != nil {
		return nil, fmt.Errorf("decode inspection compliance_data: %w", err)
	}
	return &data, nil
}

func inspectionJSONArgument(set bool, value any) (any, error) {
	if !set || value == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return string(encoded), nil
}

func mapInspectionConstraintError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23503":
		switch {
		case strings.Contains(pgErr.ConstraintName, "period_id"):
			return inspections.ErrPeriodNotFound
		case strings.Contains(pgErr.ConstraintName, "project_id"):
			return inspections.ErrProjectNotFound
		}
	case "23505":
		return inspections.ErrConflict
	}
	return err
}

func inspectionComplianceTotal(data *inspections.ComplianceData) *int {
	if data == nil {
		return nil
	}
	values := []*int{
		data.IPInfringement,
		data.IPComplaints,
		data.ProductAuthenticityComplaints,
		data.ProductConditionComplaints,
		data.FoodProductSafety,
		data.ListingPolicyViolations,
		data.RestrictedProductViolations,
		data.ReviewPolicyViolations,
		data.OtherPolicyViolations,
		data.RegulatoryCompliance,
	}
	hasValue := false
	total := 0
	for _, value := range values {
		if value != nil {
			hasValue = true
			total += *value
		}
	}
	if !hasValue {
		return nil
	}
	return &total
}

func inspectionReportScreenshots(records []inspections.ScreenshotRecord) []inspections.ScreenshotItem {
	items := make([]inspections.ScreenshotItem, 0, len(records))
	for _, record := range records {
		items = append(items, inspections.ScreenshotItem{
			ID:           record.ID,
			R2Key:        record.R2Key,
			ThumbnailKey: record.ThumbnailKey,
			Filename:     record.Filename,
			ContentType:  record.ContentType,
			FileSize:     record.FileSize,
			Caption:      record.Caption,
			SortOrder:    record.SortOrder,
			CreatedAt:    record.CreatedAt,
		})
	}
	return items
}

func inspectionOverviewScreenshots(
	records []inspections.ScreenshotRecord,
) []inspections.OverviewScreenshot {
	if len(records) > 4 {
		records = records[:4]
	}
	items := make([]inspections.OverviewScreenshot, 0, len(records))
	for _, record := range records {
		items = append(items, inspections.OverviewScreenshot{
			ID:           record.ID,
			Caption:      record.Caption,
			R2Key:        record.R2Key,
			ThumbnailKey: record.ThumbnailKey,
		})
	}
	return items
}

func inspectionHistoryScreenshots(
	records []inspections.ScreenshotRecord,
) []inspections.HistoryScreenshot {
	if len(records) > 4 {
		records = records[:4]
	}
	items := make([]inspections.HistoryScreenshot, 0, len(records))
	for _, record := range records {
		items = append(items, inspections.HistoryScreenshot{
			ID:           record.ID,
			Caption:      record.Caption,
			R2Key:        record.R2Key,
			ThumbnailKey: record.ThumbnailKey,
		})
	}
	return items
}

func inspectionShanghaiLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("Asia/Shanghai", 8*60*60)
	}
	return location
}

func inspectionTextContainsName(value *string, target string) bool {
	target = strings.TrimSpace(target)
	if value == nil || target == "" {
		return false
	}
	for _, name := range strings.FieldsFunc(*value, func(char rune) bool {
		switch char {
		case ',', '、', '，', ';', '\n':
			return true
		default:
			return false
		}
	}) {
		if strings.TrimSpace(name) == target {
			return true
		}
	}
	return false
}

func inspectionSafeStorageKey(key string) bool {
	if key == "" ||
		path.IsAbs(key) ||
		strings.HasPrefix(key, "/") ||
		strings.Contains(key, "\\") {
		return false
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	for _, char := range key {
		if unicode.IsControl(char) {
			return false
		}
	}
	cleaned := path.Clean(key)
	return cleaned == key &&
		strings.HasPrefix(cleaned, strings.TrimSuffix("inspection-screenshots/", "/")+"/")
}

func inspectionSafeFilename(filename string) bool {
	if filename == "" ||
		path.Base(filename) != filename ||
		strings.Contains(filename, "\\") {
		return false
	}
	for _, char := range filename {
		if unicode.IsControl(char) {
			return false
		}
	}
	return true
}

func inspectionThresholdWarnings(
	health *inspections.HealthData,
	compliance *inspections.ComplianceData,
) []inspections.ThresholdWarning {
	warnings := make([]inspections.ThresholdWarning, 0)
	if health != nil {
		appendInspectionThreshold(&warnings, "inspection_negative_feedback", "negative_feedback", health.NegativeFeedback, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_a2z_claims", "a2z_claims", health.A2ZClaims, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_chargeback_claims", "chargeback_claims", health.ChargebackClaims, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_late_shipment", "late_shipment_rate", health.LateShipmentRate, "above", 2.0, 4.0)
		appendInspectionThreshold(&warnings, "inspection_vtr", "valid_tracking_rate", health.ValidTrackingRate, "below", 97.0, 95.0)
		appendInspectionThreshold(&warnings, "inspection_on_time_delivery", "on_time_delivery_rate", health.OnTimeDeliveryRate, "below", 97.0, 95.0)
	}
	if compliance != nil {
		appendInspectionThreshold(&warnings, "inspection_ip_infringement", "ip_infringement", compliance.IPInfringement, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_ip_complaints", "ip_complaints", compliance.IPComplaints, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_product_authenticity", "product_authenticity_complaints", compliance.ProductAuthenticityComplaints, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_product_condition", "product_condition_complaints", compliance.ProductConditionComplaints, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_food_safety", "food_product_safety", compliance.FoodProductSafety, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_listing_violations", "listing_policy_violations", compliance.ListingPolicyViolations, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_restricted_product", "restricted_product_violations", compliance.RestrictedProductViolations, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_review_violations", "review_policy_violations", compliance.ReviewPolicyViolations, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_other_violations", "other_policy_violations", compliance.OtherPolicyViolations, "above", 1, 3)
		appendInspectionThreshold(&warnings, "inspection_regulatory", "regulatory_compliance", compliance.RegulatoryCompliance, "above", 1, 3)
	}
	return warnings
}

func appendInspectionThreshold(
	warnings *[]inspections.ThresholdWarning,
	metric string,
	key string,
	value any,
	direction string,
	warning float64,
	critical float64,
) {
	if value == nil {
		return
	}
	number, ok := inspectionNumericValue(value)
	if !ok {
		return
	}
	severity := ""
	threshold := 0.0
	switch direction {
	case "above":
		if number >= critical {
			severity, threshold = "critical", critical
		} else if number >= warning {
			severity, threshold = "warning", warning
		}
	case "below":
		if number <= critical {
			severity, threshold = "critical", critical
		} else if number <= warning {
			severity, threshold = "warning", warning
		}
	}
	if severity == "" {
		return
	}
	actualValue := inspectionWarningValue(value)
	*warnings = append(*warnings, inspections.ThresholdWarning{
		Metric:    metric,
		Value:     actualValue,
		Threshold: threshold,
		Severity:  severity,
		Message: fmt.Sprintf(
			"%s is %v (%s: threshold %v)",
			key,
			actualValue,
			severity,
			threshold,
		),
	})
}

func inspectionWarningValue(value any) any {
	switch typed := value.(type) {
	case *int:
		return *typed
	case *float64:
		return *typed
	default:
		return value
	}
}

func inspectionNumericValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case *int:
		if typed == nil {
			return 0, false
		}
		return float64(*typed), true
	case *float64:
		if typed == nil {
			return 0, false
		}
		return *typed, true
	case int:
		return float64(typed), true
	case float64:
		return typed, true
	default:
		return 0, false
	}
}
