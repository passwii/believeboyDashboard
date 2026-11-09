package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	inventory "github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
	shipping "github.com/passwii/believeboyDashboard/backend-go/internal/api/shipping_plan"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage10B1ModuleRegistrar interface {
	ModuleName() string
	RegisterRoutes(chi.Router, func(http.Handler) http.Handler)
}

func TestStage10B1OpenAPIAndRouteContracts(t *testing.T) {
	inventoryRegistrar := inventory.NewRegistrar(&stage10B1InventoryStore{}, audit.NewMockService())
	shippingRegistrar := shipping.NewRegistrar(&stage10B1ShippingStore{}, audit.NewMockService())

	for _, test := range []struct {
		name      string
		registrar stage10B1ModuleRegistrar
		routes    []string
	}{
		{
			name:      "inventory",
			registrar: inventoryRegistrar,
			routes: []string{
				"GET /api/v1/inventory-replenishment-snapshots/{snapshot_id}",
				"GET /api/v1/inventory-replenishment-snapshots/{snapshot_id}/items",
				"PATCH /api/v1/inventory-replenishment-snapshots/{snapshot_id}",
				"PUT /api/v1/inventory-replenishment-snapshots/{snapshot_id}",
				"PUT /api/v1/inventory-replenishment-settings/{project_id}/*",
			},
		},
		{
			name:      "shipping",
			registrar: shippingRegistrar,
			routes: []string{
				"GET /api/v1/shipping-plan/skus",
				"PUT /api/v1/shipping-plan/skus/*",
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			router := chi.NewRouter()
			test.registrar.RegisterRoutes(router, stage10B1Passthrough)
			got := stage10B1RouteInventory(t, router)
			for _, want := range test.routes {
				if !got[want] {
					t.Fatalf("missing route %s\ngot:\n%s", want, stage10B1SortedRoutes(got))
				}
			}
		})
	}

	openAPIBytes, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "frontend", "types", "api-generated", "openapi.json",
	))
	if err != nil {
		t.Fatalf("read OpenAPI fixture: %v", err)
	}
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(openAPIBytes, &spec); err != nil {
		t.Fatalf("decode OpenAPI fixture: %v", err)
	}
	snapshotMethods := spec.Paths["/api/v1/inventory-replenishment-snapshots/{snapshot_id}"]
	for _, method := range []string{"get", "patch", "delete"} {
		if _, ok := snapshotMethods[method]; !ok {
			t.Fatalf("OpenAPI snapshot path missing %s", method)
		}
	}
	if _, ok := snapshotMethods["put"]; ok {
		t.Fatal("OpenAPI snapshot path unexpectedly includes compatibility PUT")
	}
	itemMethods := spec.Paths["/api/v1/inventory-replenishment-snapshots/{snapshot_id}/items"]
	if _, ok := itemMethods["get"]; !ok {
		t.Fatal("OpenAPI snapshot items path missing GET")
	}
}

func TestStage10B1SnapshotDetailItemsAndWildcardSKUs(t *testing.T) {
	inventoryStore := &stage10B1InventoryStore{
		snapshot: inventory.InventoryReplenishmentSnapshotListItem{
			ID:                  42,
			ProjectID:           1,
			ProjectName:         "Shop US",
			Country:             "US",
			SnapshotDate:        "2026-11-08",
			IsCurrent:           true,
			InventoryReportDate: stage10B1String("2026-11-07"),
			RowCount:            1,
			CreatedBy:           stage10B1String("alice"),
			CreatedAt:           "2026-11-08T03:04:05.123000+08:00",
			Summary: inventory.InventoryReplenishmentSnapshotSummary{
				SKUCount:                1,
				HealthyCount:            1,
				TotalAvailableInventory: 10,
				TotalInTransitQuantity:  2,
			},
		},
		items: []inventory.InventoryReplenishmentSnapshotItem{{
			SourceRowNo:        0,
			SKU:                "FAMILY/BLUE/01",
			ASIN:               stage10B1String("B001"),
			AvailableInventory: 10,
			InTransitQuantity:  2,
			SafetyFactor:       0.2,
			ProductionLeadDays: 20,
			ShippingDays:       25,
			RiskStatus:         "健康库存",
		}},
		pageResponse: inventory.InventoryReplenishmentListResponse{
			Items: []inventory.InventoryReplenishmentListItem{{
				ProjectID:           1,
				ProjectName:         "Shop US",
				SKU:                 "FAMILY/BLUE/01",
				Country:             "US",
				ASIN:                stage10B1String("B001"),
				ProductName:         stage10B1String("Blue Shirt"),
				AvailableInventory:  10,
				InTransitQuantity:   2,
				SafetyFactor:        0.2,
				ProductionLeadDays:  20,
				ShippingDays:        25,
				RiskStatus:          "健康库存",
				TargetDays:          90,
				InventoryState:      "unknown",
				ReplenishmentAction: "NO_ACTION",
			}},
			Summary: inventory.InventoryReplenishmentSnapshotSummary{
				SKUCount:                1,
				HealthyCount:            1,
				TotalAvailableInventory: 10,
				TotalInTransitQuantity:  2,
			}.ReplenishmentSummary(),
			Total: 1,
		},
	}
	shippingStore := &stage10B1ShippingStore{}
	inventoryAuditor := audit.NewMockService()
	shippingAuditor := audit.NewMockService()
	router := chi.NewRouter()
	inventory.NewRegistrar(inventoryStore, inventoryAuditor).RegisterRoutes(router, stage10B1Passthrough)
	shipping.NewRegistrar(shippingStore, shippingAuditor).RegisterRoutes(router, stage10B1Passthrough)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin",
		IsAdmin:  true,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("snapshot detail status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var detail map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode snapshot detail: %v", err)
	}
	for _, field := range []string{"id", "project_id", "project_name", "country", "snapshot_date", "is_current", "row_count", "created_at", "summary", "items"} {
		if _, ok := detail[field]; !ok {
			t.Fatalf("snapshot detail missing %s: %s", field, rec.Body.String())
		}
	}
	detailItems, ok := detail["items"].([]any)
	if !ok || len(detailItems) != 1 {
		t.Fatalf("snapshot detail items = %#v", detail["items"])
	}
	item := detailItems[0].(map[string]any)
	for _, field := range []string{
		"source_row_no", "sku", "asin", "available_inventory", "in_transit_quantity",
		"dms_30", "dms_14", "dms_7", "dms_3", "base_dms", "safety_factor",
		"production_lead_days", "shipping_days", "weighted_dms", "sellable_days",
		"sellout_date", "sellout_date_with_transit", "replenishment_order_date",
		"warehouse_entry_date", "shipment_order_date", "estimated_replenishment_quantity",
		"risk_status", "risk_anchor_date",
	} {
		if _, ok := item[field]; !ok {
			t.Fatalf("snapshot item missing %s: %#v", field, item)
		}
	}

	req = httptest.NewRequest(
		http.MethodGet,
		"/api/v1/inventory-replenishment-snapshots/42/items?keyword=blue&risk_status=%E5%81%A5%E5%BA%B7%E5%BA%93%E5%AD%98&in_transit_only=true&page=2&page_size=10",
		nil,
	).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("snapshot items status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if inventoryStore.lastFilter.Page != 2 ||
		inventoryStore.lastFilter.PageSize != 10 ||
		!inventoryStore.lastFilter.InTransitOnly ||
		inventoryStore.lastFilter.Keyword == nil ||
		*inventoryStore.lastFilter.Keyword != "blue" {
		t.Fatalf("snapshot items filter = %#v", inventoryStore.lastFilter)
	}
	var pageBody map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &pageBody); err != nil {
		t.Fatalf("decode snapshot items: %v", err)
	}
	pageItems := pageBody["items"].([]any)
	if pageItems[0].(map[string]any)["product_name"] != "Blue Shirt" {
		t.Fatalf("snapshot items product_name = %#v", pageItems[0])
	}

	req = httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/inventory-replenishment-snapshots/42",
		bytes.NewBufferString(`{"name":"Renamed","description":"Updated note"}`),
	).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK ||
		inventoryStore.snapshot.Name == nil ||
		*inventoryStore.snapshot.Name != "Renamed" {
		t.Fatalf("snapshot PATCH status=%d snapshot=%#v", rec.Code, inventoryStore.snapshot)
	}
	if len(inventoryAuditor.Entries) == 0 || inventoryAuditor.Entries[len(inventoryAuditor.Entries)-1].Action != "inventory_replenishment_snapshot.update" {
		t.Fatalf("snapshot update audit entries = %#v", inventoryAuditor.Entries)
	}

	req = httptest.NewRequest(
		http.MethodPut,
		"/api/v1/inventory-replenishment-settings/1/FAMILY/BLUE/01",
		bytes.NewBufferString(`{"production_lead_days":20,"shipping_days":25,"safety_factor":0.2}`),
	).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || inventoryStore.lastSettingSKU != "FAMILY/BLUE/01" {
		t.Fatalf("inventory wildcard SKU status=%d sku=%q", rec.Code, inventoryStore.lastSettingSKU)
	}
	if len(inventoryAuditor.Entries) == 0 || inventoryAuditor.Entries[len(inventoryAuditor.Entries)-1].Action != "inventory_replenishment_settings.upsert" {
		t.Fatalf("inventory audit entries = %#v", inventoryAuditor.Entries)
	}
	lastInventoryAudit := inventoryAuditor.Entries[len(inventoryAuditor.Entries)-1]
	if lastInventoryAudit.TargetID == nil || *lastInventoryAudit.TargetID != "1" {
		t.Fatalf("inventory audit target = %#v, want setting id 1", lastInventoryAudit.TargetID)
	}

	req = httptest.NewRequest(
		http.MethodPut,
		"/api/v1/shipping-plan/skus/FAMILY/BLUE/01/growth-factor",
		bytes.NewBufferString(`{"project_id":1,"country":"US","growth_factor":1.2}`),
	).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || shippingStore.lastGrowthSKU != "FAMILY/BLUE/01" {
		t.Fatalf("shipping wildcard SKU status=%d sku=%q", rec.Code, shippingStore.lastGrowthSKU)
	}
	if len(shippingAuditor.Entries) == 0 || shippingAuditor.Entries[len(shippingAuditor.Entries)-1].Action != "shipping_plan.growth_factor.update" {
		t.Fatalf("shipping audit entries = %#v", shippingAuditor.Entries)
	}
}

func TestStage10B1NotFoundForbiddenValidationAndAuditTransaction(t *testing.T) {
	inventoryStore := &stage10B1InventoryStore{
		snapshot: inventory.InventoryReplenishmentSnapshotListItem{ID: 42, ProjectID: 7},
	}
	shippingStore := &stage10B1ShippingStore{}
	router := chi.NewRouter()
	inventory.NewRegistrar(inventoryStore, audit.NewMockService()).RegisterRoutes(router, stage10B1Passthrough)
	shipping.NewRegistrar(shippingStore, audit.NewMockService()).RegisterRoutes(router, stage10B1Passthrough)
	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "bob",
		Operator: "bob",
	})
	inventoryStore.accessErr = inventory.ErrProjectForbidden
	shippingStore.accessErr = shipping.ErrForbidden

	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42", nil).WithContext(nonAdminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("inventory scope status = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42/items", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("inventory items scope status = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/inventory-replenishment-snapshots/42",
		bytes.NewBufferString(`{"name":"blocked"}`),
	).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin snapshot patch status = %d, want 403: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(
		http.MethodPut,
		"/api/v1/shipping-plan/skus/FAMILY/BLUE/growth-factor",
		bytes.NewBufferString(`{"project_id":7,"country":"US","growth_factor":1.2}`),
	).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("shipping scope status = %d, want 403: %s", rec.Code, rec.Body.String())
	}

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin",
		IsAdmin:  true,
	})
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/999", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing snapshot status = %d, want 404: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-snapshots/42/items?page=0", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid page status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/inventory-replenishment-snapshots/42",
		bytes.NewBufferString(`{"name":"updated","unexpected":true}`),
	).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown snapshot field status = %d, want 422: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(
		http.MethodPut,
		"/api/v1/shipping-plan/skus/FAMILY/not-growth-factor",
		bytes.NewBufferString(`{}`),
	).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("invalid shipping wildcard suffix status = %d, want 404: %s", rec.Code, rec.Body.String())
	}

	failingAuditor := &stage10B1FailingAuditor{}
	failingStore := &stage10B1InventoryStore{
		snapshot: inventory.InventoryReplenishmentSnapshotListItem{ID: 42, ProjectID: 1},
	}
	failingRouter := chi.NewRouter()
	inventory.NewRegistrar(failingStore, failingAuditor).RegisterRoutes(failingRouter, stage10B1Passthrough)
	req = httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/inventory-replenishment-snapshots/42",
		bytes.NewBufferString(`{"name":"updated"}`),
	).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	failingRouter.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	if !failingStore.rolledBack || failingStore.committed {
		t.Fatalf("audit transaction flags committed=%v rolledBack=%v", failingStore.committed, failingStore.rolledBack)
	}
}

type stage10B1InventoryStore struct {
	snapshot       inventory.InventoryReplenishmentSnapshotListItem
	items          []inventory.InventoryReplenishmentSnapshotItem
	pageResponse   inventory.InventoryReplenishmentListResponse
	accessErr      error
	lastFilter     inventory.SnapshotItemsFilter
	lastSettingSKU string
	committed      bool
	rolledBack     bool
}

func (store *stage10B1InventoryStore) GetInventoryAnalysis(context.Context, inventory.ReplenishmentFilter) (inventory.InventoryAnalysisResponse, error) {
	return inventory.InventoryAnalysisResponse{}, nil
}
func (store *stage10B1InventoryStore) ListSnapshotOptions(context.Context, *int64, *string) ([]inventory.InventorySnapshotOption, error) {
	return []inventory.InventorySnapshotOption{}, nil
}
func (store *stage10B1InventoryStore) ListAnalysis(context.Context, inventory.ReplenishmentFilter) (inventory.InventoryReplenishmentListResponse, error) {
	return inventory.InventoryReplenishmentListResponse{}, nil
}
func (store *stage10B1InventoryStore) UpdateSetting(_ context.Context, projectID int64, sku string, _ inventory.InventoryReplenishmentSettingUpdate, _ string) (inventory.InventoryReplenishmentSettingItem, error) {
	store.lastSettingSKU = sku
	return inventory.InventoryReplenishmentSettingItem{
		ID:                 1,
		ProjectID:          projectID,
		SKU:                sku,
		Country:            "US",
		SafetyFactor:       0.2,
		ProductionLeadDays: 20,
		ShippingDays:       25,
		TargetDays:         90,
	}, nil
}
func (store *stage10B1InventoryStore) ListShipments(context.Context, *int64, *string) (inventory.InventoryReplenishmentShipmentResponse, error) {
	return inventory.InventoryReplenishmentShipmentResponse{}, nil
}
func (store *stage10B1InventoryStore) ListCalendar(context.Context, *int64, *string) (inventory.CalendarResponse, error) {
	return inventory.CalendarResponse{}, nil
}
func (store *stage10B1InventoryStore) ListSeasonal(context.Context, *int64, *string) (inventory.SeasonalReplenishmentListResponse, error) {
	return inventory.SeasonalReplenishmentListResponse{}, nil
}
func (store *stage10B1InventoryStore) ListSnapshots(context.Context, *int64, *string) ([]inventory.InventoryReplenishmentSnapshotListItem, error) {
	return []inventory.InventoryReplenishmentSnapshotListItem{}, nil
}
func (store *stage10B1InventoryStore) GetSnapshot(_ context.Context, snapshotID int64) (*inventory.InventoryReplenishmentSnapshotListItem, error) {
	if store.snapshot.ID != snapshotID {
		return nil, nil
	}
	snapshot := store.snapshot
	return &snapshot, nil
}
func (store *stage10B1InventoryStore) ListSnapshotItems(context.Context, int64) ([]inventory.InventoryReplenishmentSnapshotItem, error) {
	return store.items, nil
}
func (store *stage10B1InventoryStore) ListSnapshotItemsPage(_ context.Context, snapshot *inventory.InventoryReplenishmentSnapshotListItem, filter inventory.SnapshotItemsFilter) (inventory.InventoryReplenishmentListResponse, error) {
	store.lastFilter = filter
	response := store.pageResponse
	response.Page = filter.Page
	response.PageSize = filter.PageSize
	if response.Summary.StateDistribution == nil {
		response.Summary = snapshot.Summary.ReplenishmentSummary()
	}
	return response, nil
}
func (store *stage10B1InventoryStore) CreateSnapshot(context.Context, int64, string, inventory.CreateSnapshotRequest, string) (inventory.InventoryReplenishmentSnapshotListItem, error) {
	return store.snapshot, nil
}
func (store *stage10B1InventoryStore) UpdateSnapshot(_ context.Context, _ int64, request inventory.UpdateSnapshotRequest, _ string) (*inventory.InventoryReplenishmentSnapshotListItem, error) {
	store.snapshot.Name = request.Name
	store.snapshot.Description = request.Description
	snapshot := store.snapshot
	return &snapshot, nil
}
func (store *stage10B1InventoryStore) DeleteSnapshot(context.Context, int64, string) (bool, error) {
	return true, nil
}
func (store *stage10B1InventoryStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return store.accessErr
}
func (store *stage10B1InventoryStore) RunInTx(ctx context.Context, fn func(context.Context, pgx.Tx, inventory.Store) error) error {
	if err := fn(ctx, stage10B1AuditTx{}, store); err != nil {
		store.rolledBack = true
		return err
	}
	store.committed = true
	return nil
}

type stage10B1ShippingStore struct {
	accessErr     error
	lastGrowthSKU string
}

func (*stage10B1ShippingStore) ListSkus(context.Context, int64, string, int, int) (shipping.ShippingPlanSkuListResponse, error) {
	return shipping.ShippingPlanSkuListResponse{}, nil
}
func (*stage10B1ShippingStore) GetForecast(context.Context, int64, string, string) (shipping.ShippingPlanForecastResponse, error) {
	return shipping.ShippingPlanForecastResponse{}, nil
}
func (store *stage10B1ShippingStore) UpdateGrowthFactor(_ context.Context, sku string, update shipping.ShippingPlanGrowthFactorUpdate) (shipping.ShippingPlanGrowthFactorResponse, error) {
	store.lastGrowthSKU = sku
	return shipping.ShippingPlanGrowthFactorResponse{
		ProjectID:    update.ProjectID,
		Country:      update.Country,
		SKU:          sku,
		GrowthFactor: update.GrowthFactor,
		DemandSource: "manual",
	}, nil
}
func (*stage10B1ShippingStore) GetShipmentHistory(context.Context, int64, string, string, string) (shipping.ShipmentHistoryResponse, error) {
	return shipping.ShipmentHistoryResponse{}, nil
}
func (*stage10B1ShippingStore) ListBatches(context.Context, int64, string) (shipping.ShippingPlanBatchListResponse, error) {
	return shipping.ShippingPlanBatchListResponse{}, nil
}
func (*stage10B1ShippingStore) GetBatch(context.Context, int64) (*shipping.ShippingPlanBatchResponse, error) {
	return nil, shipping.ErrNotFound
}
func (*stage10B1ShippingStore) CreateBatch(context.Context, shipping.ShippingPlanBatchCreate, string) (shipping.ShippingPlanBatchResponse, error) {
	return shipping.ShippingPlanBatchResponse{}, nil
}
func (*stage10B1ShippingStore) UpdateBatch(context.Context, int64, shipping.ShippingPlanBatchUpdate, string) (*shipping.ShippingPlanBatchResponse, error) {
	return nil, shipping.ErrNotFound
}
func (*stage10B1ShippingStore) CancelBatch(context.Context, int64, string) (*shipping.ShippingPlanBatchResponse, error) {
	return nil, shipping.ErrNotFound
}
func (*stage10B1ShippingStore) GetAllocationProjectID(context.Context, int64) (int64, error) {
	return 0, shipping.ErrNotFound
}
func (*stage10B1ShippingStore) CreateAllocation(context.Context, int64, shipping.ShippingPlanAllocationCreate, string) (shipping.ShippingPlanAllocationResult, error) {
	return shipping.ShippingPlanAllocationResult{}, nil
}
func (*stage10B1ShippingStore) DeleteAllocation(context.Context, int64, string) (bool, error) {
	return false, shipping.ErrNotFound
}
func (store *stage10B1ShippingStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return store.accessErr
}
func (store *stage10B1ShippingStore) RunInTx(ctx context.Context, fn func(context.Context, pgx.Tx, shipping.Store) error) error {
	return fn(ctx, stage10B1AuditTx{}, store)
}

type stage10B1AuditTx struct{}

func (stage10B1AuditTx) Begin(context.Context) (pgx.Tx, error) { return stage10B1AuditTx{}, nil }
func (stage10B1AuditTx) Commit(context.Context) error          { return nil }
func (stage10B1AuditTx) Rollback(context.Context) error        { return nil }
func (stage10B1AuditTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (stage10B1AuditTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}
func (stage10B1AuditTx) LargeObjects() pgx.LargeObjects { return pgx.LargeObjects{} }
func (stage10B1AuditTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (stage10B1AuditTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (stage10B1AuditTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, nil
}
func (stage10B1AuditTx) QueryRow(context.Context, string, ...any) pgx.Row { return nil }
func (stage10B1AuditTx) Conn() *pgx.Conn                                  { return nil }

type stage10B1FailingAuditor struct{}

func (*stage10B1FailingAuditor) LogAction(context.Context, audit.Entry) error {
	return errors.New("audit insert failed")
}
func (*stage10B1FailingAuditor) LogActionTx(context.Context, pgx.Tx, audit.Entry) error {
	return errors.New("audit insert failed")
}
func (*stage10B1FailingAuditor) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

func stage10B1Passthrough(next http.Handler) http.Handler {
	return next
}

func stage10B1RouteInventory(t *testing.T, router chi.Router) map[string]bool {
	t.Helper()
	routes := map[string]bool{}
	err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		routes[method+" "+route] = true
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	return routes
}

func stage10B1SortedRoutes(routes map[string]bool) string {
	items := make([]string, 0, len(routes))
	for route := range routes {
		items = append(items, route)
	}
	sort.Strings(items)
	return strings.Join(items, "\n")
}

func stage10B1String(value string) *string {
	return &value
}
