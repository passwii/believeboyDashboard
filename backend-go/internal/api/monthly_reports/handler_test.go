package monthly_reports

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type monthlyReportFakeStore struct {
	items          []MonthlyReport
	detail         *MonthlyReportDetail
	status         *MonthlyReportStatusResponse
	generated      *MonthlyReport
	exportFile     *MonthlyReportExport
	reportFile     *MonthlyReportExport
	series         *MonthlyFinancialSeriesResponse
	accounting     *MonthlyFinancialAccountingDetailResponse
	accountFile    *MonthlyReportExport
	task           *MonthlyReportTask
	taskResult     *MonthlyReportExport
	deleted        *MonthlyReport
	confirmed      *MonthlyReport
	listErr        error
	getErr         error
	generateErr    error
	statusErr      error
	confirmErr     error
	deleteErr      error
	exportErr      error
	reportFileErr  error
	seriesErr      error
	recalculateErr error
	accountingErr  error
	accountFileErr error
	taskErr        error
	taskResultErr  error
	verifyErr      error
	runInTxErr     error
	promoteErr     error
	listFilter     MonthlyReportListFilter
	generateCall   MonthlyReportGenerateInput
	seriesFilter   MonthlyFinancialSeriesFilter
	accountFilter  MonthlyFinancialAccountingFilter
	failureCall    monthlyReportFailureCall
}

type monthlyReportFailureCall struct {
	ReportID int64
	JobID    int64
	Message  string
	Called   bool
}

func (s *monthlyReportFakeStore) VerifyProjectAccess(
	context.Context,
	int64,
	string,
	bool,
) error {
	return s.verifyErr
}

func (s *monthlyReportFakeStore) List(
	_ context.Context,
	filter MonthlyReportListFilter,
) ([]MonthlyReport, error) {
	s.listFilter = filter
	return s.items, s.listErr
}

func (s *monthlyReportFakeStore) GetReport(
	context.Context,
	int64,
) (*MonthlyReportDetail, error) {
	return s.detail, s.getErr
}

func (s *monthlyReportFakeStore) Generate(
	_ context.Context,
	input MonthlyReportGenerateInput,
) (*MonthlyReport, error) {
	s.generateCall = input
	return s.generated, s.generateErr
}

func (s *monthlyReportFakeStore) PromoteCompletedReport(
	context.Context,
	int64,
) error {
	return s.promoteErr
}

func (s *monthlyReportFakeStore) MarkGenerationFailed(
	_ context.Context,
	reportID, jobID int64,
	message string,
) error {
	s.failureCall = monthlyReportFailureCall{
		ReportID: reportID,
		JobID:    jobID,
		Message:  message,
		Called:   true,
	}
	return nil
}

func (s *monthlyReportFakeStore) GetStatus(
	context.Context,
	int64,
) (*MonthlyReportStatusResponse, error) {
	return s.status, s.statusErr
}

func (s *monthlyReportFakeStore) ConfirmReport(
	context.Context,
	int64,
) (*MonthlyReport, error) {
	return s.confirmed, s.confirmErr
}

func (s *monthlyReportFakeStore) DeleteDraft(
	context.Context,
	int64,
) (*MonthlyReport, error) {
	return s.deleted, s.deleteErr
}

func (s *monthlyReportFakeStore) ExportReport(
	context.Context,
	int64,
	string,
) (*MonthlyReportExport, error) {
	return s.exportFile, s.exportErr
}

func (s *monthlyReportFakeStore) ExportReportFile(
	context.Context,
	int64,
) (*MonthlyReportExport, error) {
	return s.reportFile, s.reportFileErr
}

func (s *monthlyReportFakeStore) GetFinancialSeries(
	_ context.Context,
	filter MonthlyFinancialSeriesFilter,
) (*MonthlyFinancialSeriesResponse, error) {
	s.seriesFilter = filter
	return s.series, s.seriesErr
}

func (s *monthlyReportFakeStore) RecalculateFinancialSeries(
	_ context.Context,
	filter MonthlyFinancialSeriesFilter,
) (*MonthlyFinancialSeriesResponse, error) {
	s.seriesFilter = filter
	return s.series, s.recalculateErr
}

func (s *monthlyReportFakeStore) GetAccountingDetail(
	_ context.Context,
	filter MonthlyFinancialAccountingFilter,
) (*MonthlyFinancialAccountingDetailResponse, error) {
	s.accountFilter = filter
	return s.accounting, s.accountingErr
}

func (s *monthlyReportFakeStore) ExportAccountingDetail(
	_ context.Context,
	filter MonthlyFinancialAccountingFilter,
) (*MonthlyReportExport, error) {
	s.accountFilter = filter
	return s.accountFile, s.accountFileErr
}

func (s *monthlyReportFakeStore) GetTask(
	context.Context,
	int64,
) (*MonthlyReportTask, error) {
	return s.task, s.taskErr
}

func (s *monthlyReportFakeStore) GetTaskResult(
	context.Context,
	int64,
) (*MonthlyReportExport, error) {
	return s.taskResult, s.taskResultErr
}

func (s *monthlyReportFakeStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	if s.runInTxErr != nil {
		return s.runInTxErr
	}
	return fn(ctx, nil, s)
}

func monthlyReportTestContext(operator string, isAdmin bool) context.Context {
	return auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: operator,
		IsAdmin:  isAdmin,
	})
}

func monthlyReportRequest(
	method string,
	target string,
	body string,
	operator string,
	isAdmin bool,
) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	request = request.WithContext(monthlyReportTestContext(operator, isAdmin))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func monthlyReportRouter(store Store, auditor audit.Service) http.Handler {
	router := chi.NewRouter()
	NewRegistrar(store, auditor).RegisterRoutes(
		router,
		func(next http.Handler) http.Handler { return next },
	)
	return router
}

func monthlyReportRouterWithEnqueuer(
	store Store,
	auditor audit.Service,
	enqueuer JobEnqueuer,
) http.Handler {
	router := chi.NewRouter()
	NewRegistrarWithEnqueuer(store, auditor, enqueuer).RegisterRoutes(
		router,
		func(next http.Handler) http.Handler { return next },
	)
	return router
}

type monthlyReportFakeEnqueuer struct {
	err  error
	jobs []int64
}

func (enqueuer *monthlyReportFakeEnqueuer) EnqueueRunJob(
	_ context.Context,
	jobID int64,
) error {
	enqueuer.jobs = append(enqueuer.jobs, jobID)
	return enqueuer.err
}

type monthlyReportFailingAuditor struct {
	*audit.MockService
	logActionErr error
}

func (auditor *monthlyReportFailingAuditor) LogAction(
	context.Context,
	audit.Entry,
) error {
	return auditor.logActionErr
}

func monthlyReportTestDetail() *MonthlyReportDetail {
	settlementID := "SET-1"
	return &MonthlyReportDetail{
		Report: MonthlyReport{
			ID:                 42,
			ProjectID:          7,
			ProjectName:        "Project A",
			Country:            "US",
			ReportMonth:        "2026-10",
			Version:            1,
			IsCurrent:          true,
			Status:             MonthlyReportStatusCompleted,
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
		Project: MonthlyReportProject{
			ID:          7,
			ProjectName: "Project A",
			Country:     "US",
		},
		Year:  2026,
		Month: 10,
		SalesSummary: MonthlyReportSalesSummary{
			IncomeTotal:   1000,
			ExpenseTotal:  -200,
			AmazonPayBack: 800,
			NetAmount:     800,
		},
		Settlement: MonthlyReportSettlementSummary{
			SettlementID:      &settlementID,
			TotalTransactions: 12,
			TotalOrders:       8,
			TotalRefunds:      2,
		},
		PlatformFees: []MonthlyReportFee{{
			Key: "expense_fba_transaction_fees", Label: "FBA transaction fees", Amount: 120,
		}},
		RefundFees: []MonthlyReportFee{{
			Key: "expense_refund_administration_fees", Label: "Refund administration fees", Amount: 10,
		}},
		PurchaseCost: MonthlyReportPurchaseCost{
			FOBCostRMB: 400, FirstLegCostRMB: 50, TotalCostRMB: 450,
		},
		Profit: MonthlyReportProfit{
			Currency: "USD", NetProfit: 700, NetProfitRMB: 4900, NetProfitRate: 0.7,
		},
		PT3: map[string]float64{"income_total": 1000, "expense_total": -200},
		PT4: map[string]float64{"income_total": 1000, "expense_total": -200},
	}
}

func TestMonthlyReportListValidationAndScoping(t *testing.T) {
	store := &monthlyReportFakeStore{
		items: []MonthlyReport{{
			ID: 1, ProjectID: 7, ProjectName: "Project A", Country: "US",
			ReportMonth: "2026-10", Status: MonthlyReportStatusCompleted,
		}},
	}
	router := monthlyReportRouter(store, audit.NewMockService())

	request := monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports?project_id=7&year=2026&month=10&status=completed",
		"",
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if store.listFilter.ProjectID == nil || *store.listFilter.ProjectID != 7 {
		t.Fatalf("project filter = %#v, want 7", store.listFilter.ProjectID)
	}
	if store.listFilter.Year == nil || *store.listFilter.Year != 2026 {
		t.Fatalf("year filter = %#v, want 2026", store.listFilter.Year)
	}
	if store.listFilter.Month == nil || *store.listFilter.Month != 10 {
		t.Fatalf("month filter = %#v, want 10", store.listFilter.Month)
	}
	if store.listFilter.Status == nil || *store.listFilter.Status != MonthlyReportStatusCompleted {
		t.Fatalf("status filter = %#v, want completed", store.listFilter.Status)
	}
	if store.listFilter.Operator != "alice" || store.listFilter.IsAdmin {
		t.Fatalf("identity filter = %#v", store.listFilter)
	}

	validationCases := []struct {
		target string
		want   string
	}{
		{"/api/v1/monthly-reports?project_id=0", "project_id"},
		{"/api/v1/monthly-reports?project_id=bad", "project_id"},
		{"/api/v1/monthly-reports?year=0", "year"},
		{"/api/v1/monthly-reports?year=bad", "year"},
		{"/api/v1/monthly-reports?year=02026", "year"},
		{"/api/v1/monthly-reports?month=13", "month"},
		{"/api/v1/monthly-reports?month=bad", "month"},
		{"/api/v1/monthly-reports?status=unknown", "status"},
	}
	for _, testCase := range validationCases {
		request = monthlyReportRequest(http.MethodGet, testCase.target, "", "alice", false)
		recorder = httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d, want 422", testCase.target, recorder.Code)
		}
		if !strings.Contains(recorder.Body.String(), testCase.want) {
			t.Fatalf("%s body = %s, want mention %q", testCase.target, recorder.Body.String(), testCase.want)
		}
	}

	store.verifyErr = ErrProjectForbidden
	request = monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports?project_id=9",
		"",
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden list status = %d, want 403", recorder.Code)
	}

	store.verifyErr = ErrProjectNotFound
	request = monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports?project_id=999",
		"",
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing project status = %d, want 404", recorder.Code)
	}
}

func TestMonthlyReportDetailAndStatusAccess(t *testing.T) {
	store := &monthlyReportFakeStore{
		detail: monthlyReportTestDetail(),
		status: &MonthlyReportStatusResponse{
			ReportID:  42,
			Status:    MonthlyReportStatusCalculating,
			Stage:     "processing",
			Progress:  65,
			Message:   monthlyReportStringPointer("processing"),
			CreatedAt: "2026-11-01T00:00:00Z",
			UpdatedAt: "2026-11-01T00:01:00Z",
		},
	}
	router := monthlyReportRouter(store, audit.NewMockService())

	request := monthlyReportRequest(http.MethodGet, "/api/v1/monthly-reports/42", "", "alice", false)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("detail status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var detail MonthlyReportDetail
	if err := json.Unmarshal(recorder.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detail.Report.ID != 42 || detail.PT3["income_total"] != 1000 {
		t.Fatalf("unexpected detail: %#v", detail)
	}
	var rawDetail map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &rawDetail); err != nil {
		t.Fatalf("decode raw detail: %v", err)
	}
	for _, key := range []string{"report", "pt3", "pt4"} {
		if _, ok := rawDetail[key]; !ok {
			t.Fatalf("detail response missing %q: %s", key, recorder.Body.String())
		}
	}
	for _, key := range []string{
		"project",
		"year",
		"month",
		"sales_summary",
		"settlement",
		"platform_fees",
		"refund_fees",
		"purchase_cost",
		"profit",
	} {
		if _, ok := rawDetail[key]; ok {
			t.Fatalf("detail response leaked Go-only field %q: %s", key, recorder.Body.String())
		}
	}

	store.verifyErr = ErrProjectForbidden
	request = monthlyReportRequest(http.MethodGet, "/api/v1/monthly-reports/42", "", "alice", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("detail forbidden status = %d, want 403", recorder.Code)
	}

	store.verifyErr = nil
	store.getErr = ErrReportNotFound
	request = monthlyReportRequest(http.MethodGet, "/api/v1/monthly-reports/404", "", "alice", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("detail missing status = %d, want 404", recorder.Code)
	}

	store.getErr = nil
	store.detail = monthlyReportTestDetail()
	request = monthlyReportRequest(http.MethodGet, "/api/v1/monthly-reports/42/status", "", "alice", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status endpoint = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var statusResponse MonthlyReportStatusResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &statusResponse); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if statusResponse.Progress != 65 || statusResponse.ErrorMessage != nil {
		t.Fatalf("unexpected status payload: %#v", statusResponse)
	}

	request = monthlyReportRequest(http.MethodGet, "/api/v1/monthly-reports/bad", "", "alice", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("non-numeric report id status = %d, want 422", recorder.Code)
	}
}

func TestMonthlyReportGenerate(t *testing.T) {
	store := &monthlyReportFakeStore{
		generated: &MonthlyReport{
			ID:          43,
			JobID:       99,
			ProjectID:   7,
			ProjectName: "Project A",
			Country:     "US",
			ReportMonth: "2026-10",
			Status:      MonthlyReportStatusPending,
			CreatedAt:   "2026-11-01T00:00:00Z",
			UpdatedAt:   "2026-11-01T00:00:00Z",
		},
	}
	auditor := audit.NewMockService()
	enqueuer := &monthlyReportFakeEnqueuer{}
	router := monthlyReportRouterWithEnqueuer(store, auditor, enqueuer)

	request := monthlyReportRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/generate",
		`{"project_id":7,"country":"US","report_month":"2026-10","transaction_file_id":"file-1"}`,
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("generate status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if store.generateCall.ProjectID == nil || *store.generateCall.ProjectID != 7 {
		t.Fatalf("generate project = %#v", store.generateCall.ProjectID)
	}
	if store.generateCall.Operator != "alice" || store.generateCall.IsAdmin {
		t.Fatalf("generate identity = %#v", store.generateCall)
	}
	var generated GenerateMonthlyReportResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &generated); err != nil {
		t.Fatalf("decode generate response: %v", err)
	}
	if generated.ReportID != 43 || generated.Status != MonthlyReportStatusPending {
		t.Fatalf("unexpected generate response: %#v", generated)
	}
	if generated.StatusEndpoint != "/api/v1/monthly-reports/43/status" {
		t.Fatalf("status endpoint = %q", generated.StatusEndpoint)
	}
	if len(enqueuer.jobs) != 1 || enqueuer.jobs[0] != 99 {
		t.Fatalf("enqueued jobs = %#v, want [99]", enqueuer.jobs)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "monthly_reports.create" {
		t.Fatalf("create audit = %#v", auditor.Entries)
	}
	after, ok := auditor.Entries[0].AfterJSON.(map[string]any)
	if !ok || after["job_id"] != int64(99) {
		t.Fatalf("create audit after = %#v", auditor.Entries[0].AfterJSON)
	}

	invalidBodies := []struct {
		body string
	}{
		{body: `{}`},
		{body: `{"report_month":"2026-10"}`},
		{body: `{"project_id":0,"report_month":"2026-10"}`},
		{body: `{"project_id":7,"report_month":"2026-1"}`},
		{body: `{"project_id":7,"report_month":"2026-13"}`},
		{body: `{"project_id":7,"report_month":"2026-10","country":"XX"}`},
		{body: `{"project_id":7,"report_month":"2026-10","mode":"unknown"}`},
		{body: `{"project_id":7,"report_month":"2026-10","mode":"immediate","async":true}`},
		{body: `{"project_id":7,"report_month":"2026-10","mode":"async","async":false}`},
		{body: `{"project_id":7,"report_month":"2026-10"}`},
		{body: `{"project_id":7,"report_month":"2026-10","transaction_file_id":"file-1","transaction_file_path":"/tmp/report.csv"}`},
		{body: `{"project_id":7,"report_month":"2026-10","transaction_file_id":"file-1","summary_pdf_file_path":"/tmp/report.pdf"}`},
		{body: `{bad json}`},
		{body: `{"project_id":7,"report_month":"2026-10"}{"extra":true}`},
	}
	for _, testCase := range invalidBodies {
		request = monthlyReportRequest(
			http.MethodPost,
			"/api/v1/monthly-reports/generate",
			testCase.body,
			"alice",
			false,
		)
		recorder = httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("generate body %s status = %d, want 422", testCase.body, recorder.Code)
		}
	}

	store.generateErr = ErrProjectForbidden
	request = monthlyReportRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/generate",
		`{"project_id":7,"report_month":"2026-10","transaction_file_id":"file-1"}`,
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("generate forbidden status = %d, want 403", recorder.Code)
	}

	store.generateErr = nil
	store.generated = &MonthlyReport{
		ID:          43,
		JobID:       100,
		ProjectID:   7,
		ProjectName: "Project A",
		Country:     "US",
		ReportMonth: "2026-10",
		Status:      MonthlyReportStatusCalculating,
		CreatedAt:   "2026-11-01T00:00:00Z",
		UpdatedAt:   "2026-11-01T00:00:00Z",
	}
	request = monthlyReportRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/generate",
		`{"project_id":7,"report_month":"2026-10","transaction_file_id":"file-1","async":false}`,
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("immediate generate status = %d, want 200", recorder.Code)
	}
	if store.generateCall.Async {
		t.Fatal("immediate generate should pass async=false to the store")
	}
}

func TestMonthlyReportConfirmWritesAudit(t *testing.T) {
	store := &monthlyReportFakeStore{
		detail: monthlyReportTestDetail(),
		confirmed: &MonthlyReport{
			ID: 42, ProjectID: 7, ProjectName: "Project A", Country: "US",
			ReportMonth: "2026-10", Status: MonthlyReportStatusCompleted,
			CreatedAt: "2026-11-01T00:00:00Z", UpdatedAt: "2026-11-01T00:02:00Z",
		},
	}
	auditor := audit.NewMockService()
	router := monthlyReportRouter(store, auditor)

	request := monthlyReportRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/42/confirm",
		"",
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if len(auditor.Entries) != 1 {
		t.Fatalf("audit entries = %d, want 1", len(auditor.Entries))
	}
	entry := auditor.Entries[0]
	if entry.Action != "monthly_reports.confirm" {
		t.Fatalf("audit action = %q", entry.Action)
	}
	if entry.TargetType != "monthly_report" || entry.TargetID == nil || *entry.TargetID != "42" {
		t.Fatalf("audit target = %#v %#v", entry.TargetType, entry.TargetID)
	}
	if entry.Operator == nil || *entry.Operator != "alice" {
		t.Fatalf("audit operator = %#v", entry.Operator)
	}
	if entry.AfterJSON == nil {
		t.Fatal("audit after_json is nil")
	}

	store.confirmErr = ErrReportNotReady
	request = monthlyReportRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/42/confirm",
		"",
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("confirm not-ready status = %d, want 409", recorder.Code)
	}
}

func TestMonthlyReportExports(t *testing.T) {
	redirectURL := "https://r2.example/summary.pdf"
	store := &monthlyReportFakeStore{
		detail: monthlyReportTestDetail(),
	}
	auditor := audit.NewMockService()
	router := monthlyReportRouter(store, auditor)

	store.exportFile = &MonthlyReportExport{
		Filename:    "Project_A_Monthly_Report_2026-10.csv",
		ContentType: "text/csv; charset=utf-8",
		Content:     []byte("income,expense\n1000,-200\n"),
	}
	request := monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/excel",
		"",
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("excel export status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "text/csv; charset=utf-8" {
		t.Fatalf("excel content type = %q", recorder.Header().Get("Content-Type"))
	}
	if disposition := recorder.Header().Get("Content-Disposition"); !strings.Contains(disposition, "attachment") ||
		!strings.Contains(disposition, "Project_A_Monthly_Report_2026-10.csv") {
		t.Fatalf("content disposition = %q", disposition)
	}
	if recorder.Body.String() != "income,expense\n1000,-200\n" {
		t.Fatalf("excel body = %q", recorder.Body.String())
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "monthly_reports.export" {
		t.Fatalf("excel export audit = %#v", auditor.Entries)
	}
	excelAfter, ok := auditor.Entries[0].AfterJSON.(map[string]any)
	if !ok || excelAfter["format"] != MonthlyReportExportFormatExcel ||
		excelAfter["filename"] != "Project_A_Monthly_Report_2026-10.csv" {
		t.Fatalf("excel export audit after = %#v", auditor.Entries[0].AfterJSON)
	}

	store.exportFile = &MonthlyReportExport{RedirectURL: &redirectURL}
	request = monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/pdf",
		"",
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusFound {
		t.Fatalf("pdf export status = %d, want 302", recorder.Code)
	}
	if recorder.Header().Get("Location") != redirectURL {
		t.Fatalf("pdf redirect = %q", recorder.Header().Get("Location"))
	}
	if len(auditor.Entries) != 2 || auditor.Entries[1].Action != "monthly_reports.export" {
		t.Fatalf("pdf export audit = %#v", auditor.Entries)
	}
	pdfAfter, ok := auditor.Entries[1].AfterJSON.(map[string]any)
	if !ok || pdfAfter["format"] != MonthlyReportExportFormatPDF ||
		pdfAfter["filename"] != "summary.pdf" {
		t.Fatalf("pdf export audit after = %#v", auditor.Entries[1].AfterJSON)
	}

	unsafeRedirect := "javascript:alert(1)"
	store.exportFile = &MonthlyReportExport{RedirectURL: &unsafeRedirect}
	request = monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/pdf",
		"",
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || recorder.Header().Get("Location") != "" {
		t.Fatalf(
			"unsafe redirect status = %d location=%q",
			recorder.Code,
			recorder.Header().Get("Location"),
		)
	}
	if len(auditor.Entries) != 2 {
		t.Fatalf("unsafe redirect must not audit delivery: %#v", auditor.Entries)
	}

	store.exportFile = &MonthlyReportExport{}
	request = monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/excel",
		"",
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("empty export status = %d, want 404", recorder.Code)
	}
	if len(auditor.Entries) != 2 {
		t.Fatalf("empty export must not be audited: %#v", auditor.Entries)
	}

	store.exportErr = ErrExportNotFound
	store.exportFile = nil
	request = monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/pdf",
		"",
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing export status = %d, want 404", recorder.Code)
	}
}

func TestMonthlyReportExportAuditFailurePreventsFileResponse(t *testing.T) {
	store := &monthlyReportFakeStore{
		detail: monthlyReportTestDetail(),
		exportFile: &MonthlyReportExport{
			Filename:    "report.csv",
			ContentType: "text/csv; charset=utf-8",
			Content:     []byte("secret export body"),
		},
	}
	auditor := &monthlyReportFailingAuditor{
		MockService:  audit.NewMockService(),
		logActionErr: errors.New("audit write failed"),
	}
	router := monthlyReportRouter(store, auditor)
	request := monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/42/export/excel",
		"",
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Disposition") != "" ||
		strings.Contains(recorder.Body.String(), "secret export body") {
		t.Fatalf("export leaked before audit: headers=%v body=%q", recorder.Header(), recorder.Body.String())
	}
}

func TestMonthlyReportDeleteDraft(t *testing.T) {
	store := &monthlyReportFakeStore{
		detail: &MonthlyReportDetail{
			Report: MonthlyReport{
				ID: 42, ProjectID: 7, ProjectName: "Project A", Country: "US",
				ReportMonth: "2026-10", Status: MonthlyReportStatusPending,
			},
			Project: MonthlyReportProject{ID: 7, ProjectName: "Project A", Country: "US"},
		},
		deleted: &MonthlyReport{
			ID: 42, ProjectID: 7, ProjectName: "Project A", Country: "US",
			ReportMonth: "2026-10", Status: MonthlyReportStatusPending,
		},
	}
	auditor := audit.NewMockService()
	router := monthlyReportRouter(store, auditor)

	request := monthlyReportRequest(
		http.MethodDelete,
		"/api/v1/monthly-reports/42",
		"",
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("delete body = %q, want empty", recorder.Body.String())
	}
	if len(auditor.Entries) != 1 {
		t.Fatalf("audit entries = %d, want 1", len(auditor.Entries))
	}
	if auditor.Entries[0].Action != "monthly_reports.delete" {
		t.Fatalf("audit action = %q", auditor.Entries[0].Action)
	}

	store.deleteErr = ErrReportFinalized
	request = monthlyReportRequest(
		http.MethodDelete,
		"/api/v1/monthly-reports/42",
		"",
		"alice",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("delete finalized status = %d, want 409", recorder.Code)
	}
}

func TestMonthlyReportErrorMapping(t *testing.T) {
	store := &monthlyReportFakeStore{}
	router := monthlyReportRouter(store, audit.NewMockService())

	cases := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{name: "project not found", err: ErrProjectNotFound, wantStatus: http.StatusNotFound},
		{name: "project forbidden", err: ErrProjectForbidden, wantStatus: http.StatusForbidden},
		{name: "report not found", err: ErrReportNotFound, wantStatus: http.StatusNotFound},
		{name: "not ready", err: ErrReportNotReady, wantStatus: http.StatusConflict},
		{name: "finalized", err: ErrReportFinalized, wantStatus: http.StatusConflict},
		{name: "already confirmed", err: ErrAlreadyConfirmed, wantStatus: http.StatusConflict},
		{name: "export missing", err: ErrExportNotFound, wantStatus: http.StatusNotFound},
		{name: "transaction file required", err: ErrTransactionFileRequired, wantStatus: http.StatusUnprocessableEntity},
		{name: "unknown", err: errors.New("database down"), wantStatus: http.StatusInternalServerError},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			store.getErr = testCase.err
			request := monthlyReportRequest(http.MethodGet, "/api/v1/monthly-reports/1", "", "alice", false)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d, body=%s", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
		})
	}
}

func TestMonthlyReportValidationHelpers(t *testing.T) {
	for input, want := range map[string]string{
		"":        "US",
		"us":      "US",
		"USA":     "US",
		"美国":      "US",
		"de":      "DE",
		"GERMANY": "DE",
		"GB":      "UK",
		"英国":      "UK",
	} {
		got, err := normalizeCountry(input)
		if err != nil {
			t.Fatalf("normalizeCountry(%q) error = %v", input, err)
		}
		if got != want {
			t.Fatalf("normalizeCountry(%q) = %q, want %q", input, got, want)
		}
	}
	if _, err := normalizeCountry("XX"); err == nil {
		t.Fatal("normalizeCountry(XX) error = nil")
	}

	for input, want := range map[string]string{
		"pending":     MonthlyReportStatusPending,
		"running":     MonthlyReportStatusCalculating,
		"calculating": MonthlyReportStatusCalculating,
		"success":     MonthlyReportStatusCompleted,
		"completed":   MonthlyReportStatusCompleted,
		"failed":      MonthlyReportStatusFailed,
	} {
		got, err := normalizeStatusFilter(input)
		if err != nil {
			t.Fatalf("normalizeStatusFilter(%q) error = %v", input, err)
		}
		if got != want {
			t.Fatalf("normalizeStatusFilter(%q) = %q, want %q", input, got, want)
		}
	}
	if _, err := normalizeStatusFilter("unknown"); err == nil {
		t.Fatal("normalizeStatusFilter(unknown) error = nil")
	}

	blank := "   "
	if got := trimPointer(&blank); got != nil {
		t.Fatalf("trimPointer(blank) = %#v, want nil", got)
	}
	value := " file-1 "
	if got := trimPointer(&value); got == nil || *got != "file-1" {
		t.Fatalf("trimPointer(value) = %#v", got)
	}

	async, err := resolveGenerationMode(nil, "")
	if err != nil || !async {
		t.Fatalf("default generation mode = %v, %v", async, err)
	}
	async, err = resolveGenerationMode(nil, "immediate")
	if err != nil || async {
		t.Fatalf("immediate generation mode = %v, %v", async, err)
	}
	immediate := false
	async, err = resolveGenerationMode(&immediate, "sync")
	if err != nil || async {
		t.Fatalf("sync generation mode = %v, %v", async, err)
	}
	if _, err := resolveGenerationMode(nil, "unknown"); err == nil {
		t.Fatal("resolveGenerationMode(unknown) error = nil")
	}
}

func TestMonthlyReportGenerateByProjectName(t *testing.T) {
	store := &monthlyReportFakeStore{
		generated: &MonthlyReport{
			ID:          44,
			JobID:       101,
			ProjectID:   7,
			ProjectName: "Project A",
			Country:     "UK",
			ReportMonth: "2026-09",
			Status:      MonthlyReportStatusPending,
			CreatedAt:   "2026-11-01T00:00:00Z",
			UpdatedAt:   "2026-11-01T00:00:00Z",
		},
	}
	router := monthlyReportRouterWithEnqueuer(
		store,
		audit.NewMockService(),
		&monthlyReportFakeEnqueuer{},
	)
	request := monthlyReportRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/generate",
		`{"project_name":" Project A ","country":"GB","report_month":"2026-09","transaction_file_id":"file-2"}`,
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("generate by name status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if store.generateCall.ProjectName == nil || *store.generateCall.ProjectName != "Project A" {
		t.Fatalf("generate project name = %#v", store.generateCall.ProjectName)
	}
	if store.generateCall.Country != "UK" {
		t.Fatalf("generate country = %q, want UK", store.generateCall.Country)
	}
}

func TestMonthlyReportGenerateEnqueueFailureMarksFailed(t *testing.T) {
	store := &monthlyReportFakeStore{
		generated: &MonthlyReport{
			ID:          45,
			JobID:       102,
			ProjectID:   7,
			ProjectName: "Project A",
			Country:     "US",
			ReportMonth: "2026-10",
			Status:      MonthlyReportStatusPending,
			CreatedAt:   "2026-11-01T00:00:00Z",
			UpdatedAt:   "2026-11-01T00:00:00Z",
		},
	}
	enqueuer := &monthlyReportFakeEnqueuer{err: errors.New("redis unavailable")}
	auditor := audit.NewMockService()
	router := monthlyReportRouterWithEnqueuer(store, auditor, enqueuer)
	request := monthlyReportRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/generate",
		`{"project_id":7,"report_month":"2026-10","transaction_file_id":"file-1"}`,
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("enqueue failure status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if !store.failureCall.Called ||
		store.failureCall.ReportID != 45 ||
		store.failureCall.JobID != 102 {
		t.Fatalf("failure marker call = %#v", store.failureCall)
	}
	if len(auditor.Entries) != 0 {
		t.Fatalf("failed enqueue must not write create audit: %#v", auditor.Entries)
	}
}

func TestMonthlyReportGenerateWithoutEnqueuerFailsClosed(t *testing.T) {
	store := &monthlyReportFakeStore{
		generated: &MonthlyReport{
			ID:          46,
			JobID:       103,
			ProjectID:   7,
			ProjectName: "Project A",
			Country:     "US",
			ReportMonth: "2026-10",
			Status:      MonthlyReportStatusPending,
			CreatedAt:   "2026-11-01T00:00:00Z",
			UpdatedAt:   "2026-11-01T00:00:00Z",
		},
	}
	router := monthlyReportRouter(store, audit.NewMockService())
	request := monthlyReportRequest(
		http.MethodPost,
		"/api/v1/monthly-reports/generate",
		`{"project_id":7,"report_month":"2026-10","transaction_file_id":"file-1"}`,
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing enqueuer status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if !store.failureCall.Called ||
		store.failureCall.ReportID != 46 ||
		store.failureCall.JobID != 103 {
		t.Fatalf("failure marker call = %#v", store.failureCall)
	}
}

func TestMonthlyReportFinancialSeriesIsOwnedByExactRoute(t *testing.T) {
	store := &monthlyReportFakeStore{
		detail: monthlyReportTestDetail(),
		series: &MonthlyFinancialSeriesResponse{
			ProjectID:   7,
			ProjectName: "Project A",
			StartMonth:  "2026-10",
			EndMonth:    "2026-10",
			Rows:        []MonthlyFinancialSeriesRow{},
			Trend:       MonthlyFinancialTrend{Points: []MonthlyFinancialTrendPoint{}},
		},
	}
	router := chi.NewRouter()
	NewRegistrar(store, audit.NewMockService()).RegisterRoutes(
		router,
		func(next http.Handler) http.Handler { return next },
	)
	router.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))

	request := monthlyReportRequest(
		http.MethodGet,
		"/api/v1/monthly-reports/financial-series?project_id=7",
		"",
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("financial-series owned status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
}

func monthlyReportStringPointer(value string) *string {
	return &value
}
