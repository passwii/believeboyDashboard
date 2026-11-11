package inventory_replenishment

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

type mockReplenishmentStore struct {
	item               InventoryReplenishmentListItem
	snapshot           InventoryReplenishmentSnapshotListItem
	accessError        error
	getSnapshotError   error
	lastSettingSKU     string
	lastSnapshotFilter SnapshotItemsFilter
}

func (m *mockReplenishmentStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return m.accessError
}
func (m *mockReplenishmentStore) GetInventoryAnalysis(_ context.Context, _ ReplenishmentFilter) (InventoryAnalysisResponse, error) {
	return InventoryAnalysisResponse{Items: []InventoryAnalysisItem{}}, nil
}
func (m *mockReplenishmentStore) ListSnapshotOptions(_ context.Context, _ *int64, _ *string) ([]InventorySnapshotOption, error) {
	return []InventorySnapshotOption{{SnapshotDate: "2026-11-01", Label: "Current", IsCurrent: true}}, nil
}
func (m *mockReplenishmentStore) ListAnalysis(_ context.Context, _ ReplenishmentFilter) (InventoryReplenishmentListResponse, error) {
	return InventoryReplenishmentListResponse{
		Items: []InventoryReplenishmentListItem{m.item},
		Summary: InventoryReplenishmentSummary{
			SKUCount: 1,
		},
		Total:    1,
		Page:     1,
		PageSize: 50,
	}, nil
}
func (m *mockReplenishmentStore) UpdateSetting(_ context.Context, projectID int64, sku string, _ InventoryReplenishmentSettingUpdate, _ string) (InventoryReplenishmentSettingItem, error) {
	m.lastSettingSKU = sku
	return InventoryReplenishmentSettingItem{ProjectID: projectID, SKU: sku, SafetyFactor: 1.5}, nil
}
func (m *mockReplenishmentStore) ListShipments(_ context.Context, _ *int64, _ *string) (InventoryReplenishmentShipmentResponse, error) {
	return InventoryReplenishmentShipmentResponse{Items: []InventoryReplenishmentShipmentItem{}}, nil
}
func (m *mockReplenishmentStore) ListCalendar(_ context.Context, _ *int64, _ *string) (CalendarResponse, error) {
	return CalendarResponse{Items: []CalendarRowItem{}}, nil
}
func (m *mockReplenishmentStore) ListSeasonal(_ context.Context, _ *int64, _ *string) (SeasonalReplenishmentListResponse, error) {
	return SeasonalReplenishmentListResponse{Items: []SeasonalReplenishmentListItem{}}, nil
}
func (m *mockReplenishmentStore) ListSnapshots(_ context.Context, _ *int64, _ *string) ([]InventoryReplenishmentSnapshotListItem, error) {
	return []InventoryReplenishmentSnapshotListItem{m.snapshot}, nil
}
func (m *mockReplenishmentStore) GetSnapshot(_ context.Context, snapshotID int64) (*InventoryReplenishmentSnapshotListItem, error) {
	if m.getSnapshotError != nil {
		return nil, m.getSnapshotError
	}
	if m.snapshot.ID != snapshotID {
		return nil, nil
	}
	snapshot := m.snapshot
	return &snapshot, nil
}
func (m *mockReplenishmentStore) ListSnapshotItems(_ context.Context, _ int64) ([]InventoryReplenishmentSnapshotItem, error) {
	return []InventoryReplenishmentSnapshotItem{}, nil
}
func (m *mockReplenishmentStore) ListSnapshotItemsPage(_ context.Context, snapshot *InventoryReplenishmentSnapshotListItem, filter SnapshotItemsFilter) (InventoryReplenishmentListResponse, error) {
	m.lastSnapshotFilter = filter
	return InventoryReplenishmentListResponse{
		Items:    []InventoryReplenishmentListItem{},
		Summary:  snapshot.Summary.ReplenishmentSummary(),
		Page:     filter.Page,
		PageSize: filter.PageSize,
	}, nil
}
func (m *mockReplenishmentStore) CreateSnapshot(_ context.Context, projectID int64, country string, _ CreateSnapshotRequest, _ string) (InventoryReplenishmentSnapshotListItem, error) {
	m.snapshot.ProjectID = projectID
	m.snapshot.Country = country
	return m.snapshot, nil
}
func (m *mockReplenishmentStore) UpdateSnapshot(_ context.Context, _ int64, req UpdateSnapshotRequest, _ string) (*InventoryReplenishmentSnapshotListItem, error) {
	m.snapshot.Name = req.Name
	m.snapshot.Description = req.Description
	return &m.snapshot, nil
}
func (m *mockReplenishmentStore) DeleteSnapshot(_ context.Context, _ int64, _ string) (bool, error) {
	return true, nil
}

type mockAuditor struct {
	entries []audit.Entry
}

func (a *mockAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}
func (a *mockAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}
func (a *mockAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func TestInventoryReplenishmentHandler(t *testing.T) {
	store := &mockReplenishmentStore{
		item: InventoryReplenishmentListItem{
			ProjectID:          1,
			ProjectName:        "Shop US",
			SKU:                "SKU-1",
			Country:            "US",
			AvailableInventory: 100,
			RiskStatus:         "healthy",
		},
		snapshot: InventoryReplenishmentSnapshotListItem{
			ID:           42,
			ProjectID:    1,
			ProjectName:  "Shop US",
			Country:      "US",
			SnapshotDate: "2026-11-01",
			IsCurrent:    true,
		},
	}
	auditor := &mockAuditor{}
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test 1: analysis
	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-analysis?project_id=1", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 2: snapshot options
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-snapshot-options?project_id=1", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 3: update setting + audit
	body, _ := json.Marshal(InventoryReplenishmentSettingUpdate{
		SafetyFactor:       ptrFloat(0.2),
		ProductionLeadDays: ptrInt(20),
		ShippingDays:       ptrInt(25),
	})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/inventory-replenishment-settings/1/SKU-1", bytes.NewReader(body)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "inventory_replenishment_settings.upsert" {
		t.Fatalf("expected audit entry for setting upsert")
	}

	// Test 4: create snapshot + audit
	createBody, _ := json.Marshal(CreateSnapshotRequest{})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/inventory-replenishment-snapshots?project_id=1&country=US", bytes.NewReader(createBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on create snapshot, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "inventory_replenishment_snapshot.create" {
		t.Fatalf("expected audit entry for snapshot create")
	}

	// Test 5: update snapshot + audit
	updateSnapBody, _ := json.Marshal(UpdateSnapshotRequest{})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/inventory-replenishment-snapshots/42", bytes.NewReader(updateSnapBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on update snapshot, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "inventory_replenishment_snapshot.update" {
		t.Fatalf("expected audit entry for snapshot update")
	}

	// Test 6: delete snapshot + audit
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/inventory-replenishment-snapshots/42", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on delete snapshot, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "inventory_replenishment_snapshot.delete" {
		t.Fatalf("expected audit entry for snapshot delete")
	}

	// Test 7: non-admin permissions
	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "bob",
		Operator: "bob",
		IsAdmin:  false,
	})
	store.accessError = ErrProjectForbidden

	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-analysis?project_id=1", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on forbidden analysis, got %d", rec.Code)
	}

	// Non-admin attempting to update/delete snapshot must be rejected with 403
	req = httptest.NewRequest(http.MethodPut, "/api/v1/inventory-replenishment-snapshots/42", bytes.NewReader(updateSnapBody)).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on non-admin snapshot update, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/inventory-replenishment-snapshots/42", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on non-admin snapshot delete, got %d", rec.Code)
	}
}

type mockReplenishmentStoreWithFilter struct {
	mockReplenishmentStore
	onListAnalysis func(filter ReplenishmentFilter)
}

func (m *mockReplenishmentStoreWithFilter) ListAnalysis(ctx context.Context, filter ReplenishmentFilter) (InventoryReplenishmentListResponse, error) {
	if m.onListAnalysis != nil {
		m.onListAnalysis(filter)
	}
	return m.mockReplenishmentStore.ListAnalysis(ctx, filter)
}

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

func TestInventoryReplenishmentScopeConvergence(t *testing.T) {
	var capturedFilter ReplenishmentFilter
	_ = capturedFilter
	store := &mockReplenishmentStoreWithFilter{
		onListAnalysis: func(filter ReplenishmentFilter) {
			capturedFilter = filter
		},
	}
	auditor := &mockAuditor{}
	op := "alice"
	projectReader := &mockProjectReader{
		project: &projects.ProjectItem{
			ID:              10,
			Name:            "Shop US",
			ProjectOperator: &op,
		},
	}
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor, projectReader)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	// Missing project_id -> 422 (FastAPI requires project_id Query(gt=0))
	aliceCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "alice_user",
		Operator: "alice",
		IsAdmin:  false,
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-analysis", nil).WithContext(aliceCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for missing project_id, got %d", rec.Code)
	}

	// Unauthorized operator "bob" with project_id=10 -> 403 Forbidden
	bobCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "bob_user",
		Operator: "bob",
		IsAdmin:  false,
	})
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-analysis?project_id=10", nil).WithContext(bobCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized project_id access, got %d", rec.Code)
	}
}

func TestStage10B1InventorySnapshotRoutesAndPathSKU(t *testing.T) {
	store := &mockReplenishmentStore{
		snapshot: InventoryReplenishmentSnapshotListItem{
			ID:           42,
			ProjectID:    1,
			ProjectName:  "Shop US",
			Country:      "US",
			SnapshotDate: "2026-11-01",
			IsCurrent:    true,
		},
	}
	router := chi.NewRouter()
	NewRegistrar(store, &mockAuditor{}).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return next
	})
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET snapshot detail status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var detailBody map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &detailBody); err != nil {
		t.Fatalf("decode snapshot detail: %v", err)
	}
	if _, ok := detailBody["summary"].(map[string]any); !ok {
		t.Fatalf("snapshot detail summary = %#v, want object", detailBody["summary"])
	}
	if items, ok := detailBody["items"].([]any); !ok || len(items) != 0 {
		t.Fatalf("snapshot detail items = %#v, want []", detailBody["items"])
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42/items?page=2&page_size=10&in_transit_only=true", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET snapshot items status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if store.lastSnapshotFilter.Page != 2 || store.lastSnapshotFilter.PageSize != 10 || !store.lastSnapshotFilter.InTransitOnly {
		t.Fatalf("snapshot items filter = %#v", store.lastSnapshotFilter)
	}

	patchBody, _ := json.Marshal(UpdateSnapshotRequest{})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/inventory-replenishment-snapshots/42", bytes.NewReader(patchBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH snapshot status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/v1/inventory-replenishment-snapshots/42", bytes.NewReader(patchBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT snapshot compatibility status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	settingBody, _ := json.Marshal(InventoryReplenishmentSettingUpdate{
		SafetyFactor:       ptrFloat(0.2),
		ProductionLeadDays: ptrInt(20),
		ShippingDays:       ptrInt(25),
	})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/inventory-replenishment-settings/1/FAMILY/BLUE/01", bytes.NewReader(settingBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("multi-segment inventory SKU status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if store.lastSettingSKU != "FAMILY/BLUE/01" {
		t.Fatalf("multi-segment inventory SKU = %q, want FAMILY/BLUE/01", store.lastSettingSKU)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/not-an-int", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid snapshot id status = %d, want 422: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42/items?page=0", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid snapshot page status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
}

func ptrFloat(value float64) *float64 { return &value }
func ptrInt(value int) *int           { return &value }

func TestStage10B1InventorySnapshotPermissionsAndDatabaseErrors(t *testing.T) {
	store := &mockReplenishmentStore{
		snapshot: InventoryReplenishmentSnapshotListItem{
			ID:        42,
			ProjectID: 1,
		},
	}
	router := chi.NewRouter()
	NewRegistrar(store, &mockAuditor{}).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return next
	})
	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "bob",
		Operator: "bob",
		IsAdmin:  false,
	})
	store.accessError = ErrProjectForbidden
	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42", nil).WithContext(nonAdminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("scoped snapshot detail status = %d, want 403: %s", rec.Code, rec.Body.String())
	}

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin",
		IsAdmin:  true,
	})
	store.getSnapshotError = errors.New("postgres://secret-user:secret-pass@db")
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("database error status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("secret")) {
		t.Fatalf("database error leaked details: %s", rec.Body.String())
	}
}

type transactionalReplenishmentStore struct {
	*mockReplenishmentStore
	committed  bool
	rolledBack bool
}

func (m *transactionalReplenishmentStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	if err := fn(ctx, nil, m.mockReplenishmentStore); err != nil {
		m.rolledBack = true
		return err
	}
	m.committed = true
	return nil
}

type failingInventoryAuditor struct {
	mockAuditor
}

func (*failingInventoryAuditor) LogAction(context.Context, audit.Entry) error {
	return errors.New("audit insert failed: secret")
}

func TestStage10B1InventorySnapshotAuditFailureAbortsTransaction(t *testing.T) {
	store := &transactionalReplenishmentStore{
		mockReplenishmentStore: &mockReplenishmentStore{
			snapshot: InventoryReplenishmentSnapshotListItem{
				ID:        42,
				ProjectID: 1,
			},
		},
	}
	router := chi.NewRouter()
	NewRegistrar(store, &failingInventoryAuditor{}).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return next
	})
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin",
		IsAdmin:  true,
	})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/inventory-replenishment-snapshots/42", strings.NewReader(`{"name":"updated"}`)).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	if !store.rolledBack || store.committed {
		t.Fatalf("transaction flags committed=%v rolledBack=%v", store.committed, store.rolledBack)
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("secret")) {
		t.Fatalf("audit error leaked details: %s", rec.Body.String())
	}
}
