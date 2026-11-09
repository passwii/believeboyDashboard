package store

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"mime"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/report_reconciliation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	defaultAgentMonthlyReportRoot   = "backend/storage/agent_monthly_reports"
	defaultAgentMonthlyUploadRoot   = "backend/storage/uploads"
	defaultAgentMonthlyResultRoot   = "backend/storage/results"
	defaultAgentMonthlyMaxFileBytes = int64(50 * 1024 * 1024)
	defaultAgentMonthlyTTL          = 24 * time.Hour
)

type AgentMonthlyReportStoreOptions struct {
	Root       string
	UploadRoot string
	ResultRoot string
	TTL        time.Duration
	Now        func() time.Time
}

type AgentMonthlyReportStore struct {
	db         FullDB
	auditor    audit.Service
	root       string
	uploadRoot string
	resultRoot string
	ttl        time.Duration
	now        func() time.Time
}

type agentMonthlySeriesSource struct {
	reportID int64
	row      AgentMonthlyFinancialSeriesRow
}

type agentMonthlyAccountingSourceLine struct {
	en     string
	zh     string
	source string
	key    string
}

func NewAgentMonthlyReportStore(
	db FullDB,
	auditor audit.Service,
	options AgentMonthlyReportStoreOptions,
) *AgentMonthlyReportStore {
	root := strings.TrimSpace(options.Root)
	if root == "" {
		root = storageRoot("AGENT_MONTHLY_REPORT_ROOT", defaultAgentMonthlyReportRoot)
	}
	uploadRoot := strings.TrimSpace(options.UploadRoot)
	if uploadRoot == "" {
		uploadRoot = storageRoot("UPLOAD_ROOT", defaultAgentMonthlyUploadRoot)
	}
	resultRoot := strings.TrimSpace(options.ResultRoot)
	if resultRoot == "" {
		resultRoot = storageRoot("MONTHLY_REPORT_RESULT_ROOT", defaultAgentMonthlyResultRoot)
	}
	ttl := options.TTL
	if ttl <= 0 {
		ttl = defaultAgentMonthlyTTL
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &AgentMonthlyReportStore{
		db:         db,
		auditor:    auditor,
		root:       root,
		uploadRoot: uploadRoot,
		resultRoot: resultRoot,
		ttl:        ttl,
		now:        now,
	}
}

func (s *AgentMonthlyReportStore) ListAgentMonthlyReports(
	ctx context.Context,
	filter AgentMonthlyReportListFilter,
) ([]AgentMonthlyReportItem, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	conditions := []string{"r.project_id = $1"}
	args := []any{filter.ProjectID}
	if filter.Country != nil {
		country, err := normalizeAgentMonthlyCountry(*filter.Country)
		if err != nil {
			return nil, err
		}
		args = append(args, country)
		conditions = append(conditions, fmt.Sprintf("r.country = $%d", len(args)))
	}
	if filter.ReportMonth != nil {
		month, err := normalizeAgentMonthlyMonth(*filter.ReportMonth)
		if err != nil {
			return nil, err
		}
		args = append(args, month)
		conditions = append(conditions, fmt.Sprintf("r.report_month = $%d", len(args)))
	}
	if !filter.IncludeHistory {
		conditions = append(conditions, "r.is_current = true")
	}
	query := `
		select r.id, r.project_id, coalesce(r.project_name, p.project_name),
		       r.country, r.report_month, r.version, r.is_current,
		       r.superseded_at, r.status::text, r.settlement_id,
		       r.total_transactions, r.total_orders, r.total_refunds,
		       r.total_adjustments, r.total_service_fees, r.total_trans_fees,
		       r.result_file_path, r.error_message, r.calculation_version,
		       r.computed_at, r.created_at, r.updated_at
		from public.monthly_reports r
		join public.projects p on p.id = r.project_id
		where ` + strings.Join(conditions, " and ") + `
		order by r.report_month desc, r.id desc`
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]AgentMonthlyReportItem, 0)
	for rows.Next() {
		item, scanErr := scanAgentMonthlyReportItem(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		// Agent responses never disclose server-local storage paths or raw errors.
		item.ResultFilePath = nil
		item.ErrorMessage = nil
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyReport(
	ctx context.Context,
	reportID int64,
) (*AgentMonthlyReportDetail, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	item, err := scanAgentMonthlyReportItem(s.db.QueryRow(ctx, `
		select r.id, r.project_id, coalesce(r.project_name, p.project_name),
		       r.country, r.report_month, r.version, r.is_current,
		       r.superseded_at, r.status::text, r.settlement_id,
		       r.total_transactions, r.total_orders, r.total_refunds,
		       r.total_adjustments, r.total_service_fees, r.total_trans_fees,
		       r.result_file_path, r.error_message, r.calculation_version,
		       r.computed_at, r.created_at, r.updated_at
		from public.monthly_reports r
		join public.projects p on p.id = r.project_id
		where r.id = $1`, reportID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAgentMonthlyNotFound
		}
		return nil, err
	}
	item.ResultFilePath = nil
	item.ErrorMessage = nil
	helper := &MonthlyReportStore{db: s.db}
	pt3, err := helper.loadCalculationMap(ctx, monthlyReportPT3CalculationTable, reportID)
	if err != nil {
		return nil, err
	}
	pt4, err := helper.loadCalculationMap(ctx, monthlyReportPT4CalculationTable, reportID)
	if err != nil {
		return nil, err
	}
	return &AgentMonthlyReportDetail{Report: *item, PT3: pt3, PT4: pt4}, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyReportProjectID(
	ctx context.Context,
	reportID int64,
) (int64, error) {
	if s == nil || s.db == nil {
		return 0, ErrAgentMonthlyDependency
	}
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select project_id from public.monthly_reports where id = $1`,
		reportID,
	).Scan(&projectID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrAgentMonthlyNotFound
		}
		return 0, err
	}
	return projectID, nil
}

func (s *AgentMonthlyReportStore) ExportAgentMonthlyReport(
	ctx context.Context,
	reportID int64,
	entry audit.Entry,
) (*AgentMonthlyStoredFile, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	var (
		status      string
		projectName string
		reportMonth string
		path        *string
	)
	err := s.db.QueryRow(ctx, `
		select status::text, project_name, report_month, result_file_path
		from public.monthly_reports
		where id = $1`, reportID).Scan(&status, &projectName, &reportMonth, &path)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAgentMonthlyNotFound
		}
		return nil, err
	}
	if status != "success" {
		return nil, ErrAgentMonthlyNotReady
	}
	resolved := existingRegularFile(path, s.resultRoot)
	if resolved == "" {
		return nil, ErrAgentMonthlyNotFound
	}
	if s.auditor == nil {
		return nil, ErrAgentMonthlyDependency
	}
	entry.Action = "agent_monthly_reports.result.export"
	entry.TargetType = "monthly_report"
	target := strconv.FormatInt(reportID, 10)
	entry.TargetID = &target
	entry.AfterJSON = map[string]any{
		"report_id":    reportID,
		"filename":     filepath.Base(resolved),
		"project":      projectName,
		"report_month": reportMonth,
	}
	if err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		return s.auditor.LogActionTx(ctx, tx, entry)
	}); err != nil {
		return nil, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	return &AgentMonthlyStoredFile{
		Path:        resolved,
		Filename:    filepath.Base(resolved),
		ContentType: contentTypeForPath(resolved),
		Size:        info.Size(),
	}, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyFinancialSeries(
	ctx context.Context,
	filter AgentMonthlyFinancialSeriesFilter,
) (*AgentMonthlyFinancialSeriesResponse, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	var projectName string
	if err := s.db.QueryRow(
		ctx,
		`select project_name from public.projects where id = $1`,
		filter.ProjectID,
	).Scan(&projectName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAgentMonthlyNotFound
		}
		return nil, err
	}
	country, err := normalizeAgentMonthlyCountry(filter.Country)
	if err != nil {
		return nil, err
	}
	for _, month := range []*string{filter.StartMonth, filter.EndMonth} {
		if month != nil {
			if _, err := normalizeAgentMonthlyMonth(*month); err != nil {
				return nil, err
			}
		}
	}

	rows, err := s.db.Query(ctx, `
		select r.report_month, r.id,
		       p4.income_sales, p4.income_refund, p4.income_adjustment, p4.income_other,
		       p4.expense_selling_fee, p4.expense_fba_fee, p4.expense_inventory_fee,
		       p4.expense_service_fee, p4.expense_advertising, p4.expense_other_fees,
		       p4.income_total, p4.expense_total, p4.amazon_pay_back,
		       p4.expense_vat_total, p4.credit_card_deduction_usd,
		       p3.income_vat_total,
		       coalesce((
		         select sum(t.total)::float8
		         from public.monthly_report_transactions t
		         where t.report_id = r.id
		           and lower(btrim(t.transaction_type)) = 'debt'
		       ), 0)::float8
		from public.monthly_reports r
		left join public.monthly_report_pt4_calculation p4 on p4.report_id = r.id
		left join public.monthly_report_pt3_calculation p3 on p3.report_id = r.id
		where r.project_id = $1
		  and r.country = $2
		  and r.is_current = true
		order by r.report_month asc`,
		filter.ProjectID,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sources := make([]agentMonthlySeriesSource, 0)
	for rows.Next() {
		var (
			reportID                                                 int64
			reportMonth                                              string
			incomeSales, incomeRefund, incomeAdjustment, incomeOther *float64
			expenseSelling, expenseFBA, expenseInventory             *float64
			expenseService, expenseAdvertising, expenseOther         *float64
			incomeTotal, expenseTotal, amazonPayBack                 *float64
			expenseVAT                                               *float64
			storedCreditCard                                         *float64
			incomeVAT                                                *float64
			debtSum                                                  *float64
		)
		if err := rows.Scan(
			&reportMonth, &reportID,
			&incomeSales, &incomeRefund, &incomeAdjustment, &incomeOther,
			&expenseSelling, &expenseFBA, &expenseInventory,
			&expenseService, &expenseAdvertising, &expenseOther,
			&incomeTotal, &expenseTotal, &amazonPayBack,
			&expenseVAT, &storedCreditCard, &incomeVAT, &debtSum,
		); err != nil {
			return nil, err
		}
		creditCard := valueOrZero(storedCreditCard)
		if storedCreditCard == nil {
			creditCard = valueOrZero(debtSum)
		}
		sources = append(sources, agentMonthlySeriesSource{
			reportID: reportID,
			row: AgentMonthlyFinancialSeriesRow{
				ReportMonth:            reportMonth,
				IncomeSales:            valueOrZero(incomeSales),
				IncomeRefund:           valueOrZero(incomeRefund),
				IncomeAdjustment:       valueOrZero(incomeAdjustment),
				IncomeOther:            valueOrZero(incomeOther),
				ExpenseSellingFee:      valueOrZero(expenseSelling),
				ExpenseFBAFee:          valueOrZero(expenseFBA),
				ExpenseInventoryFee:    valueOrZero(expenseInventory),
				ExpenseServiceFee:      valueOrZero(expenseService),
				ExpenseAdvertising:     valueOrZero(expenseAdvertising),
				ExpenseOtherFees:       valueOrZero(expenseOther),
				IncomeTotal:            valueOrZero(incomeTotal),
				ExpenseTotal:           valueOrZero(expenseTotal),
				AmazonPayBack:          valueOrZero(amazonPayBack),
				IncomeVATTotal:         valueOrZero(incomeVAT),
				IncomeSalesWithTax:     valueOrZero(incomeSales),
				ExpenseVATTotal:        valueOrZero(expenseVAT),
				CreditCardDeductionUSD: creditCard,
				HasSourceReport:        true,
			},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	costs, err := s.loadAgentMonthlyCostTotals(
		ctx,
		filter.ProjectID,
		country,
		agentMonthlyReportIDs(sources),
	)
	if err != nil {
		return nil, err
	}
	for index := range sources {
		if cost, ok := costs[sources[index].reportID]; ok {
			sources[index].row.FOBCostRMB = cost[0]
			sources[index].row.FirstLegCostRMB = cost[1]
		}
	}

	monthRows := make(map[string]AgentMonthlyFinancialSeriesRow, len(sources))
	allMonths := make([]string, 0, len(sources))
	for _, source := range sources {
		monthRows[source.row.ReportMonth] = source.row
		allMonths = append(allMonths, source.row.ReportMonth)
	}
	start, end, err := resolveAgentMonthlyRange(allMonths, filter.StartMonth, filter.EndMonth, s.now())
	if err != nil {
		return nil, err
	}
	months := agentMonthlyMonthRange(start, end)
	finalRows := make([]AgentMonthlyFinancialSeriesRow, 0, len(months))
	for _, month := range months {
		if row, ok := monthRows[month]; ok {
			finalRows = append(finalRows, row)
		} else if filter.FillMissing {
			finalRows = append(finalRows, AgentMonthlyFinancialSeriesRow{
				ReportMonth: month,
			})
		}
	}
	points := make([]AgentMonthlyFinancialTrendPoint, 0, len(finalRows))
	var incomeSum, expenseSum, paybackSum, netSum float64
	for _, row := range finalRows {
		point := AgentMonthlyFinancialTrendPoint{
			ReportMonth:     row.ReportMonth,
			IncomeTotal:     row.IncomeTotal,
			ExpenseTotal:    row.ExpenseTotal,
			AmazonPayBack:   row.AmazonPayBack,
			NetAmount:       row.IncomeTotal + row.ExpenseTotal,
			HasSourceReport: row.HasSourceReport,
		}
		incomeSum += point.IncomeTotal
		expenseSum += point.ExpenseTotal
		paybackSum += point.AmazonPayBack
		netSum += point.NetAmount
		points = append(points, point)
	}
	return &AgentMonthlyFinancialSeriesResponse{
		ProjectID:   filter.ProjectID,
		ProjectName: projectName,
		StartMonth:  start.Format("2006-01"),
		EndMonth:    end.Format("2006-01"),
		Rows:        finalRows,
		Trend: AgentMonthlyFinancialTrend{
			IncomeTotalSum:   incomeSum,
			ExpenseTotalSum:  expenseSum,
			AmazonPayBackSum: paybackSum,
			NetAmountSum:     netSum,
			Points:           points,
		},
	}, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyAccountingDetail(
	ctx context.Context,
	filter AgentMonthlyAccountingFilter,
) (*AgentMonthlyFinancialAccountingDetailResponse, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	month, err := normalizeAgentMonthlyMonth(filter.ReportMonth)
	if err != nil {
		return nil, err
	}
	country, err := normalizeAgentMonthlyCountry(filter.Country)
	if err != nil {
		return nil, err
	}
	var (
		projectName string
		reportMonth string
		pt3Payload  string
	)
	err = s.db.QueryRow(ctx, `
		select p.project_name, r.report_month,
		       (to_jsonb(p3) - 'id' - 'report_id' - 'project_name' - 'report_month'
		        - 'calculation_version' - 'computed_at' - 'created_at' - 'updated_at')::text
		from public.monthly_reports r
		join public.projects p on p.id = r.project_id
		join public.monthly_report_pt3_calculation p3 on p3.report_id = r.id
		where r.project_id = $1
		  and r.country = $2
		  and r.report_month = $3
		order by r.is_current desc, r.id desc
		limit 1`,
		filter.ProjectID,
		country,
		month,
	).Scan(&projectName, &reportMonth, &pt3Payload)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAgentMonthlyNotFound
		}
		_ = pt3Payload
		return nil, err
	}
	var pt3 map[string]float64
	if err := json.Unmarshal([]byte(pt3Payload), &pt3); err != nil {
		return nil, err
	}
	return &AgentMonthlyFinancialAccountingDetailResponse{
		ProjectID:   filter.ProjectID,
		ProjectName: projectName,
		ReportMonth: reportMonth,
		Rows:        buildAgentMonthlyAccountingRows(pt3, country),
	}, nil
}

func (s *AgentMonthlyReportStore) ExportAgentMonthlyAccountingDetail(
	ctx context.Context,
	filter AgentMonthlyAccountingFilter,
	entry audit.Entry,
) (*AgentMonthlyFileResult, error) {
	detail, err := s.GetAgentMonthlyAccountingDetail(ctx, filter)
	if err != nil {
		return nil, err
	}
	rows := [][]string{{
		"Income", "收入", "In金额", "In源表", "",
		"Expense", "支出", "Ex金额", "Ex源表",
	}}
	for _, line := range detail.Rows {
		rows = append(rows, []string{
			line.IncomeEN,
			line.IncomeZH,
			formatAgentMonthlyNumber(line.IncomeAmountLocal),
			line.IncomeSource,
			"",
			line.ExpenseEN,
			line.ExpenseZH,
			formatAgentMonthlyNumber(line.ExpenseAmountLocal),
			line.ExpenseSource,
		})
	}
	content, err := buildSimpleXLSXSheet("报表核算", rows)
	if err != nil {
		return nil, err
	}
	monthParts := strings.Split(detail.ReportMonth, "-")
	monthLabel := detail.ReportMonth
	if len(monthParts) == 2 {
		monthLabel = monthParts[0] + "年" + strings.TrimLeft(monthParts[1], "0") + "月"
	}
	filename := safeAgentMonthlyFilename(detail.ProjectName) +
		"-月度财务核算明细-" + monthLabel + ".xlsx"

	if s.auditor == nil {
		return nil, ErrAgentMonthlyDependency
	}
	entry.Action = "agent_monthly_reports.accounting_detail.export"
	entry.TargetType = "monthly_report_project"
	target := strconv.FormatInt(filter.ProjectID, 10)
	entry.TargetID = &target
	entry.AfterJSON = map[string]any{
		"project_id":   filter.ProjectID,
		"country":      filter.Country,
		"report_month": detail.ReportMonth,
	}
	if err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		return s.auditor.LogActionTx(ctx, tx, entry)
	}); err != nil {
		return nil, err
	}
	return &AgentMonthlyFileResult{
		Filename:    filename,
		ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		Content:     content,
	}, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyReconciliationHistory(
	ctx context.Context,
	reportID int64,
	limit int,
	offset int,
) (*AgentMonthlyReconciliationHistory, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	if limit <= 0 || limit > 200 || offset < 0 {
		return nil, ErrAgentMonthlyInvalidInput
	}
	var total int64
	if err := s.db.QueryRow(
		ctx,
		`select count(*) from public.reconciliation_records where report_id = $1`,
		reportID,
	).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `
		select id, report_id, mode, match_rate::float8,
		       matched_items, mismatched_items, missing_items,
		       detail_json::text, created_at
		from public.reconciliation_records
		where report_id = $1
		order by created_at desc, id desc
		offset $2
		limit $3`,
		reportID,
		offset,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]AgentMonthlyReconciliationRecord, 0)
	for rows.Next() {
		var (
			record     AgentMonthlyReconciliationRecord
			detailText *string
			createdAt  time.Time
		)
		if err := rows.Scan(
			&record.ID,
			&record.ReportID,
			&record.Mode,
			&record.MatchRate,
			&record.MatchedItems,
			&record.MismatchedItems,
			&record.MissingItems,
			&detailText,
			&createdAt,
		); err != nil {
			return nil, err
		}
		record.TotalItems = record.MatchedItems + record.MismatchedItems + record.MissingItems
		record.Summary = map[string]any{}
		record.Items = []any{}
		if detailText != nil && strings.TrimSpace(*detailText) != "" {
			var parsed struct {
				Summary map[string]any `json:"summary"`
				Items   []any          `json:"items"`
			}
			if err := json.Unmarshal([]byte(*detailText), &parsed); err == nil {
				record.Summary = parsed.Summary
				record.Items = parsed.Items
			}
		}
		record.CreatedAt = httpapi.Timestamp(createdAt)
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &AgentMonthlyReconciliationHistory{
		Records: records,
		Total:   total,
		Limit:   limit,
		Offset:  offset,
	}, nil
}

func (s *AgentMonthlyReportStore) AutoReconcileAgentMonthlyReport(
	ctx context.Context,
	input AgentMonthlyAutoReconcileInput,
	entry audit.Entry,
) (map[string]any, error) {
	if s == nil || s.db == nil || s.auditor == nil {
		return nil, ErrAgentMonthlyDependency
	}
	var result map[string]any
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		reconciler := NewReportReconciliationStore(NewTxDB(tx))
		response, err := reconciler.AutoReconcile(
			ctx,
			report_reconciliation.AutoReconcileRequest{
				ReportID:  input.ReportID,
				Tolerance: input.Tolerance,
				Country:   input.Country,
			},
			input.AgentID,
			true,
		)
		if err != nil {
			return mapAgentMonthlyReconcileError(err)
		}
		result = map[string]any{
			"summary":          response.Summary,
			"total_items":      response.TotalItems,
			"matched_items":    response.MatchedItems,
			"mismatched_items": response.MismatchedItems,
			"missing_items":    response.MissingItems,
			"match_rate":       response.MatchRate,
			"items":            response.Items,
			"record_id":        response.RecordID,
		}
		entry.Action = "agent_monthly_reports.reconciliation.auto"
		entry.TargetType = "reconciliation_record"
		if response.RecordID != nil {
			target := strconv.FormatInt(*response.RecordID, 10)
			entry.TargetID = &target
		}
		entry.AfterJSON = map[string]any{
			"report_id":   input.ReportID,
			"record_id":   response.RecordID,
			"match_rate":  response.MatchRate,
			"total_items": response.TotalItems,
		}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *AgentMonthlyReportStore) ManualReconcileAgentMonthlyReport(
	ctx context.Context,
	input AgentMonthlyManualReconcileInput,
	entry audit.Entry,
) (map[string]any, error) {
	if s == nil || s.db == nil || s.auditor == nil {
		return nil, ErrAgentMonthlyDependency
	}
	var result map[string]any
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		reconciler := NewReportReconciliationStore(NewTxDB(tx))
		response, err := reconciler.ManualReconcile(
			ctx,
			&input.ReportID,
			input.ExcelBytes,
			input.PDFBytes,
			input.Tolerance,
			input.AgentID,
			true,
		)
		if err != nil {
			return mapAgentMonthlyManualReconcileError(err)
		}
		var recordID int64
		if err := tx.QueryRow(
			ctx,
			`select id from public.reconciliation_records
			 where report_id = $1 and mode = 'manual'`,
			input.ReportID,
		).Scan(&recordID); err != nil {
			return err
		}
		response["record_id"] = recordID
		result = response
		entry.Action = "agent_monthly_reports.reconciliation.manual"
		entry.TargetType = "reconciliation_record"
		target := strconv.FormatInt(recordID, 10)
		entry.TargetID = &target
		entry.AfterJSON = map[string]any{
			"report_id":   input.ReportID,
			"record_id":   recordID,
			"match_rate":  response["match_rate"],
			"total_items": response["total_items"],
			"excel_bytes": len(input.ExcelBytes),
			"pdf_bytes":   len(input.PDFBytes),
		}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func scanAgentMonthlyReportItem(scanner interface{ Scan(...any) error }) (*AgentMonthlyReportItem, error) {
	var (
		item         AgentMonthlyReportItem
		supersededAt pgtype.Timestamptz
		computedAt   pgtype.Timestamptz
		createdAt    time.Time
		updatedAt    time.Time
		resultPath   *string
		errorMessage *string
	)
	if err := scanner.Scan(
		&item.ID,
		&item.ProjectID,
		&item.ProjectName,
		&item.Country,
		&item.ReportMonth,
		&item.Version,
		&item.IsCurrent,
		&supersededAt,
		&item.Status,
		&item.SettlementID,
		&item.TotalTransactions,
		&item.TotalOrders,
		&item.TotalRefunds,
		&item.TotalAdjustments,
		&item.TotalServiceFees,
		&item.TotalTransFees,
		&resultPath,
		&errorMessage,
		&item.CalculationVersion,
		&computedAt,
		&createdAt,
		&updatedAt,
	); err != nil {
		return nil, err
	}
	item.ResultFilePath = resultPath
	item.ErrorMessage = errorMessage
	item.SupersededAt = agentMonthlyTimestamp(supersededAt)
	item.ComputedAt = agentMonthlyTimestamp(computedAt)
	item.CreatedAt = &createdAt
	item.UpdatedAt = &updatedAt
	return &item, nil
}

func agentMonthlyTimestamp(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}

func normalizeAgentMonthlyMonth(value string) (string, error) {
	value = strings.TrimSpace(value)
	parsed, err := time.Parse("2006-01", value)
	if err != nil || parsed.Format("2006-01") != value {
		return "", fmt.Errorf("%w: report_month must be YYYY-MM", ErrAgentMonthlyInvalidInput)
	}
	return value, nil
}

func normalizeAgentMonthlyCountry(value string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	switch normalized {
	case "", "US", "USA", "美国", "美国站":
		return "US", nil
	case "DE", "GERMANY", "德国", "德国站":
		return "DE", nil
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK", nil
	default:
		return "", fmt.Errorf("%w: country must be US, DE, or UK", ErrAgentMonthlyInvalidInput)
	}
}

func valueOrZero(value *float64) float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return 0
	}
	return *value
}

func agentMonthlyReportIDs(sources []agentMonthlySeriesSource) []int64 {
	ids := make([]int64, 0, len(sources))
	for _, source := range sources {
		ids = append(ids, source.reportID)
	}
	return ids
}

func resolveAgentMonthlyRange(
	months []string,
	startMonth *string,
	endMonth *string,
	now time.Time,
) (time.Time, time.Time, error) {
	var start, end time.Time
	if startMonth != nil {
		parsed, err := time.Parse("2006-01", *startMonth)
		if err != nil {
			return time.Time{}, time.Time{}, ErrAgentMonthlyInvalidInput
		}
		start = parsed
	}
	if endMonth != nil {
		parsed, err := time.Parse("2006-01", *endMonth)
		if err != nil {
			return time.Time{}, time.Time{}, ErrAgentMonthlyInvalidInput
		}
		end = parsed
	}
	current := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	var earliest *time.Time
	for _, value := range months {
		parsed, err := time.Parse("2006-01", value)
		if err != nil {
			continue
		}
		if earliest == nil || parsed.Before(*earliest) {
			earliest = &parsed
		}
	}
	if start.IsZero() && end.IsZero() {
		end = current
		start = current.AddDate(0, -11, 0)
		if earliest != nil && earliest.After(start) {
			start = *earliest
		}
	} else if start.IsZero() {
		start = end.AddDate(0, -11, 0)
		if earliest != nil && earliest.After(start) {
			start = *earliest
		}
	} else if end.IsZero() {
		end = current
	}
	if start.After(end) {
		return time.Time{}, time.Time{}, ErrAgentMonthlyInvalidInput
	}
	return start, end, nil
}

func agentMonthlyMonthRange(start, end time.Time) []string {
	months := make([]string, 0)
	for current := start; !current.After(end); current = current.AddDate(0, 1, 0) {
		months = append(months, current.Format("2006-01"))
	}
	return months
}

func (s *AgentMonthlyReportStore) loadAgentMonthlyCostTotals(
	ctx context.Context,
	projectID int64,
	country string,
	reportIDs []int64,
) (map[int64][2]float64, error) {
	if len(reportIDs) == 0 {
		return map[int64][2]float64{}, nil
	}
	rows, err := s.db.Query(ctx, `
		select transaction_totals.report_id::bigint,
		       coalesce(sum(transaction_totals.quantity * costs.fob_unit_cost), 0)::float8,
		       coalesce(sum(transaction_totals.quantity * costs.first_leg_cost_rmb), 0)::float8
		from (
		  select report_id, sku, sum(quantity)::numeric as quantity
		  from public.monthly_report_transactions
		  where report_id = any($1)
		    and sku is not null
		    and lower(btrim(transaction_type)) = 'order'
		  group by report_id, sku
		) transaction_totals
		join lateral (
		  select fob_unit_cost, first_leg_cost_rmb
		  from public.product_costs
		  where project_id = $2
		    and country = $3
		    and sku = transaction_totals.sku
		    and is_active = true
		  order by updated_at desc, id desc
		  limit 1
		) costs on true
		group by transaction_totals.report_id`,
		reportIDs,
		projectID,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[int64][2]float64, len(reportIDs))
	for rows.Next() {
		var reportID int64
		var fob, firstLeg float64
		if err := rows.Scan(&reportID, &fob, &firstLeg); err != nil {
			return nil, err
		}
		result[reportID] = [2]float64{fob, firstLeg}
	}
	return result, rows.Err()
}

func buildAgentMonthlyAccountingRows(
	pt3 map[string]float64,
	country string,
) []AgentMonthlyFinancialAccountingLine {
	currency := countryCurrency(country)
	lines := make([]AgentMonthlyFinancialAccountingLine, 0, 21)
	income := []agentMonthlyAccountingSourceLine{
		{"Product sales (non-FBA)", "销售额（非FBA）", "FBM 订单-订单金额", "income_product_sales_non_fba"},
		{"Product sale refunds (non-FBA)", "销售额退款（非FBA）", "FBM 退款-订单金额", "income_product_sale_refunds_non_fba"},
		{"FBA product sales", "销售额（FBA）", "FBA 订单-订单金额", "income_fba_product_sales"},
		{"FBA product sale refunds", "销售额退款（FBA）", "FBA 退款-订单金额 + 其他金额", "income_fba_product_sale_refunds"},
		{"FBA inventory credit", "FBA库存赔偿（FBA）", "FBA库存赔偿-总计", "income_fba_inventory_credit"},
		{"FBA liquidation proceeds", "FBA清算收入", "清算费用-订单金额", "income_fba_liquidation_proceeds"},
		{"Shipping credits", "运费收入", "所有订单-运费金额", "income_shipping_credits"},
		{"Shipping credit refunds", "运费退款", "所有退款-运费金额", "income_shipping_credit_refunds"},
		{"Gift wrap credits", "礼品包装收入", "所有订单-礼品包装金额", "income_gift_wrap_credits"},
		{"Gift wrap credit refunds", "礼品包装退款", "所有退款-礼品包装金额", "income_gift_wrap_credits_refunds"},
		{"Promotional rebates", "促销折扣", "所有订单-促销折扣金额", "income_promotional_rebates"},
		{"Promotional rebate refunds", "促销折扣退款", "所有退款-促销折扣金额", "income_promotional_rebate_refunds"},
		{"A-to-z Guarantee claims", "A-to-z保障索赔", "", "income_a_to_z_guarantee_claims"},
		{"Chargebacks", "拒付退款", "拒付退款-总计", "income_chargebacks"},
		{"SAFE-T reimbursement", "SAFE-T赔偿", "", "income_safe_t_reimbursement"},
		{"Product sales tax (gross)", "销售税（gross）", "所有订单/退款-产品销售税", "income_vat_total"},
	}
	expense := []agentMonthlyAccountingSourceLine{
		{"Seller fulfilled selling fees", "卖家自配送销售佣金", "FBM 订单-销售佣金", "expense_seller_fulfilled_selling_fees"},
		{"FBA selling fees", "FBA销售佣金", "FBA 订单-销售佣金", "expense_fba_selling_fees"},
		{"Selling fee refunds", "销售佣金退款", "所有退款-销售佣金 + 退款管理费", "expense_selling_fee_refunds"},
		{"FBA transaction fees", "FBA派送费", "FBA 订单 - 派送费", "expense_fba_transaction_fees"},
		{"FBA transaction fee refunds", "FBA派送费退款", "FBA 退款 - 派送费 + 测量费", "expense_fba_transaction_fee_refunds"},
		{"Other transaction fees", "其他交易费用", "", "expense_other_transaction_fees"},
		{"Other transaction fee refunds", "其他交易费用退款", "", "expense_other_transaction_fee_refunds"},
		{"FBA inventory and inbound services fees", "FBA库存和入库服务费", "FBA仓储及入库服务费 - 总计", "expense_fba_inventory_and_inbound_services_fees"},
		{"Shipping label purchases", "购买配送标签", "", "expense_shipping_label_purchases"},
		{"Shipping label refunds", "配送标签退款", "", "expense_shipping_label_refunds"},
		{"Carrier shipping label adjustments", "承运商配送标签调整", "", "expense_carrier_shipping_label_adjustments"},
		{"Service fees", "服务费", "服务费（不含广告）-总计", "expense_service_fees"},
		{"Refund administration fees", "退款管理费", "合并在销售佣金退款中扣除", "expense_refund_administration_fees"},
		{"Adjustments", "调整项", "其他赔偿调整-总计", "expense_adjustments"},
		{"Cost of Advertising", "广告成本", "广告费-总计", "expense_cost_of_advertising"},
		{"Refund for Advertiser", "广告商退款", "广告退款-总计", "expense_refund_for_advertiser"},
		{"Liquidations fees", "清算处理费", "清算费用-其他交易费用", "expense_liquidations_fees"},
		{"Receivables", "应收账款", "", "expense_receivables"},
		{"Deductions", "扣款", "", "expense_deductions"},
		{"Amazon Shipping Charge Adjustments", "亚马逊配送运费调整", "", "expense_amazon_shipping_charge_adjustments"},
	}
	pad := len(expense) - len(income)
	for index := 0; index < pad; index++ {
		lines = append(lines, agentMonthlyAccountingLine("", "", "", 0, expense[index], pt3, currency))
	}
	for index := range income {
		expenseIndex := pad + index
		if expenseIndex < len(expense) {
			lines = append(lines, agentMonthlyAccountingLine(income[index].en, income[index].zh, income[index].source, mapValue(pt3, income[index].key), expense[expenseIndex], pt3, currency))
		} else {
			lines = append(lines, agentMonthlyAccountingLine(income[index].en, income[index].zh, income[index].source, mapValue(pt3, income[index].key), agentMonthlyAccountingSourceLine{}, pt3, currency))
		}
	}
	lines = append(lines, AgentMonthlyFinancialAccountingLine{
		CurrencyCode: &currency,
		Kind:         "spacer",
	})
	lines = append(lines, AgentMonthlyFinancialAccountingLine{
		IncomeEN:           "Total_Income",
		IncomeZH:           "合计销售额",
		IncomeAmountLocal:  mapValue(pt3, "income_total"),
		ExpenseEN:          "Total_Expense",
		ExpenseZH:          "合计费用",
		ExpenseAmountLocal: mapValue(pt3, "expense_total"),
		CurrencyCode:       &currency,
		Kind:               "total",
	})
	return lines
}

func agentMonthlyAccountingLine(
	incomeEN, incomeZH, incomeSource string,
	incomeAmount float64,
	expense agentMonthlyAccountingSourceLine,
	pt3 map[string]float64,
	currency string,
) AgentMonthlyFinancialAccountingLine {
	return AgentMonthlyFinancialAccountingLine{
		IncomeEN:           incomeEN,
		IncomeZH:           incomeZH,
		IncomeAmountLocal:  incomeAmount,
		IncomeSource:       incomeSource,
		ExpenseEN:          expense.en,
		ExpenseZH:          expense.zh,
		ExpenseAmountLocal: mapValue(pt3, expense.key),
		ExpenseSource:      expense.source,
		CurrencyCode:       &currency,
		Kind:               "detail",
	}
}

func formatAgentMonthlyNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', 2, 64)
}

func safeAgentMonthlyFilename(value string) string {
	var builder strings.Builder
	for _, character := range strings.TrimSpace(value) {
		switch {
		case strings.ContainsRune(`\/:*?"<>|`, character), unicode.IsControl(character):
			continue
		default:
			builder.WriteRune(character)
		}
	}
	result := strings.TrimSpace(builder.String())
	if result == "" {
		return "unknown"
	}
	return result
}

func mapAgentMonthlyReconcileError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, report_reconciliation.ErrReportNotFound) || errors.Is(err, pgx.ErrNoRows) {
		return ErrAgentMonthlyNotFound
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "does not have a summary pdf"),
		strings.Contains(message, "does not have pt3"),
		strings.Contains(message, "failed to extract pdf data"),
		strings.Contains(message, "failed to extract reconciliation metrics"):
		return ErrAgentMonthlyNotReady
	default:
		return err
	}
}

func mapAgentMonthlyManualReconcileError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrAgentMonthlyNotFound) ||
		errors.Is(err, report_reconciliation.ErrReportNotFound) ||
		errors.Is(err, pgx.ErrNoRows) {
		return ErrAgentMonthlyNotFound
	}
	for _, sentinel := range []error{
		ErrAgentMonthlyConflict,
		ErrAgentMonthlyExpired,
		ErrAgentMonthlyNotReady,
		ErrAgentMonthlyIdempotencyConflict,
		ErrAgentMonthlyInvalidInput,
		ErrAgentMonthlyDependency,
	} {
		if errors.Is(err, sentinel) {
			return err
		}
	}
	message := strings.ToLower(err.Error())
	for _, fragment := range []string{
		"excel file",
		"pdf file",
		"failed to extract pdf data",
		"failed to extract reconciliation metrics",
		"invalid value",
		"invalid pdf",
		"no extractable text",
		"sheet",
		"workbook",
		"xml",
		"zip",
	} {
		if strings.Contains(message, fragment) {
			return fmt.Errorf("%w: %v", ErrAgentMonthlyInvalidInput, err)
		}
	}
	return err
}

func contentTypeForAgentMonthlyPath(path string) string {
	if value := contentTypeForPath(path); value != "" {
		return value
	}
	if value := mime.TypeByExtension(filepath.Ext(path)); value != "" {
		return value
	}
	return "application/octet-stream"
}

func validateAgentMonthlyCSVData(data []byte) error {
	if int64(len(data)) > defaultAgentMonthlyMaxFileBytes {
		return ErrAgentMonthlyInvalidInput
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		return fmt.Errorf("%w: parse transaction CSV: %v", ErrAgentMonthlyInvalidInput, err)
	}
	if len(records) < 2 || len(records[0]) == 0 {
		return fmt.Errorf("%w: transaction CSV has no data rows", ErrAgentMonthlyInvalidInput)
	}
	return nil
}
