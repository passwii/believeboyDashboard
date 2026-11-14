package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/report_reconciliation"
)

type reconciliationObjectPut struct {
	key         string
	data        []byte
	contentType string
}

type fakeReconciliationBlobs struct {
	puts            []reconciliationObjectPut
	deletedKeys     []string
	publicURLPrefix string
	putErr          error
}

func (blobs *fakeReconciliationBlobs) Put(
	_ context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	blobs.puts = append(blobs.puts, reconciliationObjectPut{
		key:         key,
		data:        append([]byte(nil), data...),
		contentType: contentType,
	})
	if blobs.putErr != nil {
		return "", blobs.putErr
	}
	return blobs.publicURLPrefix + "/" + key, nil
}

func (blobs *fakeReconciliationBlobs) Delete(_ context.Context, key string) error {
	blobs.deletedKeys = append(blobs.deletedKeys, key)
	return nil
}

func (blobs *fakeReconciliationBlobs) PublicURL(key string) (string, error) {
	if blobs.publicURLPrefix == "" {
		return "", errors.New("public URL is not configured")
	}
	return blobs.publicURLPrefix + "/" + key, nil
}

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
	blobs := &fakeReconciliationBlobs{publicURLPrefix: "https://cdn.example.com"}
	store := NewReportReconciliationStoreWithOptions(uploadDB, ReportReconciliationStoreOptions{
		Blobs: blobs,
	})
	store.fileRoot = t.TempDir()
	store.httpClient = &http.Client{Timeout: 5 * time.Second}
	uploaded, err := store.UploadSummaryPdf(context.Background(), 1, "summary.pdf", pdfBytes, "admin", true)
	if err != nil {
		t.Fatalf("UploadSummaryPdf() error = %v", err)
	}
	if len(blobs.puts) != 1 || uploaded.PdfFilePath != "https://cdn.example.com/"+uploaded.PdfFileID {
		t.Fatalf("upload did not return the object-storage URL: response=%#v puts=%#v", uploaded, blobs.puts)
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

func TestReportReconciliationUploadSummaryPdfPersistsR2Object(t *testing.T) {
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(nil))
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{int64(7)}}},
	}}
	blobs := &fakeReconciliationBlobs{publicURLPrefix: "https://cdn.example.com"}
	store := NewReportReconciliationStoreWithOptions(db, ReportReconciliationStoreOptions{
		Blobs: blobs,
	})
	store.fileRoot = t.TempDir()

	response, err := store.UploadSummaryPdf(
		context.Background(),
		42,
		"summary.pdf",
		pdfBytes,
		"alice",
		true,
	)
	if err != nil {
		t.Fatalf("UploadSummaryPdf() error = %v", err)
	}
	if len(blobs.puts) != 1 {
		t.Fatalf("Put calls = %d, want 1", len(blobs.puts))
	}
	put := blobs.puts[0]
	if !strings.HasPrefix(put.key, "monthly_summary_pdf/42/") || !strings.HasSuffix(put.key, ".pdf") {
		t.Fatalf("put key = %q", put.key)
	}
	if put.contentType != "application/pdf" || !bytes.Equal(put.data, pdfBytes) {
		t.Fatalf("put content = %q/%d bytes", put.contentType, len(put.data))
	}
	if response.PdfFileID != put.key {
		t.Fatalf("pdf_file_id = %q, want %q", response.PdfFileID, put.key)
	}
	wantURL := "https://cdn.example.com/" + put.key
	if response.PdfFilePath != wantURL {
		t.Fatalf("pdf_file_path = %q, want %q", response.PdfFilePath, wantURL)
	}
	if len(db.execCalls) != 1 {
		t.Fatalf("Exec calls = %d, want 1", len(db.execCalls))
	}
	args := db.execCalls[0].args
	if len(args) != 4 || args[0] != put.key || args[1] != wantURL || args[3] != int64(42) {
		t.Fatalf("database args = %#v", args)
	}
	localPath, ok := args[2].(string)
	if !ok || localPath == "" {
		t.Fatalf("local fallback path = %#v", args[2])
	}
	localBytes, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatalf("read local fallback: %v", err)
	}
	if !bytes.Equal(localBytes, pdfBytes) {
		t.Fatal("local fallback does not match the uploaded PDF")
	}
}

func TestReportReconciliationUploadTransactionCsvPersistsR2Object(t *testing.T) {
	csvBytes := []byte("date,order_id,amount\n2026-11-01,A,10.00\n")
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{int64(7)}}},
	}}
	blobs := &fakeReconciliationBlobs{publicURLPrefix: "https://cdn.example.com"}
	store := NewReportReconciliationStoreWithOptions(db, ReportReconciliationStoreOptions{
		Blobs: blobs,
	})
	store.fileRoot = t.TempDir()

	response, err := store.UploadTransactionCsv(
		context.Background(),
		42,
		"transactions.csv",
		csvBytes,
		"alice",
		true,
	)
	if err != nil {
		t.Fatalf("UploadTransactionCsv() error = %v", err)
	}
	if len(blobs.puts) != 1 {
		t.Fatalf("Put calls = %d, want 1", len(blobs.puts))
	}
	put := blobs.puts[0]
	if !strings.HasPrefix(put.key, "transaction_csv/42/") || !strings.HasSuffix(put.key, ".csv") {
		t.Fatalf("put key = %q", put.key)
	}
	if put.contentType != "text/csv; charset=utf-8" || !bytes.Equal(put.data, csvBytes) {
		t.Fatalf("put content = %q/%d bytes", put.contentType, len(put.data))
	}
	if response.CsvFileID != put.key {
		t.Fatalf("csv_file_id = %q, want %q", response.CsvFileID, put.key)
	}
	wantURL := "https://cdn.example.com/" + put.key
	if response.CsvFilePath != wantURL {
		t.Fatalf("csv_file_path = %q, want %q", response.CsvFilePath, wantURL)
	}
	if len(db.execCalls) != 1 {
		t.Fatalf("Exec calls = %d, want 1", len(db.execCalls))
	}
	args := db.execCalls[0].args
	if len(args) != 3 || args[0] != put.key || args[2] != int64(42) {
		t.Fatalf("database args = %#v", args)
	}
	localPath, ok := args[1].(string)
	if !ok || localPath == "" {
		t.Fatalf("local fallback path = %#v", args[1])
	}
	localBytes, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatalf("read local fallback: %v", err)
	}
	if !bytes.Equal(localBytes, csvBytes) {
		t.Fatal("local fallback does not match the uploaded CSV")
	}
}

func TestReportReconciliationUploadRemovesObjectWhenDatabaseWriteFails(t *testing.T) {
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(nil))
	csvBytes := []byte("date,order_id,amount\n2026-11-01,A,10.00\n")
	tests := []struct {
		name       string
		wantPrefix string
		upload     func(*ReportReconciliationStore) error
	}{
		{
			name:       "pdf",
			wantPrefix: "monthly_summary_pdf/42/",
			upload: func(store *ReportReconciliationStore) error {
				_, err := store.UploadSummaryPdf(context.Background(), 42, "summary.pdf", pdfBytes, "alice", true)
				return err
			},
		},
		{
			name:       "csv",
			wantPrefix: "transaction_csv/42/",
			upload: func(store *ReportReconciliationStore) error {
				_, err := store.UploadTransactionCsv(context.Background(), 42, "transactions.csv", csvBytes, "alice", true)
				return err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := &fakeWriteDB{
				fakeDB:  &fakeDB{rowsQueue: []pgx.Row{fakeRow{values: []any{int64(7)}}}},
				execErr: errors.New("database unavailable"),
			}
			blobs := &fakeReconciliationBlobs{publicURLPrefix: "https://cdn.example.com"}
			store := NewReportReconciliationStoreWithOptions(db, ReportReconciliationStoreOptions{
				Blobs: blobs,
			})
			store.fileRoot = t.TempDir()

			if err := test.upload(store); err == nil {
				t.Fatal("upload succeeded despite database failure")
			}
			if len(blobs.deletedKeys) != 1 || !strings.HasPrefix(blobs.deletedKeys[0], test.wantPrefix) {
				t.Fatalf("compensating deletes = %#v", blobs.deletedKeys)
			}
			assertReconciliationStorageEmpty(t, store.fileRoot)
		})
	}
}

func TestReportReconciliationUploadRequiresObjectStorage(t *testing.T) {
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(nil))
	csvBytes := []byte("date,order_id,amount\n2026-11-01,A,10.00\n")
	tests := []struct {
		name   string
		upload func(*ReportReconciliationStore) error
	}{
		{
			name: "pdf",
			upload: func(store *ReportReconciliationStore) error {
				_, err := store.UploadSummaryPdf(context.Background(), 42, "summary.pdf", pdfBytes, "alice", true)
				return err
			},
		},
		{
			name: "csv",
			upload: func(store *ReportReconciliationStore) error {
				_, err := store.UploadTransactionCsv(context.Background(), 42, "transactions.csv", csvBytes, "alice", true)
				return err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := &fakeWriteDB{fakeDB: &fakeDB{
				rowsQueue: []pgx.Row{fakeRow{values: []any{int64(7)}}},
			}}
			store := NewReportReconciliationStore(db)
			store.fileRoot = t.TempDir()

			err := test.upload(store)
			if !errors.Is(err, report_reconciliation.ErrObjectStorageUnavailable) {
				t.Fatalf("error = %v, want ErrObjectStorageUnavailable", err)
			}
			if len(db.execCalls) != 0 {
				t.Fatalf("database writes = %d, want 0", len(db.execCalls))
			}
			assertReconciliationStorageEmpty(t, store.fileRoot)
		})
	}
}

func TestReportReconciliationUploadRejectsObjectStorageFailure(t *testing.T) {
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(nil))
	csvBytes := []byte("date,order_id,amount\n2026-11-01,A,10.00\n")
	tests := []struct {
		name   string
		upload func(*ReportReconciliationStore) error
	}{
		{
			name: "pdf",
			upload: func(store *ReportReconciliationStore) error {
				_, err := store.UploadSummaryPdf(context.Background(), 42, "summary.pdf", pdfBytes, "alice", true)
				return err
			},
		},
		{
			name: "csv",
			upload: func(store *ReportReconciliationStore) error {
				_, err := store.UploadTransactionCsv(context.Background(), 42, "transactions.csv", csvBytes, "alice", true)
				return err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := &fakeWriteDB{fakeDB: &fakeDB{
				rowsQueue: []pgx.Row{fakeRow{values: []any{int64(7)}}},
			}}
			blobs := &fakeReconciliationBlobs{putErr: errors.New("R2 unavailable")}
			store := NewReportReconciliationStoreWithOptions(db, ReportReconciliationStoreOptions{
				Blobs: blobs,
			})
			store.fileRoot = t.TempDir()

			err := test.upload(store)
			if !errors.Is(err, report_reconciliation.ErrObjectStorageUnavailable) {
				t.Fatalf("error = %v, want ErrObjectStorageUnavailable", err)
			}
			if len(db.execCalls) != 0 {
				t.Fatalf("database writes = %d, want 0", len(db.execCalls))
			}
			if len(blobs.deletedKeys) != 0 {
				t.Fatalf("deleted keys = %#v, want none", blobs.deletedKeys)
			}
			assertReconciliationStorageEmpty(t, store.fileRoot)
		})
	}
}

func TestReportReconciliationDownloadsPreferLocalFiles(t *testing.T) {
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(nil))
	csvBytes := []byte("date,order_id,amount\n2026-11-01,A,10.00\n")
	root := t.TempDir()
	pdfPath := filepath.Join(root, "summary.pdf")
	csvPath := filepath.Join(root, "transactions.csv")
	if err := os.WriteFile(pdfPath, pdfBytes, 0o600); err != nil {
		t.Fatalf("write PDF fixture: %v", err)
	}
	if err := os.WriteFile(csvPath, csvBytes, 0o600); err != nil {
		t.Fatalf("write CSV fixture: %v", err)
	}
	db := &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{int64(7)}},
		fakeRow{values: []any{
			"Project A", "2026-10", &pdfPath,
			stringPtr("monthly_summary_pdf/42/legacy.pdf"),
			stringPtr("https://pub-r2.believeboy.com/monthly_summary_pdf/42/legacy.pdf"),
		}},
		fakeRow{values: []any{
			int64(7), "Project A", "2026-10",
			stringPtr("https://pub-r2.believeboy.com/transaction_csv/42/legacy.csv"),
			&csvPath,
		}},
	}}
	store := NewReportReconciliationStore(&fakeWriteDB{fakeDB: db})

	_, downloadedPDF, err := store.DownloadPdf(context.Background(), 42, "alice", true)
	if err != nil {
		t.Fatalf("DownloadPdf() error = %v", err)
	}
	if !bytes.Equal(downloadedPDF, pdfBytes) {
		t.Fatal("DownloadPdf() did not prefer the local fallback")
	}
	_, downloadedCSV, err := store.DownloadCsv(context.Background(), 42, "alice", true)
	if err != nil {
		t.Fatalf("DownloadCsv() error = %v", err)
	}
	if !bytes.Equal(downloadedCSV, csvBytes) {
		t.Fatal("DownloadCsv() did not prefer the local fallback")
	}
}

func TestReportReconciliationDownloadsResolveLegacyObjectKeys(t *testing.T) {
	pdfBytes := makeReconciliationPDF(reconciliationMetricLines(nil))
	csvBytes := []byte("date,order_id,amount\n2026-11-01,A,10.00\n")
	var requestedPaths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPaths = append(requestedPaths, r.URL.Path)
		switch {
		case strings.HasSuffix(r.URL.Path, ".pdf"):
			_, _ = w.Write(pdfBytes)
		case strings.HasSuffix(r.URL.Path, ".csv"):
			_, _ = w.Write(csvBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	db := &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{int64(7)}},
		fakeRow{values: []any{
			"Project A", "2026-10", nil,
			stringPtr("monthly_summary_pdf/42/legacy.pdf"), nil,
		}},
		fakeRow{values: []any{
			int64(7), "Project A", "2026-10",
			stringPtr("transaction_csv/42/legacy.csv"), nil,
		}},
	}}
	store := NewReportReconciliationStoreWithOptions(&fakeWriteDB{fakeDB: db}, ReportReconciliationStoreOptions{
		PublicURL: server.URL,
	})
	store.httpClient = server.Client()

	_, downloadedPDF, err := store.DownloadPdf(context.Background(), 42, "alice", true)
	if err != nil {
		t.Fatalf("DownloadPdf() error = %v", err)
	}
	if !bytes.Equal(downloadedPDF, pdfBytes) {
		t.Fatal("DownloadPdf() did not fetch the legacy R2 key")
	}
	_, downloadedCSV, err := store.DownloadCsv(context.Background(), 42, "alice", true)
	if err != nil {
		t.Fatalf("DownloadCsv() error = %v", err)
	}
	if !bytes.Equal(downloadedCSV, csvBytes) {
		t.Fatal("DownloadCsv() did not fetch the legacy R2 key")
	}
	wantPaths := []string{
		"/monthly_summary_pdf/42/legacy.pdf",
		"/transaction_csv/42/legacy.csv",
	}
	if len(requestedPaths) != len(wantPaths) {
		t.Fatalf("requested paths = %#v, want %#v", requestedPaths, wantPaths)
	}
	for index, want := range wantPaths {
		if requestedPaths[index] != want {
			t.Fatalf("requested paths = %#v, want %#v", requestedPaths, wantPaths)
		}
	}
}

func TestReportReconciliationObjectURLUsesConfiguration(t *testing.T) {
	blobs := &fakeReconciliationBlobs{publicURLPrefix: "https://cdn.example.com"}
	store := NewReportReconciliationStoreWithOptions(&fakeWriteDB{fakeDB: &fakeDB{}}, ReportReconciliationStoreOptions{
		Blobs:     blobs,
		PublicURL: "https://fallback.example.com",
	})
	if got := store.objectURL("monthly_summary_pdf/42/summary.pdf"); got != "https://cdn.example.com/monthly_summary_pdf/42/summary.pdf" {
		t.Fatalf("objectURL() = %q", got)
	}

	fallback := NewReportReconciliationStoreWithOptions(&fakeWriteDB{fakeDB: &fakeDB{}}, ReportReconciliationStoreOptions{
		PublicURL: "https://fallback.example.com/",
	})
	if got := fallback.objectURL("/transaction_csv/42/transactions.csv"); got != "https://fallback.example.com/transaction_csv/42/transactions.csv" {
		t.Fatalf("fallback objectURL() = %q", got)
	}

	unconfigured := NewReportReconciliationStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	if got := unconfigured.objectURL("monthly_summary_pdf/42/summary.pdf"); got != "" {
		t.Fatalf("unconfigured objectURL() = %q, want empty", got)
	}
}

func assertReconciliationStorageEmpty(t *testing.T, root string) {
	t.Helper()
	directory := filepath.Join(root, "reconciliation", "report-42")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		t.Fatalf("read reconciliation storage: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("reconciliation storage still has %d files", len(entries))
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

	store := NewReportReconciliationStoreWithOptions(NewPGXDB(pool), ReportReconciliationStoreOptions{
		Blobs: &fakeReconciliationBlobs{publicURLPrefix: "https://cdn.example.com"},
	})
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
