package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/order_info"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/sku_info"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage2AAuditor struct {
	entries []audit.Entry
}

func (a *stage2AAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}
func (a *stage2AAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}
func (a *stage2AAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

type stage2AOrderInfoStore struct {
	item      order_info.OrderInfoItem
	updateErr error
}

func (s *stage2AOrderInfoStore) GetPageData(_ context.Context, _ order_info.OrderInfoFilter) (order_info.OrderInfoPageData, error) {
	return order_info.OrderInfoPageData{
		Items:    []order_info.OrderInfoItem{s.item},
		Total:    1,
		Page:     1,
		PageSize: 50,
		Stats:    order_info.OrderInfoStats{TotalOrders: 1, TotalQuantity: 2, TotalAmount: 39.98},
		FilterOptions: order_info.OrderInfoFilterOptions{
			Projects:            []order_info.FilterOption{{Value: "1", Label: "北美"}},
			OrderStatuses:       []order_info.FilterOption{{Value: "Shipped", Label: "Shipped"}},
			FulfillmentChannels: []order_info.FilterOption{{Value: "Amazon", Label: "FBA（亚马逊配送）"}},
			Countries:           []order_info.FilterOption{{Value: "US", Label: "US"}},
			Currencies:          []order_info.FilterOption{{Value: "USD", Label: "USD"}},
		},
	}, nil
}
func (s *stage2AOrderInfoStore) ListOrders(_ context.Context, _ order_info.OrderInfoFilter) (order_info.OrderInfoListResponse, error) {
	return order_info.OrderInfoListResponse{Items: []order_info.OrderInfoItem{s.item}, Total: 1, Page: 1, PageSize: 50}, nil
}
func (s *stage2AOrderInfoStore) ComputeStats(_ context.Context, _ order_info.OrderInfoFilter) (order_info.OrderInfoStats, error) {
	return order_info.OrderInfoStats{TotalOrders: 1, TotalQuantity: 2, TotalAmount: 39.98}, nil
}
func (s *stage2AOrderInfoStore) GetOverview(_ context.Context, _ order_info.OrderInfoFilter) (order_info.OrderInfoOverview, error) {
	return order_info.OrderInfoOverview{Items: []order_info.OrderInfoItem{s.item}, Total: 1, Page: 1, PageSize: 50, Stats: order_info.OrderInfoStats{TotalOrders: 1}}, nil
}
func (s *stage2AOrderInfoStore) CollectFilterOptions(_ context.Context, _ string, _ bool) (order_info.OrderInfoFilterOptions, error) {
	return order_info.OrderInfoFilterOptions{}, nil
}
func (s *stage2AOrderInfoStore) QueryLiveStream(_ context.Context, _ []int64, _ []string, _ int, _ string, _ bool) ([]order_info.OrderLiveStreamItem, error) {
	return []order_info.OrderLiveStreamItem{{ID: "1:111", Title: "出单", TimeLabel: "12:00", OccurredAt: "2026-11-07T04:00:00Z"}}, nil
}
func (s *stage2AOrderInfoStore) ExportOrders(_ context.Context, _ order_info.OrderInfoFilter) (string, []byte, error) {
	return "orders.csv", []byte("id,sku\n1,SKU1\n"), nil
}
func (s *stage2AOrderInfoStore) GetOrderByID(_ context.Context, _ int64) (*order_info.OrderInfoItem, error) {
	return &s.item, nil
}
func (s *stage2AOrderInfoStore) UpdateOrderByID(_ context.Context, _ int64, _ order_info.OrderInfoUpdate, _ string, _ bool) (*order_info.OrderInfoItem, error) {
	if s.updateErr != nil {
		return nil, s.updateErr
	}
	return &s.item, nil
}

type stage2ASkuStore struct {
	item      sku_info.SkuRecordItem
	createErr error
}

func (s *stage2ASkuStore) ListSkuRecords(_ context.Context, _ sku_info.SkuFilter) (sku_info.SkuRecordsPage, error) {
	return sku_info.SkuRecordsPage{Items: []sku_info.SkuRecordItem{s.item}, Page: 1, PageSize: 10, HasNext: false}, nil
}
func (s *stage2ASkuStore) GetProjectIDsBySkuIDs(_ context.Context, ids []int64) (map[int64]int64, error) {
	res := make(map[int64]int64, len(ids))
	for _, id := range ids {
		res[id] = 1
	}
	return res, nil
}
func (s *stage2ASkuStore) GetSkuRecord(_ context.Context, _ int64) (*sku_info.SkuRecordItem, error) {
	return &s.item, nil
}
func (s *stage2ASkuStore) CreateOrUpdateSkuRecord(_ context.Context, _ sku_info.SkuRecordCreate, _ string) (sku_info.SkuRecordItem, string, error) {
	if s.createErr != nil {
		return sku_info.SkuRecordItem{}, "", s.createErr
	}
	return s.item, "created", nil
}
func (s *stage2ASkuStore) BulkCreateOrUpdateSkuRecords(_ context.Context, _ sku_info.SkuRecordBulkCreate, _ string) (sku_info.SkuRecordBulkUpsertResponse, error) {
	return sku_info.SkuRecordBulkUpsertResponse{Inserted: 1, Total: 1}, nil
}
func (s *stage2ASkuStore) UpdateSkuRecord(_ context.Context, _ int64, _ sku_info.SkuRecordUpdate, _ string) (*sku_info.SkuRecordItem, error) {
	return &s.item, nil
}
func (s *stage2ASkuStore) DeleteSkuRecord(_ context.Context, _ int64) (bool, error) { return true, nil }
func (s *stage2ASkuStore) MoveSkuRecord(_ context.Context, _ int64, _ string) (*sku_info.SkuRecordItem, error) {
	return &s.item, nil
}
func (s *stage2ASkuStore) RecalculateFirstLegCosts(_ context.Context, _ sku_info.SkuRecordFirstLegRecalculateRequest) (int, error) {
	return 1, nil
}
func (s *stage2ASkuStore) SyncFirstLegFromShipment(_ context.Context, _, _ string) (int, error) {
	return 1, nil
}
func (s *stage2ASkuStore) BatchUpdateFactoryInfo(_ context.Context, req sku_info.BatchUpdateFactoryInfoRequest, _ string) (int, []int64, error) {
	return len(req.SKUIDs), req.SKUIDs, nil
}
func (s *stage2ASkuStore) BatchUpdateListingCopy(_ context.Context, req sku_info.BatchUpdateListingCopyRequest, _ string) (int, int, []int64, error) {
	return len(req.Items), 0, []int64{1}, nil
}
func (s *stage2ASkuStore) GetFnskuLabelsBySkus(_ context.Context, _ string, _ []string) ([]sku_info.SkuRecordFnskuLabelItem, error) {
	return []sku_info.SkuRecordFnskuLabelItem{{ID: 1, SKU: "SKU1"}}, nil
}
func (s *stage2ASkuStore) ExportCSV(_ context.Context, _ sku_info.SkuFilter) (string, []byte, error) {
	return "sku.csv", []byte("sku\n"), nil
}
func (s *stage2ASkuStore) ImportCSV(_ context.Context, _ string, _ []byte, _ string) (sku_info.SkuRecordImportResponse, error) {
	return sku_info.SkuRecordImportResponse{Inserted: 1, Total: 1}, nil
}

func TestStage2AOrderAndSkuWireContracts(t *testing.T) {
	orderStore := &stage2AOrderInfoStore{
		item: order_info.OrderInfoItem{
			ID:                 101,
			ProjectID:          1,
			ProjectName:        "北美",
			AmazonOrderID:      "111-2222222-3333333",
			OrderStatus:        "Shipped",
			FulfillmentChannel: "Amazon",
			FulfillmentLabel:   "FBA（亚马逊配送）",
			Country:            "US",
		},
	}
	skuStore := &stage2ASkuStore{
		item: sku_info.SkuRecordItem{
			ID:          1,
			ProjectName: "北美",
			SKU:         "TEST-SKU",
			ASIN:        "B000TEST",
			Country:     "US",
			Currency:    "CNY",
			IsActive:    true,
		},
	}

	auditor := &stage2AAuditor{}
	router := chi.NewRouter()
	order_info.NewRegistrar(orderStore, auditor).RegisterRoutes(router, contractPassthrough)
	sku_info.NewRegistrar(skuStore, auditor).RegisterRoutes(router, contractPassthrough)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test order page wire contract
	req := httptest.NewRequest(http.MethodGet, "/api/v1/order-info/page", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var pageData order_info.OrderInfoPageData
	if err := json.Unmarshal(rec.Body.Bytes(), &pageData); err != nil {
		t.Fatalf("failed to unmarshal page data: %v", err)
	}
	if len(pageData.Items) != 1 || pageData.Items[0].AmazonOrderID != "111-2222222-3333333" {
		t.Fatalf("unexpected order in page data")
	}

	// Test SKU list wire contract
	req = httptest.NewRequest(http.MethodGet, "/api/v1/sku-info", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var skuPage sku_info.SkuRecordsPage
	if err := json.Unmarshal(rec.Body.Bytes(), &skuPage); err != nil {
		t.Fatalf("failed to unmarshal sku page: %v", err)
	}
	if len(skuPage.Items) != 1 || skuPage.Items[0].SKU != "TEST-SKU" {
		t.Fatalf("unexpected sku in sku page")
	}

	// Test product-costs alias
	req = httptest.NewRequest(http.MethodGet, "/api/v1/product-costs", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test batch update listing copy
	copyBody, _ := json.Marshal(sku_info.BatchUpdateListingCopyRequest{
		Items: []sku_info.BatchUpdateListingCopyItem{{ID: 1, ListingTitle: &pageData.Items[0].AmazonOrderID}},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/batch-update-listing-copy", bytes.NewReader(copyBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test Order update wire contract and audit logging
	updateOrderBody, _ := json.Marshal(order_info.OrderInfoUpdate{Carrier: &pageData.Items[0].AmazonOrderID})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/order-info/101", bytes.NewReader(updateOrderBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on order patch, got %d", rec.Code)
	}

	// Test Order cross-project permission check (forbidden returns 403)
	orderStore.updateErr = errors.New("403: 无权限编辑该项目下的订单")
	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "op1",
		Operator: "regular_op",
		IsAdmin:  false,
	})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/order-info/101", bytes.NewReader(updateOrderBody)).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for cross-project order update, got %d: %s", rec.Code, rec.Body.String())
	}
	orderStore.updateErr = nil

	// Test SKU create with missing project returns 404
	skuStore.createErr = errors.New("404: 项目不存在: MissingProject")
	createSkuBody, _ := json.Marshal(sku_info.SkuRecordCreate{
		ProjectName: "MissingProject",
		SKU:         "SKU-TEST",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info", bytes.NewReader(createSkuBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing project on sku create, got %d: %s", rec.Code, rec.Body.String())
	}
	skuStore.createErr = nil
}
