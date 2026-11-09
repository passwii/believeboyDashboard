package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/complaints"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_label"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage2CReplenishmentStore struct {
	item inventory_replenishment.InventoryReplenishmentListItem
}

func (s *stage2CReplenishmentStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return nil
}
func (s *stage2CReplenishmentStore) GetInventoryAnalysis(_ context.Context, _ inventory_replenishment.ReplenishmentFilter) (inventory_replenishment.InventoryAnalysisResponse, error) {
	return inventory_replenishment.InventoryAnalysisResponse{Items: []inventory_replenishment.InventoryAnalysisItem{}}, nil
}
func (s *stage2CReplenishmentStore) ListSnapshotOptions(_ context.Context, _ *int64, _ *string) ([]inventory_replenishment.InventorySnapshotOption, error) {
	return []inventory_replenishment.InventorySnapshotOption{{SnapshotDate: "2026-11-01", Label: "Current", IsCurrent: true}}, nil
}
func (s *stage2CReplenishmentStore) ListAnalysis(_ context.Context, _ inventory_replenishment.ReplenishmentFilter) (inventory_replenishment.InventoryReplenishmentListResponse, error) {
	return inventory_replenishment.InventoryReplenishmentListResponse{
		Items: []inventory_replenishment.InventoryReplenishmentListItem{s.item},
		Summary: inventory_replenishment.InventoryReplenishmentSummary{
			SKUCount: 1,
		},
		Total:    1,
		Page:     1,
		PageSize: 50,
	}, nil
}
func (s *stage2CReplenishmentStore) UpdateSetting(_ context.Context, projectID int64, sku string, _ inventory_replenishment.InventoryReplenishmentSettingUpdate, _ string) (inventory_replenishment.InventoryReplenishmentSettingItem, error) {
	return inventory_replenishment.InventoryReplenishmentSettingItem{ProjectID: projectID, SKU: sku, SafetyFactor: 1.5}, nil
}
func (s *stage2CReplenishmentStore) ListShipments(_ context.Context, _ *int64, _ *string) (inventory_replenishment.InventoryReplenishmentShipmentResponse, error) {
	return inventory_replenishment.InventoryReplenishmentShipmentResponse{Items: []inventory_replenishment.InventoryReplenishmentShipmentItem{}}, nil
}
func (s *stage2CReplenishmentStore) ListCalendar(_ context.Context, _ *int64, _ *string) (inventory_replenishment.CalendarResponse, error) {
	return inventory_replenishment.CalendarResponse{Items: []inventory_replenishment.CalendarRowItem{}}, nil
}
func (s *stage2CReplenishmentStore) ListSeasonal(_ context.Context, _ *int64, _ *string) (inventory_replenishment.SeasonalReplenishmentListResponse, error) {
	return inventory_replenishment.SeasonalReplenishmentListResponse{Items: []inventory_replenishment.SeasonalReplenishmentListItem{}}, nil
}
func (s *stage2CReplenishmentStore) ListSnapshots(_ context.Context, _ *int64, _ *string) ([]inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	return []inventory_replenishment.InventoryReplenishmentSnapshotListItem{}, nil
}
func (s *stage2CReplenishmentStore) GetSnapshot(_ context.Context, snapshotID int64) (*inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	return &inventory_replenishment.InventoryReplenishmentSnapshotListItem{ID: snapshotID}, nil
}
func (s *stage2CReplenishmentStore) ListSnapshotItems(_ context.Context, _ int64) ([]inventory_replenishment.InventoryReplenishmentSnapshotItem, error) {
	return []inventory_replenishment.InventoryReplenishmentSnapshotItem{}, nil
}
func (s *stage2CReplenishmentStore) ListSnapshotItemsPage(_ context.Context, _ *inventory_replenishment.InventoryReplenishmentSnapshotListItem, _ inventory_replenishment.SnapshotItemsFilter) (inventory_replenishment.InventoryReplenishmentListResponse, error) {
	return inventory_replenishment.InventoryReplenishmentListResponse{
		Items:    []inventory_replenishment.InventoryReplenishmentListItem{},
		Page:     1,
		PageSize: 50,
	}, nil
}
func (s *stage2CReplenishmentStore) CreateSnapshot(_ context.Context, projectID int64, country string, _ inventory_replenishment.CreateSnapshotRequest, _ string) (inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	return inventory_replenishment.InventoryReplenishmentSnapshotListItem{ID: 1, ProjectID: projectID, Country: country}, nil
}
func (s *stage2CReplenishmentStore) UpdateSnapshot(_ context.Context, snapshotID int64, _ inventory_replenishment.UpdateSnapshotRequest, _ string) (*inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	return &inventory_replenishment.InventoryReplenishmentSnapshotListItem{ID: snapshotID}, nil
}
func (s *stage2CReplenishmentStore) DeleteSnapshot(_ context.Context, _ int64, _ string) (bool, error) {
	return true, nil
}

type stage2CComplaintStore struct {
	detail complaints.ComplaintDetail
}

func (s *stage2CComplaintStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return nil
}
func (s *stage2CComplaintStore) GetOverview(_ context.Context, date string, _ *string) (complaints.OverviewResponse, error) {
	return complaints.OverviewResponse{Date: date, Metrics: complaints.OverviewMetrics{TotalNeedsReply: 1}}, nil
}
func (s *stage2CComplaintStore) ListComplaints(_ context.Context, _ complaints.ComplaintFilter) (complaints.ComplaintListResponse, error) {
	return complaints.ComplaintListResponse{Items: []complaints.ComplaintListItem{s.detail.ComplaintListItem}, Total: 1, Page: 1, PageSize: 20}, nil
}
func (s *stage2CComplaintStore) GetComplaint(_ context.Context, id int64) (*complaints.ComplaintDetail, error) {
	if id == s.detail.ID {
		return &s.detail, nil
	}
	return nil, nil
}
func (s *stage2CComplaintStore) PatchComplaint(_ context.Context, _ int64, _ complaints.ComplaintPatchRequest, _ string) (*complaints.ComplaintDetail, error) {
	return &s.detail, nil
}

type stage2CGenerator struct{}

func (s *stage2CGenerator) Generate(_ context.Context, input product_label.GenerateInput) ([]byte, string, error) {
	return []byte("%PDF-1.4 generated"), "label-labeled.pdf", nil
}

func TestStage2CReplenishmentComplaintsAndLabelContracts(t *testing.T) {
	replStore := &stage2CReplenishmentStore{
		item: inventory_replenishment.InventoryReplenishmentListItem{
			ProjectID:          1,
			ProjectName:        "Shop US",
			SKU:                "SKU-1",
			Country:            "US",
			AvailableInventory: 100,
			RiskStatus:         "healthy",
		},
	}
	complaintStore := &stage2CComplaintStore{
		detail: complaints.ComplaintDetail{
			ComplaintListItem: complaints.ComplaintListItem{
				ID:               1,
				RunID:            10,
				ProjectID:        1,
				ProjectName:      "Test Proj",
				Country:          "US",
				BuyerName:        "Buyer A",
				FirstMessageDate: "2026-11-01",
				MessageDate:      "2026-11-01",
				Subject:          "Help",
				Category:         "with_order",
				Status:           "pending",
			},
			MessageBody: "Need refund",
		},
	}
	generator := &stage2CGenerator{}

	passthrough := func(next http.Handler) http.Handler { return next }

	router := chi.NewRouter()
	inventory_replenishment.NewRegistrar(replStore, nil).RegisterRoutes(router, passthrough)
	complaints.NewRegistrar(complaintStore, nil).RegisterRoutes(router, passthrough)
	product_label.NewRegistrar(generator).RegisterRoutes(router, passthrough)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test 1: replenishment analysis
	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory-replenishment-analysis?project_id=1", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var replResp inventory_replenishment.InventoryReplenishmentListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &replResp); err != nil {
		t.Fatalf("failed to unmarshal replenishment response: %v", err)
	}
	if len(replResp.Items) != 1 || replResp.Items[0].SKU != "SKU-1" {
		t.Fatalf("unexpected replenishment item")
	}

	// Test 2: complaints overview
	req = httptest.NewRequest(http.MethodGet, "/api/v1/complaints/overview?date=2026-11-07", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var overviewResp complaints.OverviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &overviewResp); err != nil {
		t.Fatalf("failed to unmarshal complaints overview: %v", err)
	}
	if overviewResp.Metrics.TotalNeedsReply != 1 {
		t.Fatalf("unexpected overview metrics")
	}

	// Test 3: product label generate
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	part, _ := w.CreateFormFile("file", "label.pdf")
	_, _ = part.Write([]byte("%PDF-1.4 test"))
	_ = w.WriteField("text", "Text")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("expected application/pdf")
	}
}
