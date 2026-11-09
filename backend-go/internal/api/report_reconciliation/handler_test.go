package report_reconciliation

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockReconStore struct {
	availableReports []AvailableReportItem
	historyRecords   []ReconciliationRecordResponse
	reconcileResp    *ReconcileResultResponse
	pdfUploadResp    *PDFUploadResponse
	csvUploadResp    *CSVUploadResponse

	autoErr     error
	pdfErr      error
	csvErr      error
	exportErr   error
	manualErr   error
	downloadErr error
}

func (m *mockReconStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return nil
}
func (m *mockReconStore) GetReportProjectID(_ context.Context, _ int64) (int64, error) {
	return 1, nil
}
func (m *mockReconStore) GetAvailableReports(_ context.Context, _ AvailableReportsFilter) ([]AvailableReportItem, error) {
	return m.availableReports, nil
}
func (m *mockReconStore) AutoReconcile(_ context.Context, _ AutoReconcileRequest, _ string, _ bool) (*ReconcileResultResponse, error) {
	if m.autoErr != nil {
		return nil, m.autoErr
	}
	return m.reconcileResp, nil
}
func (m *mockReconStore) GetReconciliationHistory(_ context.Context, _ HistoryFilter) ([]ReconciliationRecordResponse, error) {
	return m.historyRecords, nil
}
func (m *mockReconStore) ManualReconcile(_ context.Context, _ *int64, _ []byte, _ []byte, _ float64, _ string, _ bool) (map[string]any, error) {
	if m.manualErr != nil {
		return nil, m.manualErr
	}
	return map[string]any{"matched_items": 7, "mismatched_items": 2, "match_rate": 77.8}, nil
}
func (m *mockReconStore) UploadSummaryPdf(_ context.Context, reportID int64, filename string, _ []byte, _ string, _ bool) (*PDFUploadResponse, error) {
	if m.pdfErr != nil {
		return nil, m.pdfErr
	}
	return m.pdfUploadResp, nil
}
func (m *mockReconStore) UploadTransactionCsv(_ context.Context, reportID int64, filename string, _ []byte, _ string, _ bool) (*CSVUploadResponse, error) {
	if m.csvErr != nil {
		return nil, m.csvErr
	}
	return m.csvUploadResp, nil
}
func (m *mockReconStore) ExportPt3Data(_ context.Context, _ int64, _ string, _ bool) (string, []byte, error) {
	if m.exportErr != nil {
		return "", nil, m.exportErr
	}
	return "test-report.xlsx", []byte("test-xlsx"), nil
}
func (m *mockReconStore) DownloadPdf(_ context.Context, _ int64, _ string, _ bool) (string, []byte, error) {
	if m.downloadErr != nil {
		return "", nil, m.downloadErr
	}
	return "test.pdf", []byte("%PDF-1.4 test"), nil
}
func (m *mockReconStore) DownloadCsv(_ context.Context, _ int64, _ string, _ bool) (string, []byte, error) {
	if m.downloadErr != nil {
		return "", nil, m.downloadErr
	}
	return "test.csv", []byte("a,b,c"), nil
}

type mockReconAuditor struct{}

func (a *mockReconAuditor) LogAction(_ context.Context, _ audit.Entry) error             { return nil }
func (a *mockReconAuditor) LogActionTx(_ context.Context, _ pgx.Tx, _ audit.Entry) error { return nil }
func (a *mockReconAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func setupReconRouter(store Store) chi.Router {
	r := chi.NewRouter()
	registrar := NewRegistrar(store, &mockReconAuditor{})
	registrar.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestReconciliationHandler(t *testing.T) {
	store := &mockReconStore{
		availableReports: []AvailableReportItem{
			{ReportID: 1, ProjectName: "Test Proj", Country: "US", ReportMonth: "2026-05", Status: "success"},
		},
		reconcileResp: &ReconcileResultResponse{
			TotalItems:      9,
			MatchedItems:    7,
			MismatchedItems: 2,
			MatchRate:       77.8,
			Summary:         ReconciliationRecordSummary{},
		},
		pdfUploadResp: &PDFUploadResponse{
			ReportID:         1,
			PdfFileID:        "pdf-id",
			OriginalFilename: "doc.pdf",
			Size:             1024,
			Message:          "PDF uploaded successfully",
		},
		csvUploadResp: &CSVUploadResponse{
			ReportID:         1,
			CsvFileID:        "csv-id",
			OriginalFilename: "tx.csv",
			Size:             2048,
			Message:          "CSV uploaded successfully",
		},
	}
	router := setupReconRouter(store)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "admin", IsAdmin: true})

	// 1. Available reports
	req := httptest.NewRequest(http.MethodGet, "/api/v1/report-reconciliation/available-reports", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var availResp AvailableReportsResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &availResp)
	if availResp.Total != 1 {
		t.Fatalf("expected 1 available report, got %d", availResp.Total)
	}

	// 2. Auto reconcile
	autoBody, _ := json.Marshal(AutoReconcileRequest{ReportID: 1, Tolerance: 0.01})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/report-reconciliation/auto-reconcile", bytes.NewReader(autoBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. Upload PDF
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	part, _ := w.CreateFormFile("pdf_file", "doc.pdf")
	part.Write([]byte("%PDF-1.4 test"))
	w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/report-reconciliation/reports/1/pdf-upload", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 4. Export PT3
	req = httptest.NewRequest(http.MethodGet, "/api/v1/report-reconciliation/reports/1/export-pt3", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

type reconciliationHandlerCase struct {
	name     string
	method   string
	path     string
	jsonBody string
	files    map[string]string
}

func reconciliationSecurityCases() []reconciliationHandlerCase {
	return []reconciliationHandlerCase{
		{name: "auto", method: http.MethodPost, path: "/api/v1/report-reconciliation/auto-reconcile", jsonBody: `{"report_id":1,"tolerance":0.01}`},
		{
			name:   "manual",
			method: http.MethodPost,
			path:   "/api/v1/report-reconciliation/reconcile?report_id=1",
			files: map[string]string{
				"excel_file": "report.xlsx",
				"pdf_file":   "report.pdf",
			},
		},
		{
			name:   "upload-pdf",
			method: http.MethodPost,
			path:   "/api/v1/report-reconciliation/reports/1/pdf-upload",
			files:  map[string]string{"pdf_file": "report.pdf"},
		},
		{
			name:   "upload-csv",
			method: http.MethodPost,
			path:   "/api/v1/report-reconciliation/reports/1/csv-upload",
			files:  map[string]string{"csv_file": "transactions.csv"},
		},
		{name: "export-pt3", method: http.MethodGet, path: "/api/v1/report-reconciliation/reports/1/export-pt3"},
		{name: "download-pdf", method: http.MethodGet, path: "/api/v1/report-reconciliation/reports/1/download-pdf"},
		{name: "download-csv", method: http.MethodGet, path: "/api/v1/report-reconciliation/reports/1/download-csv"},
	}
}

func setReconciliationCaseError(store *mockReconStore, name string, err error) {
	switch name {
	case "auto":
		store.autoErr = err
	case "manual":
		store.manualErr = err
	case "upload-pdf":
		store.pdfErr = err
	case "upload-csv":
		store.csvErr = err
	case "export-pt3":
		store.exportErr = err
	case "download-pdf", "download-csv":
		store.downloadErr = err
	}
}

func TestReconciliationHandlerMapsProjectForbidden(t *testing.T) {
	for _, test := range reconciliationSecurityCases() {
		t.Run(test.name, func(t *testing.T) {
			store := &mockReconStore{}
			setReconciliationCaseError(store, test.name, ErrProjectForbidden)
			response := performReconciliationCase(t, store, test)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403; body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestReconciliationHandlerMapsReportNotFound(t *testing.T) {
	for _, test := range reconciliationSecurityCases() {
		t.Run(test.name, func(t *testing.T) {
			store := &mockReconStore{}
			setReconciliationCaseError(store, test.name, ErrReportNotFound)
			response := performReconciliationCase(t, store, test)
			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404; body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func performReconciliationCase(t *testing.T, store Store, test reconciliationHandlerCase) *httptest.ResponseRecorder {
	t.Helper()
	router := setupReconRouter(store)
	var body *bytes.Buffer
	contentType := "application/json"
	if len(test.files) > 0 {
		body = &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		for field, filename := range test.files {
			part, err := writer.CreateFormFile(field, filename)
			if err != nil {
				t.Fatalf("create multipart file: %v", err)
			}
			content := []byte("test")
			if strings.HasSuffix(filename, ".pdf") {
				content = []byte("%PDF-1.4 test")
			}
			if _, err := part.Write(content); err != nil {
				t.Fatalf("write multipart file: %v", err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatalf("close multipart writer: %v", err)
		}
		contentType = writer.FormDataContentType()
	} else {
		body = bytes.NewBufferString(test.jsonBody)
	}
	req := httptest.NewRequest(test.method, test.path, body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}
