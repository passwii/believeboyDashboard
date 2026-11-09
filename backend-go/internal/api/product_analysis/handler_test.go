package product_analysis

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type productAnalysisFakeStore struct {
	verifyErr               error
	accessibleIDs           []int64
	accessibleErr           error
	projectIDByName         int64
	projectByErr            error
	sourceProjectID         int64
	sourceProjectErr        error
	sources                 []AnalysisSourceFileItem
	sourcesErr              error
	sourceRows              *SourceRows
	sourceRowsErr           error
	inventory               *CurrentInventorySnapshot
	inventoryErr            error
	pt1Items                []PT1CalculationItem
	pt1Err                  error
	pt1                     *PT1CalculationItem
	getPT1Err               error
	details                 *PT1Details
	detailsErr              error
	weekly                  []WeeklyAnalysisItem
	weeklyErr               error
	availability            *AvailabilityCheck
	availabilityErr         error
	lastSourceFilter        SourceFilter
	lastPT1Filter           PT1Filter
	lastAvailabilityCountry string
	lastAvailabilityStart   time.Time
	lastAvailabilityEnd     time.Time
}

func (s *productAnalysisFakeStore) VerifyProjectAccess(
	context.Context,
	int64,
	string,
	bool,
) error {
	return s.verifyErr
}

func (s *productAnalysisFakeStore) AccessibleProjectIDs(
	context.Context,
	string,
	bool,
) ([]int64, error) {
	return s.accessibleIDs, s.accessibleErr
}

func (s *productAnalysisFakeStore) ProjectIDByName(context.Context, string) (int64, error) {
	return s.projectIDByName, s.projectByErr
}

func (s *productAnalysisFakeStore) SourceProjectID(context.Context, int64) (int64, error) {
	return s.sourceProjectID, s.sourceProjectErr
}

func (s *productAnalysisFakeStore) ListSources(
	_ context.Context,
	filter SourceFilter,
) ([]AnalysisSourceFileItem, error) {
	s.lastSourceFilter = filter
	return s.sources, s.sourcesErr
}

func (s *productAnalysisFakeStore) GetSourceRows(
	context.Context,
	int64,
	int,
	int,
	bool,
) (*SourceRows, error) {
	return s.sourceRows, s.sourceRowsErr
}

func (s *productAnalysisFakeStore) GetCurrentInventory(
	context.Context,
	int64,
	string,
	*time.Time,
	*time.Time,
) (*CurrentInventorySnapshot, error) {
	return s.inventory, s.inventoryErr
}

func (s *productAnalysisFakeStore) ListPT1(
	_ context.Context,
	filter PT1Filter,
) ([]PT1CalculationItem, error) {
	s.lastPT1Filter = filter
	return s.pt1Items, s.pt1Err
}

func (s *productAnalysisFakeStore) GetPT1(context.Context, int64) (*PT1CalculationItem, error) {
	return s.pt1, s.getPT1Err
}

func (s *productAnalysisFakeStore) ListPT1Details(
	context.Context,
	PT1CalculationItem,
	string,
	int,
	int,
) (*PT1Details, error) {
	return s.details, s.detailsErr
}

func (s *productAnalysisFakeStore) ListWeekly(
	_ context.Context,
	filter PT1Filter,
) ([]WeeklyAnalysisItem, error) {
	s.lastPT1Filter = filter
	return s.weekly, s.weeklyErr
}

func (s *productAnalysisFakeStore) CheckAvailability(
	_ context.Context,
	_ int64,
	country string,
	startDate time.Time,
	endDate time.Time,
) (*AvailabilityCheck, error) {
	s.lastAvailabilityCountry = country
	s.lastAvailabilityStart = startDate
	s.lastAvailabilityEnd = endDate
	return s.availability, s.availabilityErr
}

type productAnalysisFakeEngine struct {
	runResult       *RunResponse
	runErr          error
	previewResult   *RunResponse
	previewErr      error
	recomputeResult *WeeklyRecomputeResponse
	recomputeErr    error
	triggerResult   map[string]any
	triggerErr      error
	uploadResult    *UploadSourcesResponse
	uploadErr       error
	calls           []string
	lastPrincipal   Principal
}

type productAnalysisProviderStore struct {
	*productAnalysisFakeStore
	engine CalculationEngine
}

func (store *productAnalysisProviderStore) CalculationEngine() CalculationEngine {
	if store == nil {
		return nil
	}
	return store.engine
}

func (e *productAnalysisFakeEngine) Run(
	_ context.Context,
	_ RunRequest,
	principal Principal,
) (*RunResponse, error) {
	e.calls = append(e.calls, "run")
	e.lastPrincipal = principal
	return e.runResult, e.runErr
}

func (e *productAnalysisFakeEngine) Preview(
	_ context.Context,
	_ PreviewRequest,
	principal Principal,
) (*RunResponse, error) {
	e.calls = append(e.calls, "preview")
	e.lastPrincipal = principal
	return e.previewResult, e.previewErr
}

func (e *productAnalysisFakeEngine) RecomputeWeekly(
	_ context.Context,
	_ WeeklyRecomputeRequest,
	principal Principal,
) (*WeeklyRecomputeResponse, error) {
	e.calls = append(e.calls, "recompute")
	e.lastPrincipal = principal
	return e.recomputeResult, e.recomputeErr
}

func (e *productAnalysisFakeEngine) TriggerRecompute(
	_ context.Context,
	_ TriggerRecomputeRequest,
	principal Principal,
) (map[string]any, error) {
	e.calls = append(e.calls, "trigger")
	e.lastPrincipal = principal
	return e.triggerResult, e.triggerErr
}

func (e *productAnalysisFakeEngine) UploadSources(
	_ context.Context,
	_ UploadSourcesRequest,
	principal Principal,
) (*UploadSourcesResponse, error) {
	e.calls = append(e.calls, "upload")
	e.lastPrincipal = principal
	return e.uploadResult, e.uploadErr
}

func productAnalysisTestRouter(
	store Store,
	auditor audit.Service,
	options ...Option,
) chi.Router {
	router := chi.NewRouter()
	NewRegistrar(store, auditor, options...).RegisterRoutes(
		router,
		func(next http.Handler) http.Handler { return next },
	)
	return router
}

func productAnalysisRequest(
	method string,
	target string,
	body string,
	operator string,
	isAdmin bool,
) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	request = request.WithContext(auth.WithUserContext(
		request.Context(),
		auth.UserContext{Operator: operator, IsAdmin: isAdmin},
	))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func productAnalysisServe(
	router http.Handler,
	method string,
	target string,
	body string,
	operator string,
	isAdmin bool,
) *httptest.ResponseRecorder {
	request := productAnalysisRequest(method, target, body, operator, isAdmin)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestProductAnalysisRegistrarRouteInventory(t *testing.T) {
	router := productAnalysisTestRouter(
		&productAnalysisFakeStore{},
		audit.NewMockService(),
	)
	want := []string{
		"GET /api/v1/product-analysis/sources",
		"POST /api/v1/product-analysis/sources/upload-file",
		"GET /api/v1/product-analysis/sources/{source_id}/rows",
		"GET /api/v1/product-analysis/inventory/current",
		"GET /api/v1/product-analysis/pt1",
		"GET /api/v1/product-analysis/pt1/{pt1_id}/details",
		"GET /api/v1/product-analysis/weekly",
		"POST /api/v1/product-analysis/weekly/recompute",
		"POST /api/v1/product-analysis/calculation/check",
		"POST /api/v1/product-analysis/calculation/run",
		"POST /api/v1/product-analysis/calculation/preview",
		"POST /api/v1/product-analysis/trigger-recompute",
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
	if len(got) != len(want) || strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("routes:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestProductAnalysisRegistrarModuleNameAnd401(t *testing.T) {
	registrar := NewRegistrar(&productAnalysisFakeStore{}, audit.NewMockService())
	if registrar.ModuleName() != "product_analysis" {
		t.Fatalf("ModuleName() = %q", registrar.ModuleName())
	}

	router := chi.NewRouter()
	registrar.RegisterRoutes(
		router,
		auth.RequireAPIKey("master-key", "trusted-secret", nil),
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet,
		"/api/v1/product-analysis/sources",
		nil,
	))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401; body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestProductAnalysisListSourcesDataAndPermission(t *testing.T) {
	store := &productAnalysisFakeStore{
		accessibleIDs: []int64{3, 7},
		sources: []AnalysisSourceFileItem{{
			ID:               8,
			ProjectID:        7,
			ReportType:       "business_report",
			Version:          1,
			IsCurrent:        true,
			UploadFileID:     "upload-8",
			UploadFilePath:   "/safe/business.csv",
			StoredFilename:   "business.csv",
			LogicalFilename:  "business.csv",
			StorageKey:       "business.csv",
			IngestionStatus:  "success",
			RowCountTotal:    2,
			RowCountIncluded: 2,
		}},
	}
	router := productAnalysisTestRouter(store, audit.NewMockService())
	recorder := productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/sources?report_type=ad_report&current_only=false&include_history=true",
		"",
		"alice",
		false,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var items []AnalysisSourceFileItem
	if err := json.Unmarshal(recorder.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode sources: %v", err)
	}
	if len(items) != 1 || items[0].ID != 8 {
		t.Fatalf("items = %#v", items)
	}
	if store.lastSourceFilter.ReportType == nil || *store.lastSourceFilter.ReportType != "ad_product_report" {
		t.Fatalf("normalized report type = %#v", store.lastSourceFilter.ReportType)
	}
	if store.lastSourceFilter.CurrentOnly {
		t.Fatal("include_history should not force current_only=true")
	}
	if store.lastSourceFilter.ProjectIDs == nil ||
		len(store.lastSourceFilter.ProjectIDs) != 2 ||
		store.lastSourceFilter.ProjectIDs[0] != 3 {
		t.Fatalf("project scope = %#v", store.lastSourceFilter.ProjectIDs)
	}

	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/sources?report_type=unsupported",
		"",
		"alice",
		false,
	)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid report type status = %d, want 422", recorder.Code)
	}

	store.verifyErr = ErrProjectForbidden
	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/sources?project_id=9",
		"",
		"alice",
		false,
	)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status = %d, want 403", recorder.Code)
	}
}

func TestProductAnalysisSourceRowsStatuses(t *testing.T) {
	store := &productAnalysisFakeStore{
		sourceProjectID: 7,
		sourceRows: &SourceRows{
			Source:   AnalysisSourceFileItem{ID: 4, ProjectID: 7, ReportType: "payment_report"},
			Page:     2,
			PageSize: 200,
			HasNext:  true,
			Rows:     []map[string]any{{"source_row_no": 201, "sku": "A1"}},
		},
	}
	router := productAnalysisTestRouter(store, audit.NewMockService())
	recorder := productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/sources/4/rows?page=2&page_size=200",
		"",
		"alice",
		false,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/sources/4/rows?page=0",
		"",
		"alice",
		false,
	)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid page status = %d, want 422", recorder.Code)
	}

	store.sourceProjectErr = ErrNotFound
	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/sources/999/rows",
		"",
		"alice",
		false,
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing source status = %d, want 404", recorder.Code)
	}

	store.sourceProjectErr = nil
	store.verifyErr = ErrProjectForbidden
	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/sources/4/rows",
		"",
		"alice",
		false,
	)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden source status = %d, want 403", recorder.Code)
	}
}

func TestProductAnalysisInventoryAndPT1Statuses(t *testing.T) {
	store := &productAnalysisFakeStore{
		inventory: &CurrentInventorySnapshot{
			Source: AnalysisSourceFileItem{ID: 9, ProjectID: 7, ReportType: "inventory_report"},
			Rows:   []map[string]any{{"sku": "A1", "available_qty": 12}},
		},
		pt1Items: []PT1CalculationItem{{
			ID: 11, ProjectID: 7, ProjectName: "Project A", Country: "US",
			ReportStartDate: "2026-10-26", ReportEndDate: "2026-11-01",
			Version: 1, IsCurrent: true, RowCount: 2,
			SummaryRow: map[string]any{"实际销售额": 100.0},
		}},
		pt1: &PT1CalculationItem{
			ID: 11, ProjectID: 7, ProjectName: "Project A", Country: "US",
			ReportStartDate: "2026-10-26", ReportEndDate: "2026-11-01",
			Version: 1, IsCurrent: true,
		},
		details: &PT1Details{
			PT1ID: 11, ProjectID: 7, ProjectName: "Project A",
			ReportStartDate: "2026-10-26", ReportEndDate: "2026-11-01",
			Version: 1, Page: 1, PageSize: 500, HasNext: false,
			Rows: []PT1DetailRow{{ID: 1, SourceRowNo: 1, SKU: productAnalysisTestString("A1")}},
		},
	}
	router := productAnalysisTestRouter(store, audit.NewMockService())

	recorder := productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/inventory/current?project_id=7&country=us&start_date=2026-10-26&end_date=2026-11-01",
		"",
		"alice",
		true,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("inventory status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	store.inventory = nil
	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/inventory/current?project_id=7",
		"",
		"alice",
		true,
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing inventory status = %d, want 404", recorder.Code)
	}

	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/pt1?project_id=7",
		"",
		"alice",
		true,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("pt1 list status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/pt1/11/details?country=DE",
		"",
		"alice",
		true,
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("country mismatch status = %d, want 404", recorder.Code)
	}

	recorder = productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/pt1/11/details?country=US&page_size=500",
		"",
		"alice",
		true,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("pt1 details status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestProductAnalysisWeeklyAndCheck(t *testing.T) {
	store := &productAnalysisFakeStore{
		weekly: []WeeklyAnalysisItem{{
			ID: 11, ProjectID: 7, ProjectName: "Project A", Country: "US",
			ReportStartDate: "2026-10-26", ReportEndDate: "2026-11-01",
			Version: 1, IsCurrent: true, RowCount: 3,
			TotalSales: 300, TotalUnits: 6, TotalAdSpend: 50,
			SummaryRow: map[string]any{"实际销售额": 300.0},
		}},
		availability: &AvailabilityCheck{
			BusinessReportMissing: []string{},
			ADReportMissing:       []string{},
			InventoryMissing:      []string{},
			HasMinimumData:        true,
		},
	}
	router := productAnalysisTestRouter(store, audit.NewMockService())

	recorder := productAnalysisServe(
		router,
		http.MethodGet,
		"/api/v1/product-analysis/weekly?project_id=7&country=US&start_date=2026-10-26&end_date=2026-11-01",
		"",
		"alice",
		true,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("weekly status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if store.lastPT1Filter.Country == nil || *store.lastPT1Filter.Country != "US" {
		t.Fatalf("weekly country filter = %#v", store.lastPT1Filter.Country)
	}

	recorder = productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/calculation/check",
		`{"project_id":7,"country":"us","start_date":"2026-10-26","end_date":"2026-11-01"}`,
		"alice",
		true,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("check status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if store.lastAvailabilityCountry != "US" {
		t.Fatalf("check country = %q", store.lastAvailabilityCountry)
	}

	recorder = productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/calculation/check",
		`{"project_id":7,"start_date":"not-a-date","end_date":"2026-11-01"}`,
		"alice",
		true,
	)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid check status = %d, want 422", recorder.Code)
	}
}

func TestProductAnalysisEngineRoutesAndAudit(t *testing.T) {
	engine := &productAnalysisFakeEngine{
		runResult: &RunResponse{
			ProjectID: 7, ProjectName: "Project A", Country: "US",
			TotalPeriods: 1,
			Periods: []CalculationPeriod{{
				ReportStartDate: "2026-10-26",
				ReportEndDate:   "2026-11-01",
				Summary:         map[string]any{"实际销售额": 300.0},
				Details:         []map[string]any{{"SKU": "A1"}},
				Persisted:       true,
			}},
		},
		previewResult: &RunResponse{
			ProjectID: 7, ProjectName: "Project A", Country: "US",
			TotalPeriods: 1,
			Periods: []CalculationPeriod{{
				ReportStartDate: "2026-10-26",
				ReportEndDate:   "2026-11-01",
				Summary:         map[string]any{"实际销售额": 250.0},
				Details:         []map[string]any{},
				Persisted:       false,
			}},
		},
		recomputeResult: &WeeklyRecomputeResponse{
			ProjectID: 7, ProjectName: "Project A", Country: "US",
			Recomputed: 1,
			Periods: []WeeklyRecomputePeriod{{
				PT1ID: 11, Version: 2,
				ReportStartDate: "2026-10-26", ReportEndDate: "2026-11-01",
				RowCount: 3, BusinessReportSourceID: 20, ADReportSourceID: 21,
			}},
		},
		triggerResult: map[string]any{"pt1_id": int64(12), "version": 1},
		uploadResult: &UploadSourcesResponse{Outcomes: []SourcePersistOutcome{{
			ReportType: "business_report",
			SourceID:   productAnalysisTestInt64(20),
			Success:    true,
		}}},
	}
	store := &productAnalysisFakeStore{
		projectIDByName: 7,
		verifyErr:       nil,
	}
	auditor := audit.NewMockService()
	router := productAnalysisTestRouter(
		store,
		auditor,
		WithCalculationEngine(engine),
	)

	tests := []struct {
		name   string
		method string
		path   string
		body   string
		call   string
	}{
		{
			name: "weekly recompute", method: http.MethodPost,
			path: "/api/v1/product-analysis/weekly/recompute?project_id=7&country=US&start_date=2026-10-26&end_date=2026-11-01",
			call: "recompute",
		},
		{
			name: "calculation run", method: http.MethodPost,
			path: "/api/v1/product-analysis/calculation/run",
			body: `{"project_id":7,"country":"US","start_date":"2026-10-26","end_date":"2026-11-01"}`,
			call: "run",
		},
		{
			name: "calculation preview", method: http.MethodPost,
			path: "/api/v1/product-analysis/calculation/preview",
			body: `{"project_id":7,"country":"US","start_date":"2026-10-26","end_date":"2026-11-01","business_temp_file_id":"b.csv","payment_temp_file_id":"p.csv","ad_temp_file_id":"a.xlsx"}`,
			call: "preview",
		},
		{
			name: "trigger recompute", method: http.MethodPost,
			path: "/api/v1/product-analysis/trigger-recompute?project_id=7&country=US&period_start_date=2026-10-26&period_end_date=2026-11-01",
			call: "trigger",
		},
		{
			name: "upload sources", method: http.MethodPost,
			path: "/api/v1/product-analysis/sources/upload-file",
			body: `{"project_name":"Project A","country":"US","report_start_date":"2026-10-26","report_end_date":"2026-11-01","file_ids":{"business_report":"b.csv"},"resolved_file_paths":{"business_report":"/safe/b.csv"}}`,
			call: "upload",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := productAnalysisServe(
				router,
				test.method,
				test.path,
				test.body,
				"alice",
				true,
			)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
	if len(engine.calls) != len(tests) {
		t.Fatalf("engine calls = %#v", engine.calls)
	}
	if len(auditor.Entries) != len(tests) {
		t.Fatalf("audit entries = %d, want %d", len(auditor.Entries), len(tests))
	}
}

func TestProductAnalysisNewHandlerUsesProvidedProductionEngine(t *testing.T) {
	engine := &productAnalysisFakeEngine{
		runResult: &RunResponse{
			ProjectID: 7, ProjectName: "Project A", Country: "US",
			TotalPeriods: 1,
			Periods: []CalculationPeriod{{
				ReportStartDate: "2026-10-26",
				ReportEndDate:   "2026-11-01",
				Summary:         map[string]any{"实际销售额": 300.0},
				Details:         []map[string]any{},
				Persisted:       true,
			}},
		},
	}
	store := &productAnalysisProviderStore{
		productAnalysisFakeStore: &productAnalysisFakeStore{},
		engine:                   engine,
	}
	router := productAnalysisTestRouter(store, audit.NewMockService())
	recorder := productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/calculation/run",
		`{"project_id":7,"country":"US","start_date":"2026-10-26","end_date":"2026-11-01"}`,
		"alice",
		true,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if len(engine.calls) != 1 || engine.calls[0] != "run" {
		t.Fatalf("engine calls = %#v", engine.calls)
	}
}

func TestProductAnalysisEngineFailClosedAndStatusMapping(t *testing.T) {
	store := &productAnalysisFakeStore{projectIDByName: 7}
	router := productAnalysisTestRouter(store, audit.NewMockService())
	for _, route := range []struct {
		path string
		body string
	}{
		{
			path: "/api/v1/product-analysis/calculation/run",
			body: `{"project_id":7,"start_date":"2026-10-26","end_date":"2026-11-01"}`,
		},
		{
			path: "/api/v1/product-analysis/calculation/preview",
			body: `{"project_id":7,"start_date":"2026-10-26","end_date":"2026-11-01"}`,
		},
		{
			path: "/api/v1/product-analysis/weekly/recompute?project_id=7&country=US",
		},
		{
			path: "/api/v1/product-analysis/trigger-recompute?project_id=7&country=US&period_start_date=2026-10-26&period_end_date=2026-11-01",
		},
		{
			path: "/api/v1/product-analysis/sources/upload-file",
			body: `{"project_name":"Project A","report_start_date":"2026-10-26","report_end_date":"2026-11-01","file_ids":{},"resolved_file_paths":{}}`,
		},
	} {
		recorder := productAnalysisServe(
			router,
			http.MethodPost,
			route.path,
			route.body,
			"alice",
			true,
		)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s status = %d, want 503; body=%s", route.path, recorder.Code, recorder.Body.String())
		}
	}

	engine := &productAnalysisFakeEngine{
		runErr: &StatusError{Status: http.StatusConflict, Detail: "duplicate weekly period"},
	}
	router = productAnalysisTestRouter(
		store,
		audit.NewMockService(),
		WithCalculationEngine(engine),
	)
	recorder := productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/calculation/run",
		`{"project_id":7,"start_date":"2026-10-26","end_date":"2026-11-01"}`,
		"alice",
		true,
	)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("engine conflict status = %d, want 409; body=%s", recorder.Code, recorder.Body.String())
	}

	engine.runErr = &StatusError{Status: http.StatusBadRequest, Detail: "invalid source period"}
	recorder = productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/calculation/run",
		`{"project_id":7,"start_date":"2026-10-26","end_date":"2026-11-01"}`,
		"alice",
		true,
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("engine bad request status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestProductAnalysisProjectNotFoundAndForbidden(t *testing.T) {
	store := &productAnalysisFakeStore{projectByErr: ErrProjectNotFound}
	router := productAnalysisTestRouter(store, audit.NewMockService())
	recorder := productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/sources/upload-file",
		`{"project_name":"Missing","report_start_date":"2026-10-26","report_end_date":"2026-11-01","file_ids":{},"resolved_file_paths":{}}`,
		"alice",
		true,
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing project status = %d, want 404", recorder.Code)
	}

	store.projectByErr = nil
	store.verifyErr = ErrProjectForbidden
	recorder = productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/sources/upload-file",
		`{"project_name":"Project A","report_start_date":"2026-10-26","report_end_date":"2026-11-01","file_ids":{},"resolved_file_paths":{}}`,
		"alice",
		false,
	)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden project status = %d, want 403", recorder.Code)
	}
}

func TestProductAnalysisRejectsMalformedBody(t *testing.T) {
	router := productAnalysisTestRouter(&productAnalysisFakeStore{}, audit.NewMockService())
	recorder := productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/calculation/check",
		`{"project_id":7,"start_date":"2026-10-26"}`,
		"alice",
		true,
	)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing field status = %d, want 422; body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = productAnalysisServe(
		router,
		http.MethodPost,
		"/api/v1/product-analysis/calculation/check",
		`{"project_id":7,"start_date":"2026-10-26","end_date":"2026-11-01"} trailing`,
		"alice",
		true,
	)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("trailing JSON status = %d, want 422", recorder.Code)
	}
}

func productAnalysisTestString(value string) *string {
	return &value
}

func productAnalysisTestInt64(value int64) *int64 {
	return &value
}
