package daily_analysis

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockDailyAnalysisStore struct {
	accessErr       error
	accessibleIDs   []int64
	singleResp      *DailyAnalysisResponse
	allProjectsResp *DailyAnalysisAllProjectsResponse
	allCountriesResp *DailyAnalysisAllCountriesResponse
	allProjCountResp *DailyAnalysisAllProjectsCountriesResponse
	exchangeRateErr bool
}

func (m *mockDailyAnalysisStore) VerifyProjectAccess(_ context.Context, projectID int64, _ string, _ bool) error {
	if projectID == 999 {
		return ErrProjectNotFound
	}
	return m.accessErr
}

func (m *mockDailyAnalysisStore) AccessibleProjectIDs(_ context.Context, _ string, _ bool) ([]int64, error) {
	return m.accessibleIDs, nil
}

func (m *mockDailyAnalysisStore) GetDailyAnalysis(_ context.Context, projectID int64, country string, startDate, endDate string, sku *string) (*DailyAnalysisResponse, error) {
	if m.singleResp != nil {
		return m.singleResp, nil
	}
	return &DailyAnalysisResponse{
		Console: DailyAnalysisConsoleResponse{
			ProjectID:   projectID,
			ProjectName: "Test Project",
			Country:     country,
			StartDate:   startDate,
			EndDate:     endDate,
		},
		SummaryRows: []DailyAnalysisSummaryRow{
			{Date: startDate, OrderQty: 10, SalesAmount: 100.5, ConversionRate: 0.15},
		},
		DetailRows: []DailyAnalysisDetailRow{
			{Date: startDate, SKU: "SKU-1", OrderQty: 10, SalesAmount: 100.5, ConversionRate: 0.15},
		},
		AvailableDates: map[string][]string{
			"sales_report": {startDate},
		},
	}, nil
}

func (m *mockDailyAnalysisStore) GetDailyAnalysisAll(_ context.Context, projectIDs []int64, country string, startDate, endDate string, sku *string, includeDetail bool) (*DailyAnalysisAllProjectsResponse, error) {
	if m.allProjectsResp != nil {
		return m.allProjectsResp, nil
	}
	details := []DailyAnalysisDetailRow{
		{Date: startDate, SKU: "SKU-1", OrderQty: 10, SalesAmount: 100.5},
	}
	if !includeDetail {
		details = []DailyAnalysisDetailRow{}
	}
	return &DailyAnalysisAllProjectsResponse{
		SummaryRows: []DailyAnalysisSummaryRow{
			{Date: startDate, OrderQty: 10, SalesAmount: 100.5},
		},
		DetailRows: details,
		AvailableDates: map[string][]string{
			"sales_report": {startDate},
		},
		ProjectBreakdown: map[int64]ProjectBreakdownBlock{
			projectIDs[0]: {
				ProjectName: "Test Proj",
				SummaryRows: []DailyAnalysisSummaryRow{{Date: startDate, OrderQty: 10}},
				DetailRows:  details,
			},
		},
	}, nil
}

func (m *mockDailyAnalysisStore) GetDailyAnalysisAllCountries(_ context.Context, projectID int64, startDate, endDate string) (*DailyAnalysisAllCountriesResponse, error) {
	if m.exchangeRateErr {
		return nil, ErrExchangeRateMissing
	}
	if m.allCountriesResp != nil {
		return m.allCountriesResp, nil
	}
	note := "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。"
	return &DailyAnalysisAllCountriesResponse{
		Console: DailyAnalysisConsoleResponse{
			ProjectID: projectID,
			Country:   "ALL",
			StartDate: startDate,
			EndDate:   endDate,
		},
		SummaryRows: []DailyAnalysisSummaryRow{{Date: startDate, OrderQty: 25, SalesAmount: 250.0}},
		DetailRows:  []DailyAnalysisDetailRow{{Date: startDate, SKU: "SKU-1", OrderQty: 25, SalesAmount: 250.0}},
		CountryBreakdown: map[string]CountryBreakdownBlock{
			"US": {Currency: "USD", SourceCurrency: "USD"},
		},
		Currency:     "USD",
		CurrencyNote: &note,
	}, nil
}

func (m *mockDailyAnalysisStore) GetDailyAnalysisAllProjectsCountries(_ context.Context, projectIDs []int64, startDate, endDate string) (*DailyAnalysisAllProjectsCountriesResponse, error) {
	if m.exchangeRateErr {
		return nil, ErrExchangeRateMissing
	}
	if m.allProjCountResp != nil {
		return m.allProjCountResp, nil
	}
	note := "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。"
	return &DailyAnalysisAllProjectsCountriesResponse{
		Console: DailyAnalysisConsoleResponse{
			ProjectID: 0,
			Country:   "ALL",
			StartDate: startDate,
			EndDate:   endDate,
		},
		SummaryRows: []DailyAnalysisSummaryRow{{Date: startDate, OrderQty: 50, SalesAmount: 500.0}},
		DetailRows:  []DailyAnalysisDetailRow{{Date: startDate, SKU: "SKU-1", OrderQty: 50, SalesAmount: 500.0}},
		ProjectBreakdown: map[int64]ProjectBreakdownBlock{
			projectIDs[0]: {ProjectName: "Proj 1"},
		},
		CountryBreakdown: map[string]CountryBreakdownBlock{
			"US": {Currency: "USD", SourceCurrency: "USD"},
		},
		Currency:     "USD",
		CurrencyNote: &note,
	}, nil
}

func setupRouter(store Store) http.Handler {
	router := chi.NewRouter()
	reg := NewRegistrar(store)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func TestDailyAnalysisHandler(t *testing.T) {
	store := &mockDailyAnalysisStore{accessibleIDs: []int64{1, 2}}
	router := setupRouter(store)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "admin",
		IsAdmin:  true,
	})

	// 1. Success GET /api/v1/daily-analysis
	req := httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis?project_id=1&start_date=2026-11-01&end_date=2026-11-05&country=US", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp DailyAnalysisResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Console.ProjectID != 1 || len(resp.SummaryRows) != 1 {
		t.Fatalf("unexpected response structure: %+v", resp)
	}

	// 2. Missing project_id -> 422
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis?start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for missing project_id, got %d", rec.Code)
	}

	// 3. Invalid date range (start > end) -> 422
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis?project_id=1&start_date=2026-11-10&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for start > end, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "start_date cannot be greater than end_date") {
		t.Fatalf("expected detail error message, got %s", rec.Body.String())
	}

	// 4. Invalid date format -> 422
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis?project_id=1&start_date=bad-date&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for bad date, got %d", rec.Code)
	}

	// 5. Project not found -> 404
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis?project_id=999&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}

	// 6. Project forbidden -> 403
	store.accessErr = ErrProjectForbidden
	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "alice",
		IsAdmin:  false,
	})
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis?project_id=1&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
	store.accessErr = nil
}

func TestDailyAnalysisAllHandler(t *testing.T) {
	store := &mockDailyAnalysisStore{accessibleIDs: []int64{1, 2}}
	router := setupRouter(store)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "admin",
		IsAdmin:  true,
	})

	// 1. Success GET /api/v1/daily-analysis/all with project_ids=all
	req := httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all?project_ids=all&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var allResp DailyAnalysisAllProjectsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &allResp); err != nil {
		t.Fatalf("failed to decode json: %v", err)
	}
	if len(allResp.SummaryRows) != 1 || len(allResp.ProjectBreakdown) == 0 {
		t.Fatalf("unexpected response: %+v", allResp)
	}

	// 2. Success with comma-separated IDs
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all?project_ids=1,2&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. include_detail=false
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all?project_ids=1&start_date=2026-11-01&end_date=2026-11-05&include_detail=false", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var detailFalseResp DailyAnalysisAllProjectsResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &detailFalseResp)
	if len(detailFalseResp.DetailRows) != 0 {
		t.Fatalf("expected 0 detail rows when include_detail=false, got %d", len(detailFalseResp.DetailRows))
	}

	// 4. Invalid project_ids (non-integers) -> 422
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all?project_ids=abc,def&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for non-integer project_ids, got %d", rec.Code)
	}

	// 5. Empty project_ids -> 422
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all?project_ids=&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for empty project_ids, got %d", rec.Code)
	}

	// 6. Accessible IDs empty when project_ids=all -> returns 200 with empty fields
	emptyStore := &mockDailyAnalysisStore{accessibleIDs: []int64{}}
	emptyRouter := setupRouter(emptyStore)
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all?project_ids=all&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	emptyRouter.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for empty accessible projects, got %d", rec.Code)
	}
	var emptyResp DailyAnalysisAllProjectsResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &emptyResp)
	if len(emptyResp.SummaryRows) != 0 || len(emptyResp.ProjectBreakdown) != 0 {
		t.Fatalf("expected empty summary rows and project breakdown, got %+v", emptyResp)
	}
}

func TestDailyAnalysisAllCountriesHandler(t *testing.T) {
	store := &mockDailyAnalysisStore{}
	router := setupRouter(store)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "admin",
		IsAdmin:  true,
	})

	// 1. Success GET /api/v1/daily-analysis/all-countries
	req := httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all-countries?project_id=1&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp DailyAnalysisAllCountriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Currency != "USD" || len(resp.CountryBreakdown) == 0 {
		t.Fatalf("unexpected all-countries response: %+v", resp)
	}

	// 2. Missing exchange rate -> 422
	store.exchangeRateErr = true
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all-countries?project_id=1&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for missing exchange rate, got %d", rec.Code)
	}
	store.exchangeRateErr = false
}

func TestDailyAnalysisAllProjectsCountriesHandler(t *testing.T) {
	store := &mockDailyAnalysisStore{}
	router := setupRouter(store)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "admin",
		IsAdmin:  true,
	})

	// 1. Success GET /api/v1/daily-analysis/all-projects-countries
	req := httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all-projects-countries?project_ids=1,2&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp DailyAnalysisAllProjectsCountriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Currency != "USD" || len(resp.ProjectBreakdown) == 0 {
		t.Fatalf("unexpected response: %+v", resp)
	}

	// 2. Missing project_ids -> 422
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all-projects-countries?start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for missing project_ids, got %d", rec.Code)
	}
}

func TestDailyAnalysisRegistrar(t *testing.T) {
	reg := NewRegistrar(&mockDailyAnalysisStore{})
	if reg.ModuleName() != "daily_analysis" {
		t.Fatalf("ModuleName() = %q, want daily_analysis", reg.ModuleName())
	}
}
