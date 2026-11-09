package internal_ad_data

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockInternalAdDataStore struct {
	verifyErr error
	files     []AdUploadFileItem
	raw       RawResponse
}

func (m *mockInternalAdDataStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return m.verifyErr
}
func (m *mockInternalAdDataStore) ListAdUploadFiles(_ context.Context, _ int64, _, _ *string, _ bool, _, _ int) ([]AdUploadFileItem, error) {
	return m.files, nil
}
func (m *mockInternalAdDataStore) QueryRaw(_ context.Context, filter RawQueryFilter) (*RawResponse, error) {
	resp := m.raw
	resp.ProjectID = filter.ProjectID
	return &resp, nil
}

func setupRouter(store Store) chi.Router {
	r := chi.NewRouter()
	reg := NewRegistrar(store, nil)
	reg.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestHandlerOverview(t *testing.T) {
	store := &mockInternalAdDataStore{}
	router := setupRouter(store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/internal/ad-data", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestHandlerListUploadFiles(t *testing.T) {
	store := &mockInternalAdDataStore{
		files: []AdUploadFileItem{
			{FileID: 10, ReportType: "ad_campaign_report", Country: "US"},
		},
	}
	router := setupRouter(store)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin-1",
		Operator: "admin",
		IsAdmin:  true,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/internal/ad-data/projects/1/ad-upload-files", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestHandlerQueryRaw(t *testing.T) {
	store := &mockInternalAdDataStore{
		raw: RawResponse{
			Country: "US",
			Period:  PeriodInfo{Type: "relative", Value: "7d", StartDate: "2026-10-01", EndDate: "2026-10-07"},
			Data:    []map[string]any{{"campaign_name": "Camp1"}},
			Summary: RawSummary{TotalRows: 1, DateRange: []string{"2026-10-01", "2026-10-07"}},
		},
	}
	router := setupRouter(store)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin-1",
		Operator: "admin",
		IsAdmin:  true,
	})

	rawEndpoints := []string{
		"/api/v1/internal/ad-data/projects/1/ad-campaigns-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-search-terms-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-budgets-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-targets-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-placements-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-promoted-products-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-time-trends-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-search-term-shares-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-invalid-traffic-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-purchased-products-raw?period=7d",
	}

	for _, ep := range rawEndpoints {
		req := httptest.NewRequest(http.MethodGet, ep, nil).WithContext(adminCtx)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("ep %s returned status %d, want 200", ep, rec.Code)
		}
	}
}

func TestHandlerForbidden(t *testing.T) {
	store := &mockInternalAdDataStore{
		verifyErr: ErrProjectForbidden,
	}
	router := setupRouter(store)
	userCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user-1",
		Operator: "alice",
		IsAdmin:  false,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/internal/ad-data/projects/99/ad-upload-files", nil).WithContext(userCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}
