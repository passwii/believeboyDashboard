package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/ledongthuc/pdf"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/report_reconciliation"
)

type ReportReconciliationStore struct {
	db         FullDB
	fileRoot   string
	httpClient *http.Client
}

func NewReportReconciliationStore(db FullDB) *ReportReconciliationStore {
	return &ReportReconciliationStore{
		db:         db,
		fileRoot:   reconciliationFileRoot(),
		httpClient: &http.Client{Timeout: 20 * time.Second},
	}
}

func (s *ReportReconciliationStore) VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	var projOp, asstOp *string
	err := s.db.QueryRow(ctx, "select project_operator, assistant_operator from public.projects where id = $1", projectID).Scan(&projOp, &asstOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return report_reconciliation.ErrReportNotFound
		}
		return err
	}
	op = strings.TrimSpace(op)
	if op == "" {
		return report_reconciliation.ErrProjectForbidden
	}
	if reconciliationTextContainsName(projOp, op) || reconciliationTextContainsName(asstOp, op) {
		return nil
	}
	return report_reconciliation.ErrProjectForbidden
}

func reconciliationTextContainsName(value *string, target string) bool {
	target = strings.TrimSpace(target)
	if target == "" || value == nil {
		return false
	}
	for _, name := range strings.FieldsFunc(*value, func(r rune) bool {
		return r == ',' || r == '、' || r == '，' || r == ';' || r == '\n' || r == '\r' || r == '\t' || r == ' '
	}) {
		if strings.TrimSpace(name) == target {
			return true
		}
	}
	return false
}

func (s *ReportReconciliationStore) GetReportProjectID(ctx context.Context, reportID int64) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(ctx, "select project_id from public.monthly_reports where id = $1", reportID).Scan(&projectID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, report_reconciliation.ErrReportNotFound
		}
		return 0, err
	}
	return projectID, nil
}

func (s *ReportReconciliationStore) getAccessibleProjectIDs(ctx context.Context, operator string, isAdmin bool) ([]int64, error) {
	if isAdmin {
		return nil, nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return []int64{}, nil
	}
	rows, err := s.db.Query(ctx, `
		select id
		from public.projects
		where coalesce(is_active, true) = true
		  and (
		    exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(project_operator, ''),
		        '[、,，;' || chr(10) || ']+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		    or exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(assistant_operator, ''),
		        '[、,，;' || chr(10) || ']+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		  )
		order by sort_order asc, id asc
	`, operator)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, rows.Err()
}

func (s *ReportReconciliationStore) GetAvailableReports(ctx context.Context, filter report_reconciliation.AvailableReportsFilter) ([]report_reconciliation.AvailableReportItem, error) {
	var conditions []string
	var args []any
	idx := 1

	conditions = append(conditions, "r.status = 'success'", "r.is_current = true")

	if !filter.IsAdmin {
		projectIDs, err := s.getAccessibleProjectIDs(ctx, filter.Operator, false)
		if err != nil {
			return nil, err
		}
		if len(projectIDs) == 0 {
			return []report_reconciliation.AvailableReportItem{}, nil
		}
		conditions = append(conditions, fmt.Sprintf("r.project_id = ANY($%d)", idx))
		args = append(args, projectIDs)
		idx++
	}

	if filter.ProjectID != nil && *filter.ProjectID > 0 {
		conditions = append(conditions, fmt.Sprintf("r.project_id = $%d", idx))
		args = append(args, *filter.ProjectID)
		idx++
	}
	if filter.Country != nil && *filter.Country != "" {
		conditions = append(conditions, fmt.Sprintf("r.country = $%d", idx))
		args = append(args, *filter.Country)
		idx++
	}
	if filter.Month != nil && *filter.Month != "" {
		conditions = append(conditions, fmt.Sprintf("r.report_month = $%d", idx))
		args = append(args, *filter.Month)
		idx++
	}

	where := "where " + strings.Join(conditions, " and ")
	querySQL := fmt.Sprintf(`
		select
			r.id, coalesce(r.project_name, ''), r.country, r.report_month,
			(r.summary_pdf_r2_key is not null and r.summary_pdf_r2_key != ''),
			r.summary_pdf_r2_url, r.updated_at,
			(pt3.id is not null),
			(pt4.id is not null),
			coalesce(r.status::text, 'unknown'),
			(r.transaction_file_id is not null and r.transaction_file_id != ''),
			rec.id, rec.match_rate
		from public.monthly_reports r
		left join public.monthly_report_pt3_calculation pt3 on pt3.report_id = r.id
		left join public.monthly_report_pt4_calculation pt4 on pt4.report_id = r.id
		left join lateral (
			select id, match_rate
			from public.reconciliation_records
			where report_id = r.id
			order by created_at desc
			limit 1
		) rec on true
		%s
		order by r.report_month desc, r.id desc
	`, where)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []report_reconciliation.AvailableReportItem
	for rows.Next() {
		var it report_reconciliation.AvailableReportItem
		var pdfKeyExists bool
		var updatedAt *time.Time
		var hasCsv bool
		var recIDVal *int
		var matchRate *float64

		if err := rows.Scan(
			&it.ReportID, &it.ProjectName, &it.Country, &it.ReportMonth,
			&pdfKeyExists, &it.PdfURL, &updatedAt,
			&it.Pt3CalculationComplete, &it.Pt4CalculationComplete, &it.Status,
			&hasCsv, &recIDVal, &matchRate,
		); err != nil {
			return nil, err
		}

		it.HasSummaryPdf = pdfKeyExists || (it.PdfURL != nil && *it.PdfURL != "")
		it.PdfFileMissing = !it.HasSummaryPdf
		it.HasTransactionCsv = hasCsv
		it.TransactionCsvMissing = !hasCsv
		if updatedAt != nil {
			s := updatedAt.UTC().Format(time.RFC3339Nano)
			it.PdfUploadedAt = &s
		}
		if recIDVal != nil {
			value := int64(*recIDVal)
			it.ReconcileRecordID = &value
			it.Reconciled = true
		}
		it.ReconcileMatchRate = matchRate

		items = append(items, it)
	}
	if items == nil {
		items = []report_reconciliation.AvailableReportItem{}
	}
	return items, rows.Err()
}

func (s *ReportReconciliationStore) AutoReconcile(ctx context.Context, req report_reconciliation.AutoReconcileRequest, operator string, isAdmin bool) (*report_reconciliation.ReconcileResultResponse, error) {
	var reportID, projectID int64
	var country string
	var pdfPath, pdfKey, pdfURL *string
	err := s.db.QueryRow(ctx, "select id, project_id, country, summary_pdf_file_path, summary_pdf_r2_key, summary_pdf_r2_url from public.monthly_reports where id = $1", req.ReportID).Scan(&reportID, &projectID, &country, &pdfPath, &pdfKey, &pdfURL)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, report_reconciliation.ErrReportNotFound
		}
		return nil, err
	}

	if err := s.VerifyProjectAccess(ctx, projectID, operator, isAdmin); err != nil {
		return nil, err
	}

	hasPdf := (pdfPath != nil && *pdfPath != "") ||
		(pdfKey != nil && *pdfKey != "") ||
		(pdfURL != nil && *pdfURL != "")
	if !hasPdf {
		return nil, fmt.Errorf("Report %d does not have a summary PDF uploaded to R2", req.ReportID)
	}

	pathValue := ""
	if pdfPath != nil {
		pathValue = *pdfPath
	}
	urlValue := ""
	if pdfURL != nil {
		urlValue = *pdfURL
	}
	if urlValue == "" && pdfKey != nil && *pdfKey != "" {
		urlValue = "https://pub-r2.believeboy.com/" + strings.TrimLeft(*pdfKey, "/")
	}
	pdfBytes, err := loadReportArtifact(ctx, s.httpClient, pathValue, urlValue)
	if err != nil {
		return nil, err
	}
	text, err := extractPdfText(pdfBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to extract PDF data: %w", err)
	}
	pdfCountry := country
	if req.Country != nil && strings.TrimSpace(*req.Country) != "" {
		pdfCountry = adNormalizeCountry(*req.Country)
	}
	pdfVals := extractPdfKeyValues(text, pdfCountry)
	if len(pdfVals) == 0 {
		return nil, errors.New("failed to extract reconciliation metrics from PDF")
	}

	var pt3ID int64
	var sales, refunds, incTotal, sellingFees, txFees, inboundFees, serviceFees, adCost, expTotal *float64
	pt3Query := `
		select id, income_fba_product_sales, income_fba_product_sale_refunds, income_total,
		       expense_fba_selling_fees, expense_fba_transaction_fees, expense_fba_inventory_and_inbound_services_fees,
		       expense_service_fees, expense_cost_of_advertising, expense_total
		from public.monthly_report_pt3_calculation
		where report_id = $1
	`
	err = s.db.QueryRow(ctx, pt3Query, req.ReportID).Scan(
		&pt3ID, &sales, &refunds, &incTotal,
		&sellingFees, &txFees, &inboundFees,
		&serviceFees, &adCost, &expTotal,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("Report %d does not have PT3 calculation data", req.ReportID)
		}
		return nil, err
	}

	fieldPairs := []struct {
		name   string
		dbVal  *float64
		pdfVal *float64
	}{
		{"FBA_product_sales", sales, pdfVals["FBA_product_sales"]},
		{"FBA_product_sale_refunds", refunds, pdfVals["FBA_product_sale_refunds"]},
		{"total_income", incTotal, pdfVals["total_income"]},
		{"FBA_selling_fees", sellingFees, pdfVals["FBA_selling_fees"]},
		{"FBA_transaction_fees", txFees, pdfVals["FBA_transaction_fees"]},
		{"FBA_inventory_and_inbound_services", inboundFees, pdfVals["FBA_inventory_and_inbound_services"]},
		{"service_fees", serviceFees, pdfVals["service_fees"]},
		{"advertising_costs", adCost, pdfVals["advertising_costs"]},
		{"total_expense", expTotal, pdfVals["total_expense"]},
	}

	var items []report_reconciliation.ReconcileResultItem
	matched := 0
	mismatched := 0
	missing := 0

	for _, fp := range fieldPairs {
		if fp.dbVal == nil && fp.pdfVal == nil {
			continue
		}
		var isMatch bool
		var diff, diffPct *float64

		if fp.dbVal != nil && fp.pdfVal != nil {
			d := roundReconciliation2(math.Abs(*fp.dbVal - *fp.pdfVal))
			diff = &d
			if *fp.pdfVal != 0 {
				pct := roundReconciliation2(d / math.Abs(*fp.pdfVal) * 100)
				diffPct = &pct
			}
			isMatch = d <= req.Tolerance
		} else {
			isMatch = false
		}

		if isMatch {
			matched++
		} else if fp.dbVal == nil || fp.pdfVal == nil {
			missing++
		} else {
			mismatched++
		}

		items = append(items, report_reconciliation.ReconcileResultItem{
			FieldName:         fp.name,
			DBValue:           fp.dbVal,
			PDFValue:          fp.pdfVal,
			Match:             isMatch,
			Difference:        diff,
			DifferencePercent: diffPct,
		})
	}

	totalItems := len(items)
	matchRate := 0.0
	if totalItems > 0 {
		matchRate = math.Round(float64(matched)/float64(totalItems)*1000) / 10
	}

	var dbNet, pdfNet *float64
	if incTotal != nil && expTotal != nil {
		v := *incTotal + *expTotal
		dbNet = &v
	}
	rawPDFIncome := pdfVals["total_income"]
	rawPDFExpense := pdfVals["total_expense"]
	if rawPDFIncome != nil && rawPDFExpense != nil {
		v := *rawPDFIncome + *rawPDFExpense
		pdfNet = &v
	}

	summary := report_reconciliation.ReconciliationRecordSummary{
		DBTotalIncome:   incTotal,
		DBTotalExpense:  expTotal,
		DBNetAmount:     dbNet,
		PDFTotalIncome:  rawPDFIncome,
		PDFTotalExpense: rawPDFExpense,
		PDFNetAmount:    pdfNet,
	}

	detailMap := map[string]any{
		"summary": summary,
		"items":   items,
	}
	detailBytes, err := json.Marshal(detailMap)
	if err != nil {
		return nil, fmt.Errorf("marshal reconciliation detail: %w", err)
	}

	// Upsert reconciliation_record
	upsertSQL := `
		insert into public.reconciliation_records (
			report_id, operator, mode, match_rate, matched_items, mismatched_items, missing_items, detail_json, created_at
		) values (
			$1, $2, 'auto', $3, $4, $5, $6, $7::jsonb, now()
		)
		on conflict (report_id, mode) do update set
			operator = excluded.operator,
			match_rate = excluded.match_rate,
			matched_items = excluded.matched_items,
			mismatched_items = excluded.mismatched_items,
			missing_items = excluded.missing_items,
			detail_json = excluded.detail_json
		returning id
	`
	var recordID int64
	err = s.db.QueryRow(ctx, upsertSQL, req.ReportID, operator, matchRate, matched, mismatched, missing, string(detailBytes)).Scan(&recordID)
	if err != nil {
		return nil, err
	}

	return &report_reconciliation.ReconcileResultResponse{
		Summary:         summary,
		TotalItems:      totalItems,
		MatchedItems:    matched,
		MismatchedItems: mismatched,
		MissingItems:    missing,
		MatchRate:       matchRate,
		Items:           items,
		RecordID:        &recordID,
	}, nil
}

func (s *ReportReconciliationStore) GetReconciliationHistory(ctx context.Context, filter report_reconciliation.HistoryFilter) ([]report_reconciliation.ReconciliationRecordResponse, error) {
	var conditions []string
	var args []any
	idx := 1

	if !filter.IsAdmin {
		projectIDs, err := s.getAccessibleProjectIDs(ctx, filter.Operator, false)
		if err != nil {
			return nil, err
		}
		if len(projectIDs) == 0 {
			return []report_reconciliation.ReconciliationRecordResponse{}, nil
		}
		conditions = append(conditions, fmt.Sprintf("r.project_id = ANY($%d)", idx))
		args = append(args, projectIDs)
		idx++
	}

	if filter.ProjectID != nil && *filter.ProjectID > 0 {
		conditions = append(conditions, fmt.Sprintf("r.project_id = $%d", idx))
		args = append(args, *filter.ProjectID)
		idx++
	}
	if filter.Month != nil && *filter.Month != "" {
		conditions = append(conditions, fmt.Sprintf("r.report_month = $%d", idx))
		args = append(args, *filter.Month)
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}

	querySQL := fmt.Sprintf(`
		select
			rec.id, rec.report_id, coalesce(r.project_name, ''), r.country, r.report_month,
			rec.operator, rec.mode, rec.match_rate, rec.matched_items, rec.mismatched_items,
			rec.missing_items, rec.detail_json::text, rec.created_at
		from public.reconciliation_records rec
		join public.monthly_reports r on r.id = rec.report_id
		%s
		order by rec.created_at desc
		limit $%d
	`, where, idx)
	args = append(args, limit)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var records []report_reconciliation.ReconciliationRecordResponse
	for rows.Next() {
		var it report_reconciliation.ReconciliationRecordResponse
		var detailJSON *string
		var createdAt time.Time
		if err := rows.Scan(
			&it.ID, &it.ReportID, &it.ProjectName, &it.Country, &it.ReportMonth,
			&it.Operator, &it.Mode, &it.MatchRate, &it.MatchedItems, &it.MismatchedItems,
			&it.MissingItems, &detailJSON, &createdAt,
		); err != nil {
			return nil, err
		}
		it.TotalItems = it.MatchedItems + it.MismatchedItems + it.MissingItems
		it.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		it.DetailJSON = []report_reconciliation.ReconciliationRecordItem{}

		if detailJSON != nil && *detailJSON != "" {
			var parsed struct {
				Summary report_reconciliation.ReconciliationRecordSummary `json:"summary"`
				Items   []report_reconciliation.ReconciliationRecordItem  `json:"items"`
			}
			if err := json.Unmarshal([]byte(*detailJSON), &parsed); err == nil {
				it.Summary = parsed.Summary
				it.DetailJSON = parsed.Items
			}
		}
		records = append(records, it)
	}
	if records == nil {
		records = []report_reconciliation.ReconciliationRecordResponse{}
	}
	return records, rows.Err()
}

func (s *ReportReconciliationStore) ManualReconcile(ctx context.Context, reportID *int64, excelBytes []byte, pdfBytes []byte, tolerance float64, operator string, isAdmin bool) (map[string]any, error) {
	if len(excelBytes) == 0 {
		return nil, errors.New("Excel file is empty")
	}
	if len(pdfBytes) == 0 {
		return nil, errors.New("PDF file is empty")
	}
	if len(pdfBytes) > maxReconciliationFileBytes {
		return nil, errors.New("PDF file exceeds size limit")
	}

	country := "US"
	if reportID != nil && *reportID > 0 {
		var projectID int64
		err := s.db.QueryRow(ctx, "select project_id, country from public.monthly_reports where id = $1", *reportID).Scan(&projectID, &country)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, report_reconciliation.ErrReportNotFound
			}
			return nil, err
		}
		if err := s.VerifyProjectAccess(ctx, projectID, operator, isAdmin); err != nil {
			return nil, err
		}
	}

	text, err := extractPdfText(pdfBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to extract PDF data: %w", err)
	}
	pdfVals := extractPdfKeyValues(text, country)
	if len(pdfVals) == 0 {
		return nil, errors.New("failed to extract reconciliation metrics from PDF")
	}
	excelVals, err := extractExcelKeyValues(excelBytes)
	if err != nil {
		return nil, err
	}
	if len(excelVals) == 0 {
		return nil, errors.New("failed to extract reconciliation metrics from Excel")
	}

	fields := []string{
		"advertising_costs", "FBA_inventory_and_inbound_services", "FBA_product_sale_refunds",
		"FBA_product_sales", "FBA_selling_fees", "FBA_transaction_fees", "service_fees",
		"total_expense", "total_income",
	}
	sort.Strings(fields)

	var items []map[string]any
	matched := 0
	mismatched := 0
	missing := 0

	for _, f := range fields {
		ev := excelVals[f]
		pv := pdfVals[f]
		if ev == nil && pv == nil {
			continue
		}
		var isMatch bool
		var diff, diffPct *float64
		if ev != nil && pv != nil {
			d := roundReconciliation2(math.Abs(*ev - *pv))
			diff = &d
			if *pv != 0 {
				pct := roundReconciliation2(d / math.Abs(*pv) * 100)
				diffPct = &pct
			}
			isMatch = d <= tolerance
		} else {
			isMatch = false
		}
		if isMatch {
			matched++
		} else if ev == nil || pv == nil {
			missing++
		} else {
			mismatched++
		}
		items = append(items, map[string]any{
			"field_name":         f,
			"excel_value":        reconciliationAnyValue(ev),
			"pdf_value":          reconciliationAnyValue(pv),
			"match":              isMatch,
			"difference":         reconciliationAnyValue(diff),
			"difference_percent": reconciliationAnyValue(diffPct),
		})
	}

	totalItems := len(items)
	matchRate := 0.0
	if totalItems > 0 {
		matchRate = math.Round(float64(matched)/float64(totalItems)*1000) / 10
	}

	var excelNet, pdfNet *float64
	if excelVals["total_income"] != nil && excelVals["total_expense"] != nil {
		value := *excelVals["total_income"] + *excelVals["total_expense"]
		excelNet = &value
	}
	if pdfVals["total_income"] != nil && pdfVals["total_expense"] != nil {
		value := *pdfVals["total_income"] + *pdfVals["total_expense"]
		pdfNet = &value
	}
	summary := map[string]any{
		"excel_total_income":  reconciliationAnyValue(excelVals["total_income"]),
		"excel_total_expense": reconciliationAnyValue(excelVals["total_expense"]),
		"excel_net_amount":    reconciliationAnyValue(excelNet),
		"pdf_total_income":    reconciliationAnyValue(pdfVals["total_income"]),
		"pdf_total_expense":   reconciliationAnyValue(pdfVals["total_expense"]),
		"pdf_net_amount":      reconciliationAnyValue(pdfNet),
	}

	result := map[string]any{
		"matched_items":    matched,
		"mismatched_items": mismatched,
		"missing_items":    missing,
		"total_items":      totalItems,
		"match_rate":       matchRate,
		"items":            items,
		"summary":          summary,
	}

	if reportID != nil && *reportID > 0 {
		detailBytes, err := json.Marshal(map[string]any{
			"items":   result["items"],
			"summary": result["summary"],
		})
		if err != nil {
			return nil, fmt.Errorf("marshal reconciliation detail: %w", err)
		}
		upsertSQL := `
			insert into public.reconciliation_records (
				report_id, operator, mode, match_rate, matched_items, mismatched_items, missing_items, detail_json, created_at
			) values (
				$1, $2, 'manual', $3, $4, $5, $6, $7::jsonb, now()
			)
			on conflict (report_id, mode) do update set
				operator = excluded.operator,
				match_rate = excluded.match_rate,
				matched_items = excluded.matched_items,
				mismatched_items = excluded.mismatched_items,
				missing_items = excluded.missing_items,
				detail_json = excluded.detail_json
		`
		if _, err := s.db.Exec(ctx, upsertSQL, *reportID, operator, matchRate, matched, mismatched, missing, string(detailBytes)); err != nil {
			return nil, err
		}
	}

	return result, nil
}

func (s *ReportReconciliationStore) UploadSummaryPdf(ctx context.Context, reportID int64, filename string, pdfBytes []byte, operator string, isAdmin bool) (*report_reconciliation.PDFUploadResponse, error) {
	projID, err := s.GetReportProjectID(ctx, reportID)
	if err != nil {
		return nil, err
	}
	if err := s.VerifyProjectAccess(ctx, projID, operator, isAdmin); err != nil {
		return nil, err
	}

	if len(pdfBytes) == 0 {
		return nil, errors.New("PDF file is empty")
	}
	if err := validateReconciliationUploadFilename(filename, ".pdf"); err != nil {
		return nil, err
	}
	text, err := extractPdfText(pdfBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse PDF: %w", err)
	}
	if strings.TrimSpace(text) == "" {
		return nil, errors.New("PDF contains no extractable text")
	}

	filePath, err := writeReconciliationFile(s.fileRoot, reportID, ".pdf", pdfBytes)
	if err != nil {
		return nil, err
	}
	basename := filepath.Base(filePath)
	key := fmt.Sprintf("monthly_summary_pdf/%d/%s", reportID, basename)
	url := fmt.Sprintf("https://pub-r2.believeboy.com/%s", key)

	updateSQL := `
		update public.monthly_reports
		set summary_pdf_r2_key = $1,
		    summary_pdf_r2_url = $2,
		    summary_pdf_file_id = $1,
		    summary_pdf_file_path = $3,
		    updated_at = now()
		where id = $4
	`
	if _, err := s.db.Exec(ctx, updateSQL, key, url, filePath, reportID); err != nil {
		_ = os.Remove(filePath)
		return nil, err
	}

	return &report_reconciliation.PDFUploadResponse{
		ReportID:         reportID,
		PdfFileID:        key,
		PdfFilePath:      url,
		OriginalFilename: filename,
		Size:             int64(len(pdfBytes)),
		Message:          "PDF uploaded successfully",
	}, nil
}

func (s *ReportReconciliationStore) UploadTransactionCsv(ctx context.Context, reportID int64, filename string, csvBytes []byte, op string, isAdmin bool) (*report_reconciliation.CSVUploadResponse, error) {
	projID, err := s.GetReportProjectID(ctx, reportID)
	if err != nil {
		return nil, err
	}
	if err := s.VerifyProjectAccess(ctx, projID, op, isAdmin); err != nil {
		return nil, err
	}

	if len(csvBytes) == 0 {
		return nil, errors.New("CSV file is empty")
	}
	if len(csvBytes) > maxReconciliationFileBytes {
		return nil, errors.New("CSV file exceeds size limit")
	}
	if err := validateReconciliationUploadFilename(filename, ".csv"); err != nil {
		return nil, err
	}
	if err := validateTransactionCSV(csvBytes); err != nil {
		return nil, err
	}

	filePath, err := writeReconciliationFile(s.fileRoot, reportID, ".csv", csvBytes)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("transaction_csv/%d/%s", reportID, filepath.Base(filePath))
	url := fmt.Sprintf("https://pub-r2.believeboy.com/%s", key)

	updateSQL := `
		update public.monthly_reports
		set transaction_file_id = $1,
		    transaction_file_path = $2,
		    updated_at = now()
		where id = $3
	`
	if _, err := s.db.Exec(ctx, updateSQL, key, filePath, reportID); err != nil {
		_ = os.Remove(filePath)
		return nil, err
	}

	return &report_reconciliation.CSVUploadResponse{
		ReportID:         reportID,
		CsvFileID:        key,
		CsvFilePath:      url,
		OriginalFilename: filename,
		Size:             int64(len(csvBytes)),
		Message:          "CSV uploaded successfully",
	}, nil
}

func (s *ReportReconciliationStore) ExportPt3Data(ctx context.Context, reportID int64, operator string, isAdmin bool) (string, []byte, error) {
	projID, err := s.GetReportProjectID(ctx, reportID)
	if err != nil {
		return "", nil, err
	}
	if err := s.VerifyProjectAccess(ctx, projID, operator, isAdmin); err != nil {
		return "", nil, err
	}
	var projectName, reportMonth string
	err = s.db.QueryRow(ctx, "select coalesce(project_name, ''), report_month from public.monthly_reports where id = $1", reportID).Scan(&projectName, &reportMonth)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, report_reconciliation.ErrReportNotFound
		}
		return "", nil, err
	}

	var pt3ID int64
	var sales, refunds, incTotal, sellingFees, txFees, inboundFees, serviceFees, adCost, expTotal *float64
	pt3Query := `
		select id, income_fba_product_sales, income_fba_product_sale_refunds, income_total,
		       expense_fba_selling_fees, expense_fba_transaction_fees, expense_fba_inventory_and_inbound_services_fees,
		       expense_service_fees, expense_cost_of_advertising, expense_total
		from public.monthly_report_pt3_calculation
		where report_id = $1
	`
	err = s.db.QueryRow(ctx, pt3Query, reportID).Scan(
		&pt3ID, &sales, &refunds, &incTotal,
		&sellingFees, &txFees, &inboundFees,
		&serviceFees, &adCost, &expTotal,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, report_reconciliation.ErrPt3NotFound
		}
		return "", nil, err
	}

	rows := [][]string{
		{"字段名称", "数据库值"},
		{"── 收入 ──", ""},
		{"FBA 销售额", snapshotNumberText(sales)},
		{"FBA 销售额退款", snapshotNumberText(refunds)},
		{"合计收入", snapshotNumberText(incTotal)},
		{"── 支出 ──", ""},
		{"FBA 销售佣金", snapshotNumberText(sellingFees)},
		{"FBA 派送费", snapshotNumberText(txFees)},
		{"FBA 库存和入库服务费", snapshotNumberText(inboundFees)},
		{"服务费", snapshotNumberText(serviceFees)},
		{"广告成本", snapshotNumberText(adCost)},
		{"合计费用", snapshotNumberText(expTotal)},
	}
	content, err := buildSimpleXLSX(rows)
	if err != nil {
		return "", nil, err
	}

	filename := fmt.Sprintf("%s-数据库数据-%s.xlsx", sanitizeArtifactFilenamePart(projectName), reportMonth)
	return filename, content, nil
}

func reconciliationAnyValue(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func (s *ReportReconciliationStore) DownloadPdf(ctx context.Context, reportID int64, operator string, isAdmin bool) (string, []byte, error) {
	projID, err := s.GetReportProjectID(ctx, reportID)
	if err != nil {
		return "", nil, err
	}
	if err := s.VerifyProjectAccess(ctx, projID, operator, isAdmin); err != nil {
		return "", nil, err
	}
	var projectName, reportMonth string
	var pdfKey, pdfURL *string
	var pdfPath *string
	err = s.db.QueryRow(ctx, "select coalesce(project_name, ''), report_month, summary_pdf_file_path, summary_pdf_r2_key, summary_pdf_r2_url from public.monthly_reports where id = $1", reportID).Scan(&projectName, &reportMonth, &pdfPath, &pdfKey, &pdfURL)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, report_reconciliation.ErrReportNotFound
		}
		return "", nil, err
	}
	if (pdfPath == nil || *pdfPath == "") && (pdfKey == nil || *pdfKey == "") && (pdfURL == nil || *pdfURL == "") {
		return "", nil, errors.New("PDF not found in R2")
	}
	pathValue := ""
	if pdfPath != nil {
		pathValue = *pdfPath
	}
	urlValue := ""
	if pdfURL != nil {
		urlValue = *pdfURL
	}
	if urlValue == "" && pdfKey != nil && *pdfKey != "" {
		urlValue = "https://pub-r2.believeboy.com/" + strings.TrimLeft(*pdfKey, "/")
	}
	content, err := loadReportArtifact(ctx, s.httpClient, pathValue, urlValue)
	if err != nil {
		return "", nil, err
	}
	filename := fmt.Sprintf("%s-结算汇总-%s.pdf", sanitizeArtifactFilenamePart(projectName), reportMonth)
	return filename, content, nil
}

func (s *ReportReconciliationStore) DownloadCsv(ctx context.Context, reportID int64, op string, isAdmin bool) (string, []byte, error) {
	var projectID int64
	var projectName, reportMonth string
	var csvFileID *string
	var csvPath *string
	err := s.db.QueryRow(ctx, "select project_id, coalesce(project_name, ''), report_month, transaction_file_id, transaction_file_path from public.monthly_reports where id = $1", reportID).Scan(&projectID, &projectName, &reportMonth, &csvFileID, &csvPath)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, report_reconciliation.ErrReportNotFound
		}
		return "", nil, err
	}
	if err := s.VerifyProjectAccess(ctx, projectID, op, isAdmin); err != nil {
		return "", nil, err
	}
	if (csvFileID == nil || *csvFileID == "") && (csvPath == nil || *csvPath == "") {
		return "", nil, errors.New("CSV not found")
	}
	pathValue := ""
	if csvPath != nil {
		pathValue = *csvPath
	}
	urlValue := ""
	if csvFileID != nil {
		if strings.HasPrefix(*csvFileID, "http://") || strings.HasPrefix(*csvFileID, "https://") {
			urlValue = *csvFileID
		} else if *csvFileID != "" {
			urlValue = "https://pub-r2.believeboy.com/" + strings.TrimLeft(*csvFileID, "/")
		}
	}
	content, err := loadReportArtifact(ctx, s.httpClient, pathValue, urlValue)
	if err != nil {
		return "", nil, err
	}
	filename := fmt.Sprintf("%s-交易报表-%s.csv", sanitizeArtifactFilenamePart(projectName), reportMonth)
	return filename, content, nil
}

func extractPdfText(pdfBytes []byte) (string, error) {
	if !bytes.HasPrefix(bytes.TrimSpace(pdfBytes), []byte("%PDF")) {
		return "", errors.New("invalid PDF file")
	}
	r, err := pdf.NewReader(bytes.NewReader(pdfBytes), int64(len(pdfBytes)))
	if err != nil {
		return "", err
	}
	plain, err := r.GetPlainText()
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	_, err = buf.ReadFrom(plain)
	return buf.String(), err
}

func parsePdfNumber(valStr string, country string) (float64, error) {
	valStr = strings.TrimSpace(valStr)
	if valStr == "" {
		return 0, errors.New("empty PDF number")
	}
	negative := false
	if strings.HasPrefix(valStr, "(") && strings.HasSuffix(valStr, ")") {
		negative = true
		valStr = strings.TrimSuffix(strings.TrimPrefix(valStr, "("), ")")
	}
	valStr = strings.ReplaceAll(valStr, "\u00a0", "")
	valStr = strings.ReplaceAll(valStr, " ", "")
	if strings.HasPrefix(valStr, "-") {
		negative = true
		valStr = valStr[1:]
	}
	valStr = strings.NewReplacer("US$", "", "$", "", "USD", "", "EUR", "", "€", "", "GBP", "", "£", "").Replace(valStr)
	switch strings.ToUpper(country) {
	case "DE", "FR", "IT", "ES", "NL", "BE":
		valStr = strings.ReplaceAll(valStr, ".", "")
		valStr = strings.ReplaceAll(valStr, ",", ".")
	default:
		valStr = strings.ReplaceAll(valStr, ",", "")
	}
	val, err := strconv.ParseFloat(valStr, 64)
	if err != nil {
		return 0, err
	}
	if negative {
		val = -val
	}
	return val, nil
}

func extractPdfKeyValues(text string, country string) map[string]*float64 {
	patterns := map[string][]string{
		"FBA_product_sales": {
			`(?i)FBA product sales\s*:?\s*((?:US\$|\$|USD|€|£)?\s*[\d\s.,]+)`,
			`(?i)Product Sales\s*:?\s*((?:US\$|\$|USD|€|£)?\s*[\d\s.,]+)`,
			`(?i)Verkäufe mit Versand durch Amazon\s*:?\s*((?:€|EUR)?\s*[\d\s.,]+)`,
		},
		"FBA_product_sale_refunds": {
			`(?i)FBA product sale refunds\s*:?\s*((?:US\$|\$|USD|€|£)?\s*-?[\d\s.,]+)`,
			`(?i)Erstattungen für durch Amazon versandte Artikel\s*:?\s*((?:€|EUR)?\s*-?[\d\s.,]+)`,
		},
		"FBA_selling_fees": {
			`(?i)FBA selling fees\s*:?\s*((?:US\$|\$|USD|€|£)?\s*-?[\d\s.,]+)`,
			`(?i)Verkaufsgebühren Versand durch Amazon\s*:?\s*((?:€|EUR)?\s*-?[\d\s.,]+)`,
		},
		"FBA_transaction_fees": {
			`(?i)FBA transaction fees\s*:?\s*((?:US\$|\$|USD|€|£)?\s*-?[\d\s.,]+)`,
			`(?i)Transaktionsgebühren Versand durch Amazon\s*:?\s*((?:€|EUR)?\s*-?[\d\s.,]+)`,
		},
		"FBA_inventory_and_inbound_services": {
			`(?i)FBA inventory and inbound services fees\s*:?\s*((?:US\$|\$|USD|€|£)?\s*-?[\d\s.,]+)`,
			`(?i)Lagerbestands- und Service-Gebühren für Versand durch Amazon\s*:?\s*((?:€|EUR)?\s*-?[\d\s.,]+)`,
		},
		"service_fees": {
			`(?i)Service fees\s*:?\s*((?:US\$|\$|USD|€|£)?\s*-?[\d\s.,]+)`,
			`(?i)Servicegebühren\s*:?\s*((?:€|EUR)?\s*-?[\d\s.,]+)`,
		},
		"advertising_costs": {
			`(?i)Cost of Advertising\s*:?\s*((?:US\$|\$|USD|€|£)?\s*-?[\d\s.,]+)`,
			`(?i)Werbekosten\s*:?\s*((?:€|EUR)?\s*-?[\d\s.,]+)`,
		},
		"total_income": {
			`(?i)Total\s+Income\s*:?\s*((?:US\$|\$|USD|€|£)?\s*[\d\s.,]+)`,
			`(?i)Income\s*:?\s*((?:US\$|\$|USD|€|£)?\s*[\d\s.,]+)`,
			`(?i)Total\s+Revenue\s*:?\s*((?:US\$|\$|USD|€|£)?\s*[\d\s.,]+)`,
			`(?i)Gesamt\s*Einnahmen\s*:?\s*((?:€|EUR)?\s*[\d\s.,]+)`,
		},
		"total_expense": {
			`(?i)Total\s+Expenses\s*:?\s*((?:US\$|\$|USD|€|£)?\s*-?[\d\s.,]+)`,
			`(?i)Expenses\s*:?\s*((?:US\$|\$|USD|€|£)?\s*-?[\d\s.,]+)`,
			`(?i)Gesamt\s*Ausgaben\s*:?\s*((?:€|EUR)?\s*-?[\d\s.,]+)`,
		},
	}

	results := make(map[string]*float64)
	for key, regexList := range patterns {
		for _, pat := range regexList {
			re := regexp.MustCompile(pat)
			m := re.FindStringSubmatch(text)
			if len(m) > 1 {
				if num, err := parsePdfNumber(m[1], country); err == nil {
					results[key] = &num
					break
				}
			}
		}
	}
	return results
}

func extractExcelKeyValues(excelBytes []byte) (map[string]*float64, error) {
	cells, err := xlsxSheetCells(excelBytes, "报表核算")
	if err != nil {
		return nil, err
	}

	cellMap := map[string]string{
		"FBA_product_sales":                  "C4",
		"FBA_product_sale_refunds":           "C5",
		"FBA_selling_fees":                   "H3",
		"FBA_transaction_fees":               "H5",
		"FBA_inventory_and_inbound_services": "H9",
		"service_fees":                       "H13",
		"advertising_costs":                  "H16",
		"total_income":                       "C23",
		"total_expense":                      "H23",
	}

	results := make(map[string]*float64)
	for field, cellRef := range cellMap {
		raw, ok := cells[cellRef]
		if !ok || strings.TrimSpace(raw) == "" {
			continue
		}
		value, err := parseAdNumber(raw, false)
		if err != nil {
			return nil, fmt.Errorf("invalid value in Excel cell %s: %w", cellRef, err)
		}
		results[field] = &value
	}
	return results, nil
}

func validateReconciliationUploadFilename(filename, expectedExtension string) error {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return errors.New("Missing filename")
	}
	if filepath.IsAbs(filename) || strings.Contains(filename, `\`) || strings.Contains(filename, "/") || strings.Contains(filename, "..") {
		return errors.New("invalid filename path")
	}
	if filepath.Base(filename) != filename {
		return errors.New("invalid filename path")
	}
	if strings.ToLower(filepath.Ext(filename)) != expectedExtension {
		return fmt.Errorf("Only %s files are allowed", strings.ToUpper(strings.TrimPrefix(expectedExtension, ".")))
	}
	return nil
}
