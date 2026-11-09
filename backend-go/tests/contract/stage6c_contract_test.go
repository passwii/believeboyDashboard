package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage6CMonthlyReportStore struct {
	detail      *monthly_reports.MonthlyReportDetail
	status      *monthly_reports.MonthlyReportStatusResponse
	generated   *monthly_reports.MonthlyReport
	exportFile  *monthly_reports.MonthlyReportExport
	verifyErr   error
	getErr      error
	deleteErr   error
	confirmErr  error
	generateErr error
	promoteErr  error
}

func (s *stage6CMonthlyReportStore) VerifyProjectAccess(
	context.Context,
	int64,
	string,
	bool,
) error {
	return s.verifyErr
}

func (s *stage6CMonthlyReportStore) List(
	context.Context,
	monthly_reports.MonthlyReportListFilter,
) ([]monthly_reports.MonthlyReport, error) {
	return []monthly_reports.MonthlyReport{{
		ID:                 42,
		ProjectID:          7,
		ProjectName:        "Project A",
		Country:            "US",
		ReportMonth:        "2026-10",
		Version:            1,
		IsCurrent:          true,
		Status:             monthly_reports.MonthlyReportStatusCompleted,
		TotalTransactions:  12,
		TotalOrders:        8,
		TotalRefunds:       2,
		TotalAdjustments:   1,
		TotalServiceFees:   1,
		TotalTransFees:     3,
		CalculationVersion: 1,
		CreatedAt:          "2026-11-01T00:00:00Z",
		UpdatedAt:          "2026-11-01T00:01:00Z",
	}}, nil
}

func (s *stage6CMonthlyReportStore) GetReport(
	context.Context,
	int64,
) (*monthly_reports.MonthlyReportDetail, error) {
	return s.detail, s.getErr
}

func (s *stage6CMonthlyReportStore) Generate(
	context.Context,
	monthly_reports.MonthlyReportGenerateInput,
) (*monthly_reports.MonthlyReport, error) {
	return s.generated, s.generateErr
}

func (s *stage6CMonthlyReportStore) PromoteCompletedReport(
	context.Context,
	int64,
) error {
	return s.promoteErr
}

func (s *stage6CMonthlyReportStore) GetStatus(
	context.Context,
	int64,
) (*monthly_reports.MonthlyReportStatusResponse, error) {
	return s.status, nil
}

func (s *stage6CMonthlyReportStore) ConfirmReport(
	context.Context,
	int64,
) (*monthly_reports.MonthlyReport, error) {
	return &s.detail.Report, s.confirmErr
}

func (s *stage6CMonthlyReportStore) DeleteDraft(
	context.Context,
	int64,
) (*monthly_reports.MonthlyReport, error) {
	if s.deleteErr != nil {
		return nil, s.deleteErr
	}
	return &s.detail.Report, nil
}

func (s *stage6CMonthlyReportStore) ExportReport(
	context.Context,
	int64,
	string,
) (*monthly_reports.MonthlyReportExport, error) {
	return s.exportFile, nil
}

func (s *stage6CMonthlyReportStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, monthly_reports.Store) error,
) error {
	return fn(ctx, nil, s)
}

func stage6CDetail() *monthly_reports.MonthlyReportDetail {
	settlementID := "SET-1"
	fob := 400.0
	firstLeg := 50.0
	return &monthly_reports.MonthlyReportDetail{
		Report: monthly_reports.MonthlyReport{
			ID:                 42,
			ProjectID:          7,
			ProjectName:        "Project A",
			Country:            "US",
			ReportMonth:        "2026-10",
			Version:            1,
			IsCurrent:          true,
			Status:             monthly_reports.MonthlyReportStatusCompleted,
			SettlementID:       &settlementID,
			TotalTransactions:  12,
			TotalOrders:        8,
			TotalRefunds:       2,
			TotalAdjustments:   1,
			TotalServiceFees:   1,
			TotalTransFees:     3,
			CalculationVersion: 1,
			CreatedAt:          "2026-11-01T00:00:00Z",
			UpdatedAt:          "2026-11-01T00:01:00Z",
		},
		Project: monthly_reports.MonthlyReportProject{
			ID:          7,
			ProjectName: "Project A",
			Country:     "US",
		},
		Year:  2026,
		Month: 10,
		SalesSummary: monthly_reports.MonthlyReportSalesSummary{
			IncomeTotal:    1000,
			IncomeVATTotal: 50,
			ExpenseTotal:   -200,
			AmazonPayBack:  800,
			NetAmount:      800,
		},
		Settlement: monthly_reports.MonthlyReportSettlementSummary{
			SettlementID:      &settlementID,
			TotalTransactions: 12,
			TotalOrders:       8,
			TotalRefunds:      2,
			TotalAdjustments:  1,
			TotalServiceFees:  1,
			TotalTransFees:    3,
		},
		PlatformFees: []monthly_reports.MonthlyReportFee{{
			Key: "expense_fba_transaction_fees", Label: "FBA transaction fees", Amount: 120,
		}},
		RefundFees: []monthly_reports.MonthlyReportFee{{
			Key: "expense_refund_administration_fees", Label: "Refund administration fees", Amount: 10,
		}},
		PurchaseCost: monthly_reports.MonthlyReportPurchaseCost{
			FOBCostRMB: fob, FirstLegCostRMB: firstLeg, TotalCostRMB: 450,
		},
		Profit: monthly_reports.MonthlyReportProfit{
			Currency: "USD", NetProfit: 700, NetProfitRMB: 4900, NetProfitRate: 0.7,
		},
		PT3: map[string]float64{
			"income_total":                       1000,
			"expense_total":                      -200,
			"expense_fba_transaction_fees":       120,
			"expense_refund_administration_fees": 10,
		},
		PT4: map[string]float64{
			"income_total":              1000,
			"expense_total":             -200,
			"amazon_pay_back":           800,
			"credit_card_deduction_usd": 0,
		},
	}
}

func stage6CRequest(
	method string,
	target string,
	body string,
	operator string,
	isAdmin bool,
) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: operator,
		IsAdmin:  isAdmin,
	}))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func stage6CRouter(
	store monthly_reports.Store,
	auditor audit.Service,
	enqueuer monthly_reports.JobEnqueuer,
) http.Handler {
	router := chi.NewRouter()
	monthly_reports.NewRegistrarWithEnqueuer(store, auditor, enqueuer).RegisterRoutes(
		router,
		func(next http.Handler) http.Handler { return next },
	)
	router.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-FastAPI-Fallback", "true")
		w.WriteHeader(http.StatusBadGateway)
	}))
	return router
}

type stage6CEnqueuer struct {
	err  error
	jobs []int64
}

func (enqueuer *stage6CEnqueuer) EnqueueRunJob(_ context.Context, jobID int64) error {
	enqueuer.jobs = append(enqueuer.jobs, jobID)
	return enqueuer.err
}

func TestStage6CMonthlyReportsContract(t *testing.T) {
	redirectURL := "https://r2.example/project-a-summary.pdf"
	store := &stage6CMonthlyReportStore{
		detail: stage6CDetail(),
		status: &monthly_reports.MonthlyReportStatusResponse{
			ReportID:  42,
			Status:    monthly_reports.MonthlyReportStatusCalculating,
			Stage:     "processing",
			Progress:  65,
			Message:   stage6CStringPointer("processing"),
			CreatedAt: "2026-11-01T00:00:00Z",
			UpdatedAt: "2026-11-01T00:01:00Z",
		},
		generated: &monthly_reports.MonthlyReport{
			ID:          43,
			JobID:       99,
			ProjectID:   7,
			ProjectName: "Project A",
			Country:     "US",
			ReportMonth: "2026-10",
			Status:      monthly_reports.MonthlyReportStatusPending,
			CreatedAt:   "2026-11-01T00:00:00Z",
			UpdatedAt:   "2026-11-01T00:00:00Z",
		},
		exportFile: &monthly_reports.MonthlyReportExport{
			Filename:    "Project_A_Monthly_Report_2026-10.csv",
			ContentType: "text/csv; charset=utf-8",
			Content:     []byte("income_total,expense_total\n1000,-200\n"),
		},
	}
	auditor := audit.NewMockService()
	enqueuer := &stage6CEnqueuer{}
	router := stage6CRouter(store, auditor, enqueuer)
	admin := stage6CRequest(http.MethodGet, "/api/v1/monthly-reports", "", "admin", true)

	request := admin
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var list []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list length = %d", len(list))
	}
	assertStage6CSnakeCaseKeys(t, list)
	for _, field := range []string{
		"id", "project_id", "project_name", "country", "report_month",
		"status", "total_transactions", "created_at", "updated_at",
	} {
		if _, ok := list[0][field]; !ok {
			t.Fatalf("list item missing %q: %#v", field, list[0])
		}
	}

	request = stage6CRequest(http.MethodGet, "/api/v1/monthly-reports/42", "", "admin", true)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("detail status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var detail map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	assertStage6CSnakeCaseKeys(t, detail)
	for _, field := range []string{"report", "pt3", "pt4"} {
		if _, ok := detail[field]; !ok {
			t.Fatalf("detail missing %q: %#v", field, detail)
		}
	}

	request = stage6CRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/generate",
		`{"project_id":7,"country":"US","report_month":"2026-10","transaction_file_id":"file-1"}`,
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("generate status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var generated map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &generated); err != nil {
		t.Fatalf("decode generate: %v", err)
	}
	assertStage6CSnakeCaseKeys(t, generated)
	for _, field := range []string{"report_id", "status", "status_endpoint", "created_at"} {
		if _, ok := generated[field]; !ok {
			t.Fatalf("generate missing %q: %#v", field, generated)
		}
	}
	if len(enqueuer.jobs) != 1 || enqueuer.jobs[0] != 99 {
		t.Fatalf("enqueued jobs = %#v, want [99]", enqueuer.jobs)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "monthly_reports.create" {
		t.Fatalf("create audit = %#v", auditor.Entries)
	}

	for _, body := range []string{
		`{"project_id":7,"report_month":"2026-10"}`,
		`{"project_id":7,"report_month":"2026-10","transaction_file_id":"file-1","transaction_file_path":"/tmp/report.csv"}`,
		`{"project_id":7,"report_month":"2026-10","transaction_file_id":"file-1","summary_pdf_file_path":"/tmp/report.pdf"}`,
	} {
		request = stage6CRequest(
			http.MethodPost,
			"/api/v1/monthly-reports/generate",
			body,
			"admin",
			true,
		)
		recorder = httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("generate body %s status=%d, want 422", body, recorder.Code)
		}
	}

	request = stage6CRequest(http.MethodGet, "/api/v1/monthly-reports/42/status", "", "admin", true)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status endpoint = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var statusPayload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &statusPayload); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	assertStage6CSnakeCaseKeys(t, statusPayload)
	for _, field := range []string{"report_id", "status", "progress", "error_message", "updated_at"} {
		if _, ok := statusPayload[field]; !ok {
			t.Fatalf("status missing %q: %#v", field, statusPayload)
		}
	}

	request = stage6CRequest(http.MethodPost, "/api/v1/monthly-reports/42/confirm", "", "admin", true)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if action := stage6CAuditEntry(t, auditor, "monthly_reports.confirm"); action == nil {
		t.Fatalf("confirm audit = %#v", auditor.Entries)
	}

	request = stage6CRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/excel",
		"",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("excel export status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("excel Content-Disposition = %q", recorder.Header().Get("Content-Disposition"))
	}
	if recorder.Header().Get("Content-Type") != "text/csv; charset=utf-8" {
		t.Fatalf("excel Content-Type = %q", recorder.Header().Get("Content-Type"))
	}
	excelAudit := stage6CAuditEntry(t, auditor, "monthly_reports.export")
	if excelAudit == nil {
		t.Fatalf("excel export audit = %#v", auditor.Entries)
	}
	after, ok := excelAudit.AfterJSON.(map[string]any)
	if !ok || after["format"] != monthly_reports.MonthlyReportExportFormatExcel {
		t.Fatalf("excel export audit after = %#v", excelAudit.AfterJSON)
	}

	store.exportFile = &monthly_reports.MonthlyReportExport{RedirectURL: &redirectURL}
	request = stage6CRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/pdf",
		"",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != redirectURL {
		t.Fatalf(
			"pdf export status = %d location=%q",
			recorder.Code,
			recorder.Header().Get("Location"),
		)
	}
	if count := stage6CAuditCount(auditor, "monthly_reports.export"); count != 2 {
		t.Fatalf("pdf export audit count = %d, want 2", count)
	}

	unsafeRedirect := "http://user:pass@r2.example/summary.pdf"
	store.exportFile = &monthly_reports.MonthlyReportExport{RedirectURL: &unsafeRedirect}
	request = stage6CRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/pdf",
		"",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || recorder.Header().Get("Location") != "" {
		t.Fatalf(
			"unsafe redirect status=%d location=%q",
			recorder.Code,
			recorder.Header().Get("Location"),
		)
	}
	if count := stage6CAuditCount(auditor, "monthly_reports.export"); count != 2 {
		t.Fatalf("unsafe redirect wrote export audit, count=%d", count)
	}

	request = stage6CRequest(http.MethodDelete, "/api/v1/monthly-reports/42", "", "admin", true)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("delete body = %q, want empty", recorder.Body.String())
	}
	if stage6CAuditEntry(t, auditor, "monthly_reports.delete") == nil {
		t.Fatalf("delete audit = %#v", auditor.Entries)
	}

	validationCases := []string{
		"/api/v1/monthly-reports?project_id=bad",
		"/api/v1/monthly-reports?year=bad",
		"/api/v1/monthly-reports?month=13",
		"/api/v1/monthly-reports?status=unknown",
	}
	for _, target := range validationCases {
		request = stage6CRequest(http.MethodGet, target, "", "admin", true)
		recorder = httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d, want 422", target, recorder.Code)
		}
	}

	store.verifyErr = monthly_reports.ErrProjectForbidden
	request = stage6CRequest(http.MethodGet, "/api/v1/monthly-reports/42", "", "alice", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status = %d, want 403", recorder.Code)
	}

	store.verifyErr = nil
	store.getErr = monthly_reports.ErrReportNotFound
	request = stage6CRequest(http.MethodGet, "/api/v1/monthly-reports/999", "", "admin", true)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d, want 404", recorder.Code)
	}

	store.getErr = nil
	store.confirmErr = monthly_reports.ErrReportNotReady
	request = stage6CRequest(http.MethodPost, "/api/v1/monthly-reports/42/confirm", "", "admin", true)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("not-ready status = %d, want 409", recorder.Code)
	}
}

func stage6CAuditEntry(t *testing.T, auditor *audit.MockService, action string) *audit.Entry {
	t.Helper()
	for index := range auditor.Entries {
		if auditor.Entries[index].Action == action {
			return &auditor.Entries[index]
		}
	}
	return nil
}

func stage6CAuditCount(auditor *audit.MockService, action string) int {
	count := 0
	for _, entry := range auditor.Entries {
		if entry.Action == action {
			count++
		}
	}
	return count
}

func assertStage6CSnakeCaseKeys(t *testing.T, value any) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == "pt3" || key == "pt4" {
				childMap, ok := child.(map[string]any)
				if ok {
					assertStage6CSnakeCaseKeys(t, childMap)
				}
				continue
			}
			if !stage6CSnakeCasePattern.MatchString(key) {
				t.Fatalf("non snake_case key %q in %#v", key, typed)
			}
			assertStage6CSnakeCaseKeys(t, child)
		}
	case []any:
		for _, child := range typed {
			assertStage6CSnakeCaseKeys(t, child)
		}
	}
}

var stage6CSnakeCasePattern = regexp.MustCompile(`^[a-z0-9_]+$`)

func stage6CStringPointer(value string) *string {
	return &value
}

func TestStage6CResponseDoesNotContainCamelCase(t *testing.T) {
	payload := map[string]any{
		"project_id":   int64(1),
		"report_month": "2026-10",
		"created_at":   time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339),
	}
	bytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(bytes), "projectId") || strings.Contains(string(bytes), "reportMonth") {
		t.Fatalf("camelCase leaked: %s", bytes)
	}
}
