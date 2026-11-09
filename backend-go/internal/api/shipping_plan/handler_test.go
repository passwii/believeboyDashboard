package shipping_plan

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
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockProjectReader struct {
	project *projects.ProjectItem
}

func (m *mockProjectReader) GetProject(_ context.Context, id int64) (*projects.ProjectItem, error) {
	if m.project != nil && m.project.ID == id {
		return m.project, nil
	}
	return nil, nil
}

func (m *mockProjectReader) ListManage(_ context.Context, _ string, _ bool, _ bool) ([]projects.ProjectItem, error) {
	if m.project != nil {
		return []projects.ProjectItem{*m.project}, nil
	}
	return []projects.ProjectItem{}, nil
}

type mockShippingPlanStore struct {
	batch             ShippingPlanBatchResponse
	lastGrowthSKU     string
	lastGrowthUpdate  ShippingPlanGrowthFactorUpdate
	updateGrowthError error
}

func (m *mockShippingPlanStore) ListSkus(_ context.Context, _ int64, _ string, _, _ int) (ShippingPlanSkuListResponse, error) {
	return ShippingPlanSkuListResponse{Items: []ShippingPlanSkuItem{{SKU: "SKU1", GrowthFactor: 1.0}}, Total: 1}, nil
}
func (m *mockShippingPlanStore) GetForecast(_ context.Context, _ int64, _, sku string) (ShippingPlanForecastResponse, error) {
	return ShippingPlanForecastResponse{SKU: sku, GrowthFactor: 1.0}, nil
}
func (m *mockShippingPlanStore) UpdateGrowthFactor(_ context.Context, sku string, update ShippingPlanGrowthFactorUpdate) (ShippingPlanGrowthFactorResponse, error) {
	if m.updateGrowthError != nil {
		return ShippingPlanGrowthFactorResponse{}, m.updateGrowthError
	}
	m.lastGrowthSKU = sku
	m.lastGrowthUpdate = update
	return ShippingPlanGrowthFactorResponse{SKU: sku, GrowthFactor: 1.2}, nil
}
func (m *mockShippingPlanStore) GetShipmentHistory(_ context.Context, _ int64, _, _, _ string) (ShipmentHistoryResponse, error) {
	return ShipmentHistoryResponse{Country: "US"}, nil
}
func (m *mockShippingPlanStore) ListBatches(_ context.Context, _ int64, _ string) (ShippingPlanBatchListResponse, error) {
	return ShippingPlanBatchListResponse{Items: []ShippingPlanBatchResponse{m.batch}, Total: 1}, nil
}
func (m *mockShippingPlanStore) GetBatch(_ context.Context, _ int64) (*ShippingPlanBatchResponse, error) {
	return &m.batch, nil
}
func (m *mockShippingPlanStore) GetAllocationProjectID(_ context.Context, _ int64) (int64, error) {
	return m.batch.ProjectID, nil
}
func (m *mockShippingPlanStore) CreateBatch(_ context.Context, _ ShippingPlanBatchCreate, _ string) (ShippingPlanBatchResponse, error) {
	return m.batch, nil
}
func (m *mockShippingPlanStore) UpdateBatch(_ context.Context, _ int64, _ ShippingPlanBatchUpdate, _ string) (*ShippingPlanBatchResponse, error) {
	return &m.batch, nil
}
func (m *mockShippingPlanStore) CancelBatch(_ context.Context, _ int64, _ string) (*ShippingPlanBatchResponse, error) {
	return &m.batch, nil
}
func (m *mockShippingPlanStore) CreateAllocation(_ context.Context, _ int64, _ ShippingPlanAllocationCreate, _ string) (ShippingPlanAllocationResult, error) {
	return ShippingPlanAllocationResult{Allocation: ShippingPlanAllocationResponse{ID: 10, PlanItemID: 1, ShipmentScheduleID: 5, SKU: "SKU1", Quantity: 10}, PlanItemRemainingQuantity: 0, ShipmentSKURemainingQuantity: 0}, nil
}
func (m *mockShippingPlanStore) DeleteAllocation(_ context.Context, _ int64, _ string) (bool, error) {
	return true, nil
}

func TestShippingPlanHandler(t *testing.T) {
	store := &mockShippingPlanStore{
		batch: ShippingPlanBatchResponse{
			ID:                  1,
			ProjectID:           1,
			Country:             "US",
			Name:                "Plan Batch 1",
			ExpectedArrivalDate: "2026-12-01",
			Status:              "active",
		},
	}
	auditor := audit.NewMockService()
	op := "alice"
	projectReader := &mockProjectReader{
		project: &projects.ProjectItem{
			ID:              1,
			Name:            "US Shop",
			ProjectOperator: &op,
		},
	}
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor, projectReader)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	operatorCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user1",
		Operator: "alice",
		IsAdmin:  false,
	})

	unauthorizedCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user2",
		Operator: "bob",
		IsAdmin:  false,
	})

	// Test 1: skus (admin)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shipping-plan/skus?project_id=1&country=US", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 2: skus (unauthorized operator -> 403 Forbidden)
	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipping-plan/skus?project_id=1&country=US", nil).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden, got %d", rec.Code)
	}

	// Test 3: batches (authorized operator)
	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipping-plan/batches?project_id=1&country=US", nil).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 4: create batch (should return 201 Created and log audit)
	body, _ := json.Marshal(ShippingPlanBatchCreate{
		ProjectID:           1,
		Country:             "US",
		Name:                "Plan Batch 1",
		ExpectedArrivalDate: "2026-12-01",
		Items:               []ShippingPlanItemInput{{SKU: "SKU1", Quantity: 10}},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches", bytes.NewReader(body)).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.Entries) == 0 || auditor.Entries[len(auditor.Entries)-1].Action != "shipping_plan.batch.create" {
		t.Fatalf("expected audit log for shipping_plan.batch.create, got %v", auditor.Entries)
	}

	// Test 5: create allocation (should return 201 Created and log audit)
	allocBody, _ := json.Marshal(ShippingPlanAllocationCreate{
		PlanItemID:         1,
		ShipmentScheduleID: 5,
		Quantity:           10,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches/1/allocations?project_id=1", bytes.NewReader(allocBody)).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.Entries) == 0 || auditor.Entries[len(auditor.Entries)-1].Action != "shipping_plan.allocation.create" {
		t.Fatalf("expected audit log for shipping_plan.allocation.create, got %v", auditor.Entries)
	}

	// Test 6: delete allocation (should return 204 No Content and log audit)
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/shipping-plan/allocations/10?project_id=1", nil).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 No Content, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.Entries) == 0 || auditor.Entries[len(auditor.Entries)-1].Action != "shipping_plan.allocation.delete" {
		t.Fatalf("expected audit log for shipping_plan.allocation.delete, got %v", auditor.Entries)
	}
}

func TestShippingPlanPermissionsAndQuantityValidation(t *testing.T) {
	store := &mockShippingPlanStore{
		batch: ShippingPlanBatchResponse{
			ID:                  10,
			ProjectID:           99, // project 99
			Country:             "US",
			Name:                "Secret Batch",
			ExpectedArrivalDate: "2026-12-01",
			Status:              "active",
		},
	}
	auditor := audit.NewMockService()
	// project 99 belongs to alice only
	projectReader := &mockProjectReader{
		project: &projects.ProjectItem{
			ID:              99,
			Name:            "Secret Project",
			ProjectOperator: ptrString("alice"),
		},
	}
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor, projectReader)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	unauthorizedCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "bob_user",
		Operator: "bob",
		IsAdmin:  false,
	})

	// 1. PatchBatch before writing returns 403 for unauthorized user
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/shipping-plan/batches/10", strings.NewReader(`{"name": "Hacked"}`)).WithContext(unauthorizedCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on batch patch for unauthorized user, got %d", rec.Code)
	}

	// 2. CancelBatch before writing returns 403 for unauthorized user
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches/10/cancel", nil).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on batch cancel for unauthorized user, got %d", rec.Code)
	}

	// 3. PostAllocation returns 403 for unauthorized user
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches/10/allocations", strings.NewReader(`{"plan_item_id": 1, "shipment_schedule_id": 5, "quantity": 10}`)).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on allocation create for unauthorized user, got %d", rec.Code)
	}

	// 4. DeleteAllocation returns 403 for unauthorized user
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/shipping-plan/allocations/10", nil).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on allocation delete for unauthorized user, got %d", rec.Code)
	}

	// 5. Quantity validation (qty <= 0) returns 422
	authorizedCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "alice_user",
		Operator: "alice",
		IsAdmin:  false,
	})

	// Zero quantity allocation
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches/10/allocations", strings.NewReader(`{"plan_item_id": 1, "shipment_schedule_id": 5, "quantity": 0}`)).WithContext(authorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for 0 quantity allocation, got %d", rec.Code)
	}

	// Negative quantity allocation
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches/10/allocations", strings.NewReader(`{"plan_item_id": 1, "shipment_schedule_id": 5, "quantity": -5}`)).WithContext(authorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for negative quantity allocation, got %d", rec.Code)
	}

	// Zero quantity batch creation
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches", strings.NewReader(`{"project_id": 99, "country": "US", "name": "Batch1", "expected_arrival_date": "2026-12-01", "items": [{"sku": "SKU1", "quantity": 0}]}`)).WithContext(authorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for batch with 0 quantity item, got %d", rec.Code)
	}
}

func ptrString(s string) *string { return &s }

func TestStage10B1ShippingPlanPathSKUWildcard(t *testing.T) {
	store := &mockShippingPlanStore{
		batch: ShippingPlanBatchResponse{
			ID:        1,
			ProjectID: 1,
			Country:   "US",
			Status:    "active",
		},
	}
	op := "alice"
	projectReader := &mockProjectReader{
		project: &projects.ProjectItem{
			ID:              1,
			ProjectOperator: &op,
		},
	}
	router := chi.NewRouter()
	NewRegistrar(store, audit.NewMockService(), projectReader).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return next
	})

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})
	body := strings.NewReader(`{"project_id":1,"country":"US","growth_factor":1.2}`)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/shipping-plan/skus/FAMILY/BLUE/01/growth-factor", body).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("multi-segment shipping SKU status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if store.lastGrowthSKU != "FAMILY/BLUE/01" {
		t.Fatalf("multi-segment shipping SKU = %q, want FAMILY/BLUE/01", store.lastGrowthSKU)
	}
	if store.lastGrowthUpdate.ProjectID != 1 || store.lastGrowthUpdate.Country != "US" || store.lastGrowthUpdate.GrowthFactor != 1.2 {
		t.Fatalf("growth factor payload = %#v", store.lastGrowthUpdate)
	}

	req = httptest.NewRequest(http.MethodPut, "/api/v1/shipping-plan/skus/FAMILY/not-growth-factor", body).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unsupported shipping SKU suffix status = %d, want 404: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipping-plan/skus?project_id=1&country=US", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("static shipping SKU route status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/v1/shipping-plan/skus/FAMILY/BLUE/01/growth-factor", strings.NewReader(`{"project_id":1,"country":"US","growth_factor":-1}`)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("negative growth factor status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
}

func TestStage10B1ShippingPlanPermissionsAndDatabaseErrors(t *testing.T) {
	store := &mockShippingPlanStore{}
	op := "alice"
	projectReader := &mockProjectReader{
		project: &projects.ProjectItem{
			ID:              1,
			ProjectOperator: &op,
		},
	}
	router := chi.NewRouter()
	NewRegistrar(store, audit.NewMockService(), projectReader).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return next
	})
	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "bob",
		Operator: "bob",
		IsAdmin:  false,
	})
	req := httptest.NewRequest(http.MethodPut, "/api/v1/shipping-plan/skus/FAMILY/BLUE/growth-factor", strings.NewReader(`{"project_id":1,"country":"US","growth_factor":1.2}`)).WithContext(nonAdminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unauthorized growth factor status = %d, want 403: %s", rec.Code, rec.Body.String())
	}

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin",
		IsAdmin:  true,
	})
	store.updateGrowthError = errors.New("postgres://secret-user:secret-pass@db")
	req = httptest.NewRequest(http.MethodPut, "/api/v1/shipping-plan/skus/FAMILY/BLUE/growth-factor", strings.NewReader(`{"project_id":1,"country":"US","growth_factor":1.2}`)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("growth factor database error status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("secret")) {
		t.Fatalf("growth factor database error leaked details: %s", rec.Body.String())
	}

	store.updateGrowthError = ErrSKUNotFound
	req = httptest.NewRequest(http.MethodPut, "/api/v1/shipping-plan/skus/MISSING/SKU/growth-factor", strings.NewReader(`{"project_id":1,"country":"US","growth_factor":1.2}`)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing shipping SKU status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
}

type transactionalShippingPlanStore struct {
	*mockShippingPlanStore
	committed  bool
	rolledBack bool
}

func (m *transactionalShippingPlanStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	if err := fn(ctx, nil, m.mockShippingPlanStore); err != nil {
		m.rolledBack = true
		return err
	}
	m.committed = true
	return nil
}

type failingShippingAuditor struct{}

func (*failingShippingAuditor) LogAction(context.Context, audit.Entry) error {
	return errors.New("audit insert failed: secret")
}
func (*failingShippingAuditor) LogActionTx(context.Context, pgx.Tx, audit.Entry) error {
	return errors.New("audit insert failed: secret")
}
func (*failingShippingAuditor) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

func TestStage10B1ShippingPlanAuditFailureAbortsTransaction(t *testing.T) {
	store := &transactionalShippingPlanStore{
		mockShippingPlanStore: &mockShippingPlanStore{},
	}
	router := chi.NewRouter()
	NewRegistrar(store, &failingShippingAuditor{}).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return next
	})
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin",
		IsAdmin:  true,
	})
	req := httptest.NewRequest(http.MethodPut, "/api/v1/shipping-plan/skus/FAMILY/BLUE/growth-factor", strings.NewReader(`{"project_id":1,"country":"US","growth_factor":1.2}`)).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("shipping audit failure status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	if !store.rolledBack || store.committed {
		t.Fatalf("transaction flags committed=%v rolledBack=%v", store.committed, store.rolledBack)
	}
}
