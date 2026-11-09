package order_info

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
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockAuditor struct {
	entries []audit.Entry
}

func (m *mockAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	m.entries = append(m.entries, entry)
	return nil
}
func (m *mockAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	m.entries = append(m.entries, entry)
	return nil
}
func (m *mockAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

type mockOrderInfoStore struct {
	pageData     OrderInfoPageData
	listResponse OrderInfoListResponse
	stats        OrderInfoStats
	overview     OrderInfoOverview
	filterOpts   OrderInfoFilterOptions
	liveStream   []OrderLiveStreamItem
	exportFile   string
	exportBytes  []byte
	item         *OrderInfoItem
	updateErr    error
}

func (m *mockOrderInfoStore) GetPageData(_ context.Context, _ OrderInfoFilter) (OrderInfoPageData, error) {
	return m.pageData, nil
}
func (m *mockOrderInfoStore) ListOrders(_ context.Context, _ OrderInfoFilter) (OrderInfoListResponse, error) {
	return m.listResponse, nil
}
func (m *mockOrderInfoStore) ComputeStats(_ context.Context, _ OrderInfoFilter) (OrderInfoStats, error) {
	return m.stats, nil
}
func (m *mockOrderInfoStore) GetOverview(_ context.Context, _ OrderInfoFilter) (OrderInfoOverview, error) {
	return m.overview, nil
}
func (m *mockOrderInfoStore) CollectFilterOptions(_ context.Context, _ string, _ bool) (OrderInfoFilterOptions, error) {
	return m.filterOpts, nil
}
func (m *mockOrderInfoStore) QueryLiveStream(_ context.Context, _ []int64, _ []string, _ int, _ string, _ bool) ([]OrderLiveStreamItem, error) {
	return m.liveStream, nil
}
func (m *mockOrderInfoStore) ExportOrders(_ context.Context, _ OrderInfoFilter) (string, []byte, error) {
	return m.exportFile, m.exportBytes, nil
}
func (m *mockOrderInfoStore) GetOrderByID(_ context.Context, _ int64) (*OrderInfoItem, error) {
	return m.item, nil
}
func (m *mockOrderInfoStore) UpdateOrderByID(_ context.Context, _ int64, _ OrderInfoUpdate, _ string, _ bool) (*OrderInfoItem, error) {
	if m.updateErr != nil {
		return nil, m.updateErr
	}
	return m.item, nil
}

func TestOrderInfoHandler(t *testing.T) {
	auditor := &mockAuditor{}
	store := &mockOrderInfoStore{
		item: &OrderInfoItem{
			ID:                 101,
			ProjectID:          1,
			ProjectName:        "Test Project",
			AmazonOrderID:      "111-2222222-3333333",
			OrderStatus:        "Shipped",
			FulfillmentChannel: "Amazon",
			FulfillmentLabel:   "FBA（亚马逊配送）",
			Country:            "US",
		},
		exportFile:  "orders.csv",
		exportBytes: []byte("header\ndata\n"),
	}
	handler := NewHandler(store, auditor)
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test 1: Page
	req := httptest.NewRequest(http.MethodGet, "/api/v1/order-info/page", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 2: List
	req = httptest.NewRequest(http.MethodGet, "/api/v1/order-info/list", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 3: Stats
	req = httptest.NewRequest(http.MethodGet, "/api/v1/order-info/stats", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 4: Overview
	req = httptest.NewRequest(http.MethodGet, "/api/v1/order-info/overview", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 5: Filter options
	req = httptest.NewRequest(http.MethodGet, "/api/v1/order-info/filter-options", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 6: Live stream
	req = httptest.NewRequest(http.MethodGet, "/api/v1/order-info/live-stream", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 7: Export
	reqBody, _ := json.Marshal(OrderInfoExportRequest{
		ProjectIDs: []int64{1},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/order-info/export", bytes.NewReader(reqBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 8: Patch order with audit logging
	patchBody, _ := json.Marshal(OrderInfoUpdate{
		Carrier: ptrString("FedEx"),
	})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/order-info/101", bytes.NewReader(patchBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "order_info.update" {
		t.Fatalf("expected audit log for order_info.update, got %v", auditor.entries)
	}

	// Test 9: Operator header missing when non-admin
	nonAdminNoOp := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:  "user1",
		IsAdmin: false,
	})
	req = httptest.NewRequest(http.MethodGet, "/api/v1/order-info/page", nil).WithContext(nonAdminNoOp)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Test 10: Non-admin update forbidden on cross-project order
	store.updateErr = errors.New("403: 无权限编辑该项目下的订单")
	nonAdminWithOp := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user1",
		Operator: "alice",
		IsAdmin:  false,
	})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/order-info/101", bytes.NewReader(patchBody)).WithContext(nonAdminWithOp)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden, got %d: %s", rec.Code, rec.Body.String())
	}

	_ = handler
}

func ptrString(s string) *string {
	return &s
}
