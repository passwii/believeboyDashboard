package vat_invoices

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockVatStore struct {
	verifyErr error
	vatErr    error
	entity    *VatEntityResponse
	entities  []VatEntityResponse
	invoice   *VatInvoiceResponse
	invoices  []VatInvoiceListItem
	pdfResp   *VatInvoicePdfUploadResponse
	voidResp  *VatInvoiceResponse

	getEntityErr  error
	upsertErr     error
	updateErr     error
	deleteErr     error
	getInvoiceErr error
	createInvErr  error
	attachPdfErr  error
	voidInvErr    error
}

func (m *mockVatStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return m.verifyErr
}
func (m *mockVatStore) EnsureVatEnabled(_ context.Context, _ int64) error {
	return m.vatErr
}
func (m *mockVatStore) ListEntities(_ context.Context, _ int64) ([]VatEntityResponse, error) {
	return m.entities, nil
}
func (m *mockVatStore) UpsertEntity(_ context.Context, payload VatEntityCreate) (*VatEntityResponse, error) {
	if m.upsertErr != nil {
		return nil, m.upsertErr
	}
	return &VatEntityResponse{
		VatEntityBase: payload.VatEntityBase,
		ID:            1,
		ProjectID:     payload.ProjectID,
		CreatedAt:     "2026-11-08T00:00:00Z",
		UpdatedAt:     "2026-11-08T00:00:00Z",
	}, nil
}
func (m *mockVatStore) UpdateEntity(_ context.Context, entityID int64, _ VatEntityUpdate) (*VatEntityResponse, error) {
	if m.updateErr != nil {
		return nil, m.updateErr
	}
	return &VatEntityResponse{
		ID:        entityID,
		ProjectID: 1,
		VatEntityBase: VatEntityBase{
			Country:     "DE",
			CompanyName: "Updated Corp",
		},
	}, nil
}
func (m *mockVatStore) DeleteEntity(_ context.Context, _ int64) error {
	return m.deleteErr
}
func (m *mockVatStore) GetEntity(_ context.Context, _ int64) (*VatEntityResponse, error) {
	if m.getEntityErr != nil {
		return nil, m.getEntityErr
	}
	return m.entity, nil
}
func (m *mockVatStore) ListInvoices(_ context.Context, _ VatInvoiceFilter) ([]VatInvoiceListItem, error) {
	return m.invoices, nil
}
func (m *mockVatStore) GetInvoice(_ context.Context, _ int64) (*VatInvoiceResponse, error) {
	if m.getInvoiceErr != nil {
		return nil, m.getInvoiceErr
	}
	return m.invoice, nil
}
func (m *mockVatStore) CreateInvoice(_ context.Context, payload VatInvoiceCreate, createdBy string) (*VatInvoiceResponse, error) {
	if m.createInvErr != nil {
		return nil, m.createInvErr
	}
	return &VatInvoiceResponse{
		ID:        10,
		InvoiceNo: "INV-TEST-2026-000010",
		ProjectID: payload.ProjectID,
		Currency:  payload.Currency,
		OrderID:   payload.OrderID,
		TotalIncl: "119.00",
		Status:    "draft",
		CreatedBy: &createdBy,
		CreatedAt: "2026-11-08T00:00:00Z",
		UpdatedAt: "2026-11-08T00:00:00Z",
		Lines:     []VatInvoiceLineResponse{},
	}, nil
}
func (m *mockVatStore) AttachInvoicePdf(_ context.Context, invoiceID int64, filename string, _ []byte) (*VatInvoicePdfUploadResponse, error) {
	if m.attachPdfErr != nil {
		return nil, m.attachPdfErr
	}
	return m.pdfResp, nil
}
func (m *mockVatStore) VoidInvoice(_ context.Context, invoiceID int64, reason string) (*VatInvoiceResponse, error) {
	if m.voidInvErr != nil {
		return nil, m.voidInvErr
	}
	return m.voidResp, nil
}

type mockVatAuditor struct {
	logged []audit.Entry
}

func (a *mockVatAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.logged = append(a.logged, entry)
	return nil
}
func (a *mockVatAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.logged = append(a.logged, entry)
	return nil
}
func (a *mockVatAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func setupVatRouter(store Store, auditor audit.Service) chi.Router {
	r := chi.NewRouter()
	registrar := NewRegistrar(store, auditor)
	registrar.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestVatEntitiesCRUD(t *testing.T) {
	auditor := &mockVatAuditor{}
	store := &mockVatStore{
		entity: &VatEntityResponse{
			ID:        1,
			ProjectID: 10,
			VatEntityBase: VatEntityBase{
				Country:     "DE",
				CompanyName: "Test Co",
			},
		},
		entities: []VatEntityResponse{
			{ID: 1, ProjectID: 10, VatEntityBase: VatEntityBase{Country: "DE", CompanyName: "Test Co"}},
		},
	}
	router := setupVatRouter(store, auditor)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "admin_op", IsAdmin: true})

	// 1. List
	req := httptest.NewRequest(http.MethodGet, "/api/v1/vat-entities?project_id=10", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 2. Create
	createPayload := VatEntityCreate{
		ProjectID: 10,
		VatEntityBase: VatEntityBase{
			Country:     "DE",
			CompanyName: "New Co",
		},
	}
	b, _ := json.Marshal(createPayload)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/vat-entities", bytes.NewReader(b)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.logged) != 1 || auditor.logged[0].Action != "vat_entities.upsert" {
		t.Fatalf("expected vat_entities.upsert, got %+v", auditor.logged)
	}

	// 3. Update
	name := "Updated Name"
	updatePayload := VatEntityUpdate{CompanyName: &name}
	b, _ = json.Marshal(updatePayload)
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/vat-entities/1", bytes.NewReader(b)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.logged) != 2 || auditor.logged[1].Action != "vat_entities.update" {
		t.Fatalf("expected vat_entities.update, got %+v", auditor.logged)
	}

	// 4. Delete
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/vat-entities/1", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if len(auditor.logged) != 3 || auditor.logged[2].Action != "vat_entities.delete" {
		t.Fatalf("expected vat_entities.delete, got %+v", auditor.logged)
	}
}

func TestVatInvoicesOperations(t *testing.T) {
	auditor := &mockVatAuditor{}
	pdfURL := "https://r2/invoice.pdf"
	store := &mockVatStore{
		invoice: &VatInvoiceResponse{
			ID:        10,
			InvoiceNo: "INV-10",
			ProjectID: 10,
			TotalIncl: "119.00",
			R2URL:     &pdfURL,
			Status:    "issued",
		},
		pdfResp: &VatInvoicePdfUploadResponse{
			ID:        10,
			InvoiceNo: "INV-10",
			R2Key:     "pdf-key",
			R2URL:     pdfURL,
			Status:    "issued",
		},
		voidResp: &VatInvoiceResponse{
			ID:         10,
			InvoiceNo:  "INV-10",
			ProjectID:  10,
			Status:     "voided",
			VoidReason: &pdfURL,
		},
	}
	router := setupVatRouter(store, auditor)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "admin_op", IsAdmin: true})

	// 1. Create Invoice
	createPayload := VatInvoiceCreate{
		ProjectID:   10,
		Currency:    "EUR",
		OrderID:     "123-456",
		InvoiceDate: "2026-11-08",
		Buyer:       VatBuyerIn{Name: "Buyer A"},
		Lines: []VatInvoiceLineIn{
			{Description: "Item 1", ASIN: "B001", Qty: 1, UnitPriceInclVat: 119.0, VatRate: 19.0},
		},
	}
	b, _ := json.Marshal(createPayload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/vat-invoices", bytes.NewReader(b)).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Upload PDF
	pdfPayload := VatInvoicePdfUploadRequest{
		PdfBase64: base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 test")),
		Filename:  "invoice.pdf",
	}
	b, _ = json.Marshal(pdfPayload)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/vat-invoices/10/pdf", bytes.NewReader(b)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. Get PDF Redirect
	req = httptest.NewRequest(http.MethodGet, "/api/v1/vat-invoices/10/pdf", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("expected 302 redirect, got %d", rec.Code)
	}

	// 4. Void Invoice
	voidPayload := VatInvoiceVoidRequest{Reason: "Customer cancel"}
	b, _ = json.Marshal(voidPayload)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/vat-invoices/10/void", bytes.NewReader(b)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}
