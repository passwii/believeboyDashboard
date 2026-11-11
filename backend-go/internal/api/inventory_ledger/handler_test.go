package inventory_ledger

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockLedgerStore struct{}

func (m *mockLedgerStore) VerifyProjectAccess(_ context.Context, projectID int64, op string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	if projectID == 999 {
		return ErrProjectNotFound
	}
	if op == "allowed_op" {
		return nil
	}
	return ErrProjectForbidden
}
func (m *mockLedgerStore) ListMonths(_ context.Context, projectID int64, _ *string) (MonthsResponse, error) {
	return MonthsResponse{ProjectID: projectID, Months: []string{"2026-10"}}, nil
}
func (m *mockLedgerStore) GetSnapshot(_ context.Context, _ int64, _ *string, month string) (MonthlySnapshotResponse, error) {
	return MonthlySnapshotResponse{ReportMonth: month, SKUCount: 1, TotalQty: 100}, nil
}
func (m *mockLedgerStore) GetEvents(_ context.Context, _ int64, _ *string, month string) (EventsResponse, error) {
	return EventsResponse{ReportMonth: month, SKUs: []SkuMonthEvents{}}, nil
}
func (m *mockLedgerStore) GetClusters(_ context.Context, _ int64, _ *string, month string) (ReceiptClustersResponse, error) {
	return ReceiptClustersResponse{ReportMonth: month, Clusters: []ReceiptCluster{}}, nil
}
func (m *mockLedgerStore) GetLocationDetail(_ context.Context, _ int64, _ *string, month string) (LocationDetailResponse, error) {
	return LocationDetailResponse{ReportMonth: month, Rows: []LocationDetail{}}, nil
}
func (m *mockLedgerStore) GetTrend(_ context.Context, projectID int64, _ *string) (TrendResponse, error) {
	return TrendResponse{ProjectID: projectID, Months: []TrendMonthItem{}}, nil
}
func (m *mockLedgerStore) GetDetail(_ context.Context, _ int64, _ *string, month string, _, _ *string) (LedgerDetailResponse, error) {
	return LedgerDetailResponse{ReportMonth: month, Rows: []LedgerDetailRow{}}, nil
}
func (m *mockLedgerStore) GetSummary(_ context.Context, _ int64, _ *string, month string, _, _ *string) (LedgerSummaryResponse, error) {
	return LedgerSummaryResponse{ReportMonth: month, Rows: []LedgerSummaryRow{}}, nil
}
func (m *mockLedgerStore) ListBatches(_ context.Context, projectID int64, _ *string) (IngestBatchesResponse, error) {
	return IngestBatchesResponse{ProjectID: projectID, Batches: []IngestBatchInfo{}}, nil
}
func (m *mockLedgerStore) GetConsistency(_ context.Context, _ int64, _ *string, month string) (ConsistencyCheckResult, error) {
	return ConsistencyCheckResult{ReportMonth: month, Status: "OK"}, nil
}
func (m *mockLedgerStore) GetMonthAnalysis(_ context.Context, projectID int64, _ *string, month string) (LedgerMonthAnalysisResponse, error) {
	return LedgerMonthAnalysisResponse{ProjectID: projectID, ReportMonth: month}, nil
}

func TestInventoryLedgerHandler(t *testing.T) {
	store := &mockLedgerStore{}
	router := chi.NewRouter()
	reg := NewRegistrar(store)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test 1: months
	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory-ledger/months?project_id=1&country=US", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 2: snapshot
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-ledger/snapshot?project_id=1&period=2026-10", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 3: remaining endpoints with admin
	endpoints := []string{
		"/api/v1/inventory-ledger/events?project_id=1&period=2026-10",
		"/api/v1/inventory-ledger/receipt-clusters?project_id=1&period=2026-10",
		"/api/v1/inventory-ledger/location-detail?project_id=1&period=2026-10",
		"/api/v1/inventory-ledger/trend?project_id=1",
		"/api/v1/inventory-ledger/detail?project_id=1&period=2026-10",
		"/api/v1/inventory-ledger/summary?project_id=1&period=2026-10",
		"/api/v1/inventory-ledger/batches?project_id=1",
		"/api/v1/inventory-ledger/consistency?project_id=1&period=2026-10",
		"/api/v1/inventory-ledger/month-analysis?project_id=1&period=2026-10",
	}
	for _, ep := range endpoints {
		req = httptest.NewRequest(http.MethodGet, ep, nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for %s, got %d", ep, rec.Code)
		}
	}

	// Test 4: non-admin allowed
	allowedCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user-1",
		Operator: "allowed_op",
		IsAdmin:  false,
	})
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-ledger/snapshot?project_id=1&period=2026-10", nil).WithContext(allowedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for allowed non-admin, got %d", rec.Code)
	}

	// Test 5: non-admin forbidden (403)
	forbiddenCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user-2",
		Operator: "intruder",
		IsAdmin:  false,
	})
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-ledger/snapshot?project_id=1&period=2026-10", nil).WithContext(forbiddenCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden, got %d", rec.Code)
	}

	// Test 6: project not found (404)
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-ledger/snapshot?project_id=999&period=2026-10", nil).WithContext(allowedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", rec.Code)
	}

	// Test 7: missing or invalid project_id (422, FastAPI-compatible validation)
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-ledger/snapshot?period=2026-10", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 Unprocessable Entity, got %d", rec.Code)
	}
}
