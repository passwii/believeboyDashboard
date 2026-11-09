package shipment_schedules

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
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

type mockShipmentStore struct {
	detail  ShipmentScheduleDetail
	fbaResp ShipmentFbaBoxDetailResponse
}

func (m *mockShipmentStore) ListShipmentSchedules(_ context.Context, _ ShipmentFilter) (ShipmentScheduleListResponse, error) {
	return ShipmentScheduleListResponse{
		Items: []ShipmentScheduleListItem{{
			ID:             m.detail.ID,
			ProjectID:      m.detail.ProjectID,
			ProjectName:    m.detail.ProjectName,
			Country:        m.detail.Country,
			ShipmentNo:     m.detail.ShipmentNo,
			ShippingMethod: m.detail.ShippingMethod,
			ShipmentStatus: m.detail.ShipmentStatus,
		}},
		Page:     1,
		PageSize: 20,
		HasNext:  false,
	}, nil
}
func (m *mockShipmentStore) SummarizeCosts(_ context.Context, _ *int64, _ []int64, _, _, _ *string) (ShipmentScheduleCostSummary, error) {
	return ShipmentScheduleCostSummary{ShipmentCount: 1, TotalQuantity: 100}, nil
}
func (m *mockShipmentStore) ListSkuSummary(_ context.Context, _ *int64, _, _, _ *string) (ShipmentSkuSummaryResponse, error) {
	return ShipmentSkuSummaryResponse{Items: []ShipmentSkuSummaryItem{}}, nil
}
func (m *mockShipmentStore) ListFbaBoxDetails(_ context.Context, _ []int64, _, _ []string) (ShipmentFbaBoxDetailResponse, error) {
	if len(m.fbaResp.ProjectIDs) > 0 {
		return m.fbaResp, nil
	}
	return ShipmentFbaBoxDetailResponse{Items: []ShipmentFbaBoxDetailItem{}}, nil
}
func (m *mockShipmentStore) ListBatches(_ context.Context, _ *int64, _ []int64, _ *string) ([]string, error) {
	return []string{"batch-1"}, nil
}
func (m *mockShipmentStore) HideBatch(_ context.Context, _ ShipmentBatchHiddenDeleteRequest) (bool, error) {
	return true, nil
}
func (m *mockShipmentStore) GetShipmentSchedule(_ context.Context, _ int64) (*ShipmentScheduleDetail, error) {
	return &m.detail, nil
}
func (m *mockShipmentStore) CreateShipmentSchedule(_ context.Context, _ ShipmentScheduleCreate, _ string) (ShipmentScheduleDetail, error) {
	return m.detail, nil
}
func (m *mockShipmentStore) UpdateShipmentSchedule(_ context.Context, _ int64, _ ShipmentScheduleUpdate, _ string) (*ShipmentScheduleDetail, error) {
	return &m.detail, nil
}
func (m *mockShipmentStore) DeleteShipmentSchedule(_ context.Context, _ int64) (bool, error) {
	return true, nil
}
func (m *mockShipmentStore) ImportSchedulesCSV(_ context.Context, _ []byte, _ string, _ bool) (ShipmentSchedulesImportResponse, error) {
	return ShipmentSchedulesImportResponse{Inserted: 1, ShipmentNos: []string{"FBA123456"}}, nil
}
func (m *mockShipmentStore) ImportItemsCSV(_ context.Context, _ int64, _ []byte, _ string) (ShipmentItemsImportResponse, error) {
	return ShipmentItemsImportResponse{Inserted: 1}, nil
}
func (m *mockShipmentStore) CalculateCosts(_ context.Context, _ int64, _ ShipmentCostCalculateRequest) (*ShipmentScheduleDetail, error) {
	return &m.detail, nil
}

func TestShipmentSchedulesHandler(t *testing.T) {
	store := &mockShipmentStore{
		detail: ShipmentScheduleDetail{
			ID:             1,
			ProjectID:      10,
			ProjectName:    "US Shop",
			Country:        "US",
			ShipmentNo:     "FBA123456",
			ShippingMethod: "sea",
			ShipmentStatus: "in_transit",
		},
	}
	auditor := audit.NewMockService()
	op := "alice"
	projectReader := &mockProjectReader{
		project: &projects.ProjectItem{
			ID:              10,
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

	// Test 1: List and check snake_case has_next field
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shipment-schedules?project_id=10", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"has_next":`) {
		t.Fatalf("expected response to contain snake_case has_next, got %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"hasNext":`) {
		t.Fatalf("response should not contain camelCase hasNext, got %s", rec.Body.String())
	}

	// Test 2: Detail with unauthorized user -> 403 Forbidden
	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipment-schedules/1", nil).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 3: Detail with authorized user -> 200 OK
	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipment-schedules/1", nil).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 4: Create with audit
	body, _ := json.Marshal(ShipmentScheduleCreate{
		ProjectID:      10,
		Country:        "US",
		ShipmentNo:     "FBA123456",
		ShippingMethod: "sea",
		ShipmentStatus: "draft",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shipment-schedules", bytes.NewReader(body)).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.Entries) == 0 || auditor.Entries[len(auditor.Entries)-1].Action != "shipment_schedules.create" {
		t.Fatalf("expected audit log for shipment_schedules.create, got %v", auditor.Entries)
	}

	// Test 5: Update with audit
	updateBody, _ := json.Marshal(ShipmentScheduleUpdate{
		ProjectID:      10,
		Country:        "US",
		ShipmentNo:     "FBA123456",
		ShippingMethod: "air",
		ShipmentStatus: "in_transit",
	})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/shipment-schedules/1", bytes.NewReader(updateBody)).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.Entries) == 0 || auditor.Entries[len(auditor.Entries)-1].Action != "shipment_schedules.update" {
		t.Fatalf("expected audit log for shipment_schedules.update, got %v", auditor.Entries)
	}

	// Test 6: Delete with audit
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/shipment-schedules/1", nil).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.Entries) == 0 || auditor.Entries[len(auditor.Entries)-1].Action != "shipment_schedules.delete" {
		t.Fatalf("expected audit log for shipment_schedules.delete, got %v", auditor.Entries)
	}

	// Test 7: Hide batch with audit
	hideBody, _ := json.Marshal(ShipmentBatchHiddenDeleteRequest{
		ProjectID:     10,
		Country:       "US",
		ShipmentBatch: "batch-1",
	})
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/shipment-schedules/batches/hidden", bytes.NewReader(hideBody)).WithContext(operatorCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.Entries) == 0 || auditor.Entries[len(auditor.Entries)-1].Action != "shipment_schedules.batches.hide" {
		t.Fatalf("expected audit log for shipment_schedules.batches.hide, got %v", auditor.Entries)
	}
}

func TestShipmentSchedulesProjectScopeAndCSVImport(t *testing.T) {
	store := &mockShipmentStore{
		detail: ShipmentScheduleDetail{
			ID:             1,
			ProjectID:      10,
			ProjectName:    "Project10",
			Country:        "US",
			ShipmentNo:     "FBA123456",
			ShippingMethod: "sea",
			ShipmentStatus: "in_transit",
		},
	}
	auditor := audit.NewMockService()
	// projectReader with 0 accessible projects for unauthorized op
	emptyProjectReader := &mockProjectReader{
		project: nil,
	}
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor, emptyProjectReader)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user_no_proj",
		Operator: "op_no_proj",
		IsAdmin:  false,
	})

	// 1. Cost summary without project_id for non-admin with 0 accessible projects returns empty (0 count)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shipment-schedules/cost-summary", nil).WithContext(nonAdminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var sum ShipmentScheduleCostSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &sum); err != nil {
		t.Fatalf("unmarshal summary: %v", err)
	}
	if sum.ShipmentCount != 0 {
		t.Fatalf("expected 0 shipment count for non-admin without project, got %d", sum.ShipmentCount)
	}

	// 2. Batches list without project_id for non-admin with 0 accessible projects returns empty list
	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipment-schedules/batches", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var batches []string
	if err := json.Unmarshal(rec.Body.Bytes(), &batches); err != nil {
		t.Fatalf("unmarshal batches: %v", err)
	}
	if len(batches) != 0 {
		t.Fatalf("expected 0 batches for non-admin without project, got %d", len(batches))
	}

	// 3. FBA box details with unauthorized project returns 403 Forbidden
	secretOp := "secret_alice"
	secretProjectReader := &mockProjectReader{
		project: &projects.ProjectItem{
			ID:              999,
			Name:            "Secret Project",
			ProjectOperator: &secretOp,
		},
	}
	storeWithUnauthorized := &mockShipmentStore{
		fbaResp: ShipmentFbaBoxDetailResponse{
			ProjectIDs: []int64{999},
		},
	}
	regWithUnauthorized := NewRegistrar(storeWithUnauthorized, auditor, secretProjectReader)
	routerWithUnauthorized := chi.NewRouter()
	regWithUnauthorized.RegisterRoutes(routerWithUnauthorized, func(next http.Handler) http.Handler { return next })

	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipment-schedules/fba-box-details?project_ids=999", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	routerWithUnauthorized.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized project FBA box details, got %d", rec.Code)
	}

	// 4. FBA box details queried by shipment_nos where target shipment belongs to unauthorized project returns 403
	req = httptest.NewRequest(http.MethodGet, "/api/v1/shipment-schedules/fba-box-details?shipment_nos=FBA-SECRET", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	routerWithUnauthorized.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-project target shipment in FBA box details, got %d", rec.Code)
	}
}
