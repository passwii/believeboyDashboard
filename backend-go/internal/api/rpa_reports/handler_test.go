package rpa_reports

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockRpaStore struct {
	resp RpaReportStatusResponse
	err  error
}

func (m *mockRpaStore) GetReportStatusForDate(_ context.Context, _, _, _ string, _ bool) (*RpaReportStatusResponse, error) {
	return &m.resp, m.err
}

func setupRouter(store Store) chi.Router {
	r := chi.NewRouter()
	reg := NewRegistrar(store, nil)
	reg.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestHandlerGetStatus(t *testing.T) {
	store := &mockRpaStore{
		resp: RpaReportStatusResponse{
			Country: "US",
			Items: []ProjectReportStatus{
				{
					ProjectID:   1,
					ProjectName: "US Project",
					Country:     "US",
					Statuses: []ReportTypeStatus{
						{ReportType: "inventory_report", HasData: true, IsUploaded: true},
					},
				},
			},
		},
	}
	router := setupRouter(store)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin-1",
		Operator: "admin",
		IsAdmin:  true,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/rpa-reports/status?report_date=2026-10-10&country=US", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestHandlerGetStatusMissingDate(t *testing.T) {
	store := &mockRpaStore{}
	router := setupRouter(store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/rpa-reports/status", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
}
