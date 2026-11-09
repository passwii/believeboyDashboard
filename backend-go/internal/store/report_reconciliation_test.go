package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/report_reconciliation"
)

func TestReportReconciliationStoreAvailableReports(t *testing.T) {
	ctx := context.Background()
	now := time.Now()

	foundDB := &fakeDB{
		rows: &fakeRows{
			batches: [][]any{
				{
					int64(1), "Project Alpha", "US", "2026-05",
					true, stringPtr("https://r2/summary.pdf"), &now,
					true, true, "success",
					true, intPointer(10), float64Pointer(100.0),
				},
			},
		},
	}
	store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: foundDB})

	reports, err := store.GetAvailableReports(ctx, report_reconciliation.AvailableReportsFilter{IsAdmin: true})
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if len(reports) != 1 {
		t.Fatalf("expected 1 report, got %d", len(reports))
	}
	if reports[0].ReportID != 1 || !reports[0].HasSummaryPdf || !reports[0].Pt3CalculationComplete {
		t.Fatalf("unexpected available report: %+v", reports[0])
	}
}

func TestReportReconciliationAvailableAndHistoryFilterByAccessibleProjects(t *testing.T) {
	ctx := context.Background()
	db := &fakeDB{
		rowsQueueQuery: []Rows{
			&fakeRows{batches: [][]any{{int64(7)}}},
			&fakeRows{},
			&fakeRows{batches: [][]any{{int64(7)}}},
			&fakeRows{},
		},
	}
	store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: db})

	if _, err := store.GetAvailableReports(ctx, report_reconciliation.AvailableReportsFilter{Operator: "alice"}); err != nil {
		t.Fatalf("GetAvailableReports() error = %v", err)
	}
	if _, err := store.GetReconciliationHistory(ctx, report_reconciliation.HistoryFilter{Operator: "alice"}); err != nil {
		t.Fatalf("GetReconciliationHistory() error = %v", err)
	}
	if len(db.queryCalls) != 4 {
		t.Fatalf("Query calls = %d, want 4", len(db.queryCalls))
	}
	if !strings.Contains(db.queryCalls[1].sql, "r.project_id = ANY(") || !strings.Contains(db.queryCalls[3].sql, "r.project_id = ANY(") {
		t.Fatalf("visible-project filter missing: available=%q history=%q", db.queryCalls[1].sql, db.queryCalls[3].sql)
	}
}

func TestReportReconciliationStoreAutoReconcile(t *testing.T) {
	ctx := context.Background()
	pdfPath := writeReconciliationTestPDF(t, reconciliationMetricLines(
		map[string]string{"FBA_product_sales": "101.00", "total_income": "99.00"},
	))

	val100 := 100.0
	val0 := 0.0
	reportRow := fakeRow{values: []any{int64(1), int64(1), "US", &pdfPath, nil, nil}}
	pt3Row := fakeRow{values: []any{
		int64(1), &val100, &val0, &val100,
		&val0, &val0, &val0,
		&val0, &val0, &val0,
	}}
	upsertRow := fakeRow{values: []any{int64(101)}}
	db := &fakeDB{rowsQueue: []pgx.Row{reportRow, pt3Row, upsertRow}}
	store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: db})

	res, err := store.AutoReconcile(ctx, report_reconciliation.AutoReconcileRequest{ReportID: 1, Tolerance: 0.01}, "test_op", true)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if res.TotalItems != 9 || res.MatchedItems != 7 || res.MismatchedItems != 2 || res.MissingItems != 0 {
		t.Fatalf("unexpected reconcile result: %+v", res)
	}
	if res.MatchRate != 77.8 || res.MatchRate == 100 {
		t.Fatalf("match rate = %v, want real 77.8", res.MatchRate)
	}
	if res.Summary.PDFTotalIncome == nil || *res.Summary.PDFTotalIncome != 99 {
		t.Fatalf("PDF summary was not read from the document: %+v", res.Summary)
	}
	if res.RecordID == nil || *res.RecordID != 101 {
		t.Fatalf("record id = %v, want 101", res.RecordID)
	}
}

func TestReportReconciliationAutoParseFailureDoesNotWrite(t *testing.T) {
	ctx := context.Background()
	badPath := writeReconciliationTestBytes(t, []byte("not a pdf"))
	val := 100.0
	reportRow := fakeRow{values: []any{int64(1), int64(1), "US", &badPath, nil, nil}}
	pt3Row := fakeRow{values: []any{
		int64(1), &val, &val, &val,
		&val, &val, &val,
		&val, &val, &val,
	}}
	db := &fakeDB{rowsQueue: []pgx.Row{reportRow, pt3Row, fakeRow{values: []any{int64(999)}}}}
	store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: db})

	if _, err := store.AutoReconcile(ctx, report_reconciliation.AutoReconcileRequest{ReportID: 1, Tolerance: 0.01}, "op", true); err == nil {
		t.Fatal("AutoReconcile() succeeded for malformed PDF")
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow calls = %d, want only the report lookup before parse failure", len(db.queryRowCalls))
	}
}

func TestReportReconciliationManualUsesRealExcelAndPDFValues(t *testing.T) {
	excelBytes := reconciliationTestWorkbook(t, map[string]string{
		"C4": "100", "C5": "0", "H3": "0", "H5": "0", "H9": "0",
		"H13": "0", "H16": "0", "C23": "100", "H23": "0",
	})
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(
		map[string]string{"FBA_product_sales": "101.00", "total_income": "99.00"},
	))
	store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: &fakeDB{}})

	result, err := store.ManualReconcile(context.Background(), nil, excelBytes, pdfBytes, 0.01, "manual", true)
	if err != nil {
		t.Fatalf("ManualReconcile() error = %v", err)
	}
	if result["total_items"] != 9 || result["matched_items"] != 7 || result["mismatched_items"] != 2 || result["missing_items"] != 0 {
		t.Fatalf("unexpected manual result: %#v", result)
	}
	if result["match_rate"] != 77.8 {
		t.Fatalf("match_rate = %v, want 77.8", result["match_rate"])
	}
	items := result["items"].([]map[string]any)
	foundRealExcelValue := false
	for _, item := range items {
		if item["field_name"] == "FBA_product_sales" {
			foundRealExcelValue = item["excel_value"] == 100.0 && item["pdf_value"] == 101.0
		}
	}
	if !foundRealExcelValue {
		t.Fatalf("manual items did not compare parsed values: %#v", items)
	}
}

func TestReportReconciliationManualInvalidExcelDoesNotWrite(t *testing.T) {
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(nil))
	writeDB := &fakeWriteDB{fakeDB: &fakeDB{}}
	store := NewReportReconciliationStore(writeDB)

	if _, err := store.ManualReconcile(context.Background(), nil, []byte("not an xlsx"), pdfBytes, 0.01, "manual", true); err == nil {
		t.Fatal("ManualReconcile() succeeded for malformed Excel")
	}
	if len(writeDB.execCalls) != 0 {
		t.Fatalf("malformed Excel wrote %d records", len(writeDB.execCalls))
	}
}

func TestReportReconciliationReportIDEndpointsEnforceProjectAccess(t *testing.T) {
	validPDF := makeReconciliationPDF(reconciliationMetricLines(nil))
	validExcel := reconciliationTestWorkbook(t, map[string]string{"C4": "100", "C23": "100"})
	validCSV := []byte("date,order_id,amount\n2026-10-01,A,1\n")
	project := int64(7)
	operators := fakeRow{values: []any{"someone_else", "assistant"}}
	tests := []struct {
		name      string
		firstRows []pgx.Row
		call      func(*ReportReconciliationStore) error
	}{
		{
			name:      "auto",
			firstRows: []pgx.Row{fakeRow{values: []any{int64(1), project, "US", nil, nil, nil}}, operators},
			call: func(store *ReportReconciliationStore) error {
				_, err := store.AutoReconcile(context.Background(), report_reconciliation.AutoReconcileRequest{ReportID: 1, Tolerance: 0.01}, "alice", false)
				return err
			},
		},
		{
			name:      "manual",
			firstRows: []pgx.Row{fakeRow{values: []any{project, "US"}}, operators},
			call: func(store *ReportReconciliationStore) error {
				reportID := int64(1)
				_, err := store.ManualReconcile(context.Background(), &reportID, validExcel, validPDF, 0.01, "alice", false)
				return err
			},
		},
		{
			name:      "upload pdf",
			firstRows: []pgx.Row{fakeRow{values: []any{project}}, operators},
			call: func(store *ReportReconciliationStore) error {
				_, err := store.UploadSummaryPdf(context.Background(), 1, "summary.pdf", validPDF, "alice", false)
				return err
			},
		},
		{
			name:      "upload csv",
			firstRows: []pgx.Row{fakeRow{values: []any{project}}, operators},
			call: func(store *ReportReconciliationStore) error {
				_, err := store.UploadTransactionCsv(context.Background(), 1, "tx.csv", validCSV, "alice", false)
				return err
			},
		},
		{
			name:      "export pt3",
			firstRows: []pgx.Row{fakeRow{values: []any{project}}, operators},
			call: func(store *ReportReconciliationStore) error {
				_, _, err := store.ExportPt3Data(context.Background(), 1, "alice", false)
				return err
			},
		},
		{
			name:      "download pdf",
			firstRows: []pgx.Row{fakeRow{values: []any{project}}, operators},
			call: func(store *ReportReconciliationStore) error {
				_, _, err := store.DownloadPdf(context.Background(), 1, "alice", false)
				return err
			},
		},
		{
			name:      "download csv",
			firstRows: []pgx.Row{fakeRow{values: []any{project, "Project", "2026-10", stringPtr("key"), nil}}, operators},
			call: func(store *ReportReconciliationStore) error {
				_, _, err := store.DownloadCsv(context.Background(), 1, "alice", false)
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := &fakeDB{rowsQueue: test.firstRows}
			store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: db})
			err := test.call(store)
			if !errors.Is(err, report_reconciliation.ErrProjectForbidden) {
				t.Fatalf("error = %v, want ErrProjectForbidden", err)
			}
			if len(db.queryRowCalls) != 2 || !strings.Contains(db.queryRowCalls[1].sql, "project_operator") {
				t.Fatalf("project access was not verified before work: %#v", db.queryRowCalls)
			}
		})
	}
}

func TestReportReconciliationUploadEndpointsVerifyAccessBeforeParsing(t *testing.T) {
	project := int64(7)
	operators := fakeRow{values: []any{"someone_else", "assistant"}}
	tests := []struct {
		name string
		call func(*ReportReconciliationStore) error
	}{
		{
			name: "upload pdf",
			call: func(store *ReportReconciliationStore) error {
				_, err := store.UploadSummaryPdf(context.Background(), 1, "summary.pdf", []byte("not a pdf"), "alice", false)
				return err
			},
		},
		{
			name: "upload csv",
			call: func(store *ReportReconciliationStore) error {
				_, err := store.UploadTransactionCsv(context.Background(), 1, "tx.csv", []byte("not a csv"), "alice", false)
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := &fakeDB{rowsQueue: []pgx.Row{
				fakeRow{values: []any{project}},
				operators,
			}}
			store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: db})
			if err := test.call(store); !errors.Is(err, report_reconciliation.ErrProjectForbidden) {
				t.Fatalf("error = %v, want ErrProjectForbidden before file parsing", err)
			}
			if len(db.queryRowCalls) != 2 || !strings.Contains(db.queryRowCalls[1].sql, "project_operator") {
				t.Fatalf("project access was not verified before parsing: %#v", db.queryRowCalls)
			}
		})
	}
}

func TestReportReconciliationReportIDEndpointsReturnNotFound(t *testing.T) {
	validPDF := makeReconciliationPDF(reconciliationMetricLines(nil))
	validExcel := reconciliationTestWorkbook(t, map[string]string{"C4": "100", "C23": "100"})
	validCSV := []byte("date,order_id,amount\n2026-10-01,A,1\n")
	missing := fakeRow{err: pgx.ErrNoRows}
	tests := []struct {
		name string
		call func(*ReportReconciliationStore) error
	}{
		{"auto", func(store *ReportReconciliationStore) error {
			_, err := store.AutoReconcile(context.Background(), report_reconciliation.AutoReconcileRequest{ReportID: 999, Tolerance: 0.01}, "alice", false)
			return err
		}},
		{"manual", func(store *ReportReconciliationStore) error {
			reportID := int64(999)
			_, err := store.ManualReconcile(context.Background(), &reportID, validExcel, validPDF, 0.01, "alice", false)
			return err
		}},
		{"upload pdf", func(store *ReportReconciliationStore) error {
			_, err := store.UploadSummaryPdf(context.Background(), 999, "summary.pdf", validPDF, "alice", false)
			return err
		}},
		{"upload csv", func(store *ReportReconciliationStore) error {
			_, err := store.UploadTransactionCsv(context.Background(), 999, "tx.csv", validCSV, "alice", false)
			return err
		}},
		{"export pt3", func(store *ReportReconciliationStore) error {
			_, _, err := store.ExportPt3Data(context.Background(), 999, "alice", false)
			return err
		}},
		{"download pdf", func(store *ReportReconciliationStore) error {
			_, _, err := store.DownloadPdf(context.Background(), 999, "alice", false)
			return err
		}},
		{"download csv", func(store *ReportReconciliationStore) error {
			_, _, err := store.DownloadCsv(context.Background(), 999, "alice", false)
			return err
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{missing}}})
			if err := test.call(store); !errors.Is(err, report_reconciliation.ErrReportNotFound) {
				t.Fatalf("error = %v, want ErrReportNotFound", err)
			}
		})
	}
}

func TestReportReconciliationUploadAndDownloadRealPDF(t *testing.T) {
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(nil))
	projectRow := fakeRow{values: []any{int64(7)}}
	uploadDB := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{projectRow}}}
	store := &ReportReconciliationStore{
		db:         uploadDB,
		fileRoot:   t.TempDir(),
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
	if _, err := store.UploadSummaryPdf(context.Background(), 1, "summary.pdf", pdfBytes, "admin", true); err != nil {
		t.Fatalf("UploadSummaryPdf() error = %v", err)
	}
	if len(uploadDB.execCalls) != 1 {
		t.Fatalf("upload Exec calls = %d, want 1", len(uploadDB.execCalls))
	}
	localPath, ok := uploadDB.execCalls[0].args[2].(string)
	if !ok || localPath == "" {
		t.Fatalf("upload did not persist a local path: %#v", uploadDB.execCalls[0].args)
	}
	key := stringPtr("summary-key")
	downloadDB := &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{int64(7)}},
		fakeRow{values: []any{"Project Alpha", "2026-10", &localPath, key, nil}},
	}}
	downloadStore := NewReportReconciliationStore(&fakeWriteDB{fakeDB: downloadDB})
	_, downloaded, err := downloadStore.DownloadPdf(context.Background(), 1, "admin", true)
	if err != nil {
		t.Fatalf("DownloadPdf() error = %v", err)
	}
	if !bytes.Equal(downloaded, pdfBytes) {
		t.Fatal("DownloadPdf() did not return the uploaded bytes")
	}
}

func TestReportReconciliationExportPt3BuildsRealXLSX(t *testing.T) {
	val := 123.45
	db := &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{int64(7)}},
		fakeRow{values: []any{"Project Alpha", "2026-10"}},
		fakeRow{values: []any{
			int64(1), &val, &val, &val,
			&val, &val, &val,
			&val, &val, &val,
		}},
	}}
	store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: db})
	filename, content, err := store.ExportPt3Data(context.Background(), 1, "admin", true)
	if err != nil {
		t.Fatalf("ExportPt3Data() error = %v", err)
	}
	if !strings.HasSuffix(filename, ".xlsx") {
		t.Fatalf("filename = %q, want xlsx", filename)
	}
	workbook, err := parseXLSXWorkbook(content)
	if err != nil {
		t.Fatalf("exported workbook is not valid xlsx: %v", err)
	}
	if len(workbook.Sheets) != 1 || workbook.Sheets[0].Name != "数据库数据" {
		t.Fatalf("unexpected workbook sheets: %#v", workbook.Sheets)
	}
}

func reconciliationMetricLines(overrides map[string]string) []string {
	values := map[string]string{
		"FBA_product_sales":                  "100.00",
		"FBA_product_sale_refunds":           "0.00",
		"FBA_selling_fees":                   "0.00",
		"FBA_transaction_fees":               "0.00",
		"FBA_inventory_and_inbound_services": "0.00",
		"service_fees":                       "0.00",
		"advertising_costs":                  "0.00",
		"total_income":                       "100.00",
		"total_expense":                      "0.00",
	}
	for key, value := range overrides {
		values[key] = value
	}
	labels := map[string]string{
		"FBA_product_sales":                  "FBA product sales",
		"FBA_product_sale_refunds":           "FBA product sale refunds",
		"FBA_selling_fees":                   "FBA selling fees",
		"FBA_transaction_fees":               "FBA transaction fees",
		"FBA_inventory_and_inbound_services": "FBA inventory and inbound services fees",
		"service_fees":                       "Service fees",
		"advertising_costs":                  "Cost of Advertising",
		"total_income":                       "Total Income",
		"total_expense":                      "Total Expenses",
	}
	order := []string{
		"FBA_product_sales", "FBA_product_sale_refunds", "FBA_selling_fees",
		"FBA_transaction_fees", "FBA_inventory_and_inbound_services", "service_fees",
		"advertising_costs", "total_income", "total_expense",
	}
	lines := make([]string, 0, len(order))
	for _, key := range order {
		lines = append(lines, labels[key]+" "+values[key])
	}
	return lines
}

func writeReconciliationTestPDF(t *testing.T, lines []string) string {
	t.Helper()
	return writeReconciliationTestBytes(t, makeReconciliationPDF(lines))
}

func writeReconciliationTestBytes(t *testing.T, content []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "report.bin")
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write test file: %v", err)
	}
	return path
}

func makeReconciliationPDF(lines []string) []byte {
	var stream strings.Builder
	y := 760.0
	for _, line := range lines {
		fmt.Fprintf(&stream, "BT /F1 9 Tf 1 0 0 1 24 %.1f Tm (%s) Tj ET\n", y, escapePDFText(line))
		y -= 18
	}
	objects := []string{
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
		fmt.Sprintf("4 0 obj\n<< /Length %d >>\nstream\n%sendstream\nendobj\n", len(stream.String()), stream.String()),
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
	}
	var output bytes.Buffer
	output.WriteString("%PDF-1.4\n")
	offsets := make([]int, 0, len(objects))
	for _, object := range objects {
		offsets = append(offsets, output.Len())
		output.WriteString(object)
	}
	xrefOffset := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&output, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xrefOffset)
	return output.Bytes()
}

func escapePDFText(value string) string {
	return strings.NewReplacer(`\`, `\\`, `(`, `\(`, `)`, `\)`).Replace(value)
}

func reconciliationTestWorkbook(t *testing.T, cells map[string]string) []byte {
	t.Helper()
	rows := make([][]string, 23)
	for i := range rows {
		rows[i] = make([]string, 8)
	}
	for ref, value := range cells {
		column := xlsxColumnNumber(ref)
		rowText := ref[strings.IndexFunc(ref, func(r rune) bool { return r >= '0' && r <= '9' }):]
		rowNumber, err := strconv.Atoi(rowText)
		if err != nil || column <= 0 || rowNumber <= 0 || rowNumber > len(rows) || column > len(rows[rowNumber-1]) {
			t.Fatalf("invalid test cell %s", ref)
		}
		rows[rowNumber-1][column-1] = value
	}
	content, err := buildSimpleXLSXSheet("报表核算", rows)
	if err != nil {
		t.Fatalf("buildSimpleXLSXSheet() error = %v", err)
	}
	return content
}

func float64Pointer(value float64) *float64 { return &value }

func intPointer(value int) *int { return &value }

func TestReportReconciliationStoreIntegration(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}

	projectName := fmt.Sprintf("stage4-reconciliation-integration-%d", time.Now().UnixNano())
	var projectID int64
	if err := pool.QueryRow(ctx, `
		insert into public.projects (project_name, sort_order, project_operator, commission_rate)
		values ($1, 9999, 'alice', 0.15)
		returning id
	`, projectName).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from public.projects where id = $1`, projectID)
	})

	pdfPath := writeReconciliationTestPDF(t, reconciliationMetricLines(
		map[string]string{"FBA_product_sales": "101.00", "total_income": "99.00"},
	))
	var reportID int64
	if err := pool.QueryRow(ctx, `
		insert into public.monthly_reports (
			project_id, project_name, report_month, transaction_file_id,
			transaction_file_path, status, summary_pdf_file_path
		) values (
			$1, $2, '2026-11', '', '',
			'success'::jobstatus, $3
		)
		returning id
	`, projectID, projectName, pdfPath).Scan(&reportID); err != nil {
		t.Fatalf("insert monthly report: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from public.reconciliation_records where report_id = $1`, reportID)
		_, _ = pool.Exec(context.Background(), `delete from public.monthly_report_pt3_calculation where report_id = $1`, reportID)
		_, _ = pool.Exec(context.Background(), `delete from public.monthly_reports where id = $1`, reportID)
	})

	if _, err := pool.Exec(ctx, `
		insert into public.monthly_report_pt3_calculation (
			report_id, report_month, income_fba_product_sales, income_fba_product_sale_refunds,
			income_total, expense_fba_selling_fees, expense_fba_transaction_fees,
			expense_fba_inventory_and_inbound_services_fees, expense_service_fees,
			expense_cost_of_advertising, expense_total
		) values ($1, '2026-11', 100, 0, 100, 0, 0, 0, 0, 0, 0)
	`, reportID); err != nil {
		t.Fatalf("insert PT3: %v", err)
	}

	store := NewReportReconciliationStore(NewPGXDB(pool))
	reports, err := store.GetAvailableReports(ctx, report_reconciliation.AvailableReportsFilter{
		ProjectID: &projectID,
		IsAdmin:   true,
	})
	if err != nil {
		t.Fatalf("GetAvailableReports() error = %v", err)
	}
	if len(reports) != 1 || !reports[0].Pt3CalculationComplete {
		t.Fatalf("unexpected available reports: %#v", reports)
	}

	result, err := store.AutoReconcile(ctx, report_reconciliation.AutoReconcileRequest{
		ReportID:  reportID,
		Tolerance: 0.01,
	}, "alice", true)
	if err != nil {
		t.Fatalf("AutoReconcile() error = %v", err)
	}
	if result.MatchedItems != 7 || result.MismatchedItems != 2 || result.MatchRate != 77.8 {
		t.Fatalf("unexpected reconciliation result: %#v", result)
	}

	var persistedRate float64
	if err := pool.QueryRow(ctx, `
		select match_rate
		from public.reconciliation_records
		where report_id = $1 and mode = 'auto'
	`, reportID).Scan(&persistedRate); err != nil {
		t.Fatalf("query reconciliation record: %v", err)
	}
	if persistedRate != 77.8 {
		t.Fatalf("persisted match_rate = %v", persistedRate)
	}
	history, err := store.GetReconciliationHistory(ctx, report_reconciliation.HistoryFilter{
		ProjectID: &projectID,
		Limit:     10,
		IsAdmin:   true,
	})
	if err != nil {
		t.Fatalf("GetReconciliationHistory() error = %v", err)
	}
	if len(history) != 1 || history[0].MatchRate != 77.8 || len(history[0].DetailJSON) != 9 {
		t.Fatalf("unexpected reconciliation history: %#v", history)
	}

	_, exportBytes, err := store.ExportPt3Data(ctx, reportID, "alice", true)
	if err != nil {
		t.Fatalf("ExportPt3Data() error = %v", err)
	}
	if _, err := parseXLSXWorkbook(exportBytes); err != nil {
		t.Fatalf("exported PT3 is not a valid xlsx: %v", err)
	}

	store.fileRoot = t.TempDir()
	uploadedPDF := makeReconciliationPDF(reconciliationMetricLines(nil))
	if _, err := store.UploadSummaryPdf(ctx, reportID, "summary.pdf", uploadedPDF, "alice", true); err != nil {
		t.Fatalf("UploadSummaryPdf() error = %v", err)
	}
	_, downloadedPDF, err := store.DownloadPdf(ctx, reportID, "alice", true)
	if err != nil {
		t.Fatalf("DownloadPdf() error = %v", err)
	}
	if !bytes.Equal(downloadedPDF, uploadedPDF) {
		t.Fatal("DownloadPdf() did not return uploaded bytes")
	}

	transactionCSV := []byte("date,order_id,amount\n2026-11-01,A,10.00\n")
	if _, err := store.UploadTransactionCsv(ctx, reportID, "transactions.csv", transactionCSV, "alice", true); err != nil {
		t.Fatalf("UploadTransactionCsv() error = %v", err)
	}
	_, downloadedCSV, err := store.DownloadCsv(ctx, reportID, "alice", true)
	if err != nil {
		t.Fatalf("DownloadCsv() error = %v", err)
	}
	if !bytes.Equal(downloadedCSV, transactionCSV) {
		t.Fatal("DownloadCsv() did not return uploaded bytes")
	}
}
