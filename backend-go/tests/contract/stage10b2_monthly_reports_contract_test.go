package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

const (
	stage10B2APIKey       = "stage10b2-api-key"
	stage10B2ProxySecret  = "stage10b2-proxy-secret"
	stage10B2ProjectName  = "Stage 10B2 Project"
	stage10B2ReportMonth  = "2026-10"
	stage10B2Transaction  = "transaction-file-1"
	stage10B2TaskEndpoint = "/api/v1/monthly-reports/tasks/99"
)

type stage10B2Store struct {
	monthly_reports.Store

	generated         *monthly_reports.MonthlyReport
	generateErr       error
	verifyErr         error
	generateInput     monthly_reports.MonthlyReportGenerateInput
	failureReportID   int64
	failureJobID      int64
	failureMessage    string
	failureMarkerHit  bool
	items             []monthly_reports.MonthlyReport
	listErr           error
	listFilter        monthly_reports.MonthlyReportListFilter
	series            *monthly_reports.MonthlyFinancialSeriesResponse
	seriesErr         error
	recalculateErr    error
	seriesFilter      monthly_reports.MonthlyFinancialSeriesFilter
	accounting        *monthly_reports.MonthlyFinancialAccountingDetailResponse
	accountingErr     error
	accountingFile    *monthly_reports.MonthlyReportExport
	accountingFileErr error
	accountingFilter  monthly_reports.MonthlyFinancialAccountingFilter
	task              *monthly_reports.MonthlyReportTask
	taskErr           error
	taskResult        *monthly_reports.MonthlyReportExport
	taskResultErr     error
	detail            *monthly_reports.MonthlyReportDetail
	detailErr         error
	reportFile        *monthly_reports.MonthlyReportExport
	reportFileErr     error
}

func (s *stage10B2Store) VerifyProjectAccess(
	context.Context,
	int64,
	string,
	bool,
) error {
	return s.verifyErr
}

func (s *stage10B2Store) Generate(
	_ context.Context,
	input monthly_reports.MonthlyReportGenerateInput,
) (*monthly_reports.MonthlyReport, error) {
	s.generateInput = input
	return s.generated, s.generateErr
}

func (s *stage10B2Store) List(
	_ context.Context,
	filter monthly_reports.MonthlyReportListFilter,
) ([]monthly_reports.MonthlyReport, error) {
	s.listFilter = filter
	return s.items, s.listErr
}

func (s *stage10B2Store) GetFinancialSeries(
	_ context.Context,
	filter monthly_reports.MonthlyFinancialSeriesFilter,
) (*monthly_reports.MonthlyFinancialSeriesResponse, error) {
	s.seriesFilter = filter
	return s.series, s.seriesErr
}

func (s *stage10B2Store) RecalculateFinancialSeries(
	_ context.Context,
	filter monthly_reports.MonthlyFinancialSeriesFilter,
) (*monthly_reports.MonthlyFinancialSeriesResponse, error) {
	s.seriesFilter = filter
	return s.series, s.recalculateErr
}

func (s *stage10B2Store) GetAccountingDetail(
	_ context.Context,
	filter monthly_reports.MonthlyFinancialAccountingFilter,
) (*monthly_reports.MonthlyFinancialAccountingDetailResponse, error) {
	s.accountingFilter = filter
	return s.accounting, s.accountingErr
}

func (s *stage10B2Store) ExportAccountingDetail(
	_ context.Context,
	filter monthly_reports.MonthlyFinancialAccountingFilter,
) (*monthly_reports.MonthlyReportExport, error) {
	s.accountingFilter = filter
	return s.accountingFile, s.accountingFileErr
}

func (s *stage10B2Store) GetTask(
	context.Context,
	int64,
) (*monthly_reports.MonthlyReportTask, error) {
	return s.task, s.taskErr
}

func (s *stage10B2Store) GetTaskResult(
	context.Context,
	int64,
) (*monthly_reports.MonthlyReportExport, error) {
	return s.taskResult, s.taskResultErr
}

func (s *stage10B2Store) GetReport(
	context.Context,
	int64,
) (*monthly_reports.MonthlyReportDetail, error) {
	return s.detail, s.detailErr
}

func (s *stage10B2Store) ExportReportFile(
	context.Context,
	int64,
) (*monthly_reports.MonthlyReportExport, error) {
	return s.reportFile, s.reportFileErr
}

func (s *stage10B2Store) MarkGenerationFailed(
	_ context.Context,
	reportID, jobID int64,
	message string,
) error {
	s.failureReportID = reportID
	s.failureJobID = jobID
	s.failureMessage = message
	s.failureMarkerHit = true
	return nil
}

type stage10B2Enqueuer struct {
	err  error
	jobs []int64
}

func (e *stage10B2Enqueuer) EnqueueRunJob(_ context.Context, jobID int64) error {
	e.jobs = append(e.jobs, jobID)
	return e.err
}

func stage10B2Router(
	t *testing.T,
	store monthly_reports.Store,
	enqueuer monthly_reports.JobEnqueuer,
) *chi.Mux {
	return stage10B2RouterWithAuditor(t, store, enqueuer, audit.NewMockService())
}

func stage10B2RouterWithAuditor(
	t *testing.T,
	store monthly_reports.Store,
	enqueuer monthly_reports.JobEnqueuer,
	auditor audit.Service,
) *chi.Mux {
	t.Helper()
	router := chi.NewRouter()
	registrar := monthly_reports.NewRegistrarWithEnqueuer(
		store,
		auditor,
		enqueuer,
	)
	registrar.RegisterRoutes(
		router,
		auth.RequireAPIKey(stage10B2APIKey, stage10B2ProxySecret, nil),
	)
	return router
}

func stage10B2Request(
	t *testing.T,
	router http.Handler,
	method, path string,
	body string,
	authenticated bool,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	if authenticated {
		request.Header.Set("X-API-Key", stage10B2APIKey)
		request.Header.Set(auth.TrustedProxySecretHeader, stage10B2ProxySecret)
		request.Header.Set("X-Operator", "alice")
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestStage10B2MonthlyReportsRouteInventory(t *testing.T) {
	router := stage10B2Router(t, &stage10B2Store{}, &stage10B2Enqueuer{})
	routes := make(map[string]struct{})
	err := chi.Walk(router, func(
		method string,
		route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		routes[method+" "+route] = struct{}{}
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}

	expected := []string{
		"GET /api/v1/monthly-reports",
		"POST /api/v1/monthly-reports",
		"POST /api/v1/monthly-reports/generate",
		"GET /api/v1/monthly-reports/financial-series",
		"GET /api/v1/monthly-reports/financial-series/accounting-detail",
		"GET /api/v1/monthly-reports/financial-series/accounting-detail/export",
		"POST /api/v1/monthly-reports/financial-series/recalculate",
		"GET /api/v1/monthly-reports/tasks/{task_id}",
		"GET /api/v1/monthly-reports/tasks/{task_id}/result",
		"GET /api/v1/monthly-reports/{report_id}",
		"GET /api/v1/monthly-reports/{report_id}/status",
		"POST /api/v1/monthly-reports/{report_id}/confirm",
		"GET /api/v1/monthly-reports/{report_id}/export",
		"GET /api/v1/monthly-reports/{report_id}/export/excel",
		"GET /api/v1/monthly-reports/{report_id}/export/pdf",
		"DELETE /api/v1/monthly-reports/{report_id}",
	}
	sort.Strings(expected)
	for _, route := range expected {
		if _, ok := routes[route]; !ok {
			t.Errorf("missing route %s", route)
		}
	}
}

func TestStage10B2MonthlyReportsAPIKeyAuth(t *testing.T) {
	router := stage10B2Router(t, &stage10B2Store{}, &stage10B2Enqueuer{})
	response := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/financial-series?project_id=7",
		"",
		false,
	)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", response.Code, response.Body.String())
	}
}

func TestStage10B2MonthlyReportsCanonicalCreate(t *testing.T) {
	store := &stage10B2Store{
		generated: &monthly_reports.MonthlyReport{
			ID:          42,
			JobID:       99,
			ProjectID:   7,
			ProjectName: stage10B2ProjectName,
			Country:     "US",
			ReportMonth: stage10B2ReportMonth,
			Status:      monthly_reports.MonthlyReportStatusPending,
			CreatedAt:   "2026-11-01T00:00:00Z",
		},
	}
	enqueuer := &stage10B2Enqueuer{}
	auditor := audit.NewMockService()
	router := stage10B2RouterWithAuditor(t, store, enqueuer, auditor)

	response := stage10B2Request(
		t,
		router,
		http.MethodPost,
		"/api/v1/monthly-reports",
		`{"project_id":7,"project_name":"Stage 10B2 Project","country":"US","report_month":"2026-10","transaction_file_id":"transaction-file-1","transaction_file_path":"/tmp/client.csv","async":false}`,
		true,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
	var body struct {
		JobID           int64   `json:"job_id"`
		MonthlyReportID *int64  `json:"monthly_report_id"`
		StatusEndpoint  *string `json:"status_endpoint"`
		ResultEndpoint  string  `json:"result_endpoint"`
		Status          string  `json:"status"`
		CreatedAt       *string `json:"created_at"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.JobID != 99 || body.MonthlyReportID != nil {
		t.Fatalf("unexpected create ids: %#v", body)
	}
	if body.StatusEndpoint == nil || *body.StatusEndpoint != stage10B2TaskEndpoint {
		t.Fatalf("status_endpoint = %#v, want %s", body.StatusEndpoint, stage10B2TaskEndpoint)
	}
	if body.ResultEndpoint != stage10B2TaskEndpoint+"/result" {
		t.Fatalf("result_endpoint = %q", body.ResultEndpoint)
	}
	if body.Status != monthly_reports.MonthlyReportStatusPending {
		t.Fatalf("status = %q", body.Status)
	}
	if body.CreatedAt == nil || *body.CreatedAt != "2026-11-01T00:00:00Z" {
		t.Fatalf("created_at = %#v", body.CreatedAt)
	}
	var rawBody map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &rawBody); err != nil {
		t.Fatalf("decode raw response: %v", err)
	}
	for _, key := range []string{
		"job_id",
		"monthly_report_id",
		"status_endpoint",
		"result_endpoint",
		"status",
		"created_at",
	} {
		if _, ok := rawBody[key]; !ok {
			t.Fatalf("create response missing %q: %#v", key, rawBody)
		}
	}
	if _, ok := rawBody["report_id"]; ok {
		t.Fatalf("legacy report_id leaked into canonical response: %#v", rawBody)
	}
	if store.generateInput.ProjectID == nil || *store.generateInput.ProjectID != 7 {
		t.Fatalf("project_id = %#v", store.generateInput.ProjectID)
	}
	if store.generateInput.ProjectName == nil ||
		*store.generateInput.ProjectName != stage10B2ProjectName {
		t.Fatalf("project_name = %#v", store.generateInput.ProjectName)
	}
	if !store.generateInput.Async {
		t.Fatalf("canonical create must ignore legacy async=false: %#v", store.generateInput)
	}
	if store.generateInput.TransactionFilePath != nil {
		t.Fatalf("canonical create trusted client path: %#v", store.generateInput.TransactionFilePath)
	}
	if len(enqueuer.jobs) != 1 || enqueuer.jobs[0] != 99 {
		t.Fatalf("enqueued jobs = %#v", enqueuer.jobs)
	}
	if len(auditor.Entries) != 1 ||
		auditor.Entries[0].Action != "monthly_reports.create" ||
		auditor.Entries[0].TargetType != "monthly_report_task" ||
		auditor.Entries[0].TargetID == nil ||
		*auditor.Entries[0].TargetID != "99" {
		t.Fatalf("create audit = %#v", auditor.Entries)
	}
}

func TestStage10B2MonthlyReportsCreateFailsClosedWithoutEnqueuer(t *testing.T) {
	store := &stage10B2Store{
		generated: &monthly_reports.MonthlyReport{
			ID:        42,
			JobID:     99,
			ProjectID: 7,
			Status:    monthly_reports.MonthlyReportStatusPending,
			CreatedAt: "2026-11-01T00:00:00Z",
		},
	}
	router := stage10B2Router(t, store, nil)
	response := stage10B2Request(
		t,
		router,
		http.MethodPost,
		"/api/v1/monthly-reports",
		`{"project_id":7,"project_name":"Stage 10B2 Project","report_month":"2026-10","transaction_file_id":"transaction-file-1"}`,
		true,
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", response.Code, response.Body.String())
	}
	if !store.failureMarkerHit ||
		store.failureReportID != 42 ||
		store.failureJobID != 99 ||
		!strings.Contains(store.failureMessage, "enqueuer") {
		t.Fatalf("failure marker = %#v", store)
	}
}

func TestStage10B2MonthlyReportsCreateEnqueueFailureIs503(t *testing.T) {
	store := &stage10B2Store{
		generated: &monthly_reports.MonthlyReport{
			ID:        42,
			JobID:     99,
			ProjectID: 7,
			Status:    monthly_reports.MonthlyReportStatusPending,
			CreatedAt: "2026-11-01T00:00:00Z",
		},
	}
	router := stage10B2Router(t, store, &stage10B2Enqueuer{err: errors.New("redis down")})
	response := stage10B2Request(
		t,
		router,
		http.MethodPost,
		"/api/v1/monthly-reports",
		`{"project_id":7,"project_name":"Stage 10B2 Project","report_month":"2026-10","transaction_file_id":"transaction-file-1"}`,
		true,
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", response.Code, response.Body.String())
	}
	if !store.failureMarkerHit || !strings.Contains(store.failureMessage, "redis down") {
		t.Fatalf("failure marker = %#v", store)
	}
}

func TestStage10B2MonthlyReportsCanonicalCreateValidation(t *testing.T) {
	store := &stage10B2Store{}
	router := stage10B2Router(t, store, &stage10B2Enqueuer{})
	cases := []string{
		`{"project_id":7,"report_month":"2026-10","transaction_file_id":"transaction-file-1"}`,
		`{"project_id":7,"project_name":"P","country":"","report_month":"2026-10","transaction_file_id":"transaction-file-1"}`,
		`{"project_id":7,"project_name":"P","country":null,"report_month":"2026-10","transaction_file_id":"transaction-file-1"}`,
		`{"project_id":7,"project_name":"P","report_month":"2026-10","transaction_file_id":""}`,
		`{"project_id":7,"project_name":"P","report_month":"2026-10","transaction_file_id":"transaction-file-1","summary_pdf_file_id":""}`,
		`{"project_id":7,"project_name":"P","report_month":"2026-1","transaction_file_id":"transaction-file-1"}`,
		`{"project_id":0,"project_name":"P","report_month":"2026-10","transaction_file_id":"transaction-file-1"}`,
	}
	for _, body := range cases {
		response := stage10B2Request(
			t,
			router,
			http.MethodPost,
			"/api/v1/monthly-reports",
			body,
			true,
		)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body=%s status = %d, want 422; response=%s", body, response.Code, response.Body.String())
		}
	}
	badSemanticValues := []string{
		`{"project_id":7,"project_name":"P","country":"XX","report_month":"2026-10","transaction_file_id":"transaction-file-1"}`,
		`{"project_id":7,"project_name":"P","report_month":"2026-13","transaction_file_id":"transaction-file-1"}`,
	}
	for _, body := range badSemanticValues {
		response := stage10B2Request(
			t,
			router,
			http.MethodPost,
			"/api/v1/monthly-reports",
			body,
			true,
		)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status = %d, want 400; response=%s", body, response.Code, response.Body.String())
		}
	}
}

func TestStage10B2MonthlyReportsListFiltersAndPagination(t *testing.T) {
	store := &stage10B2Store{
		items: []monthly_reports.MonthlyReport{{
			ID:          42,
			ProjectID:   7,
			ProjectName: stage10B2ProjectName,
			Country:     "US",
			ReportMonth: stage10B2ReportMonth,
			Status:      monthly_reports.MonthlyReportStatusCompleted,
		}},
	}
	router := stage10B2Router(t, store, &stage10B2Enqueuer{})
	response := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports?project_id=7&country=US&month=2026-10&include_history=true&limit=25&offset=50",
		"",
		true,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	if store.listFilter.ProjectID == nil || *store.listFilter.ProjectID != 7 {
		t.Fatalf("project filter = %#v", store.listFilter.ProjectID)
	}
	if store.listFilter.Country == nil || *store.listFilter.Country != "US" {
		t.Fatalf("country filter = %#v", store.listFilter.Country)
	}
	if store.listFilter.ReportMonth == nil || *store.listFilter.ReportMonth != "2026-10" {
		t.Fatalf("report_month filter = %#v", store.listFilter.ReportMonth)
	}
	if !store.listFilter.IncludeHistory ||
		store.listFilter.Limit == nil ||
		*store.listFilter.Limit != 25 ||
		store.listFilter.Offset != 50 {
		t.Fatalf("pagination filter = %#v", store.listFilter)
	}
	var items []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(items) != 1 || items[0]["status"] != "success" {
		t.Fatalf("unexpected list response: %#v", items)
	}

	invalid := []string{
		"/api/v1/monthly-reports?project_id=0",
		"/api/v1/monthly-reports?month=bad",
		"/api/v1/monthly-reports?include_history=not-bool",
		"/api/v1/monthly-reports?limit=0",
		"/api/v1/monthly-reports?offset=-1",
	}
	for _, path := range invalid {
		response = stage10B2Request(t, router, http.MethodGet, path, "", true)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d, want 422", path, response.Code)
		}
	}

	store.verifyErr = monthly_reports.ErrProjectForbidden
	response = stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports?project_id=7",
		"",
		true,
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden status = %d, want 403", response.Code)
	}
	store.verifyErr = monthly_reports.ErrProjectNotFound
	response = stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports?project_id=999",
		"",
		true,
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing project status = %d, want 404", response.Code)
	}
}

func TestStage10B2MonthlyReportsFinancialRoutes(t *testing.T) {
	series := &monthly_reports.MonthlyFinancialSeriesResponse{
		ProjectID:   7,
		ProjectName: stage10B2ProjectName,
		StartMonth:  "2026-09",
		EndMonth:    "2026-10",
		Rows: []monthly_reports.MonthlyFinancialSeriesRow{{
			ReportMonth:            "2026-10",
			IncomeSales:            1000,
			IncomeSalesWithTax:     1000,
			ExpenseTotal:           -200,
			AmazonPayBack:          800,
			IncomeTotal:            1000,
			CreditCardDeductionUSD: 12,
			FOBCostRMB:             300,
			FirstLegCostRMB:        20,
			HasSourceReport:        true,
		}, {
			ReportMonth: "2026-09",
		}},
		Trend: monthly_reports.MonthlyFinancialTrend{
			IncomeTotalSum:   1000,
			ExpenseTotalSum:  -200,
			AmazonPayBackSum: 800,
			NetAmountSum:     800,
			Points: []monthly_reports.MonthlyFinancialTrendPoint{{
				ReportMonth:     "2026-10",
				IncomeTotal:     1000,
				ExpenseTotal:    -200,
				AmazonPayBack:   800,
				NetAmount:       800,
				HasSourceReport: true,
			}},
		},
	}
	store := &stage10B2Store{series: series}
	router := stage10B2Router(t, store, &stage10B2Enqueuer{})

	response := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/financial-series?project_id=7&country=US&start_month=2026-09&end_month=2026-10&fill_missing=false",
		"",
		true,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("series status = %d, body=%s", response.Code, response.Body.String())
	}
	if store.seriesFilter.Country != "US" ||
		store.seriesFilter.StartMonth != "2026-09" ||
		store.seriesFilter.EndMonth != "2026-10" ||
		store.seriesFilter.FillMissing {
		t.Fatalf("series filter = %#v", store.seriesFilter)
	}
	var seriesBody map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &seriesBody); err != nil {
		t.Fatalf("decode series: %v", err)
	}
	if seriesBody["project_name"] != stage10B2ProjectName {
		t.Fatalf("series body = %#v", seriesBody)
	}
	rows, ok := seriesBody["rows"].([]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("series rows = %#v", seriesBody["rows"])
	}

	recalculate := stage10B2Request(
		t,
		router,
		http.MethodPost,
		"/api/v1/monthly-reports/financial-series/recalculate?project_id=7&country=US&start_month=2026-09&end_month=2026-10&fill_missing=false",
		"",
		true,
	)
	if recalculate.Code != http.StatusOK {
		t.Fatalf("recalculate status = %d, body=%s", recalculate.Code, recalculate.Body.String())
	}
	if !store.seriesFilter.FillMissing {
		t.Fatalf("recalculate filter = %#v, want fill_missing default true", store.seriesFilter)
	}

	invalidQueries := []string{
		"/api/v1/monthly-reports/financial-series",
		"/api/v1/monthly-reports/financial-series?project_id=7&fill_missing=bad",
		"/api/v1/monthly-reports/financial-series?project_id=7&start_month=2026-13",
	}
	for _, path := range invalidQueries {
		response = stage10B2Request(t, router, http.MethodGet, path, "", true)
		if response.Code != http.StatusUnprocessableEntity && response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400/422", path, response.Code)
		}
	}

	store.seriesErr = monthly_reports.ErrInvalidFinancialRange
	response = stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/financial-series?project_id=7&start_month=2026-10&end_month=2026-09",
		"",
		true,
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid range status = %d, want 400", response.Code)
	}

	store.seriesErr = nil
	store.verifyErr = monthly_reports.ErrProjectForbidden
	response = stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/financial-series?project_id=7",
		"",
		true,
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden series status = %d, want 403", response.Code)
	}
}

func TestStage10B2MonthlyReportsAccountingAndTaskRoutes(t *testing.T) {
	accounting := &monthly_reports.MonthlyFinancialAccountingDetailResponse{
		ProjectID:   7,
		ProjectName: stage10B2ProjectName,
		ReportMonth: stage10B2ReportMonth,
		Rows: []monthly_reports.MonthlyFinancialAccountingLine{{
			IncomeEN:         "Total_Income",
			IncomeZH:         "合计销售额",
			IncomeAmountUSD:  1000,
			ExpenseEN:        "Total_Expense",
			ExpenseZH:        "合计费用",
			ExpenseAmountUSD: -200,
			CurrencyCode:     stage10B2StringPointer("USD"),
			Kind:             "total",
		}},
	}
	task := &monthly_reports.MonthlyReportTask{
		TaskID:             99,
		Status:             "success",
		Stage:              "completed",
		Progress:           100,
		PersistenceStatus:  "success",
		PersistenceMessage: stage10B2StringPointer("后台同步完成：数据库已更新"),
		CreatedAt:          "2026-11-01T00:00:00Z",
		UpdatedAt:          "2026-11-01T00:01:00Z",
		ProjectID:          7,
	}
	store := &stage10B2Store{
		accounting: accounting,
		accountingFile: &monthly_reports.MonthlyReportExport{
			Filename:    "accounting-detail.xlsx",
			ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			Content:     []byte("PK\x03\x04stage10b2xlsx"),
			ProjectID:   7,
		},
		task: task,
		taskResult: &monthly_reports.MonthlyReportExport{
			Filename:    "result.xlsx",
			ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			Content:     []byte("PK\x03\x04task-result"),
			ProjectID:   7,
		},
	}
	auditor := audit.NewMockService()
	router := stage10B2RouterWithAuditor(t, store, &stage10B2Enqueuer{}, auditor)

	detail := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/financial-series/accounting-detail?project_id=7&country=US&report_month=2026-10",
		"",
		true,
	)
	if detail.Code != http.StatusOK {
		t.Fatalf("accounting status = %d, body=%s", detail.Code, detail.Body.String())
	}
	if store.accountingFilter.ReportMonth != "2026-10" {
		t.Fatalf("accounting filter = %#v", store.accountingFilter)
	}

	export := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/financial-series/accounting-detail/export?project_id=7&country=US&report_month=2026-10",
		"",
		true,
	)
	if export.Code != http.StatusOK {
		t.Fatalf("accounting export status = %d, body=%s", export.Code, export.Body.String())
	}
	if export.Header().Get("Content-Type") != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		!strings.Contains(export.Header().Get("Content-Disposition"), "accounting-detail.xlsx") ||
		!bytes.HasPrefix(export.Body.Bytes(), []byte("PK\x03\x04")) {
		t.Fatalf("accounting export headers=%v magic=%q", export.Header(), export.Body.Bytes())
	}

	taskResponse := stage10B2Request(
		t,
		router,
		http.MethodGet,
		stage10B2TaskEndpoint,
		"",
		true,
	)
	if taskResponse.Code != http.StatusOK {
		t.Fatalf("task status = %d, body=%s", taskResponse.Code, taskResponse.Body.String())
	}
	var taskBody map[string]any
	if err := json.Unmarshal(taskResponse.Body.Bytes(), &taskBody); err != nil {
		t.Fatalf("decode task: %v", err)
	}
	if taskBody["task_id"] != float64(99) || taskBody["status"] != "success" {
		t.Fatalf("task body = %#v", taskBody)
	}
	if _, leaked := taskBody["ProjectID"]; leaked {
		t.Fatalf("internal project field leaked: %#v", taskBody)
	}

	result := stage10B2Request(
		t,
		router,
		http.MethodGet,
		stage10B2TaskEndpoint+"/result",
		"",
		true,
	)
	if result.Code != http.StatusOK ||
		!bytes.HasPrefix(result.Body.Bytes(), []byte("PK\x03\x04task-result")) ||
		!strings.Contains(result.Header().Get("Content-Disposition"), "result.xlsx") {
		t.Fatalf("task result = %d headers=%v body=%q", result.Code, result.Header(), result.Body.Bytes())
	}
	if len(auditor.Entries) != 1 ||
		auditor.Entries[0].Action != "monthly_reports.result.export" ||
		auditor.Entries[0].TargetType != "monthly_report_task" {
		t.Fatalf("task result audit = %#v", auditor.Entries)
	}

	invalidAccounting := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/financial-series/accounting-detail?project_id=7&report_month=2026-1",
		"",
		true,
	)
	if invalidAccounting.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid accounting status = %d, want 422", invalidAccounting.Code)
	}

	store.taskResultErr = monthly_reports.ErrTaskNotFinished
	notFinished := stage10B2Request(
		t,
		router,
		http.MethodGet,
		stage10B2TaskEndpoint+"/result",
		"",
		true,
	)
	if notFinished.Code != http.StatusConflict {
		t.Fatalf("task not finished status = %d, want 409", notFinished.Code)
	}
	store.taskResultErr = nil
	store.task = nil
	missingTask := stage10B2Request(
		t,
		router,
		http.MethodGet,
		stage10B2TaskEndpoint,
		"",
		true,
	)
	if missingTask.Code != http.StatusNotFound {
		t.Fatalf("missing task status = %d, want 404", missingTask.Code)
	}
	invalidTask := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/tasks/not-a-number",
		"",
		true,
	)
	if invalidTask.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid task id status = %d, want 422", invalidTask.Code)
	}
	store.task = task
	store.verifyErr = monthly_reports.ErrProjectForbidden
	forbiddenTask := stage10B2Request(
		t,
		router,
		http.MethodGet,
		stage10B2TaskEndpoint,
		"",
		true,
	)
	if forbiddenTask.Code != http.StatusForbidden {
		t.Fatalf("forbidden task status = %d, want 403", forbiddenTask.Code)
	}
}

func TestStage10B2MonthlyReportsReportExportRoutes(t *testing.T) {
	store := &stage10B2Store{
		detail: &monthly_reports.MonthlyReportDetail{
			Report: monthly_reports.MonthlyReport{
				ID:          42,
				ProjectID:   7,
				ProjectName: stage10B2ProjectName,
				Status:      monthly_reports.MonthlyReportStatusCompleted,
			},
		},
		reportFile: &monthly_reports.MonthlyReportExport{
			Filename:    "monthly-report.xlsx",
			ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			Content:     []byte("PK\x03\x04monthly-report"),
			ProjectID:   7,
		},
	}
	auditor := audit.NewMockService()
	router := stage10B2RouterWithAuditor(t, store, &stage10B2Enqueuer{}, auditor)

	response := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/42/export",
		"",
		true,
	)
	if response.Code != http.StatusOK ||
		!bytes.HasPrefix(response.Body.Bytes(), []byte("PK\x03\x04")) ||
		!strings.Contains(response.Header().Get("Content-Disposition"), "monthly-report.xlsx") {
		t.Fatalf("report export = %d headers=%v body=%q", response.Code, response.Header(), response.Body.Bytes())
	}
	if len(auditor.Entries) != 1 ||
		auditor.Entries[0].Action != "monthly_reports.export" ||
		auditor.Entries[0].TargetType != "monthly_report" {
		t.Fatalf("report export audit = %#v", auditor.Entries)
	}

	store.reportFileErr = monthly_reports.ErrReportNotReady
	notReady := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/42/export",
		"",
		true,
	)
	if notReady.Code != http.StatusConflict {
		t.Fatalf("not ready export status = %d, want 409", notReady.Code)
	}
	store.reportFileErr = nil
	store.detailErr = monthly_reports.ErrReportNotFound
	missing := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/404/export",
		"",
		true,
	)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing export status = %d, want 404", missing.Code)
	}
	store.detailErr = nil
	store.verifyErr = monthly_reports.ErrProjectForbidden
	forbidden := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/42/export",
		"",
		true,
	)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("forbidden export status = %d, want 403", forbidden.Code)
	}
	invalidReport := stage10B2Request(
		t,
		router,
		http.MethodGet,
		"/api/v1/monthly-reports/not-a-number/export",
		"",
		true,
	)
	if invalidReport.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid report id status = %d, want 422", invalidReport.Code)
	}
}

func stage10B2StringPointer(value string) *string {
	return &value
}
