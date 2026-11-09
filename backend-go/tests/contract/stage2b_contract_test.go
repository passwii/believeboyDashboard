package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_ledger"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipment_schedules"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipping_plan"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage2BShipmentStore struct {
	detail shipment_schedules.ShipmentScheduleDetail
}

func (s *stage2BShipmentStore) ListShipmentSchedules(_ context.Context, _ shipment_schedules.ShipmentFilter) (shipment_schedules.ShipmentScheduleListResponse, error) {
	return shipment_schedules.ShipmentScheduleListResponse{
		Items: []shipment_schedules.ShipmentScheduleListItem{{
			ID:             s.detail.ID,
			ProjectID:      s.detail.ProjectID,
			ProjectName:    s.detail.ProjectName,
			Country:        s.detail.Country,
			ShipmentNo:     s.detail.ShipmentNo,
			ShippingMethod: s.detail.ShippingMethod,
			ShipmentStatus: s.detail.ShipmentStatus,
		}},
		Page:     1,
		PageSize: 20,
		HasNext:  false,
	}, nil
}
func (s *stage2BShipmentStore) SummarizeCosts(_ context.Context, _ *int64, _ []int64, _, _, _ *string) (shipment_schedules.ShipmentScheduleCostSummary, error) {
	return shipment_schedules.ShipmentScheduleCostSummary{ShipmentCount: 1, TotalQuantity: 100}, nil
}
func (s *stage2BShipmentStore) ListSkuSummary(_ context.Context, _ *int64, _, _, _ *string) (shipment_schedules.ShipmentSkuSummaryResponse, error) {
	return shipment_schedules.ShipmentSkuSummaryResponse{Items: []shipment_schedules.ShipmentSkuSummaryItem{}}, nil
}
func (s *stage2BShipmentStore) ListFbaBoxDetails(_ context.Context, _ []int64, _, _ []string) (shipment_schedules.ShipmentFbaBoxDetailResponse, error) {
	return shipment_schedules.ShipmentFbaBoxDetailResponse{Items: []shipment_schedules.ShipmentFbaBoxDetailItem{}}, nil
}
func (s *stage2BShipmentStore) ListBatches(_ context.Context, _ *int64, _ []int64, _ *string) ([]string, error) {
	return []string{"batch-1"}, nil
}
func (s *stage2BShipmentStore) HideBatch(_ context.Context, _ shipment_schedules.ShipmentBatchHiddenDeleteRequest) (bool, error) {
	return true, nil
}
func (s *stage2BShipmentStore) GetShipmentSchedule(_ context.Context, _ int64) (*shipment_schedules.ShipmentScheduleDetail, error) {
	return &s.detail, nil
}
func (s *stage2BShipmentStore) CreateShipmentSchedule(_ context.Context, _ shipment_schedules.ShipmentScheduleCreate, _ string) (shipment_schedules.ShipmentScheduleDetail, error) {
	return s.detail, nil
}
func (s *stage2BShipmentStore) UpdateShipmentSchedule(_ context.Context, _ int64, _ shipment_schedules.ShipmentScheduleUpdate, _ string) (*shipment_schedules.ShipmentScheduleDetail, error) {
	return &s.detail, nil
}
func (s *stage2BShipmentStore) DeleteShipmentSchedule(_ context.Context, _ int64) (bool, error) {
	return true, nil
}
func (s *stage2BShipmentStore) ImportSchedulesCSV(_ context.Context, _ []byte, _ string, _ bool) (shipment_schedules.ShipmentSchedulesImportResponse, error) {
	return shipment_schedules.ShipmentSchedulesImportResponse{Inserted: 1}, nil
}
func (s *stage2BShipmentStore) ImportItemsCSV(_ context.Context, _ int64, _ []byte, _ string) (shipment_schedules.ShipmentItemsImportResponse, error) {
	return shipment_schedules.ShipmentItemsImportResponse{Inserted: 1}, nil
}
func (s *stage2BShipmentStore) CalculateCosts(_ context.Context, _ int64, _ shipment_schedules.ShipmentCostCalculateRequest) (*shipment_schedules.ShipmentScheduleDetail, error) {
	return &s.detail, nil
}

type stage2BShippingPlanStore struct {
	batch shipping_plan.ShippingPlanBatchResponse
}

func (s *stage2BShippingPlanStore) ListSkus(_ context.Context, _ int64, _ string, _, _ int) (shipping_plan.ShippingPlanSkuListResponse, error) {
	return shipping_plan.ShippingPlanSkuListResponse{Items: []shipping_plan.ShippingPlanSkuItem{{SKU: "SKU1", GrowthFactor: 1.0}}, Total: 1}, nil
}
func (s *stage2BShippingPlanStore) GetForecast(_ context.Context, _ int64, _, sku string) (shipping_plan.ShippingPlanForecastResponse, error) {
	return shipping_plan.ShippingPlanForecastResponse{SKU: sku, GrowthFactor: 1.0}, nil
}
func (s *stage2BShippingPlanStore) UpdateGrowthFactor(_ context.Context, sku string, _ shipping_plan.ShippingPlanGrowthFactorUpdate) (shipping_plan.ShippingPlanGrowthFactorResponse, error) {
	return shipping_plan.ShippingPlanGrowthFactorResponse{SKU: sku, GrowthFactor: 1.2}, nil
}
func (s *stage2BShippingPlanStore) GetShipmentHistory(_ context.Context, _ int64, _, _, _ string) (shipping_plan.ShipmentHistoryResponse, error) {
	return shipping_plan.ShipmentHistoryResponse{Country: "US"}, nil
}
func (s *stage2BShippingPlanStore) ListBatches(_ context.Context, _ int64, _ string) (shipping_plan.ShippingPlanBatchListResponse, error) {
	return shipping_plan.ShippingPlanBatchListResponse{Items: []shipping_plan.ShippingPlanBatchResponse{s.batch}, Total: 1}, nil
}
func (s *stage2BShippingPlanStore) GetBatch(_ context.Context, _ int64) (*shipping_plan.ShippingPlanBatchResponse, error) {
	return &s.batch, nil
}
func (s *stage2BShippingPlanStore) GetAllocationProjectID(_ context.Context, _ int64) (int64, error) {
	return s.batch.ProjectID, nil
}
func (s *stage2BShippingPlanStore) CreateBatch(_ context.Context, _ shipping_plan.ShippingPlanBatchCreate, _ string) (shipping_plan.ShippingPlanBatchResponse, error) {
	return s.batch, nil
}
func (s *stage2BShippingPlanStore) UpdateBatch(_ context.Context, _ int64, _ shipping_plan.ShippingPlanBatchUpdate, _ string) (*shipping_plan.ShippingPlanBatchResponse, error) {
	return &s.batch, nil
}
func (s *stage2BShippingPlanStore) CancelBatch(_ context.Context, _ int64, _ string) (*shipping_plan.ShippingPlanBatchResponse, error) {
	return &s.batch, nil
}
func (s *stage2BShippingPlanStore) CreateAllocation(_ context.Context, _ int64, _ shipping_plan.ShippingPlanAllocationCreate, _ string) (shipping_plan.ShippingPlanAllocationResult, error) {
	return shipping_plan.ShippingPlanAllocationResult{Allocation: shipping_plan.ShippingPlanAllocationResponse{ID: 1, SKU: "SKU1", Quantity: 10}}, nil
}
func (s *stage2BShippingPlanStore) DeleteAllocation(_ context.Context, _ int64, _ string) (bool, error) {
	return true, nil
}

type stage2BLedgerStore struct{}

func (s *stage2BLedgerStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return nil
}
func (s *stage2BLedgerStore) ListMonths(_ context.Context, projectID int64, _ *string) (inventory_ledger.MonthsResponse, error) {
	return inventory_ledger.MonthsResponse{ProjectID: projectID, Months: []string{"2026-10"}}, nil
}
func (s *stage2BLedgerStore) GetSnapshot(_ context.Context, _ int64, _ *string, month string) (inventory_ledger.MonthlySnapshotResponse, error) {
	return inventory_ledger.MonthlySnapshotResponse{ReportMonth: month, SKUCount: 1, TotalQty: 100}, nil
}
func (s *stage2BLedgerStore) GetEvents(_ context.Context, _ int64, _ *string, month string) (inventory_ledger.EventsResponse, error) {
	return inventory_ledger.EventsResponse{ReportMonth: month, SKUs: []inventory_ledger.SkuMonthEvents{}}, nil
}
func (s *stage2BLedgerStore) GetClusters(_ context.Context, _ int64, _ *string, month string) (inventory_ledger.ReceiptClustersResponse, error) {
	return inventory_ledger.ReceiptClustersResponse{ReportMonth: month, Clusters: []inventory_ledger.ReceiptCluster{}}, nil
}
func (s *stage2BLedgerStore) GetLocationDetail(_ context.Context, _ int64, _ *string, month string) (inventory_ledger.LocationDetailResponse, error) {
	return inventory_ledger.LocationDetailResponse{ReportMonth: month, Rows: []inventory_ledger.LocationDetail{}}, nil
}
func (s *stage2BLedgerStore) GetTrend(_ context.Context, projectID int64, _ *string) (inventory_ledger.TrendResponse, error) {
	return inventory_ledger.TrendResponse{ProjectID: projectID, Months: []inventory_ledger.TrendMonthItem{}}, nil
}
func (s *stage2BLedgerStore) GetDetail(_ context.Context, _ int64, _ *string, month string, _, _ *string) (inventory_ledger.LedgerDetailResponse, error) {
	return inventory_ledger.LedgerDetailResponse{ReportMonth: month, Rows: []inventory_ledger.LedgerDetailRow{}}, nil
}
func (s *stage2BLedgerStore) GetSummary(_ context.Context, _ int64, _ *string, month string, _, _ *string) (inventory_ledger.LedgerSummaryResponse, error) {
	return inventory_ledger.LedgerSummaryResponse{ReportMonth: month, Rows: []inventory_ledger.LedgerSummaryRow{}}, nil
}
func (s *stage2BLedgerStore) ListBatches(_ context.Context, projectID int64, _ *string) (inventory_ledger.IngestBatchesResponse, error) {
	return inventory_ledger.IngestBatchesResponse{ProjectID: projectID, Batches: []inventory_ledger.IngestBatchInfo{}}, nil
}
func (s *stage2BLedgerStore) GetConsistency(_ context.Context, _ int64, _ *string, month string) (inventory_ledger.ConsistencyCheckResult, error) {
	return inventory_ledger.ConsistencyCheckResult{ReportMonth: month, Status: "OK"}, nil
}
func (s *stage2BLedgerStore) GetMonthAnalysis(_ context.Context, projectID int64, _ *string, month string) (inventory_ledger.LedgerMonthAnalysisResponse, error) {
	return inventory_ledger.LedgerMonthAnalysisResponse{ProjectID: projectID, ReportMonth: month}, nil
}

func TestStage2BShipmentAndLedgerWireContracts(t *testing.T) {
	shipmentStore := &stage2BShipmentStore{
		detail: shipment_schedules.ShipmentScheduleDetail{
			ID:             1,
			ProjectID:      10,
			ProjectName:    "US Shop",
			Country:        "US",
			ShipmentNo:     "FBA123456",
			ShippingMethod: "sea",
			ShipmentStatus: "in_transit",
		},
	}
	planStore := &stage2BShippingPlanStore{
		batch: shipping_plan.ShippingPlanBatchResponse{
			ID:                  1,
			ProjectID:           10,
			Country:             "US",
			Name:                "Plan 1",
			ExpectedArrivalDate: "2026-12-01",
			Status:              "active",
		},
	}
	ledgerStore := &stage2BLedgerStore{}

	passthrough := func(next http.Handler) http.Handler { return next }

	router := chi.NewRouter()
	shipment_schedules.NewRegistrar(shipmentStore, nil).RegisterRoutes(router, passthrough)
	shipping_plan.NewRegistrar(planStore, nil).RegisterRoutes(router, passthrough)
	inventory_ledger.NewRegistrar(ledgerStore).RegisterRoutes(router, passthrough)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test 1: shipment-schedules list with snake_case has_next
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shipment-schedules", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var shipmentList shipment_schedules.ShipmentScheduleListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &shipmentList); err != nil {
		t.Fatalf("failed to unmarshal shipment list: %v", err)
	}
	if len(shipmentList.Items) != 1 || shipmentList.Items[0].ShipmentNo != "FBA123456" {
		t.Fatalf("unexpected shipment in list")
	}
	if !strings.Contains(rec.Body.String(), `"has_next":`) {
		t.Fatalf("expected response to contain snake_case has_next, got %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"hasNext":`) {
		t.Fatalf("response should not contain camelCase hasNext, got %s", rec.Body.String())
	}

	// Test 2: shipping-plan skus
	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipping-plan/skus?project_id=10&country=US", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var planSkus shipping_plan.ShippingPlanSkuListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &planSkus); err != nil {
		t.Fatalf("failed to unmarshal shipping plan skus: %v", err)
	}
	if len(planSkus.Items) != 1 || planSkus.Items[0].SKU != "SKU1" {
		t.Fatalf("unexpected plan sku in list")
	}

	// Test 3: inventory-ledger months
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory-ledger/months?project_id=10&country=US", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var monthsResp inventory_ledger.MonthsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &monthsResp); err != nil {
		t.Fatalf("failed to unmarshal months resp: %v", err)
	}
	if len(monthsResp.Months) != 1 || monthsResp.Months[0] != "2026-10" {
		t.Fatalf("unexpected months in resp")
	}

	// Test 4: create shipping plan batch (returns 201 Created)
	batchBody, _ := json.Marshal(shipping_plan.ShippingPlanBatchCreate{
		ProjectID:           10,
		Country:             "US",
		Name:                "Plan 1",
		ExpectedArrivalDate: "2026-12-01",
		Items:               []shipping_plan.ShippingPlanItemInput{{SKU: "SKU1", Quantity: 5}},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches", bytes.NewReader(batchBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 5: create allocation (returns 201 Created)
	allocBody, _ := json.Marshal(shipping_plan.ShippingPlanAllocationCreate{
		PlanItemID:         1,
		ShipmentScheduleID: 5,
		Quantity:           10,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipping-plan/batches/1/allocations?project_id=10", bytes.NewReader(allocBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 6: delete allocation (returns 204 No Content)
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/shipping-plan/allocations/1?project_id=10", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 No Content, got %d: %s", rec.Code, rec.Body.String())
	}
}
