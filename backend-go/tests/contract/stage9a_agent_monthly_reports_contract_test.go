package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_monthly_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

type stage9ACredentialStore struct {
	row *agentauth.CredentialRow
}

func (s *stage9ACredentialStore) FindByHash(
	context.Context,
	string,
) (*agentauth.CredentialRow, error) {
	if s.row == nil {
		return nil, nil
	}
	row := *s.row
	return &row, nil
}

func (s *stage9ACredentialStore) TouchLastUsed(context.Context, int64, time.Time) error {
	return nil
}

type stage9AAuditor struct {
	mu      sync.Mutex
	entries []audit.Entry
}

func (a *stage9AAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.entries = append(a.entries, entry)
	return nil
}

func (a *stage9AAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	return a.LogAction(context.Background(), entry)
}

func (a *stage9AAuditor) LogView(
	context.Context,
	string,
	string,
	*string,
	any,
	*http.Request,
) error {
	return nil
}

type stage9ADispatcher struct {
	err   error
	calls []int64
}

func (d *stage9ADispatcher) EnqueueBuild(_ context.Context, buildID int64) error {
	d.calls = append(d.calls, buildID)
	return d.err
}

type stage9AFakeStore struct {
	agent_monthly_reports.Store

	mu sync.Mutex

	listErr        error
	reportErr      error
	exportErr      error
	reconcileErr   error
	uploadErr      error
	fileErr        error
	buildErr       error
	previewErr     error
	buildResultErr error
	confirmErr     error
	projectID      int64
	projectErr     error

	reports               []store.AgentMonthlyReportItem
	report                *store.AgentMonthlyReportDetail
	series                *store.AgentMonthlyFinancialSeriesResponse
	accounting            *store.AgentMonthlyFinancialAccountingDetailResponse
	accountFile           *store.AgentMonthlyFileResult
	reconciliationHistory *store.AgentMonthlyReconciliationHistory
	autoResult            map[string]any
	manualResult          map[string]any

	upload       *store.AgentMonthlyUpload
	uploadedFile *store.AgentMonthlyUploadedFile
	build        *store.AgentMonthlyBuild
	buildReplay  bool
	preview      *store.AgentMonthlyBuildPreview
	storedResult *store.AgentMonthlyStoredFile
	confirm      *store.AgentMonthlyConfirmResult

	auditEntries     []audit.Entry
	lastUploadCreate store.AgentMonthlyUploadCreateInput
	lastUploadFile   store.AgentMonthlyUploadFileInput
	lastBuildCreate  store.AgentMonthlyBuildCreateInput
	lastConfirm      store.AgentMonthlyBuildConfirmInput
	lastAuto         store.AgentMonthlyAutoReconcileInput
	lastManual       store.AgentMonthlyManualReconcileInput
	dispatchFailures []int64
	confirmed        bool
}

func (s *stage9AFakeStore) ListAgentMonthlyReports(
	_ context.Context,
	filter store.AgentMonthlyReportListFilter,
) ([]store.AgentMonthlyReportItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listErr != nil {
		return nil, s.listErr
	}
	items := make([]store.AgentMonthlyReportItem, 0, len(s.reports))
	for _, item := range s.reports {
		if item.ProjectID == filter.ProjectID {
			items = append(items, item)
		}
	}
	return items, nil
}

func (s *stage9AFakeStore) GetAgentMonthlyReport(
	_ context.Context,
	_ int64,
) (*store.AgentMonthlyReportDetail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.report, s.reportErr
}

func (s *stage9AFakeStore) ExportAgentMonthlyReport(
	_ context.Context,
	_ int64,
	entry audit.Entry,
) (*store.AgentMonthlyStoredFile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry.Action = "agent_monthly_reports.result.export"
	s.auditEntries = append(s.auditEntries, entry)
	return s.storedResult, s.exportErr
}

func (s *stage9AFakeStore) GetAgentMonthlyReportProjectID(
	_ context.Context,
	_ int64,
) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.projectErr != nil {
		return 0, s.projectErr
	}
	return s.projectID, nil
}

func (s *stage9AFakeStore) GetAgentMonthlyFinancialSeries(
	_ context.Context,
	_ store.AgentMonthlyFinancialSeriesFilter,
) (*store.AgentMonthlyFinancialSeriesResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.series, s.reconcileErr
}

func (s *stage9AFakeStore) GetAgentMonthlyAccountingDetail(
	_ context.Context,
	_ store.AgentMonthlyAccountingFilter,
) (*store.AgentMonthlyFinancialAccountingDetailResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accounting, s.reportErr
}

func (s *stage9AFakeStore) ExportAgentMonthlyAccountingDetail(
	_ context.Context,
	_ store.AgentMonthlyAccountingFilter,
	entry audit.Entry,
) (*store.AgentMonthlyFileResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry.Action = "agent_monthly_reports.accounting_detail.export"
	s.auditEntries = append(s.auditEntries, entry)
	return s.accountFile, s.exportErr
}

func (s *stage9AFakeStore) GetAgentMonthlyReconciliationHistory(
	_ context.Context,
	_ int64,
	_ int,
	_ int,
) (*store.AgentMonthlyReconciliationHistory, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reconciliationHistory, s.reconcileErr
}

func (s *stage9AFakeStore) AutoReconcileAgentMonthlyReport(
	_ context.Context,
	input store.AgentMonthlyAutoReconcileInput,
	entry audit.Entry,
) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastAuto = input
	entry.Action = "agent_monthly_reports.reconciliation.auto"
	s.auditEntries = append(s.auditEntries, entry)
	return s.autoResult, s.reconcileErr
}

func (s *stage9AFakeStore) ManualReconcileAgentMonthlyReport(
	_ context.Context,
	input store.AgentMonthlyManualReconcileInput,
	entry audit.Entry,
) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastManual = input
	entry.Action = "agent_monthly_reports.reconciliation.manual"
	s.auditEntries = append(s.auditEntries, entry)
	return s.manualResult, s.reconcileErr
}

func (s *stage9AFakeStore) CreateAgentMonthlyUpload(
	_ context.Context,
	input store.AgentMonthlyUploadCreateInput,
	entry audit.Entry,
) (*store.AgentMonthlyUpload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastUploadCreate = input
	entry.Action = "agent_monthly_reports.upload.create"
	s.auditEntries = append(s.auditEntries, entry)
	return s.upload, s.uploadErr
}

func (s *stage9AFakeStore) GetAgentMonthlyUpload(
	_ context.Context,
	_ int64,
	_ int64,
) (*store.AgentMonthlyUpload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.upload, s.uploadErr
}

func (s *stage9AFakeStore) UploadAgentMonthlyFile(
	_ context.Context,
	input store.AgentMonthlyUploadFileInput,
	entry audit.Entry,
) (*store.AgentMonthlyUploadedFile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastUploadFile = input
	entry.Action = "agent_monthly_reports.upload.file"
	s.auditEntries = append(s.auditEntries, entry)
	return s.uploadedFile, s.fileErr
}

func (s *stage9AFakeStore) CreateAgentMonthlyBuild(
	_ context.Context,
	input store.AgentMonthlyBuildCreateInput,
	entry audit.Entry,
) (*store.AgentMonthlyBuild, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastBuildCreate = input
	entry.Action = "agent_monthly_reports.build"
	s.auditEntries = append(s.auditEntries, entry)
	return s.build, s.buildReplay, s.buildErr
}

func (s *stage9AFakeStore) GetAgentMonthlyBuild(
	_ context.Context,
	_ int64,
	_ int64,
) (*store.AgentMonthlyBuild, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.build, s.buildErr
}

func (s *stage9AFakeStore) GetAgentMonthlyBuildPreview(
	_ context.Context,
	_ int64,
	_ int64,
) (*store.AgentMonthlyBuildPreview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.preview, s.previewErr
}

func (s *stage9AFakeStore) GetAgentMonthlyBuildResult(
	_ context.Context,
	_ int64,
	_ int64,
) (*store.AgentMonthlyStoredFile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.storedResult, s.buildResultErr
}

func (s *stage9AFakeStore) MarkAgentMonthlyBuildDispatchFailed(
	_ context.Context,
	buildID int64,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dispatchFailures = append(s.dispatchFailures, buildID)
	return nil
}

func (s *stage9AFakeStore) ConfirmAgentMonthlyBuild(
	_ context.Context,
	input store.AgentMonthlyBuildConfirmInput,
	entry audit.Entry,
) (*store.AgentMonthlyConfirmResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastConfirm = input
	entry.Action = "agent_monthly_reports.confirm"
	s.auditEntries = append(s.auditEntries, entry)
	s.confirmed = true
	return s.confirm, s.confirmErr
}

func (s *stage9AFakeStore) GetAgentMonthlyConfirmReplay(
	_ context.Context,
	input store.AgentMonthlyBuildConfirmInput,
) (*store.AgentMonthlyConfirmResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.confirmed || s.confirm == nil || input.IdempotencyKey != "confirm-key" {
		return nil, nil
	}
	result := *s.confirm
	result.Replayed = true
	return &result, nil
}

func stage9ACredentials(t *testing.T, businessScope, projectScope string) *stage9ACredentialStore {
	t.Helper()
	return &stage9ACredentialStore{row: &agentauth.CredentialRow{
		KeyID:         11,
		AgentID:       "agent-stage9a",
		Label:         "Stage 9A Agent",
		BusinessScope: businessScope,
		ProjectScope:  projectScope,
	}}
}

func stage9ARouter(
	t *testing.T,
	storeValue agent_monthly_reports.Store,
	credentials agentauth.CredentialStore,
	confirmStore agentauth.ConfirmStore,
	dispatcher agent_monthly_reports.BuildDispatcher,
) *chi.Mux {
	t.Helper()
	return stage9ARouterWithLimiters(
		t,
		storeValue,
		credentials,
		confirmStore,
		dispatcher,
		nil,
		nil,
	)
}

func stage9ARouterWithLimiters(
	t *testing.T,
	storeValue agent_monthly_reports.Store,
	credentials agentauth.CredentialStore,
	confirmStore agentauth.ConfirmStore,
	dispatcher agent_monthly_reports.BuildDispatcher,
	readLimiter agentauth.RateLimiter,
	writeLimiter agentauth.RateLimiter,
) *chi.Mux {
	t.Helper()
	auditor := &stage9AAuditor{}
	registrar := agent_monthly_reports.NewRegistrar(storeValue, auditor, agent_monthly_reports.Options{
		Credentials:  credentials,
		ConfirmStore: confirmStore,
		Dispatcher:   dispatcher,
		ReadLimiter:  readLimiter,
		WriteLimiter: writeLimiter,
		Now:          func() time.Time { return time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC) },
		MaxFileBytes: 1024,
		UploadTTL:    24 * time.Hour,
	})
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)
	return router
}

func stage9ARequest(
	router http.Handler,
	method string,
	path string,
	body io.Reader,
	headers map[string]string,
	authenticated bool,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, body)
	if authenticated {
		request.Header.Set("Authorization", "Bearer stage9a-secret")
		request.Header.Set("X-Agent-Id", "agent-stage9a")
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func stage9AMultipart(
	t *testing.T,
	path string,
	fields map[string]string,
	filename string,
	content []byte,
) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("write multipart field: %v", err)
		}
	}
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create multipart file: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &body, writer.FormDataContentType()
}

type stage9AFilePart struct {
	filename string
	content  []byte
}

func stage9AMultipartFiles(
	t *testing.T,
	fields map[string]string,
	files map[string]stage9AFilePart,
) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("write multipart field: %v", err)
		}
	}
	for field, file := range files {
		part, err := writer.CreateFormFile(field, file.filename)
		if err != nil {
			t.Fatalf("create multipart file: %v", err)
		}
		if _, err := part.Write(file.content); err != nil {
			t.Fatalf("write multipart file: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &body, writer.FormDataContentType()
}

func stage9AObject(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("decode JSON %s: %v", payload, err)
	}
	return value
}

func stage9AData(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	body := stage9AObject(t, response.Body.Bytes())
	if body["ok"] != true {
		t.Fatalf("ok = %#v, body=%s", body["ok"], response.Body.String())
	}
	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %#v", body["data"])
	}
	return data
}

func stage9AAuditEntry(
	t *testing.T,
	fake *stage9AFakeStore,
	action string,
) audit.Entry {
	t.Helper()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	for index := len(fake.auditEntries) - 1; index >= 0; index-- {
		if fake.auditEntries[index].Action == action {
			return fake.auditEntries[index]
		}
	}
	t.Fatalf("audit action %q not found in %#v", action, fake.auditEntries)
	return audit.Entry{}
}

func stage9AFixture() (*stage9AFakeStore, *store.AgentMonthlyReportDetail) {
	now := time.Date(2026, 11, 8, 9, 30, 0, 0, time.UTC)
	calculationVersion := 1
	item := store.AgentMonthlyReportItem{
		ID:                 41,
		ProjectID:          7,
		ProjectName:        "Project A",
		Country:            "US",
		ReportMonth:        "2026-10",
		Version:            1,
		IsCurrent:          true,
		Status:             "success",
		TotalTransactions:  3,
		CalculationVersion: 1,
		CreatedAt:          &now,
		UpdatedAt:          &now,
	}
	detail := &store.AgentMonthlyReportDetail{
		Report: item,
		PT3:    map[string]float64{"income_total": 12.34},
		PT4:    map[string]float64{"income_total": 12.34},
	}
	build := &store.AgentMonthlyBuild{
		ID:                 9,
		UploadID:           4,
		AgentKeyID:         11,
		AgentID:            "agent-stage9a",
		Status:             "success",
		ProjectID:          7,
		ProjectName:        "Project A",
		Country:            "US",
		ReportMonth:        "2026-10",
		InputSHA256:        strings.Repeat("a", 64),
		CalculationVersion: &calculationVersion,
		ExpiresAt:          now.Add(24 * time.Hour),
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	expires := now.Add(24 * time.Hour)
	upload := &store.AgentMonthlyUpload{
		ID:          4,
		AgentKeyID:  11,
		AgentID:     "agent-stage9a",
		ProjectID:   7,
		ProjectName: "Project A",
		Country:     "US",
		ReportMonth: "2026-10",
		Status:      "built",
		ExpiresAt:   expires,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	fake := &stage9AFakeStore{
		projectID: 7,
		reports:   []store.AgentMonthlyReportItem{item},
		report:    detail,
		series: &store.AgentMonthlyFinancialSeriesResponse{
			ProjectID:   7,
			ProjectName: "Project A",
			StartMonth:  "2026-10",
			EndMonth:    "2026-10",
			Rows:        []store.AgentMonthlyFinancialSeriesRow{},
			Trend: store.AgentMonthlyFinancialTrend{
				Points: []store.AgentMonthlyFinancialTrendPoint{},
			},
		},
		accounting: &store.AgentMonthlyFinancialAccountingDetailResponse{
			ProjectID:   7,
			ProjectName: "Project A",
			ReportMonth: "2026-10",
			Rows:        []store.AgentMonthlyFinancialAccountingLine{},
		},
		accountFile: &store.AgentMonthlyFileResult{
			Filename:    "accounting.xlsx",
			ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			Content:     []byte("xlsx-accounting"),
		},
		reconciliationHistory: &store.AgentMonthlyReconciliationHistory{
			Records: []store.AgentMonthlyReconciliationRecord{},
			Total:   0,
			Limit:   50,
			Offset:  0,
		},
		autoResult: map[string]any{
			"record_id":   101,
			"match_rate":  100.0,
			"total_items": 9,
		},
		manualResult: map[string]any{
			"record_id":   102,
			"match_rate":  98.0,
			"total_items": 9,
		},
		upload: upload,
		uploadedFile: &store.AgentMonthlyUploadedFile{
			UploadID:         4,
			FileID:           "file-csv",
			Kind:             "transaction_csv",
			OriginalFilename: "transactions.csv",
			SHA256:           strings.Repeat("b", 64),
			SizeBytes:        123,
			Validation:       map[string]any{"rows": 3},
		},
		build: build,
		preview: &store.AgentMonthlyBuildPreview{
			Build:             build,
			TransactionsCount: 3,
			PT3:               map[string]string{"income_total": "12.34"},
			PT4:               map[string]string{"income_total": "12.34"},
		},
		storedResult: &store.AgentMonthlyStoredFile{
			Path:        "/tmp/result.xlsx",
			Filename:    "result.xlsx",
			ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		},
		confirm: &store.AgentMonthlyConfirmResult{
			BuildID:     9,
			ReportID:    41,
			Replayed:    false,
			ProjectID:   7,
			ProjectName: "Project A",
			Country:     "US",
			ReportMonth: "2026-10",
			Version:     1,
			IsCurrent:   true,
			Status:      "success",
			ConfirmedAt: &now,
		},
	}
	return fake, detail
}

func TestStage9AAgentMonthlyReportsRouteInventory(t *testing.T) {
	fake, _ := stage9AFixture()
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	want := []string{
		"GET /api/v1/agent/monthly-reports",
		"POST /api/v1/agent/monthly-reports/builds",
		"GET /api/v1/agent/monthly-reports/builds/{build_id}",
		"POST /api/v1/agent/monthly-reports/builds/{build_id}/confirm",
		"GET /api/v1/agent/monthly-reports/builds/{build_id}/preview",
		"GET /api/v1/agent/monthly-reports/builds/{build_id}/result",
		"GET /api/v1/agent/monthly-reports/financial-series",
		"GET /api/v1/agent/monthly-reports/financial-series/accounting-detail",
		"GET /api/v1/agent/monthly-reports/financial-series/accounting-detail/export",
		"POST /api/v1/agent/monthly-reports/uploads",
		"POST /api/v1/agent/monthly-reports/uploads/{upload_id}/files",
		"GET /api/v1/agent/monthly-reports/{report_id}",
		"GET /api/v1/agent/monthly-reports/{report_id}/export",
		"GET /api/v1/agent/monthly-reports/{report_id}/reconciliation",
		"POST /api/v1/agent/monthly-reports/{report_id}/reconciliation/auto",
		"POST /api/v1/agent/monthly-reports/{report_id}/reconciliation/manual",
	}
	var got []string
	if err := chi.Walk(router, func(
		method string,
		route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		got = append(got, method+" "+route)
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("routes mismatch\ngot:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestStage9AAgentMonthlyReportsAuthAndScope(t *testing.T) {
	fake, _ := stage9AFixture()
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	unauthorized := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports?project_id=7",
		nil,
		nil,
		false,
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want 401", unauthorized.Code)
	}

	otherRouter := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "sales", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)
	forbiddenBusiness := stage9ARequest(
		otherRouter,
		http.MethodGet,
		"/api/v1/agent/monthly-reports?project_id=7",
		nil,
		nil,
		true,
	)
	if forbiddenBusiness.Code != http.StatusForbidden {
		t.Fatalf("business scope status = %d, want 403", forbiddenBusiness.Code)
	}

	projectLimited := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "8"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)
	forbiddenProject := stage9ARequest(
		projectLimited,
		http.MethodGet,
		"/api/v1/agent/monthly-reports?project_id=7",
		nil,
		nil,
		true,
	)
	if forbiddenProject.Code != http.StatusForbidden {
		t.Fatalf("project scope status = %d, want 403", forbiddenProject.Code)
	}

	invalidProject := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports?project_id=0",
		nil,
		nil,
		true,
	)
	if invalidProject.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid project status = %d, want 422", invalidProject.Code)
	}
}

func TestStage9AAgentMonthlyReportsRateLimits(t *testing.T) {
	fake, _ := stage9AFixture()
	clock := func() time.Time {
		return time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	}
	readLimiter := agentauth.NewMemoryRateLimiter(
		agentauth.RateLimit{Requests: 1, Window: time.Minute},
		agentauth.WithMemoryRateLimitClock(clock),
	)
	writeLimiter := agentauth.NewMemoryRateLimiter(
		agentauth.RateLimit{Requests: 1, Window: time.Minute},
		agentauth.WithMemoryRateLimitClock(clock),
	)
	router := stage9ARouterWithLimiters(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
		readLimiter,
		writeLimiter,
	)

	firstRead := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports?project_id=7",
		nil,
		nil,
		true,
	)
	if firstRead.Code != http.StatusOK {
		t.Fatalf("first read = %d, body=%s", firstRead.Code, firstRead.Body.String())
	}
	secondRead := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports?project_id=7",
		nil,
		nil,
		true,
	)
	if secondRead.Code != http.StatusTooManyRequests {
		t.Fatalf("second read = %d, body=%s", secondRead.Code, secondRead.Body.String())
	}
	if secondRead.Header().Get("Retry-After") == "" {
		t.Fatal("rate-limited read did not include Retry-After")
	}

	firstWrite := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads",
		strings.NewReader(`{"project_id":7,"country":"US","report_month":"2026-10"}`),
		map[string]string{"Content-Type": "application/json"},
		true,
	)
	if firstWrite.Code != http.StatusOK {
		t.Fatalf("first write = %d, body=%s", firstWrite.Code, firstWrite.Body.String())
	}
	secondWrite := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads",
		strings.NewReader(`{"project_id":7,"country":"US","report_month":"2026-10"}`),
		map[string]string{"Content-Type": "application/json"},
		true,
	)
	if secondWrite.Code != http.StatusTooManyRequests {
		t.Fatalf("second write = %d, body=%s", secondWrite.Code, secondWrite.Body.String())
	}
}

func TestStage9AAgentMonthlyReportsResourceScopeSizeAndDependencies(t *testing.T) {
	fake, _ := stage9AFixture()
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	outOfScopeUpload := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads",
		strings.NewReader(`{"project_id":8,"country":"US","report_month":"2026-10"}`),
		map[string]string{
			"Content-Type": "application/json",
			"X-User-Id":    "1",
			"X-Is-Admin":   "true",
		},
		true,
	)
	if outOfScopeUpload.Code != http.StatusForbidden {
		t.Fatalf("out-of-scope upload = %d, body=%s", outOfScopeUpload.Code, outOfScopeUpload.Body.String())
	}

	fake.upload.ProjectID = 8
	outOfScopeBuild := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds",
		strings.NewReader(`{"upload_id":4,"transaction_file_id":"file-csv"}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "build-scope-key",
		},
		true,
	)
	if outOfScopeBuild.Code != http.StatusForbidden {
		t.Fatalf("out-of-scope build = %d, body=%s", outOfScopeBuild.Code, outOfScopeBuild.Body.String())
	}

	fake.uploadErr = store.ErrAgentMonthlyNotFound
	crossCredentialBuild := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds",
		strings.NewReader(`{"upload_id":4,"transaction_file_id":"file-csv"}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "build-cross-credential-key",
		},
		true,
	)
	if crossCredentialBuild.Code != http.StatusNotFound {
		t.Fatalf(
			"cross-credential build = %d, body=%s",
			crossCredentialBuild.Code,
			crossCredentialBuild.Body.String(),
		)
	}

	fake.uploadErr = nil
	fake.upload.ProjectID = 7
	oversizeBody, oversizeContentType := stage9AMultipart(
		t,
		"/api/v1/agent/monthly-reports/uploads/4/files",
		map[string]string{"kind": "transaction_csv"},
		"oversize.csv",
		bytes.Repeat([]byte("a"), 2048),
	)
	oversizeUpload := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads/4/files",
		oversizeBody,
		map[string]string{"Content-Type": oversizeContentType},
		true,
	)
	if oversizeUpload.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize upload = %d, body=%s", oversizeUpload.Code, oversizeUpload.Body.String())
	}

	fake.listErr = store.ErrAgentMonthlyDependency
	dependencyFailure := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports?project_id=7",
		nil,
		nil,
		true,
	)
	if dependencyFailure.Code != http.StatusServiceUnavailable {
		t.Fatalf(
			"dependency failure = %d, body=%s",
			dependencyFailure.Code,
			dependencyFailure.Body.String(),
		)
	}

	missingConfirmStore := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		nil,
		&stage9ADispatcher{},
	)
	confirmDependencyFailure := stage9ARequest(
		missingConfirmStore,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds/9/confirm",
		strings.NewReader(`{}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "missing-confirm-store-key",
		},
		true,
	)
	if confirmDependencyFailure.Code != http.StatusServiceUnavailable {
		t.Fatalf(
			"confirm dependency failure = %d, body=%s",
			confirmDependencyFailure.Code,
			confirmDependencyFailure.Body.String(),
		)
	}
}

func TestStage9AAgentMonthlyReportsWriteAndExportAudit(t *testing.T) {
	fake, _ := stage9AFixture()
	exportPath := filepath.Join(t.TempDir(), "audit-result.xlsx")
	if err := os.WriteFile(exportPath, []byte("PK\x03\x04audit"), 0o600); err != nil {
		t.Fatalf("write export fixture: %v", err)
	}
	fake.storedResult.Path = exportPath
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	createUpload := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads",
		strings.NewReader(`{"project_id":7,"country":"US","report_month":"2026-10"}`),
		map[string]string{"Content-Type": "application/json"},
		true,
	)
	if createUpload.Code != http.StatusOK {
		t.Fatalf("create upload = %d, body=%s", createUpload.Code, createUpload.Body.String())
	}
	uploadEntry := stage9AAuditEntry(t, fake, "agent_monthly_reports.upload.create")
	if uploadEntry.AgentID == nil || *uploadEntry.AgentID != "agent-stage9a" {
		t.Fatalf("upload audit agent id = %#v", uploadEntry.AgentID)
	}

	fileBody, fileContentType := stage9AMultipart(
		t,
		"/api/v1/agent/monthly-reports/uploads/4/files",
		map[string]string{"kind": "transaction_csv"},
		"transactions.csv",
		[]byte("type,quantity,total\nOrder,1,10\n"),
	)
	uploadFile := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads/4/files",
		fileBody,
		map[string]string{"Content-Type": fileContentType},
		true,
	)
	if uploadFile.Code != http.StatusOK {
		t.Fatalf("upload file = %d, body=%s", uploadFile.Code, uploadFile.Body.String())
	}
	fileEntry := stage9AAuditEntry(t, fake, "agent_monthly_reports.upload.file")
	if fileEntry.AgentID == nil || *fileEntry.AgentID != "agent-stage9a" {
		t.Fatalf("upload file audit agent id = %#v", fileEntry.AgentID)
	}

	createBuild := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds",
		strings.NewReader(`{"upload_id":4,"transaction_file_id":"file-csv"}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "audit-build-key",
		},
		true,
	)
	if createBuild.Code != http.StatusAccepted {
		t.Fatalf("create build = %d, body=%s", createBuild.Code, createBuild.Body.String())
	}
	buildEntry := stage9AAuditEntry(t, fake, "agent_monthly_reports.build")
	if buildEntry.AgentID == nil || *buildEntry.AgentID != "agent-stage9a" {
		t.Fatalf("build audit agent id = %#v", buildEntry.AgentID)
	}
	if buildEntry.IdempotencyKey == nil || *buildEntry.IdempotencyKey != "audit-build-key" {
		t.Fatalf("build audit idempotency = %#v", buildEntry.IdempotencyKey)
	}

	accountingExport := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/financial-series/accounting-detail/export?project_id=7&country=US&report_month=2026-10",
		nil,
		nil,
		true,
	)
	if accountingExport.Code != http.StatusOK {
		t.Fatalf(
			"accounting export = %d, body=%s",
			accountingExport.Code,
			accountingExport.Body.String(),
		)
	}
	accountingEntry := stage9AAuditEntry(
		t,
		fake,
		"agent_monthly_reports.accounting_detail.export",
	)
	if accountingEntry.AgentID == nil || *accountingEntry.AgentID != "agent-stage9a" {
		t.Fatalf("accounting audit agent id = %#v", accountingEntry.AgentID)
	}

	reportExport := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/41/export",
		nil,
		nil,
		true,
	)
	if reportExport.Code != http.StatusOK {
		t.Fatalf("report export = %d, body=%s", reportExport.Code, reportExport.Body.String())
	}
	resultEntry := stage9AAuditEntry(t, fake, "agent_monthly_reports.result.export")
	if resultEntry.AgentID == nil || *resultEntry.AgentID != "agent-stage9a" {
		t.Fatalf("result audit agent id = %#v", resultEntry.AgentID)
	}
}

func TestStage9AAgentMonthlyReportsReadAndExportRoutes(t *testing.T) {
	fake, _ := stage9AFixture()
	exportPath := filepath.Join(t.TempDir(), "result.xlsx")
	if err := os.WriteFile(exportPath, []byte("PK\x03\x04result"), 0o600); err != nil {
		t.Fatalf("write result fixture: %v", err)
	}
	fake.storedResult.Path = exportPath
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	list := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports?project_id=7&country=US&month=2026-10",
		nil,
		nil,
		true,
	)
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d, body=%s", list.Code, list.Body.String())
	}
	var listBody struct {
		OK   bool                           `json:"ok"`
		Data []store.AgentMonthlyReportItem `json:"data"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if !listBody.OK || len(listBody.Data) != 1 || listBody.Data[0].ResultFilePath != nil {
		t.Fatalf("unexpected list response: %#v", listBody)
	}

	series := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/financial-series?project_id=7&country=US&start_month=2026-10&end_month=2026-10",
		nil,
		nil,
		true,
	)
	if series.Code != http.StatusOK {
		t.Fatalf("series status = %d, body=%s", series.Code, series.Body.String())
	}

	accounting := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/financial-series/accounting-detail?project_id=7&country=US&report_month=2026-10",
		nil,
		nil,
		true,
	)
	if accounting.Code != http.StatusOK {
		t.Fatalf("accounting status = %d, body=%s", accounting.Code, accounting.Body.String())
	}

	accountingExport := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/financial-series/accounting-detail/export?project_id=7&country=US&report_month=2026-10",
		nil,
		nil,
		true,
	)
	if accountingExport.Code != http.StatusOK ||
		accountingExport.Header().Get("Content-Type") !=
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		!strings.Contains(accountingExport.Header().Get("Content-Disposition"), "accounting.xlsx") {
		t.Fatalf("accounting export = %d headers=%v", accountingExport.Code, accountingExport.Header())
	}

	detail := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/41",
		nil,
		nil,
		true,
	)
	if detail.Code != http.StatusOK {
		t.Fatalf("detail status = %d, body=%s", detail.Code, detail.Body.String())
	}

	reportExport := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/41/export",
		nil,
		nil,
		true,
	)
	if reportExport.Code != http.StatusOK {
		t.Fatalf("report export status = %d, body=%s", reportExport.Code, reportExport.Body.String())
	}

	reconciliation := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/41/reconciliation?limit=50&offset=0",
		nil,
		nil,
		true,
	)
	if reconciliation.Code != http.StatusOK {
		t.Fatalf("reconciliation status = %d, body=%s", reconciliation.Code, reconciliation.Body.String())
	}
}

func TestStage9AAgentMonthlyReportsUploadAndBuildRoutes(t *testing.T) {
	fake, _ := stage9AFixture()
	buildResultPath := filepath.Join(t.TempDir(), "build-result.xlsx")
	if err := os.WriteFile(buildResultPath, []byte("PK\x03\x04build"), 0o600); err != nil {
		t.Fatalf("write build result fixture: %v", err)
	}
	fake.storedResult.Path = buildResultPath
	dispatcher := &stage9ADispatcher{}
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		dispatcher,
	)

	createUpload := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads",
		strings.NewReader(`{"project_id":7,"country":"US","report_month":"2026-10"}`),
		map[string]string{"Content-Type": "application/json"},
		true,
	)
	if createUpload.Code != http.StatusOK {
		t.Fatalf("create upload = %d, body=%s", createUpload.Code, createUpload.Body.String())
	}
	uploadData := stage9AData(t, createUpload)
	if uploadData["upload_id"] != float64(4) {
		t.Fatalf("upload_id = %#v", uploadData["upload_id"])
	}

	fileBody, contentType := stage9AMultipart(
		t,
		"/api/v1/agent/monthly-reports/uploads/4/files",
		map[string]string{"kind": "transaction_csv"},
		"transactions.csv",
		[]byte("type,quantity,total\nOrder,1,10\n"),
	)
	uploadFile := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads/4/files",
		fileBody,
		map[string]string{
			"Content-Type": contentType,
			"X-Agent-Id":   "agent-stage9a",
		},
		true,
	)
	if uploadFile.Code != http.StatusOK {
		t.Fatalf("upload file = %d, body=%s", uploadFile.Code, uploadFile.Body.String())
	}

	missingIdempotency := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds",
		strings.NewReader(`{"upload_id":4,"transaction_file_id":"file-csv"}`),
		map[string]string{"Content-Type": "application/json"},
		true,
	)
	if missingIdempotency.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing idempotency = %d, body=%s", missingIdempotency.Code, missingIdempotency.Body.String())
	}

	createBuild := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds",
		strings.NewReader(`{"upload_id":4,"transaction_file_id":"file-csv"}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "build-key",
		},
		true,
	)
	if createBuild.Code != http.StatusAccepted {
		t.Fatalf("create build = %d, body=%s", createBuild.Code, createBuild.Body.String())
	}
	if len(dispatcher.calls) != 1 || dispatcher.calls[0] != 9 {
		t.Fatalf("dispatcher calls = %#v", dispatcher.calls)
	}
	if fake.lastBuildCreate.IdempotencyKey != "build-key" {
		t.Fatalf("idempotency key = %q", fake.lastBuildCreate.IdempotencyKey)
	}

	buildGet := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/builds/9",
		nil,
		nil,
		true,
	)
	if buildGet.Code != http.StatusOK {
		t.Fatalf("get build = %d, body=%s", buildGet.Code, buildGet.Body.String())
	}
	preview := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/builds/9/preview",
		nil,
		nil,
		true,
	)
	if preview.Code != http.StatusOK {
		t.Fatalf("preview = %d, body=%s", preview.Code, preview.Body.String())
	}
	buildResult := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/builds/9/result",
		nil,
		nil,
		true,
	)
	if buildResult.Code != http.StatusOK {
		t.Fatalf("build result = %d, body=%s", buildResult.Code, buildResult.Body.String())
	}

	failingRouter := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{err: errors.New("queue unavailable")},
	)
	dispatchFailure := stage9ARequest(
		failingRouter,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds",
		strings.NewReader(`{"upload_id":4,"transaction_file_id":"file-csv"}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "build-key-2",
		},
		true,
	)
	if dispatchFailure.Code != http.StatusServiceUnavailable {
		t.Fatalf("dispatch failure = %d, body=%s", dispatchFailure.Code, dispatchFailure.Body.String())
	}
	if len(fake.dispatchFailures) != 1 || fake.dispatchFailures[0] != 9 {
		t.Fatalf("dispatch failure marks = %#v", fake.dispatchFailures)
	}
}

func TestStage9AAgentMonthlyReportsConfirmFlowAndAudit(t *testing.T) {
	fake, _ := stage9AFixture()
	confirmStore := agentauth.NewMemoryConfirmStore()
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		confirmStore,
		&stage9ADispatcher{},
	)

	preview := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds/9/confirm",
		strings.NewReader(`{}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "confirm-key",
		},
		true,
	)
	if preview.Code != http.StatusOK {
		t.Fatalf("confirm preview = %d, body=%s", preview.Code, preview.Body.String())
	}
	previewData := stage9AObject(t, preview.Body.Bytes())
	if previewData["requires_confirmation"] != true {
		t.Fatalf("requires_confirmation = %#v", previewData["requires_confirmation"])
	}
	token, _ := previewData["confirm_token"].(string)
	if token == "" {
		t.Fatalf("confirm token is empty: %#v", previewData)
	}

	confirmed := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds/9/confirm",
		strings.NewReader(`{}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "confirm-key",
			"X-Confirm-Token": token,
		},
		true,
	)
	if confirmed.Code != http.StatusOK {
		t.Fatalf("confirm = %d, body=%s", confirmed.Code, confirmed.Body.String())
	}
	confirmedData := stage9AData(t, confirmed)
	if confirmedData["report_id"] != float64(41) {
		t.Fatalf("report_id = %#v", confirmedData["report_id"])
	}
	if fake.lastConfirm.IdempotencyKey != "confirm-key" {
		t.Fatalf("confirm idempotency = %q", fake.lastConfirm.IdempotencyKey)
	}
	if len(fake.auditEntries) == 0 {
		t.Fatal("confirm did not pass an audit entry")
	}
	auditEntry := fake.auditEntries[len(fake.auditEntries)-1]
	if auditEntry.IdempotencyKey == nil || *auditEntry.IdempotencyKey != "confirm-key" {
		t.Fatalf("audit idempotency key = %#v", auditEntry.IdempotencyKey)
	}
	if auditEntry.AgentID == nil || *auditEntry.AgentID != "agent-stage9a" {
		t.Fatalf("audit agent id = %#v", auditEntry.AgentID)
	}

	replayToken := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds/9/confirm",
		strings.NewReader(`{}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "different-key",
			"X-Confirm-Token": token,
		},
		true,
	)
	if replayToken.Code != http.StatusBadRequest {
		t.Fatalf("replayed token = %d, body=%s", replayToken.Code, replayToken.Body.String())
	}

	idempotentReplay := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds/9/confirm",
		strings.NewReader(`{}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "confirm-key",
		},
		true,
	)
	if idempotentReplay.Code != http.StatusOK {
		t.Fatalf("idempotent replay = %d, body=%s", idempotentReplay.Code, idempotentReplay.Body.String())
	}
}

func TestStage9AAgentMonthlyReportsConfirmTokenBinding(t *testing.T) {
	fake, _ := stage9AFixture()
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	tests := []struct {
		name        string
		previewPath string
		replayPath  string
		replayBody  string
	}{
		{
			name:        "query",
			previewPath: "/api/v1/agent/monthly-reports/builds/9/confirm?source=preview",
			replayPath:  "/api/v1/agent/monthly-reports/builds/9/confirm?source=replay",
			replayBody:  `{}`,
		},
		{
			name:        "path",
			previewPath: "/api/v1/agent/monthly-reports/builds/9/confirm",
			replayPath:  "/api/v1/agent/monthly-reports/builds/10/confirm",
			replayBody:  `{}`,
		},
		{
			name:        "body",
			previewPath: "/api/v1/agent/monthly-reports/builds/9/confirm",
			replayPath:  "/api/v1/agent/monthly-reports/builds/9/confirm",
			replayBody:  `{"confirmed":true}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			key := "confirm-binding-" + test.name
			preview := stage9ARequest(
				router,
				http.MethodPost,
				test.previewPath,
				strings.NewReader(`{}`),
				map[string]string{
					"Content-Type":    "application/json",
					"Idempotency-Key": key,
				},
				true,
			)
			if preview.Code != http.StatusOK {
				t.Fatalf("preview = %d, body=%s", preview.Code, preview.Body.String())
			}
			token, _ := stage9AObject(t, preview.Body.Bytes())["confirm_token"].(string)
			if token == "" {
				t.Fatalf("confirm token is empty: %s", preview.Body.String())
			}

			replay := stage9ARequest(
				router,
				http.MethodPost,
				test.replayPath,
				strings.NewReader(test.replayBody),
				map[string]string{
					"Content-Type":    "application/json",
					"Idempotency-Key": key,
					"X-Confirm-Token": token,
				},
				true,
			)
			if replay.Code != http.StatusBadRequest {
				t.Fatalf("bound replay = %d, body=%s", replay.Code, replay.Body.String())
			}
		})
	}
}

func TestStage9AAgentMonthlyReportsConfirmPreviewShowsBlockingReport(t *testing.T) {
	fake, _ := stage9AFixture()
	blockingID := int64(42)
	blockingStatus := "running"
	fake.build.BlockingReportID = &blockingID
	fake.build.BlockingReportStatus = &blockingStatus
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	preview := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/builds/9/confirm",
		strings.NewReader(`{}`),
		map[string]string{
			"Content-Type":    "application/json",
			"Idempotency-Key": "confirm-blocking-preview-key",
		},
		true,
	)
	if preview.Code != http.StatusOK {
		t.Fatalf("confirm preview = %d, body=%s", preview.Code, preview.Body.String())
	}
	body := stage9AObject(t, preview.Body.Bytes())
	previewData, ok := body["preview"].(map[string]any)
	if !ok {
		t.Fatalf("preview is not an object: %#v", body["preview"])
	}
	if previewData["existing_report_id"] != float64(42) ||
		previewData["existing_report_status"] != "running" ||
		previewData["will_conflict"] != true {
		t.Fatalf("blocking preview = %#v", previewData)
	}
}

func TestStage9AAgentMonthlyReportsReconciliationRoutes(t *testing.T) {
	fake, _ := stage9AFixture()
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	auto := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/41/reconciliation/auto?tolerance=0.01",
		nil,
		nil,
		true,
	)
	if auto.Code != http.StatusOK {
		t.Fatalf("auto reconcile = %d, body=%s", auto.Code, auto.Body.String())
	}

	manualBody, manualContentType := stage9AMultipartFiles(
		t,
		map[string]string{"tolerance": "0.01"},
		map[string]stage9AFilePart{
			"excel_file": {
				filename: "reconciliation.xlsx",
				content:  []byte("PK\x03\x04xlsx"),
			},
			"pdf_file": {
				filename: "reconciliation.pdf",
				content:  []byte("%PDF-doc"),
			},
		},
	)
	manualRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/agent/monthly-reports/41/reconciliation/manual?tolerance=0.01",
		manualBody,
	)
	manualRequest.Header.Set("Content-Type", manualContentType)
	manualRequest.Header.Set("Authorization", "Bearer stage9a-secret")
	manualRequest.Header.Set("X-Agent-Id", "agent-stage9a")
	manualResponse := httptest.NewRecorder()
	router.ServeHTTP(manualResponse, manualRequest)
	if manualResponse.Code != http.StatusOK {
		t.Fatalf("manual reconcile = %d, body=%s", manualResponse.Code, manualResponse.Body.String())
	}
}

func TestStage9AAgentMonthlyReportsCrossProjectAndErrorMapping(t *testing.T) {
	fake, detail := stage9AFixture()
	detail.Report.ProjectID = 8
	fake.projectID = 8
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	detailResponse := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/41",
		nil,
		nil,
		true,
	)
	if detailResponse.Code != http.StatusForbidden {
		t.Fatalf("cross-project detail = %d, body=%s", detailResponse.Code, detailResponse.Body.String())
	}

	reconciliation := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/41/reconciliation",
		nil,
		nil,
		true,
	)
	if reconciliation.Code != http.StatusNotFound {
		t.Fatalf("cross-project reconciliation = %d, body=%s", reconciliation.Code, reconciliation.Body.String())
	}

	fake.projectErr = store.ErrAgentMonthlyNotFound
	migrated := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/999/reconciliation",
		nil,
		nil,
		true,
	)
	if migrated.Code != http.StatusNotFound {
		t.Fatalf("missing reconciliation = %d, body=%s", migrated.Code, migrated.Body.String())
	}
}

func TestStage9AAgentMonthlyReportsConflictAndCrossCredential404(t *testing.T) {
	fake, _ := stage9AFixture()
	router := stage9ARouter(
		t,
		fake,
		stage9ACredentials(t, "monthly_reports", "7"),
		agentauth.NewMemoryConfirmStore(),
		&stage9ADispatcher{},
	)

	fake.previewErr = store.ErrAgentMonthlyNotReady
	preview := stage9ARequest(
		router,
		http.MethodGet,
		"/api/v1/agent/monthly-reports/builds/9/preview",
		nil,
		nil,
		true,
	)
	if preview.Code != http.StatusConflict {
		t.Fatalf("not-ready preview = %d, body=%s", preview.Code, preview.Body.String())
	}

	fake.uploadErr = store.ErrAgentMonthlyNotFound
	upload := stage9ARequest(
		router,
		http.MethodPost,
		"/api/v1/agent/monthly-reports/uploads/4/files",
		strings.NewReader("not-multipart"),
		map[string]string{"Content-Type": "application/octet-stream"},
		true,
	)
	if upload.Code != http.StatusNotFound {
		t.Fatalf("cross-credential upload = %d, body=%s", upload.Code, upload.Body.String())
	}
}
