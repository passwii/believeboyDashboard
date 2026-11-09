package complaints

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

type mockComplaintStore struct {
	detail      ComplaintDetail
	accessError error
}

func (m *mockComplaintStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return m.accessError
}
func (m *mockComplaintStore) GetOverview(_ context.Context, date string, _ *string) (OverviewResponse, error) {
	return OverviewResponse{Date: date, Metrics: OverviewMetrics{TotalNeedsReply: 1}}, nil
}
func (m *mockComplaintStore) ListComplaints(_ context.Context, _ ComplaintFilter) (ComplaintListResponse, error) {
	return ComplaintListResponse{
		Items:    []ComplaintListItem{m.detail.ComplaintListItem},
		Total:    1,
		Page:     1,
		PageSize: 20,
	}, nil
}
func (m *mockComplaintStore) GetComplaint(_ context.Context, id int64) (*ComplaintDetail, error) {
	if id == m.detail.ID {
		return &m.detail, nil
	}
	return nil, nil
}
func (m *mockComplaintStore) PatchComplaint(_ context.Context, _ int64, req ComplaintPatchRequest, _ string) (*ComplaintDetail, error) {
	if req.Status != nil {
		m.detail.Status = *req.Status
	}
	if req.DraftPath != nil {
		m.detail.DraftPath = req.DraftPath
	}
	if req.ReplySentAt != nil {
		m.detail.ReplySentAt = req.ReplySentAt
	}
	if req.HandlerNote != nil {
		m.detail.HandlerNote = req.HandlerNote
	}
	return &m.detail, nil
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

func TestComplaintsHandler(t *testing.T) {
	store := &mockComplaintStore{
		detail: ComplaintDetail{
			ComplaintListItem: ComplaintListItem{
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
	auditor := &mockAuditor{}
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test 1: overview
	req := httptest.NewRequest(http.MethodGet, "/api/v1/complaints/overview?date=2026-11-07", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 2: list
	req = httptest.NewRequest(http.MethodGet, "/api/v1/complaints", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 3: get detail
	req = httptest.NewRequest(http.MethodGet, "/api/v1/complaints/1", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Test 4: legal transition pending -> drafted
	statusDrafted := "drafted"
	body, _ := json.Marshal(ComplaintPatchRequest{Status: &statusDrafted})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/complaints/1", bytes.NewReader(body)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on legal transition, got %d", rec.Code)
	}
	if len(auditor.entries) == 0 || auditor.entries[0].Action != "complaint_center.status_change" {
		t.Fatalf("expected audit log for status change")
	}

	// Test 5: legal transition drafted -> resolved
	statusResolved := "resolved"
	body, _ = json.Marshal(ComplaintPatchRequest{Status: &statusResolved})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/complaints/1", bytes.NewReader(body)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on drafted -> resolved, got %d", rec.Code)
	}

	// Test 6: illegal transition resolved -> pending must return 400
	statusPending := "pending"
	body, _ = json.Marshal(ComplaintPatchRequest{Status: &statusPending})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/complaints/1", bytes.NewReader(body)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on illegal transition, got %d", rec.Code)
	}

	// Test 7: non-admin forbidden project access returns 403
	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "user_bob",
		Operator: "bob",
		IsAdmin:  false,
	})
	store.accessError = ErrProjectForbidden

	req = httptest.NewRequest(http.MethodGet, "/api/v1/complaints?project_id=1", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on forbidden project list, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/complaints/1", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on forbidden complaint detail, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/v1/complaints/1", bytes.NewReader(body)).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on forbidden complaint patch, got %d", rec.Code)
	}
}

type errorComplaintStore struct {
	mockComplaintStore
	patchErr error
}

func (e *errorComplaintStore) PatchComplaint(_ context.Context, _ int64, _ ComplaintPatchRequest, _ string) (*ComplaintDetail, error) {
	return nil, e.patchErr
}

func TestComplaintHandlerConcurrentConflictAndBadTime(t *testing.T) {
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// 1. Conflict 409
	store409 := &errorComplaintStore{
		mockComplaintStore: mockComplaintStore{
			detail: ComplaintDetail{
				ComplaintListItem: ComplaintListItem{ID: 1, ProjectID: 1, Status: "pending"},
			},
		},
		patchErr: errors.New("409: 客诉状态已被并发修改，请刷新后重试"),
	}
	router := chi.NewRouter()
	NewRegistrar(store409, &mockAuditor{}).RegisterRoutes(router, func(n http.Handler) http.Handler { return n })

	body, _ := json.Marshal(ComplaintPatchRequest{Status: ptrString("drafted")})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/complaints/1", bytes.NewReader(body)).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Bad time format 400
	store400 := &errorComplaintStore{
		mockComplaintStore: mockComplaintStore{
			detail: ComplaintDetail{
				ComplaintListItem: ComplaintListItem{ID: 1, ProjectID: 1, Status: "pending"},
			},
		},
		patchErr: errors.New("400: reply_sent_at 时间格式无效: bad_date"),
	}
	router = chi.NewRouter()
	NewRegistrar(store400, &mockAuditor{}).RegisterRoutes(router, func(n http.Handler) http.Handler { return n })

	body, _ = json.Marshal(ComplaintPatchRequest{ReplySentAt: ptrString("bad_date")})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/complaints/1", bytes.NewReader(body)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d: %s", rec.Code, rec.Body.String())
	}
}

func ptrString(s string) *string { return &s }
