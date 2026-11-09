package sku_info

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"

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

type mockSkuStore struct {
	item           SkuRecordItem
	createErr      error
	bulkErr        error
	importCSVCalls int
	importCSVBytes []byte
}

func (m *mockSkuStore) ListSkuRecords(_ context.Context, _ SkuFilter) (SkuRecordsPage, error) {
	return SkuRecordsPage{
		Items:    []SkuRecordItem{m.item},
		Page:     1,
		PageSize: 10,
		Total:    ptrInt(1),
		HasNext:  false,
	}, nil
}
func (m *mockSkuStore) GetProjectIDsBySkuIDs(_ context.Context, ids []int64) (map[int64]int64, error) {
	res := make(map[int64]int64, len(ids))
	for _, id := range ids {
		res[id] = 1
	}
	return res, nil
}
func (m *mockSkuStore) GetSkuRecord(_ context.Context, _ int64) (*SkuRecordItem, error) {
	return &m.item, nil
}
func (m *mockSkuStore) CreateOrUpdateSkuRecord(_ context.Context, _ SkuRecordCreate, _ string) (SkuRecordItem, string, error) {
	if m.createErr != nil {
		return SkuRecordItem{}, "", m.createErr
	}
	return m.item, "created", nil
}
func (m *mockSkuStore) BulkCreateOrUpdateSkuRecords(_ context.Context, _ SkuRecordBulkCreate, _ string) (SkuRecordBulkUpsertResponse, error) {
	if m.bulkErr != nil {
		return SkuRecordBulkUpsertResponse{}, m.bulkErr
	}
	return SkuRecordBulkUpsertResponse{Inserted: 1, Total: 1}, nil
}
func (m *mockSkuStore) UpdateSkuRecord(_ context.Context, _ int64, _ SkuRecordUpdate, _ string) (*SkuRecordItem, error) {
	return &m.item, nil
}
func (m *mockSkuStore) DeleteSkuRecord(_ context.Context, _ int64) (bool, error) {
	return true, nil
}
func (m *mockSkuStore) MoveSkuRecord(_ context.Context, _ int64, _ string) (*SkuRecordItem, error) {
	return &m.item, nil
}
func (m *mockSkuStore) RecalculateFirstLegCosts(_ context.Context, _ SkuRecordFirstLegRecalculateRequest) (int, error) {
	return 1, nil
}
func (m *mockSkuStore) SyncFirstLegFromShipment(_ context.Context, _, _ string) (int, error) {
	return 1, nil
}
func (m *mockSkuStore) BatchUpdateFactoryInfo(_ context.Context, req BatchUpdateFactoryInfoRequest, _ string) (int, []int64, error) {
	return len(req.SKUIDs), req.SKUIDs, nil
}
func (m *mockSkuStore) BatchUpdateListingCopy(_ context.Context, req BatchUpdateListingCopyRequest, _ string) (int, int, []int64, error) {
	ids := make([]int64, len(req.Items))
	for i, it := range req.Items {
		ids[i] = it.ID
	}
	return len(req.Items), 0, ids, nil
}
func (m *mockSkuStore) GetFnskuLabelsBySkus(_ context.Context, _ string, skus []string) ([]SkuRecordFnskuLabelItem, error) {
	return []SkuRecordFnskuLabelItem{{ID: 1, SKU: "SKU1"}}, nil
}
func (m *mockSkuStore) ExportCSV(_ context.Context, _ SkuFilter) (string, []byte, error) {
	return "sku_info.csv", []byte("sku,asin\nSKU1,ASIN1\n"), nil
}
func (m *mockSkuStore) ImportCSV(_ context.Context, _ string, data []byte, _ string) (SkuRecordImportResponse, error) {
	m.importCSVCalls++
	m.importCSVBytes = data
	return SkuRecordImportResponse{Inserted: 1, Total: 1}, nil
}

func ptrInt(i int) *int { return &i }

func TestSkuInfoHandler(t *testing.T) {
	auditor := &mockAuditor{}
	store := &mockSkuStore{
		item: SkuRecordItem{
			ID:          1,
			ProjectName: "ProjectA",
			SKU:         "SKU1",
			ASIN:        "ASIN1",
			Country:     "US",
			Currency:    "CNY",
			IsActive:    true,
		},
	}
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test 1: List /sku-info
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sku-info?project_name=ProjectA", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 2: List /product-costs
	req = httptest.NewRequest(http.MethodGet, "/api/v1/product-costs", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 3: Create /sku-info with audit
	createBody, _ := json.Marshal(SkuRecordCreate{
		ProjectName: "ProjectA",
		SKU:         "SKU1",
		ASIN:        "ASIN1",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info", bytes.NewReader(createBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.create" {
		t.Fatalf("expected audit for sku_info.create")
	}

	// Test 4: Create with missing project returns 404
	store.createErr = errors.New("404: 项目不存在: MissingProject")
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info", bytes.NewReader(createBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing project, got %d", rec.Code)
	}
	store.createErr = nil

	// Test 5: Bulk create with audit
	bulkBody, _ := json.Marshal(SkuRecordBulkCreate{
		Items: []SkuRecordCreate{{ProjectName: "ProjectA", SKU: "SKU1", ASIN: "ASIN1"}},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/bulk", bytes.NewReader(bulkBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.bulk_upsert" {
		t.Fatalf("expected audit for sku_info.bulk_upsert")
	}

	// Test 6: Bulk create with missing project returns 404
	store.bulkErr = errors.New("404: 项目不存在: BadProject")
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/bulk", bytes.NewReader(bulkBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing project in bulk, got %d", rec.Code)
	}
	store.bulkErr = nil

	// Test 7: Patch /sku-info/{id} with audit
	patchBody, _ := json.Marshal(SkuRecordUpdate{
		ProductName: ptrString("Updated"),
	})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/sku-info/1", bytes.NewReader(patchBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.update" {
		t.Fatalf("expected audit for sku_info.update")
	}

	// Test 8: Delete /sku-info/{id} with audit
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/sku-info/1", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.delete" {
		t.Fatalf("expected audit for sku_info.delete")
	}

	// Test 9: Move /sku-info/{id}/move with audit
	moveBody, _ := json.Marshal(SkuRecordSortMove{Direction: "up"})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/1/move", bytes.NewReader(moveBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.move_sort" {
		t.Fatalf("expected audit for sku_info.move_sort")
	}

	// Test 10: Batch update factory info with audit
	factoryBody, _ := json.Marshal(BatchUpdateFactoryInfoRequest{
		SKUIDs:         []int64{1},
		SkuFactoryInfo: map[string]string{"factory": "Fab1"},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/batch-update-factory-info", bytes.NewReader(factoryBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.batch_update_factory_info" {
		t.Fatalf("expected audit for sku_info.batch_update_factory_info")
	}

	// Test 11: Batch update listing copy with audit
	copyBody, _ := json.Marshal(BatchUpdateListingCopyRequest{
		Items: []BatchUpdateListingCopyItem{{ID: 1, ListingTitle: ptrString("New Title")}},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/batch-update-listing-copy", bytes.NewReader(copyBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.batch_update_listing_copy" {
		t.Fatalf("expected audit for sku_info.batch_update_listing_copy")
	}

	// Test 12: Recalculate first leg costs with audit
	recalcBody, _ := json.Marshal(SkuRecordFirstLegRecalculateRequest{
		ProjectName:       "ProjectA",
		UnitPricePerKgRMB: 15.5,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/recalculate-first-leg-costs", bytes.NewReader(recalcBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.recalculate_first_leg_costs" {
		t.Fatalf("expected audit for sku_info.recalculate_first_leg_costs")
	}

	// Test 13: Import CSV with audit
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	part, _ := w.CreateFormFile("file", "test.csv")
	_, _ = io.WriteString(part, "id,sku,asin\n1,SKU1,ASIN1\n")
	_ = w.WriteField("project_name", "ProjectA")
	_ = w.Close()

	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/import-csv", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "sku_info.import_csv" {
		t.Fatalf("expected audit for sku_info.import_csv")
	}
}

func ptrString(s string) *string { return &s }

type mockSkuProjectReader struct {
	proj projects.ProjectItem
}

func (m *mockSkuProjectReader) GetProject(_ context.Context, id int64) (*projects.ProjectItem, error) {
	return &m.proj, nil
}
func (m *mockSkuProjectReader) GetProjectByName(_ context.Context, name string) (*projects.ProjectItem, error) {
	return &m.proj, nil
}
func (m *mockSkuProjectReader) ListManage(_ context.Context, _ string, _ bool, _ bool) ([]projects.ProjectItem, error) {
	return []projects.ProjectItem{m.proj}, nil
}

func TestSkuInfoProjectPermissions(t *testing.T) {
	auditor := &mockAuditor{}
	store := &mockSkuStore{
		item: SkuRecordItem{
			ID:          1,
			ProjectID:   10,
			ProjectName: "ProjectSecret",
			SKU:         "SKU1",
			ASIN:        "ASIN1",
			Country:     "US",
			Currency:    "CNY",
			IsActive:    true,
		},
	}
	projReader := &mockSkuProjectReader{
		proj: projects.ProjectItem{
			ID:              10,
			Name:            "ProjectSecret",
			ProjectOperator: ptrString("alice"),
		},
	}
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor, projReader)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	// unauthorized user "bob"
	unauthorizedCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "bob_user",
		Operator: "bob",
		IsAdmin:  false,
	})

	// 1. Update SKU should return 403
	updateBody := `{"sku": "NEW-SKU"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/sku-info/1", strings.NewReader(updateBody)).WithContext(unauthorizedCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized sku update, got %d", rec.Code)
	}

	// 2. Delete SKU should return 403
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/sku-info/1", nil).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized sku delete, got %d", rec.Code)
	}

	// 3. Move SKU should return 403
	moveBody := `{"direction": "up"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/1/move", strings.NewReader(moveBody)).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized sku move, got %d", rec.Code)
	}

	// 4. Batch update factory info should return 403
	factoryBody := `{"sku_ids": [1], "sku_factory_info": {"material": "steel"}}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/batch-update-factory-info", strings.NewReader(factoryBody)).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized batch factory update, got %d", rec.Code)
	}

	// 5. Batch update listing copy should return 403
	copyBody := `{"items": [{"id": 1, "listing_title": "Title"}]}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/batch-update-listing-copy", strings.NewReader(copyBody)).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized batch listing update, got %d", rec.Code)
	}

	// 6. Recalculate first leg costs should return 403
	recalcBody := `{"project_name": "ProjectSecret", "unit_price_per_kg_rmb": 12.5}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/recalculate-first-leg-costs", strings.NewReader(recalcBody)).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized first leg recalculate, got %d", rec.Code)
	}

	// 7. FNSKU labels by skus should return 403
	fnskuBody := `{"project_name": "ProjectSecret", "skus": ["SKU1"]}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/fnsku-labels/by-skus", strings.NewReader(fnskuBody)).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized fnsku labels query, got %d", rec.Code)
	}

	// 8. Bulk create SKU records should return 403 for unauthorized project
	bulkBody := `{"items": [{"project_name": "ProjectSecret", "sku": "NEW-SKU", "asin": "NEW-ASIN"}]}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/bulk", strings.NewReader(bulkBody)).WithContext(unauthorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized bulk create, got %d", rec.Code)
	}

	// Authorized user "alice" succeeds
	authorizedCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "alice_user",
		Operator: "alice",
		IsAdmin:  false,
	})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/sku-info/1", strings.NewReader(updateBody)).WithContext(authorizedCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for authorized sku update, got %d", rec.Code)
	}
}

func TestSkuInfoImportCSVAcceptsWithinUploadLimit(t *testing.T) {
	auditor := &mockAuditor{}
	store := &mockSkuStore{item: SkuRecordItem{ID: 1, ProjectName: "ProjectA", SKU: "SKU1"}}
	router := chi.NewRouter()
	NewRegistrar(store, auditor).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	const csv = "sku,asin\nSKU1,ASIN1\n"
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "sku.csv")
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if _, err := io.WriteString(part, csv); err != nil {
		t.Fatalf("write file part error = %v", err)
	}
	if err := writer.WriteField("project_name", "ProjectA"); err != nil {
		t.Fatalf("WriteField() error = %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("multipart close error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/import-csv", &body).WithContext(adminCtxFor(t))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.importCSVCalls != 1 || string(store.importCSVBytes) != csv {
		t.Fatalf("ImportCSV() calls/bytes = (%d, %q), want the uploaded CSV payload", store.importCSVCalls, store.importCSVBytes)
	}
}

func TestSkuInfoImportCSVRejectsOversizedUpload(t *testing.T) {
	auditor := &mockAuditor{}
	store := &mockSkuStore{item: SkuRecordItem{ID: 1, ProjectName: "ProjectA", SKU: "SKU1"}}
	router := chi.NewRouter()
	NewRegistrar(store, auditor).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "huge.csv")
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if _, err := io.WriteString(part, strings.Repeat("x", int(maxSKUImportBytes)+1)); err != nil {
		t.Fatalf("write oversized file part error = %v", err)
	}
	if err := writer.WriteField("project_name", "ProjectA"); err != nil {
		t.Fatalf("WriteField() error = %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("multipart close error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/sku-info/import-csv", &body).WithContext(adminCtxFor(t))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode 413 body: %v (body = %s)", err, rec.Body.String())
	}
	if payload.Detail != skuImportTooLargeDetail {
		t.Fatalf("detail = %q, want %q", payload.Detail, skuImportTooLargeDetail)
	}
	if store.importCSVCalls != 0 {
		t.Fatalf("ImportCSV() calls = %d, want 0 for an oversized upload", store.importCSVCalls)
	}
	if len(auditor.entries) != 0 {
		t.Fatalf("oversized upload was audited: %#v", auditor.entries)
	}
}

func adminCtxFor(t *testing.T) context.Context {
	t.Helper()
	return auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})
}
