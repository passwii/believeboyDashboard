package platform_revenues

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockPlatformRevenueStore struct {
	items        []PlatformRevenueItem
	total        int
	item         *PlatformRevenueItem
	countries    []string
	verifyErr    error
	getErr       error
	createErr    error
	updateErr    error
	deleteErr    error
	countriesErr error
}

func (m *mockPlatformRevenueStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return m.verifyErr
}
func (m *mockPlatformRevenueStore) AccessibleProjectIDs(_ context.Context, _ string) ([]int64, error) {
	return []int64{1}, nil
}
func (m *mockPlatformRevenueStore) ListRevenues(_ context.Context, _ PlatformRevenueFilter) ([]PlatformRevenueItem, int, error) {
	if m.verifyErr != nil {
		return nil, 0, m.verifyErr
	}
	return m.items, m.total, nil
}
func (m *mockPlatformRevenueStore) GetRevenue(_ context.Context, _ int64, _ string, _ bool) (*PlatformRevenueItem, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	return m.item, nil
}
func (m *mockPlatformRevenueStore) CreateRevenue(_ context.Context, payload PlatformRevenueCreate, _ string, _ bool) (*PlatformRevenueItem, error) {
	if m.createErr != nil {
		return nil, m.createErr
	}
	return &PlatformRevenueItem{
		ID:           101,
		ProjectID:    payload.ProjectID,
		ProjectName:  "Test Project",
		Country:      payload.Country,
		ReceivedDate: payload.ReceivedDate,
		Amount:       payload.Amount,
		Currency:     payload.Currency,
		RevenueType:  payload.RevenueType,
		CreatedBy:    "test_user",
		CreatedAt:    "2026-11-08T00:00:00Z",
		UpdatedAt:    "2026-11-08T00:00:00Z",
	}, nil
}
func (m *mockPlatformRevenueStore) UpdateRevenue(_ context.Context, revenueID int64, payload PlatformRevenueUpdate, _ string, _ bool) (*PlatformRevenueItem, error) {
	if m.updateErr != nil {
		return nil, m.updateErr
	}
	return &PlatformRevenueItem{
		ID:           revenueID,
		ProjectID:    1,
		ProjectName:  "Test Project",
		Country:      "US",
		ReceivedDate: "2026-11-08",
		Amount:       200.0,
		Currency:     "USD",
		RevenueType:  "订单回款",
		CreatedBy:    "test_user",
		CreatedAt:    "2026-11-08T00:00:00Z",
		UpdatedAt:    "2026-11-08T00:00:00Z",
	}, nil
}
func (m *mockPlatformRevenueStore) DeleteRevenue(_ context.Context, _ int64, _ string, _ bool) error {
	return m.deleteErr
}
func (m *mockPlatformRevenueStore) GetProjectCountries(_ context.Context, _ int64) ([]string, error) {
	if m.countriesErr != nil {
		return nil, m.countriesErr
	}
	return m.countries, nil
}

type mockAuditor struct {
	logged []audit.Entry
}

func (a *mockAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.logged = append(a.logged, entry)
	return nil
}
func (a *mockAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.logged = append(a.logged, entry)
	return nil
}
func (a *mockAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func setupPlatformRevenueRouter(store Store, auditor audit.Service, blobs ...BlobStore) chi.Router {
	r := chi.NewRouter()
	registrar := NewRegistrar(store, auditor)
	if len(blobs) > 0 {
		registrar.WithBlobStore(blobs[0])
	}
	registrar.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestPlatformRevenueHandlerList(t *testing.T) {
	store := &mockPlatformRevenueStore{
		items: []PlatformRevenueItem{
			{ID: 1, ProjectID: 1, ProjectName: "Project 1", Country: "US", Amount: 100.5, Currency: "USD"},
		},
		total: 1,
	}
	router := setupPlatformRevenueRouter(store, &mockAuditor{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/platform-revenues?page=1&page_size=20", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{Operator: "test", IsAdmin: true}))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp PlatformRevenueListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if resp.Total != 1 || len(resp.Items) != 1 {
		t.Fatalf("unexpected list response: %+v", resp)
	}
}

func TestPlatformRevenueHandlerGet(t *testing.T) {
	item := &PlatformRevenueItem{ID: 1, ProjectID: 1, ProjectName: "Project 1", Country: "US", Amount: 100.5}
	store := &mockPlatformRevenueStore{item: item}
	router := setupPlatformRevenueRouter(store, &mockAuditor{})

	// 1. Success
	req := httptest.NewRequest(http.MethodGet, "/api/v1/platform-revenues/1", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{Operator: "test", IsAdmin: true}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 2. 404
	store.getErr = ErrRevenueNotFound
	req = httptest.NewRequest(http.MethodGet, "/api/v1/platform-revenues/999", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{Operator: "test", IsAdmin: true}))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestPlatformRevenueHandlerCreateUpdateDelete(t *testing.T) {
	auditor := &mockAuditor{}
	store := &mockPlatformRevenueStore{
		item: &PlatformRevenueItem{ID: 101, ProjectID: 1, ProjectName: "Project 1", Country: "US", Amount: 100.5},
	}
	router := setupPlatformRevenueRouter(store, auditor)

	// 1. Create
	createPayload := PlatformRevenueCreate{
		ProjectID:    1,
		Country:      "US",
		ReceivedDate: "2026-11-08",
		Amount:       500.0,
		Currency:     "USD",
		RevenueType:  "订单回款",
	}
	bodyBytes, _ := json.Marshal(createPayload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/platform-revenues", bytes.NewReader(bodyBytes))
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{Operator: "test_op", IsAdmin: true}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.logged) != 1 || auditor.logged[0].Action != "platform_revenues.create" {
		t.Fatalf("expected create audit log, got %+v", auditor.logged)
	}

	// 2. Update
	amt := 600.0
	updatePayload := PlatformRevenueUpdate{Amount: &amt}
	bodyBytes, _ = json.Marshal(updatePayload)
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/platform-revenues/101", bytes.NewReader(bodyBytes))
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{Operator: "test_op", IsAdmin: true}))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.logged) != 2 || auditor.logged[1].Action != "platform_revenues.update" {
		t.Fatalf("expected update audit log, got %+v", auditor.logged)
	}

	// 3. Delete
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/platform-revenues/101", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{Operator: "test_op", IsAdmin: true}))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if len(auditor.logged) != 3 || auditor.logged[2].Action != "platform_revenues.delete" {
		t.Fatalf("expected delete audit log, got %+v", auditor.logged)
	}
}

func TestPlatformRevenueHandlerProjectCountries(t *testing.T) {
	store := &mockPlatformRevenueStore{
		countries: []string{"CA", "US"},
	}
	router := setupPlatformRevenueRouter(store, &mockAuditor{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/platform-revenues/project-countries/1", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{Operator: "test", IsAdmin: true}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var cResp ProjectCountriesResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &cResp)
	if len(cResp.Countries) != 2 {
		t.Fatalf("unexpected countries response: %+v", cResp)
	}
}
