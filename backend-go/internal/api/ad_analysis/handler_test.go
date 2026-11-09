package ad_analysis

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockStore struct {
	verifyErr error
	overview  AdAnalysisOverviewResponse
	campaigns AdAnalysisCampaignsResponse
	products  AdAnalysisProductsResponse
	timeTrend AdAnalysisTimeTrendResponse
	purchased AdAnalysisPurchasedProductsResponse
	search    AdAnalysisSearchTermsResponse
	targets   AdAnalysisTargetsResponse
	budget    AdAnalysisBudgetResponse
	placement AdAnalysisPlacementsResponse
	traffic   AdAnalysisTrafficQualityResponse
}

func (m *mockStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return m.verifyErr
}
func (m *mockStore) BuildOverview(_ context.Context, _ BaseFilter) (*AdAnalysisOverviewResponse, error) {
	return &m.overview, nil
}
func (m *mockStore) BuildCampaigns(_ context.Context, _ CampaignsFilter) (*AdAnalysisCampaignsResponse, error) {
	return &m.campaigns, nil
}
func (m *mockStore) BuildProducts(_ context.Context, _ ProductsFilter) (*AdAnalysisProductsResponse, error) {
	return &m.products, nil
}
func (m *mockStore) BuildTimeTrend(_ context.Context, _ BaseFilter) (*AdAnalysisTimeTrendResponse, error) {
	return &m.timeTrend, nil
}
func (m *mockStore) BuildPurchasedProducts(_ context.Context, _ PurchasedProductsFilter) (*AdAnalysisPurchasedProductsResponse, error) {
	return &m.purchased, nil
}
func (m *mockStore) BuildSearchTerms(_ context.Context, _ SearchTermsFilter) (*AdAnalysisSearchTermsResponse, error) {
	return &m.search, nil
}
func (m *mockStore) BuildTargets(_ context.Context, _ TargetsFilter) (*AdAnalysisTargetsResponse, error) {
	return &m.targets, nil
}
func (m *mockStore) BuildBudget(_ context.Context, _ BudgetFilter) (*AdAnalysisBudgetResponse, error) {
	return &m.budget, nil
}
func (m *mockStore) BuildPlacements(_ context.Context, _ PlacementsFilter) (*AdAnalysisPlacementsResponse, error) {
	return &m.placement, nil
}
func (m *mockStore) BuildTrafficQuality(_ context.Context, _ TrafficQualityFilter) (*AdAnalysisTrafficQualityResponse, error) {
	return &m.traffic, nil
}

func setupRouter(store Store) chi.Router {
	r := chi.NewRouter()
	reg := NewRegistrar(store, nil)
	reg.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestHandlerEndpoints(t *testing.T) {
	store := &mockStore{
		overview:  AdAnalysisOverviewResponse{ProjectID: 1, Country: "US"},
		campaigns: AdAnalysisCampaignsResponse{ProjectID: 1, Country: "US"},
		products:  AdAnalysisProductsResponse{ProjectID: 1, Country: "US"},
		timeTrend: AdAnalysisTimeTrendResponse{ProjectID: 1, Country: "US"},
		purchased: AdAnalysisPurchasedProductsResponse{ProjectID: 1, Country: "US"},
		search:    AdAnalysisSearchTermsResponse{ProjectID: 1, Country: "US"},
		targets:   AdAnalysisTargetsResponse{ProjectID: 1, Country: "US"},
		budget:    AdAnalysisBudgetResponse{ProjectID: 1, Country: "US"},
		placement: AdAnalysisPlacementsResponse{ProjectID: 1, Country: "US"},
		traffic:   AdAnalysisTrafficQualityResponse{ProjectID: 1, Country: "US"},
	}

	router := setupRouter(store)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin-1",
		Operator: "admin",
		IsAdmin:  true,
	})

	endpoints := []string{
		"/api/v1/ad-analysis/overview?project_id=1&country=US",
		"/api/v1/ad-analysis/campaigns?project_id=1&country=US&campaign=Test",
		"/api/v1/ad-analysis/products?project_id=1&country=US&sku=SKU1",
		"/api/v1/ad-analysis/time-trend?project_id=1&country=US",
		"/api/v1/ad-analysis/purchased-products?project_id=1&country=US",
		"/api/v1/ad-analysis/search-terms?project_id=1&country=US",
		"/api/v1/ad-analysis/targets?project_id=1&country=US",
		"/api/v1/ad-analysis/budget?project_id=1&country=US",
		"/api/v1/ad-analysis/placements?project_id=1&country=US",
		"/api/v1/ad-analysis/traffic-quality?project_id=1&country=US",
	}

	for _, ep := range endpoints {
		req := httptest.NewRequest(http.MethodGet, ep, nil).WithContext(adminCtx)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("endpoint %s returned status %d, want 200", ep, rec.Code)
		}
	}
}

func TestHandlerForbidden(t *testing.T) {
	store := &mockStore{
		verifyErr: ErrProjectForbidden,
	}
	router := setupRouter(store)
	userCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user-1",
		Operator: "alice",
		IsAdmin:  false,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/ad-analysis/overview?project_id=99", nil).WithContext(userCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden, got %d", rec.Code)
	}
}

func TestHandlerMissingProjectID(t *testing.T) {
	store := &mockStore{}
	router := setupRouter(store)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ad-analysis/overview", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 Unprocessable Entity, got %d", rec.Code)
	}
}
