package contract

import (
	"bytes"
	"context"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/amazon_review_tracking"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inspections"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage8DModuleRegistrar interface {
	ModuleName() string
	RegisterRoutes(chi.Router, func(http.Handler) http.Handler)
}

func TestStage8DProductOpsRouteInventory(t *testing.T) {
	t.Helper()
	auditor := audit.NewMockService()
	cases := []struct {
		module    string
		registrar stage8DModuleRegistrar
		routes    []string
	}{
		{
			module: "product_analysis",
			registrar: product_analysis.NewRegistrar(
				nil,
				auditor,
			),
			routes: []string{
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
			},
		},
		{
			module: "product_analysis_reports",
			registrar: product_analysis_reports.NewRegistrarWithDependencies(
				nil,
				auditor,
				nil,
				"",
				nil,
			),
			routes: []string{
				"POST /api/v1/product-analysis-reports",
				"GET /api/v1/product-analysis-reports/tasks/{task_id}",
				"GET /api/v1/product-analysis-reports/tasks/{task_id}/result",
			},
		},
		{
			module: "inspections",
			registrar: inspections.NewRegistrar(
				nil,
				nil,
				auditor,
			),
			routes: []string{
				"GET /api/v1/inspections/template",
				"GET /api/v1/inspections/periods",
				"GET /api/v1/inspections/periods/current",
				"GET /api/v1/inspections/periods/{period_id}/overview",
				"GET /api/v1/inspections/periods/{period_id}/projects/{project_id}",
				"POST /api/v1/inspections/periods/{period_id}/projects/{project_id}",
				"PATCH /api/v1/inspections/periods/{period_id}/projects/{project_id}",
				"POST /api/v1/inspections/periods/{period_id}/projects/{project_id}/submit",
				"POST /api/v1/inspections/screenshots/upload",
				"DELETE /api/v1/inspections/screenshots/{screenshot_id}",
				"GET /api/v1/inspections/history",
			},
		},
		{
			module: "amazon_review_tracking",
			registrar: amazon_review_tracking.NewRegistrar(
				nil,
				auditor,
			),
			routes: []string{
				"GET /api/v1/amazon-review-tracking/external-targets",
				"POST /api/v1/amazon-review-tracking/external-targets",
				"GET /api/v1/amazon-review-tracking/groups",
				"POST /api/v1/amazon-review-tracking/groups",
				"PATCH /api/v1/amazon-review-tracking/groups/{group_id}",
				"POST /api/v1/amazon-review-tracking/groups/{group_id}/deactivate",
				"GET /api/v1/amazon-review-tracking/targets",
				"POST /api/v1/amazon-review-tracking/targets/{target_id}/external-links",
				"DELETE /api/v1/amazon-review-tracking/targets/{target_id}/external-links/{link_id}",
				"GET /api/v1/amazon-review-tracking/targets/{target_id}/rating-snapshots",
				"GET /api/v1/amazon-review-tracking/targets/{target_id}/reviews",
				"GET /api/v1/amazon-review-tracking/targets/{target_id}/runs",
			},
		},
	}

	for _, test := range cases {
		t.Run(test.module, func(t *testing.T) {
			router := chi.NewRouter()
			test.registrar.RegisterRoutes(router, stage8DPassthrough)
			if got := test.registrar.ModuleName(); got != test.module {
				t.Fatalf("ModuleName() = %q, want %q", got, test.module)
			}
			got := stage8DRouteInventory(t, router)
			sort.Strings(got)
			sort.Strings(test.routes)
			if len(got) != len(test.routes) {
				t.Fatalf("route count = %d, want %d\ngot:\n%s", len(got), len(test.routes), strings.Join(got, "\n"))
			}
			for index := range test.routes {
				if got[index] != test.routes[index] {
					t.Fatalf("route[%d] = %q, want %q", index, got[index], test.routes[index])
				}
			}
		})
	}
}

func TestStage8DAllProductOpsRoutesRequireAPIKey(t *testing.T) {
	auditor := audit.NewMockService()
	modules := []struct {
		registrar stage8DModuleRegistrar
		routes    []string
	}{
		{
			registrar: product_analysis.NewRegistrar(nil, auditor),
			routes: []string{
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
			},
		},
		{
			registrar: product_analysis_reports.NewRegistrarWithDependencies(
				nil, auditor, nil, "", nil,
			),
			routes: []string{
				"POST /api/v1/product-analysis-reports",
				"GET /api/v1/product-analysis-reports/tasks/{task_id}",
				"GET /api/v1/product-analysis-reports/tasks/{task_id}/result",
			},
		},
		{
			registrar: inspections.NewRegistrar(nil, nil, auditor),
			routes: []string{
				"GET /api/v1/inspections/template",
				"GET /api/v1/inspections/periods",
				"GET /api/v1/inspections/periods/current",
				"GET /api/v1/inspections/periods/{period_id}/overview",
				"GET /api/v1/inspections/periods/{period_id}/projects/{project_id}",
				"POST /api/v1/inspections/periods/{period_id}/projects/{project_id}",
				"PATCH /api/v1/inspections/periods/{period_id}/projects/{project_id}",
				"POST /api/v1/inspections/periods/{period_id}/projects/{project_id}/submit",
				"POST /api/v1/inspections/screenshots/upload",
				"DELETE /api/v1/inspections/screenshots/{screenshot_id}",
				"GET /api/v1/inspections/history",
			},
		},
		{
			registrar: amazon_review_tracking.NewRegistrar(nil, auditor),
			routes: []string{
				"GET /api/v1/amazon-review-tracking/external-targets",
				"POST /api/v1/amazon-review-tracking/external-targets",
				"GET /api/v1/amazon-review-tracking/groups",
				"POST /api/v1/amazon-review-tracking/groups",
				"PATCH /api/v1/amazon-review-tracking/groups/{group_id}",
				"POST /api/v1/amazon-review-tracking/groups/{group_id}/deactivate",
				"GET /api/v1/amazon-review-tracking/targets",
				"POST /api/v1/amazon-review-tracking/targets/{target_id}/external-links",
				"DELETE /api/v1/amazon-review-tracking/targets/{target_id}/external-links/{link_id}",
				"GET /api/v1/amazon-review-tracking/targets/{target_id}/rating-snapshots",
				"GET /api/v1/amazon-review-tracking/targets/{target_id}/reviews",
				"GET /api/v1/amazon-review-tracking/targets/{target_id}/runs",
			},
		},
	}

	requireAPIKey := auth.RequireAPIKey(
		"stage8d-master-key",
		"stage8d-proxy-secret",
		nil,
	)
	for _, module := range modules {
		router := chi.NewRouter()
		module.registrar.RegisterRoutes(router, requireAPIKey)
		for _, route := range module.routes {
			method, target, ok := strings.Cut(route, " ")
			if !ok {
				t.Fatalf("invalid route fixture %q", route)
			}
			request := httptest.NewRequest(
				method,
				stage8DFillRouteParameters(target),
				nil,
			)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("%s status = %d, want 401", route, response.Code)
			}
		}
	}
}

type stage8DProductStore struct {
	product_analysis.Store
	verifyErr        error
	accessibleErr    error
	projectErr       error
	sourceProjectErr error
}

func (store *stage8DProductStore) VerifyProjectAccess(
	context.Context,
	int64,
	string,
	bool,
) error {
	return store.verifyErr
}

func (store *stage8DProductStore) AccessibleProjectIDs(
	context.Context,
	string,
	bool,
) ([]int64, error) {
	return []int64{7}, store.accessibleErr
}

func (store *stage8DProductStore) ProjectIDByName(context.Context, string) (int64, error) {
	if store.projectErr != nil {
		return 0, store.projectErr
	}
	return 7, nil
}

func (store *stage8DProductStore) SourceProjectID(context.Context, int64) (int64, error) {
	if store.sourceProjectErr != nil {
		return 0, store.sourceProjectErr
	}
	return 7, nil
}

func (*stage8DProductStore) ListSources(
	context.Context,
	product_analysis.SourceFilter,
) ([]product_analysis.AnalysisSourceFileItem, error) {
	return []product_analysis.AnalysisSourceFileItem{
		stage8DProductSource(),
	}, nil
}

func (*stage8DProductStore) GetSourceRows(
	context.Context,
	int64,
	int,
	int,
	bool,
) (*product_analysis.SourceRows, error) {
	return &product_analysis.SourceRows{
		Source:   stage8DProductSource(),
		Page:     1,
		PageSize: 10,
		HasNext:  false,
		Rows: []map[string]any{
			{"sku": "SKU-1", "asin": "B012345678"},
		},
	}, nil
}

func (*stage8DProductStore) GetCurrentInventory(
	context.Context,
	int64,
	string,
	*time.Time,
	*time.Time,
) (*product_analysis.CurrentInventorySnapshot, error) {
	return &product_analysis.CurrentInventorySnapshot{
		Source: stage8DProductSource(),
		Rows: []map[string]any{
			{"sku": "SKU-1", "available_qty": 12},
		},
	}, nil
}

func (*stage8DProductStore) ListPT1(
	context.Context,
	product_analysis.PT1Filter,
) ([]product_analysis.PT1CalculationItem, error) {
	return []product_analysis.PT1CalculationItem{stage8DPT1()}, nil
}

func (*stage8DProductStore) GetPT1(
	context.Context,
	int64,
) (*product_analysis.PT1CalculationItem, error) {
	item := stage8DPT1()
	return &item, nil
}

func (*stage8DProductStore) ListPT1Details(
	context.Context,
	product_analysis.PT1CalculationItem,
	string,
	int,
	int,
) (*product_analysis.PT1Details, error) {
	return &product_analysis.PT1Details{
		PT1ID:           12,
		ProjectID:       7,
		ProjectName:     "Project A",
		ReportStartDate: "2026-10-01",
		ReportEndDate:   "2026-10-31",
		Version:         1,
		Page:            1,
		PageSize:        500,
		HasNext:         false,
		Rows: []product_analysis.PT1DetailRow{
			{ID: 1, SourceRowNo: 1, SKU: stage8DString("SKU-1")},
		},
	}, nil
}

func (*stage8DProductStore) ListWeekly(
	context.Context,
	product_analysis.PT1Filter,
) ([]product_analysis.WeeklyAnalysisItem, error) {
	return []product_analysis.WeeklyAnalysisItem{
		{
			ID:               12,
			ProjectID:        7,
			ProjectName:      "Project A",
			Country:          "US",
			ReportStartDate:  "2026-10-01",
			ReportEndDate:    "2026-10-31",
			Version:          1,
			IsCurrent:        true,
			RowCount:         2,
			TotalSales:       100,
			TotalUnits:       4,
			TotalAdSpend:     20,
			SummaryRow:       map[string]any{"实际销售额": 100},
			WeeklySummaryRaw: map[string]any{"实际销售额": 100},
		},
	}, nil
}

func (*stage8DProductStore) CheckAvailability(
	context.Context,
	int64,
	string,
	time.Time,
	time.Time,
) (*product_analysis.AvailabilityCheck, error) {
	return &product_analysis.AvailabilityCheck{
		BusinessReportMissing:       []string{},
		ADReportMissing:             []string{},
		InventoryMissing:            []string{},
		BusinessPeriodInfo:          []product_analysis.PeriodCoverageInfo{},
		ADPeriodInfo:                []product_analysis.PeriodCoverageInfo{},
		BusinessPeriodicOnlyMissing: []string{},
		ADPeriodicOnlyMissing:       []string{},
		PaymentPeriodsOverlapping:   []product_analysis.PaymentPeriodOverlap{},
		PaymentFullPeriodCovered:    true,
		PaymentDailyCoveredDates:    []string{},
		PaymentObjectiveEmptyDates:  []string{},
		HasMinimumData:              true,
		WeeklyAvailability:          []product_analysis.WeeklyAvailability{},
	}, nil
}

type stage8DCalculationEngine struct {
	conflictError error
}

func (engine *stage8DCalculationEngine) Run(
	context.Context,
	product_analysis.RunRequest,
	product_analysis.Principal,
) (*product_analysis.RunResponse, error) {
	if engine.conflictError != nil {
		return nil, engine.conflictError
	}
	return stage8DRunResponse(), nil
}

func (*stage8DCalculationEngine) Preview(
	context.Context,
	product_analysis.PreviewRequest,
	product_analysis.Principal,
) (*product_analysis.RunResponse, error) {
	return stage8DRunResponse(), nil
}

func (*stage8DCalculationEngine) RecomputeWeekly(
	context.Context,
	product_analysis.WeeklyRecomputeRequest,
	product_analysis.Principal,
) (*product_analysis.WeeklyRecomputeResponse, error) {
	return &product_analysis.WeeklyRecomputeResponse{
		ProjectID:   7,
		ProjectName: "Project A",
		Country:     "US",
		Recomputed:  1,
		Skipped:     0,
		Periods: []product_analysis.WeeklyRecomputePeriod{
			{
				PT1ID:                  12,
				Version:                1,
				ReportStartDate:        "2026-10-01",
				ReportEndDate:          "2026-10-31",
				RowCount:               2,
				BusinessReportSourceID: 21,
				ADReportSourceID:       22,
			},
		},
	}, nil
}

func (*stage8DCalculationEngine) TriggerRecompute(
	context.Context,
	product_analysis.TriggerRecomputeRequest,
	product_analysis.Principal,
) (map[string]any, error) {
	return map[string]any{"pt1_id": 12}, nil
}

func (*stage8DCalculationEngine) UploadSources(
	context.Context,
	product_analysis.UploadSourcesRequest,
	product_analysis.Principal,
) (*product_analysis.UploadSourcesResponse, error) {
	return &product_analysis.UploadSourcesResponse{
		Outcomes: []product_analysis.SourcePersistOutcome{
			{
				ReportType: "business_report",
				SourceID:   stage8DInt64(21),
				Success:    true,
			},
		},
	}, nil
}

func TestStage8DProductAnalysisReadAndEngineContract(t *testing.T) {
	store := &stage8DProductStore{}
	auditor := audit.NewMockService()
	router := chi.NewRouter()
	product_analysis.NewRegistrar(
		store,
		auditor,
		product_analysis.WithCalculationEngine(&stage8DCalculationEngine{}),
	).RegisterRoutes(router, stage8DPassthrough)
	identity := auth.UserContext{Operator: "admin", IsAdmin: true}

	tests := []struct {
		name     string
		method   string
		target   string
		body     string
		fragment string
	}{
		{"sources", http.MethodGet, "/api/v1/product-analysis/sources?project_id=7", "", `"id":11`},
		{"source rows", http.MethodGet, "/api/v1/product-analysis/sources/11/rows?page=1&page_size=10", "", `"has_next":false`},
		{"inventory", http.MethodGet, "/api/v1/product-analysis/inventory/current?project_id=7&country=US", "", `"available_qty":12`},
		{"pt1", http.MethodGet, "/api/v1/product-analysis/pt1?project_id=7", "", `"summary_row":{}`},
		{"pt1 details", http.MethodGet, "/api/v1/product-analysis/pt1/12/details?country=US", "", `"pt1_id":12`},
		{"weekly", http.MethodGet, "/api/v1/product-analysis/weekly?project_id=7&country=US", "", `"total_sales":100`},
		{"weekly recompute", http.MethodPost, "/api/v1/product-analysis/weekly/recompute?project_id=7&country=US&start_date=2026-10-01&end_date=2026-10-31", "", `"recomputed":1`},
		{"calculation check", http.MethodPost, "/api/v1/product-analysis/calculation/check", `{"project_id":7,"country":"US","start_date":"2026-10-01","end_date":"2026-10-31"}`, `"has_minimum_data":true`},
		{"calculation run", http.MethodPost, "/api/v1/product-analysis/calculation/run", `{"project_id":7,"country":"US","start_date":"2026-10-01","end_date":"2026-10-31","current_only":true}`, `"total_periods":1`},
		{"calculation preview", http.MethodPost, "/api/v1/product-analysis/calculation/preview", `{"project_id":7,"country":"US","start_date":"2026-10-01","end_date":"2026-10-31"}`, `"persisted":false`},
		{"trigger recompute", http.MethodPost, "/api/v1/product-analysis/trigger-recompute?project_id=7&country=US&period_start_date=2026-10-01&period_end_date=2026-10-31", "", `"pt1_id":12`},
		{"upload sources", http.MethodPost, "/api/v1/product-analysis/sources/upload-file", `{"project_name":"Project A","country":"US","report_start_date":"2026-10-01","report_end_date":"2026-10-31","file_ids":{"business_report":"business.csv"},"resolved_file_paths":{"business_report":"/tmp/business.csv"}}`, `"success":true`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := stage8DServe(
				router,
				stage8DRequest(test.method, test.target, test.body, identity),
			)
			if response.Code != http.StatusOK {
				t.Fatalf("%s status = %d, body=%s", test.name, response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), test.fragment) {
				t.Fatalf("%s body = %s, want %q", test.name, response.Body.String(), test.fragment)
			}
		})
	}
}

func TestStage8DProductAnalysisStatusContracts(t *testing.T) {
	identity := auth.UserContext{Operator: "alice", IsAdmin: false}

	assertStatus := func(t *testing.T, router http.Handler, request *http.Request, want int) {
		t.Helper()
		response := stage8DServe(router, request)
		if response.Code != want {
			t.Fatalf("status = %d, want %d, body=%s", response.Code, want, response.Body.String())
		}
	}

	store := &stage8DProductStore{}
	router := chi.NewRouter()
	product_analysis.NewRegistrar(store, audit.NewMockService()).RegisterRoutes(
		router,
		stage8DPassthrough,
	)
	assertStatus(
		t,
		router,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/product-analysis/calculation/run",
			`{"project_id":7,"country":"US","start_date":"2026-10-01","end_date":"2026-10-31"}`,
			identity,
		),
		http.StatusServiceUnavailable,
	)

	conflictEngine := &stage8DCalculationEngine{
		conflictError: &product_analysis.StatusError{
			Status: http.StatusConflict,
			Detail: "calculation source changed",
		},
	}
	conflictRouter := chi.NewRouter()
	product_analysis.NewRegistrar(
		store,
		audit.NewMockService(),
		product_analysis.WithCalculationEngine(conflictEngine),
	).RegisterRoutes(conflictRouter, stage8DPassthrough)
	assertStatus(
		t,
		conflictRouter,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/product-analysis/calculation/run",
			`{"project_id":7,"country":"US","start_date":"2026-10-01","end_date":"2026-10-31"}`,
			identity,
		),
		http.StatusConflict,
	)

	store.verifyErr = product_analysis.ErrProjectForbidden
	assertStatus(
		t,
		router,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis/weekly?project_id=7&country=US",
			"",
			identity,
		),
		http.StatusForbidden,
	)

	store.verifyErr = nil
	store.sourceProjectErr = product_analysis.ErrNotFound
	assertStatus(
		t,
		router,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis/sources/999/rows",
			"",
			identity,
		),
		http.StatusNotFound,
	)

	assertStatus(
		t,
		router,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis/inventory/current?project_id=0",
			"",
			identity,
		),
		http.StatusUnprocessableEntity,
	)
	assertStatus(
		t,
		router,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/product-analysis/calculation/check",
			`{"project_id":7,"start_date":"not-a-date","end_date":"2026-10-31"}`,
			identity,
		),
		http.StatusUnprocessableEntity,
	)
}

type stage8DReportsStore struct {
	product_analysis_reports.Store
	createResult  *product_analysis_reports.Task
	createErr     error
	createInput   product_analysis_reports.CreateInput
	task          *product_analysis_reports.Task
	taskErr       error
	failedTaskID  int64
	failedMessage string
}

func (store *stage8DReportsStore) CreateTask(
	_ context.Context,
	input product_analysis_reports.CreateInput,
) (*product_analysis_reports.Task, error) {
	store.createInput = input
	if store.createErr != nil {
		return nil, store.createErr
	}
	if store.createResult != nil {
		return store.createResult, nil
	}
	return stage8DReportTask(), nil
}

func (store *stage8DReportsStore) GetTask(
	context.Context,
	int64,
	string,
	bool,
) (*product_analysis_reports.Task, error) {
	return store.task, store.taskErr
}

func (store *stage8DReportsStore) MarkTaskFailed(
	_ context.Context,
	taskID int64,
	message string,
) error {
	store.failedTaskID = taskID
	store.failedMessage = message
	return nil
}

type stage8DReportEnqueuer struct {
	ids []int64
	err error
}

func (enqueuer *stage8DReportEnqueuer) EnqueueProductAnalysisReport(
	_ context.Context,
	taskID int64,
) error {
	enqueuer.ids = append(enqueuer.ids, taskID)
	return enqueuer.err
}

type stage8DObjectURLBuilder struct {
	url string
	err error
}

func (builder stage8DObjectURLBuilder) PublicURL(context.Context, string) (string, error) {
	return builder.url, builder.err
}

func TestStage8DProductAnalysisReportContract(t *testing.T) {
	auditor := audit.NewMockService()
	identity := auth.UserContext{Operator: "alice", IsAdmin: false}
	store := &stage8DReportsStore{createResult: stage8DReportTask()}
	enqueuer := &stage8DReportEnqueuer{}
	router := chi.NewRouter()
	product_analysis_reports.NewRegistrarWithDependencies(
		store,
		auditor,
		enqueuer,
		t.TempDir(),
		nil,
	).RegisterRoutes(router, stage8DPassthrough)

	createBody := `{
	  "project_name":"Project A",
	  "report_start_date":"2026-10-01",
	  "report_end_date":"2026-10-31",
	  "business_report_file_id":"business.csv",
	  "payment_report_file_id":"payment.csv",
	  "ad_report_file_id":"ads.xlsx",
	  "country":"USA"
	}`
	response := stage8DServe(
		router,
		stage8DRequest(http.MethodPost, "/api/v1/product-analysis-reports", createBody, identity),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", response.Code, response.Body.String())
	}
	if enqueuer.ids[0] != 42 || store.createInput.Operator != "alice" {
		t.Fatalf("enqueue ids = %#v, create input = %#v", enqueuer.ids, store.createInput)
	}

	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/product-analysis-reports",
			strings.Replace(createBody, `"2026-10-01"`, `"2026-13-40"`, 1),
			identity,
		),
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid date status = %d, body=%s", response.Code, response.Body.String())
	}

	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/product-analysis-reports",
			`{"project_name":"Project A"}`,
			identity,
		),
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing fields status = %d, body=%s", response.Code, response.Body.String())
	}

	noQueueRouter := chi.NewRouter()
	product_analysis_reports.NewRegistrarWithDependencies(
		store, auditor, nil, t.TempDir(), nil,
	).RegisterRoutes(noQueueRouter, stage8DPassthrough)
	response = stage8DServe(
		noQueueRouter,
		stage8DRequest(http.MethodPost, "/api/v1/product-analysis-reports", createBody, identity),
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing enqueuer status = %d, body=%s", response.Code, response.Body.String())
	}
	if store.failedTaskID != 42 || store.failedMessage == "" {
		t.Fatalf("failed task = %d %q", store.failedTaskID, store.failedMessage)
	}

	localRoot := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(localRoot, "result.xlsx"),
		[]byte("result"),
		0o600,
	); err != nil {
		t.Fatalf("write result: %v", err)
	}
	success := stage8DReportTask()
	success.Status = product_analysis_reports.StatusSuccess
	success.ResultPath = stage8DString("result.xlsx")
	store.task = success
	resultRouter := chi.NewRouter()
	product_analysis_reports.NewRegistrarWithDependencies(
		store, auditor, nil, localRoot, nil,
	).RegisterRoutes(resultRouter, stage8DPassthrough)
	response = stage8DServe(
		resultRouter,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			identity,
		),
	)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "result") {
		t.Fatalf("local result status = %d, body=%q", response.Code, response.Body.String())
	}

	store.task = stage8DReportTask()
	response = stage8DServe(
		resultRouter,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			identity,
		),
	)
	if response.Code != http.StatusConflict {
		t.Fatalf("unfinished result status = %d, body=%s", response.Code, response.Body.String())
	}

	store.taskErr = product_analysis_reports.ErrProjectForbidden
	response = stage8DServe(
		resultRouter,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42",
			"",
			identity,
		),
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden status status = %d, body=%s", response.Code, response.Body.String())
	}

	store.taskErr = product_analysis_reports.ErrTaskNotFound
	response = stage8DServe(
		resultRouter,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42",
			"",
			identity,
		),
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing task status = %d, body=%s", response.Code, response.Body.String())
	}

	store.taskErr = nil
	success = stage8DReportTask()
	success.Status = product_analysis_reports.StatusSuccess
	success.ResultPath = stage8DString("objects/result.xlsx")
	store.task = success
	objectRouter := chi.NewRouter()
	product_analysis_reports.NewRegistrarWithDependencies(
		store,
		auditor,
		nil,
		"",
		stage8DObjectURLBuilder{url: "https://r2.example.com/result.xlsx"},
	).RegisterRoutes(objectRouter, stage8DPassthrough)
	response = stage8DServe(
		objectRouter,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			identity,
		),
	)
	if response.Code != http.StatusFound ||
		response.Header().Get("Location") != "https://r2.example.com/result.xlsx" {
		t.Fatalf("object result = %d location=%q", response.Code, response.Header().Get("Location"))
	}

	store.task = success
	missingObjectRouter := chi.NewRouter()
	product_analysis_reports.NewRegistrarWithDependencies(
		store, auditor, nil, "", nil,
	).RegisterRoutes(missingObjectRouter, stage8DPassthrough)
	response = stage8DServe(
		missingObjectRouter,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			identity,
		),
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing object storage status = %d, body=%s", response.Code, response.Body.String())
	}

	success.ResultPath = stage8DString("../secret.xlsx")
	store.task = success
	response = stage8DServe(
		resultRouter,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			identity,
		),
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("traversal result status = %d, body=%s", response.Code, response.Body.String())
	}
}

type stage8DInspectionStore struct {
	inspections.Store
	accessErr    error
	period       *inspections.Period
	report       *inspections.Report
	inserted     *inspections.ScreenshotRecord
	screenshot   *inspections.ScreenshotRecord
	submitErr    error
	deleteResult bool
}

func (store *stage8DInspectionStore) VerifyProjectAccess(
	context.Context,
	int64,
	string,
	bool,
) error {
	return store.accessErr
}

func (*stage8DInspectionStore) ListPeriods(
	context.Context,
	int,
	int,
) (inspections.PeriodListResponse, error) {
	return inspections.PeriodListResponse{
		Items: []inspections.Period{stage8DPeriod()},
		Total: 1,
	}, nil
}

func (*stage8DInspectionStore) GetOrCreateCurrentPeriod(
	context.Context,
) (inspections.Period, error) {
	return stage8DPeriod(), nil
}

func (store *stage8DInspectionStore) GetPeriod(
	context.Context,
	int64,
) (*inspections.Period, error) {
	return store.period, nil
}

func (*stage8DInspectionStore) GetOverview(
	context.Context,
	int64,
	string,
	bool,
) (*inspections.OverviewResponse, error) {
	period := stage8DPeriod()
	return &inspections.OverviewResponse{
		Period: period,
		Items: []inspections.OverviewItem{
			{
				ProjectID:   7,
				ProjectName: "Project A",
				Status:      "submitted",
				Screenshots: []inspections.OverviewScreenshot{
					{
						ID:           5,
						R2Key:        "inspection-screenshots/project-a/report_9/one.png",
						ThumbnailKey: stage8DString("thumb"),
					},
				},
			},
		},
	}, nil
}

func (store *stage8DInspectionStore) GetReport(
	context.Context,
	int64,
	int64,
) (*inspections.Report, error) {
	return store.report, nil
}

func (*stage8DInspectionStore) GetReportByID(
	context.Context,
	int64,
) (*inspections.Report, error) {
	return stage8DInspectionReport(), nil
}

func (*stage8DInspectionStore) CreateOrUpdateReport(
	context.Context,
	int64,
	int64,
	inspections.ReportWriteInput,
) (*inspections.Report, error) {
	return stage8DInspectionReport(), nil
}

func (store *stage8DInspectionStore) SubmitReport(
	context.Context,
	int64,
	*string,
) (*inspections.Report, []inspections.ThresholdWarning, error) {
	if store.submitErr != nil {
		return nil, nil, store.submitErr
	}
	report := stage8DInspectionReport()
	report.Status = "submitted"
	return report, []inspections.ThresholdWarning{
		{Metric: "negative_feedback", Severity: "warning", Threshold: 1},
	}, nil
}

func (store *stage8DInspectionStore) GetScreenshot(
	context.Context,
	int64,
) (*inspections.ScreenshotRecord, error) {
	if store.screenshot == nil {
		screenshot := stage8DScreenshotRecord()
		return &screenshot, nil
	}
	return store.screenshot, nil
}

func (store *stage8DInspectionStore) InsertScreenshot(
	_ context.Context,
	input inspections.InsertScreenshotInput,
) (*inspections.ScreenshotRecord, error) {
	if store.inserted == nil {
		record := stage8DScreenshotRecord()
		record.ReportID = input.ReportID
		record.R2Key = input.R2Key
		record.Filename = input.Filename
		record.ContentType = input.ContentType
		record.FileSize = input.FileSize
		return &record, nil
	}
	return store.inserted, nil
}

func (store *stage8DInspectionStore) DeleteScreenshot(
	context.Context,
	int64,
) (bool, error) {
	return true, nil
}

func (*stage8DInspectionStore) ListHistory(
	context.Context,
	inspections.HistoryFilter,
) (inspections.HistoryResponse, error) {
	return inspections.HistoryResponse{
		Items: []inspections.HistoryItem{
			{
				ID:          9,
				PeriodID:    4,
				WeekStart:   "2026-11-02",
				WeekEnd:     "2026-11-08",
				ProjectID:   7,
				ProjectName: "Project A",
				Status:      "submitted",
			},
		},
		Total: 1,
	}, nil
}

type stage8DBlobStore struct {
	putURL    string
	putErr    error
	deleteErr error
	deleted   []string
}

func (store *stage8DBlobStore) Put(
	_ context.Context,
	_ string,
	_ []byte,
	_ string,
) (string, error) {
	return store.putURL, store.putErr
}

func (store *stage8DBlobStore) Delete(
	_ context.Context,
	key string,
) error {
	store.deleted = append(store.deleted, key)
	return store.deleteErr
}

func (store *stage8DBlobStore) Presign(
	context.Context,
	string,
) (string, error) {
	return store.putURL, nil
}

func TestStage8DInspectionsContract(t *testing.T) {
	store := &stage8DInspectionStore{
		period: stage8DPeriodPointer(),
		report: stage8DInspectionReport(),
	}
	blobs := &stage8DBlobStore{putURL: "https://cdn.example.com/shot.png"}
	auditor := audit.NewMockService()
	router := chi.NewRouter()
	inspections.NewRegistrar(store, blobs, auditor).RegisterRoutes(
		router,
		stage8DPassthrough,
	)
	identity := auth.UserContext{Operator: "alice"}

	tests := []struct {
		name     string
		method   string
		target   string
		body     string
		status   int
		fragment string
	}{
		{"template", http.MethodGet, "/api/v1/inspections/template", "", http.StatusOK, "account_health_rating"},
		{"periods", http.MethodGet, "/api/v1/inspections/periods?limit=20&offset=0", "", http.StatusOK, `"total":1`},
		{"current period", http.MethodGet, "/api/v1/inspections/periods/current", "", http.StatusOK, `"week_start":"2026-11-02"`},
		{"overview", http.MethodGet, "/api/v1/inspections/periods/4/overview", "", http.StatusOK, `"submitted_count":1`},
		{"get report", http.MethodGet, "/api/v1/inspections/periods/4/projects/7", "", http.StatusOK, `"project_id":7`},
		{"create report", http.MethodPost, "/api/v1/inspections/periods/4/projects/7", `{"status_summary":"ok"}`, http.StatusCreated, `"status_summary":"ok"`},
		{"update report", http.MethodPatch, "/api/v1/inspections/periods/4/projects/7", `{"status_summary":"updated"}`, http.StatusOK, `"project_id":7`},
		{"submit report", http.MethodPost, "/api/v1/inspections/periods/4/projects/7/submit", "", http.StatusOK, `"status":"submitted"`},
		{"history", http.MethodGet, "/api/v1/inspections/history?limit=50", "", http.StatusOK, `"project_name":"Project A"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := stage8DServe(
				router,
				stage8DRequest(test.method, test.target, test.body, identity),
			)
			if response.Code != test.status {
				t.Fatalf("%s status = %d, want %d, body=%s", test.name, response.Code, test.status, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), test.fragment) {
				t.Fatalf("%s body = %s, want %q", test.name, response.Body.String(), test.fragment)
			}
		})
	}

	uploadResponse := stage8DServe(
		router,
		stage8DScreenshotUploadRequest(t, "/api/v1/inspections/screenshots/upload?report_id=9", "shot.png", "image/png", []byte{
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		}, identity),
	)
	if uploadResponse.Code != http.StatusCreated ||
		!strings.Contains(uploadResponse.Body.String(), `"url":"https://cdn.example.com/shot.png"`) {
		t.Fatalf("upload status = %d, body=%s", uploadResponse.Code, uploadResponse.Body.String())
	}

	deleteResponse := stage8DServe(
		router,
		stage8DRequest(http.MethodDelete, "/api/v1/inspections/screenshots/5", "", identity),
	)
	if deleteResponse.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}
	if len(blobs.deleted) == 0 {
		t.Fatal("screenshot blob was not deleted")
	}

	store.accessErr = inspections.ErrProjectForbidden
	response := stage8DServe(
		router,
		stage8DRequest(http.MethodGet, "/api/v1/inspections/periods/4/projects/7", "", identity),
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden status = %d, body=%s", response.Code, response.Body.String())
	}

	store.accessErr = nil
	store.period = nil
	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/inspections/periods/999/projects/7",
			`{}`,
			identity,
		),
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing period status = %d, body=%s", response.Code, response.Body.String())
	}

	store.period = stage8DPeriodPointer()
	store.submitErr = inspections.ErrConflict
	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/inspections/periods/4/projects/7/submit",
			"",
			identity,
		),
	)
	if response.Code != http.StatusConflict {
		t.Fatalf("submit conflict status = %d, body=%s", response.Code, response.Body.String())
	}
	store.submitErr = nil

	response = stage8DServe(
		router,
		stage8DScreenshotUploadRequest(t, "/api/v1/inspections/screenshots/upload?report_id=9", "shot.png", "image/png", []byte("not an image"), identity),
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid image status = %d, body=%s", response.Code, response.Body.String())
	}

	response = stage8DServe(
		router,
		stage8DScreenshotUploadRequest(t, "/api/v1/inspections/screenshots/upload", "shot.png", "image/png", []byte{
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		}, identity),
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing report id status = %d, body=%s", response.Code, response.Body.String())
	}

	noBlobRouter := chi.NewRouter()
	inspections.NewRegistrar(store, nil, auditor).RegisterRoutes(
		noBlobRouter,
		stage8DPassthrough,
	)
	response = stage8DServe(
		noBlobRouter,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/inspections/screenshots/upload?report_id=9",
			"",
			identity,
		),
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing blob store status = %d, body=%s", response.Code, response.Body.String())
	}
}

type stage8DAmazonStore struct {
	amazon_review_tracking.Store
	groups           []amazon_review_tracking.ReviewGroupItem
	group            *amazon_review_tracking.ReviewGroupItem
	mutation         *amazon_review_tracking.ReviewGroupMutation
	targets          []amazon_review_tracking.TargetItem
	snapshots        []amazon_review_tracking.RatingSnapshotItem
	reviews          []amazon_review_tracking.ReviewItem
	runs             []amazon_review_tracking.CrawlRunItem
	externalTargets  []amazon_review_tracking.ExternalTargetItem
	externalTarget   *amazon_review_tracking.ExternalTargetItem
	externalLink     *amazon_review_tracking.ExternalLinkItem
	createGroupErr   error
	patchGroupErr    error
	listTargetsErr   error
	snapshotsErr     error
	lastTargetFilter *amazon_review_tracking.TargetListFilter
}

func (store *stage8DAmazonStore) GetSessionAccount(
	_ context.Context,
	userID string,
) (*amazon_review_tracking.SessionAccount, error) {
	switch userID {
	case "admin":
		return &amazon_review_tracking.SessionAccount{
			IsAdmin: true, IsActive: true, RoleType: "admin",
		}, nil
	case "operator":
		return &amazon_review_tracking.SessionAccount{
			IsAdmin: false, IsActive: true, RoleType: "operator",
		}, nil
	case "viewer":
		return &amazon_review_tracking.SessionAccount{
			IsAdmin: false, IsActive: true, RoleType: "viewer",
		}, nil
	case "inactive":
		return &amazon_review_tracking.SessionAccount{
			IsAdmin: false, IsActive: false, RoleType: "operator",
		}, nil
	default:
		return nil, nil
	}
}

func (store *stage8DAmazonStore) ListGroups(
	context.Context,
	amazon_review_tracking.GroupListFilter,
) ([]amazon_review_tracking.ReviewGroupItem, error) {
	return store.groups, nil
}

func (store *stage8DAmazonStore) CreateGroup(
	context.Context,
	amazon_review_tracking.ReviewGroupCreateInput,
) (*amazon_review_tracking.ReviewGroupItem, error) {
	if store.createGroupErr != nil {
		return nil, store.createGroupErr
	}
	return store.group, nil
}

func (store *stage8DAmazonStore) PatchGroup(
	context.Context,
	int64,
	amazon_review_tracking.ReviewGroupPatchInput,
) (*amazon_review_tracking.ReviewGroupMutation, error) {
	if store.patchGroupErr != nil {
		return nil, store.patchGroupErr
	}
	return store.mutation, nil
}

func (store *stage8DAmazonStore) DeactivateGroup(
	context.Context,
	int64,
) (*amazon_review_tracking.ReviewGroupMutation, error) {
	return store.mutation, nil
}

func (store *stage8DAmazonStore) ListTargets(
	_ context.Context,
	filter amazon_review_tracking.TargetListFilter,
) ([]amazon_review_tracking.TargetItem, error) {
	store.lastTargetFilter = &filter
	return store.targets, store.listTargetsErr
}

func (store *stage8DAmazonStore) ListRatingSnapshots(
	context.Context,
	amazon_review_tracking.RatingSnapshotFilter,
) ([]amazon_review_tracking.RatingSnapshotItem, error) {
	return store.snapshots, store.snapshotsErr
}

func (store *stage8DAmazonStore) ListReviews(
	context.Context,
	amazon_review_tracking.ReviewFilter,
) ([]amazon_review_tracking.ReviewItem, error) {
	return store.reviews, nil
}

func (store *stage8DAmazonStore) ListRuns(
	context.Context,
	amazon_review_tracking.CrawlRunFilter,
) ([]amazon_review_tracking.CrawlRunItem, error) {
	return store.runs, nil
}

func (store *stage8DAmazonStore) ListExternalTargets(
	context.Context,
	int64,
	int64,
) ([]amazon_review_tracking.ExternalTargetItem, error) {
	return store.externalTargets, nil
}

func (store *stage8DAmazonStore) CreateExternalTarget(
	context.Context,
	amazon_review_tracking.ExternalTargetCreateInput,
) (*amazon_review_tracking.ExternalTargetItem, error) {
	return store.externalTarget, nil
}

func (store *stage8DAmazonStore) AddExternalLink(
	context.Context,
	int64,
	int64,
) (*amazon_review_tracking.ExternalLinkItem, error) {
	return store.externalLink, nil
}

func (store *stage8DAmazonStore) RemoveExternalLink(
	context.Context,
	int64,
	int64,
) (*amazon_review_tracking.ExternalLinkItem, error) {
	return store.externalLink, nil
}

func (store *stage8DAmazonStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, amazon_review_tracking.Store) error,
) error {
	return fn(ctx, nil, store)
}

func TestStage8DAmazonReviewTrackingContract(t *testing.T) {
	storeValue := stage8DAmazonFixture()
	store := &storeValue
	router := chi.NewRouter()
	amazon_review_tracking.NewRegistrar(store, audit.NewMockService()).RegisterRoutes(
		router,
		stage8DPassthrough,
	)
	admin := auth.UserContext{
		UserID: "admin", SessionID: "session-admin",
		Operator: "admin", IsAdmin: true,
	}
	operator := auth.UserContext{
		UserID: "operator", SessionID: "session-operator",
		Operator: "operator", IsAdmin: false,
	}

	tests := []struct {
		name   string
		method string
		target string
		body   string
		status int
	}{
		{"external targets", http.MethodGet, "/api/v1/amazon-review-tracking/external-targets", "", http.StatusOK},
		{"create external target", http.MethodPost, "/api/v1/amazon-review-tracking/external-targets", `{"marketplace":"US","asin":"B012345678","display_name":"Competitor"}`, http.StatusCreated},
		{"groups", http.MethodGet, "/api/v1/amazon-review-tracking/groups", "", http.StatusOK},
		{"create group", http.MethodPost, "/api/v1/amazon-review-tracking/groups", `{"project_id":10,"marketplace":"US","name":"Core","member_ids":[101,102],"representative_id":101}`, http.StatusCreated},
		{"patch group", http.MethodPatch, "/api/v1/amazon-review-tracking/groups/1", `{"name":"Core Updated"}`, http.StatusOK},
		{"deactivate group", http.MethodPost, "/api/v1/amazon-review-tracking/groups/1/deactivate", "", http.StatusOK},
		{"targets", http.MethodGet, "/api/v1/amazon-review-tracking/targets?project_id=10", "", http.StatusOK},
		{"create external link", http.MethodPost, "/api/v1/amazon-review-tracking/targets/5/external-links", `{"shop_id":3}`, http.StatusCreated},
		{"delete external link", http.MethodDelete, "/api/v1/amazon-review-tracking/targets/5/external-links/9", "", http.StatusOK},
		{"rating snapshots", http.MethodGet, "/api/v1/amazon-review-tracking/targets/5/rating-snapshots", "", http.StatusOK},
		{"reviews", http.MethodGet, "/api/v1/amazon-review-tracking/targets/5/reviews", "", http.StatusOK},
		{"runs", http.MethodGet, "/api/v1/amazon-review-tracking/targets/5/runs", "", http.StatusOK},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := stage8DServe(
				router,
				stage8DRequest(test.method, test.target, test.body, admin),
			)
			if response.Code != test.status {
				t.Fatalf("%s status = %d, want %d, body=%s", test.name, response.Code, test.status, response.Body.String())
			}
		})
	}

	response := stage8DServe(
		router,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/amazon-review-tracking/targets?project_id=10",
			"",
			operator,
		),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("operator targets status = %d, body=%s", response.Code, response.Body.String())
	}
	if store.lastTargetFilter == nil ||
		store.lastTargetFilter.ProjectID == nil ||
		*store.lastTargetFilter.ProjectID != 10 ||
		store.lastTargetFilter.Operator != "operator" ||
		store.lastTargetFilter.IsAdmin {
		t.Fatalf("target filter = %#v", store.lastTargetFilter)
	}

	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/amazon-review-tracking/targets",
			"",
			auth.UserContext{UserID: "admin", Operator: "admin"},
		),
	)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing session status = %d, body=%s", response.Code, response.Body.String())
	}

	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/amazon-review-tracking/targets",
			"",
			auth.UserContext{
				UserID: "viewer", SessionID: "session-viewer", Operator: "viewer",
			},
		),
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("viewer status = %d, body=%s", response.Code, response.Body.String())
	}

	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/amazon-review-tracking/groups",
			"",
			operator,
		),
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-admin groups status = %d, body=%s", response.Code, response.Body.String())
	}

	store.snapshotsErr = amazon_review_tracking.NewError(http.StatusNotFound, "review target not found")
	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodGet,
			"/api/v1/amazon-review-tracking/targets/404/rating-snapshots",
			"",
			admin,
		),
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("target not found status = %d, body=%s", response.Code, response.Body.String())
	}
	store.snapshotsErr = nil

	store.createGroupErr = amazon_review_tracking.NewError(
		http.StatusConflict,
		"active review group with this name already exists",
	)
	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/amazon-review-tracking/groups",
			`{"project_id":10,"marketplace":"US","name":"Core","member_ids":[101,102],"representative_id":101}`,
			admin,
		),
	)
	if response.Code != http.StatusConflict {
		t.Fatalf("group conflict status = %d, body=%s", response.Code, response.Body.String())
	}
	store.createGroupErr = nil

	response = stage8DServe(
		router,
		stage8DRequest(
			http.MethodPost,
			"/api/v1/amazon-review-tracking/external-targets",
			`{"marketplace":"XX","asin":"bad"}`,
			admin,
		),
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid external target status = %d, body=%s", response.Code, response.Body.String())
	}
}

func stage8DPassthrough(next http.Handler) http.Handler {
	return next
}

func stage8DRouteInventory(t *testing.T, router chi.Router) []string {
	t.Helper()
	var routes []string
	if err := chi.Walk(router, func(
		method string,
		route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		routes = append(routes, method+" "+route)
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	return routes
}

func stage8DFillRouteParameters(route string) string {
	for {
		start := strings.Index(route, "{")
		if start < 0 {
			return route
		}
		end := strings.Index(route[start:], "}")
		if end < 0 {
			return route
		}
		route = route[:start] + "1" + route[start+end+1:]
	}
}

func stage8DRequest(
	method string,
	target string,
	body string,
	identity auth.UserContext,
) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request = request.WithContext(auth.WithUserContext(request.Context(), identity))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func stage8DServe(router http.Handler, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func stage8DScreenshotUploadRequest(
	t *testing.T,
	target string,
	filename string,
	contentType string,
	data []byte,
	identity auth.UserContext,
) *http.Request {
	t.Helper()
	body := bytes.NewBuffer(nil)
	writer := multipart.NewWriter(body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filename))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("create multipart part: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write multipart part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, target, body)
	request = request.WithContext(auth.WithUserContext(request.Context(), identity))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func stage8DProductSource() product_analysis.AnalysisSourceFileItem {
	return product_analysis.AnalysisSourceFileItem{
		ID:               11,
		ProjectID:        7,
		ReportType:       "business_report",
		PeriodStartDate:  stage8DString("2026-10-01"),
		PeriodEndDate:    stage8DString("2026-10-31"),
		Version:          1,
		IsCurrent:        true,
		UploadFileID:     "business.csv",
		UploadFilePath:   "uploads/project-a/business.csv",
		StoredFilename:   "business.csv",
		LogicalFilename:  "business.csv",
		StorageKey:       "project-a/business.csv",
		IngestionStatus:  "success",
		RowCountTotal:    2,
		RowCountIncluded: 2,
	}
}

func stage8DPT1() product_analysis.PT1CalculationItem {
	return product_analysis.PT1CalculationItem{
		ID:                 12,
		ProjectID:          7,
		ProjectName:        "Project A",
		Country:            "US",
		ReportStartDate:    "2026-10-01",
		ReportEndDate:      "2026-10-31",
		Version:            1,
		IsCurrent:          true,
		RowCount:           2,
		SummaryRow:         map[string]any{},
		CalculationVersion: 1,
	}
}

func stage8DRunResponse() *product_analysis.RunResponse {
	return &product_analysis.RunResponse{
		ProjectID:    7,
		ProjectName:  "Project A",
		Country:      "US",
		TotalPeriods: 1,
		Periods: []product_analysis.CalculationPeriod{
			{
				ReportStartDate: "2026-10-01",
				ReportEndDate:   "2026-10-31",
				Summary:         map[string]any{},
				Details:         []map[string]any{},
				Persisted:       false,
			},
		},
	}
}

func stage8DReportTask() *product_analysis_reports.Task {
	message := "处理中：任务已接收"
	return &product_analysis_reports.Task{
		ID:                42,
		Status:            product_analysis_reports.StatusPending,
		Stage:             "started",
		Progress:          1,
		Message:           &message,
		PersistenceStatus: "idle",
		CreatedAt:         "2026-11-08T01:02:03Z",
		UpdatedAt:         "2026-11-08T01:02:03Z",
		ProjectID:         7,
		ProjectName:       "Project A",
	}
}

func stage8DPeriod() inspections.Period {
	return inspections.Period{
		ID:        4,
		WeekStart: "2026-11-02",
		WeekEnd:   "2026-11-08",
		Deadline:  "2026-11-09T09:00:00+08:00",
		CreatedAt: "2026-11-02T00:00:00+08:00",
	}
}

func stage8DPeriodPointer() *inspections.Period {
	period := stage8DPeriod()
	return &period
}

func stage8DInspectionReport() *inspections.Report {
	statusSummary := "ok"
	return &inspections.Report{
		ID:            9,
		PeriodID:      4,
		ProjectID:     7,
		ProjectName:   "Project A",
		Status:        "draft",
		StatusSummary: &statusSummary,
		Screenshots:   []inspections.ScreenshotItem{},
		CreatedAt:     "2026-11-08T10:00:00+08:00",
		UpdatedAt:     "2026-11-08T10:00:00+08:00",
	}
}

func stage8DScreenshotRecord() inspections.ScreenshotRecord {
	return inspections.ScreenshotRecord{
		ID:          5,
		ReportID:    9,
		ProjectID:   7,
		R2Key:       "inspection-screenshots/project-a/report_9/one.png",
		Filename:    "one.png",
		ContentType: "image/png",
		FileSize:    8,
		SortOrder:   0,
		CreatedAt:   "2026-11-08T10:00:00+08:00",
	}
}

func stage8DAmazonFixture() stage8DAmazonStore {
	group := amazon_review_tracking.ReviewGroupItem{
		ID:               1,
		ProjectID:        10,
		Marketplace:      "US",
		Name:             "Core",
		MemberIDs:        []int64{101, 102},
		RepresentativeID: stage8DInt64(101),
		IsActive:         true,
	}
	asin := "B012345678"
	displayName := "Competitor"
	link := &amazon_review_tracking.ExternalLinkItem{
		ID: 9, TargetID: 5, ShopID: 3, IsActive: true,
	}
	return stage8DAmazonStore{
		groups: []amazon_review_tracking.ReviewGroupItem{group},
		group:  &group,
		mutation: &amazon_review_tracking.ReviewGroupMutation{
			Before: &group,
			After: &amazon_review_tracking.ReviewGroupItem{
				ID:               1,
				ProjectID:        10,
				Marketplace:      "US",
				Name:             "Core Updated",
				MemberIDs:        []int64{101, 102},
				RepresentativeID: stage8DInt64(101),
				IsActive:         true,
			},
		},
		targets: []amazon_review_tracking.TargetItem{
			{
				ID:          5,
				Kind:        "external_asin",
				Marketplace: "US",
				ASIN:        &asin,
				DisplayName: &displayName,
				IsActive:    true,
			},
		},
		snapshots: []amazon_review_tracking.RatingSnapshotItem{
			{
				CaptureDate:      "2026-10-21",
				CapturedAt:       "2026-10-21T00:00:00Z",
				StarCountQuality: "exact",
				CaptureStatus:    "success",
			},
		},
		reviews: []amazon_review_tracking.ReviewItem{
			{
				ReviewKey:        "R1",
				IDConfidence:     "original",
				FirstSeenAt:      "2026-10-21T00:00:00Z",
				LastSeenAt:       "2026-10-21T00:00:00Z",
				VisibilityStatus: "visible",
			},
		},
		runs: []amazon_review_tracking.CrawlRunItem{
			{
				ID:              7,
				StartedAt:       "2026-10-21T00:00:00Z",
				Status:          "success",
				IsCompleteList:  true,
				RatingsCaptured: true,
			},
		},
		externalTargets: []amazon_review_tracking.ExternalTargetItem{
			{
				TargetItem: amazon_review_tracking.TargetItem{
					ID:          5,
					Kind:        "external_asin",
					Marketplace: "US",
					ASIN:        &asin,
					DisplayName: &displayName,
					IsActive:    true,
				},
				Links: []amazon_review_tracking.ExternalLinkItem{*link},
			},
		},
		externalTarget: &amazon_review_tracking.ExternalTargetItem{
			TargetItem: amazon_review_tracking.TargetItem{
				ID:          5,
				Kind:        "external_asin",
				Marketplace: "US",
				ASIN:        &asin,
				DisplayName: &displayName,
				IsActive:    true,
			},
			Links: []amazon_review_tracking.ExternalLinkItem{*link},
		},
		externalLink: link,
	}
}

func stage8DString(value string) *string {
	return &value
}

func stage8DInt64(value int64) *int64 {
	return &value
}
