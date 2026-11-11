package users

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestListUsesPaginationAndSerializesSnakeCaseTimestamps(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	store := &fakeStore{
		listRows: []User{{
			ID:        "user-123",
			Name:      "operator",
			Email:     "person@example.com",
			FullName:  testStringPointer("Person Name"),
			IsActive:  true,
			RoleType:  "operator",
			CreatedAt: createdAt,
			UpdatedAt: createdAt,
		}},
		total: 11,
	}
	req := adminRequest(http.MethodGet, "/api/v1/system-management/users?page=2&page_size=5", "")
	rec := httptest.NewRecorder()

	NewHandler(store, audit.NewMockService()).List(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.page != 2 || store.pageSize != 5 {
		t.Errorf("pagination = (%d, %d), want (2, 5)", store.page, store.pageSize)
	}
	want := `{"items":[{"id":"user-123","name":"operator","email":"person@example.com","full_name":"Person Name","is_admin":false,"is_active":true,"role_type":"operator","created_at":"2026-10-01T02:03:04.123000Z","updated_at":"2026-10-01T02:03:04.123000Z"}]}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}

func TestListRequiresAdmin(t *testing.T) {
	store := &fakeStore{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/users", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "user-1"}))
	rec := httptest.NewRecorder()

	NewHandler(store, audit.NewMockService()).List(rec, req)

	assertResponse(t, rec, http.StatusForbidden, `{"detail":"需要管理员权限"}`)
	if store.listCalls != 0 {
		t.Errorf("List() calls = %d, want 0", store.listCalls)
	}
}

func TestCreateValidatesAndAuditsUser(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	store := &fakeStore{created: &User{
		ID:        "user-123",
		Name:      "operator",
		Email:     "person@example.com",
		FullName:  testStringPointer("Person Name"),
		IsActive:  true,
		RoleType:  "operator",
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}}
	auditor := audit.NewMockService()
	req := adminRequest(
		http.MethodPost,
		"/api/v1/system-management/users",
		`{"name":" operator ","email":" Person@Example.com ","full_name":" Person Name ","password":"correct horse","role_type":"operator"}`,
	)
	rec := httptest.NewRecorder()

	NewHandler(store, auditor).Create(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	if store.createInput.Name != "operator" || store.createInput.Email != "person@example.com" ||
		store.createInput.FullName == nil || *store.createInput.FullName != "Person Name" ||
		store.createInput.Password != "correct horse" {
		t.Errorf("Create() input = %#v, want normalized user input", store.createInput)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "users.create" {
		t.Errorf("audit entries = %#v, want users.create", auditor.Entries)
	}
	if strings.Contains(rec.Body.String(), "password") || strings.Contains(rec.Body.String(), "password_hash") {
		t.Errorf("response leaks password data: %s", rec.Body.String())
	}
}

func TestCreateRejectsShortPasswordBeforeStoreCall(t *testing.T) {
	store := &fakeStore{}
	req := adminRequest(
		http.MethodPost,
		"/api/v1/system-management/users",
		`{"name":"operator","email":"person@example.com","password":"short"}`,
	)
	rec := httptest.NewRecorder()

	NewHandler(store, audit.NewMockService()).Create(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body = %s", rec.Code, rec.Body.String())
	}
	if store.createCalls != 0 {
		t.Errorf("Create() calls = %d, want 0", store.createCalls)
	}
}

func TestUpdateSynchronizesRoleAndAdminFlag(t *testing.T) {
	store := &fakeStore{
		user: &User{ID: "user-123", Name: "operator", Email: "person@example.com", IsActive: true, RoleType: "operator"},
		updated: &User{
			ID:       "user-123",
			Name:     "admin",
			Email:    "person@example.com",
			IsAdmin:  true,
			IsActive: true,
			RoleType: "admin",
		},
	}
	auditor := audit.NewMockService()
	req := adminRequest(
		http.MethodPatch,
		"/api/v1/system-management/users/user-123",
		`{"name":" admin ","role_type":"admin"}`,
	)
	req = withURLParam(req, "user_id", "user-123")
	rec := httptest.NewRecorder()

	NewHandler(store, auditor).Update(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.updateInput.Name == nil || *store.updateInput.Name != "admin" ||
		store.updateInput.RoleType == nil || *store.updateInput.RoleType != "admin" ||
		store.updateInput.IsAdmin == nil || !*store.updateInput.IsAdmin {
		t.Errorf("Update() input = %#v, want normalized admin role and flag", store.updateInput)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "users.update" {
		t.Errorf("audit entries = %#v, want users.update", auditor.Entries)
	}
}

func TestUpdateRejectsEmptyPasswordBeforeStoreCall(t *testing.T) {
	store := &fakeStore{user: &User{
		ID:       "user-123",
		Name:     "operator",
		Email:    "person@example.com",
		IsActive: true,
	}}
	req := adminRequest(
		http.MethodPatch,
		"/api/v1/system-management/users/user-123",
		`{"password":""}`,
	)
	req = withURLParam(req, "user_id", "user-123")
	rec := httptest.NewRecorder()

	NewHandler(store, audit.NewMockService()).Update(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body = %s", rec.Code, rec.Body.String())
	}
	if store.updateCalls != 0 {
		t.Errorf("Update() calls = %d, want 0", store.updateCalls)
	}
}

func TestDeleteDeactivatesUserAndAudits(t *testing.T) {
	store := &fakeStore{
		user:        &User{ID: "user-123", Name: "operator", Email: "person@example.com", IsActive: true},
		deactivated: &User{ID: "user-123", Name: "operator", Email: "person@example.com", IsActive: false},
	}
	auditor := audit.NewMockService()
	req := adminRequest(http.MethodDelete, "/api/v1/system-management/users/user-123", "")
	req = withURLParam(req, "user_id", "user-123")
	rec := httptest.NewRecorder()

	NewHandler(store, auditor).Delete(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rec.Code, rec.Body.String())
	}
	if !store.deactivateCalled {
		t.Error("Deactivate() was not called")
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "users.delete" {
		t.Errorf("audit entries = %#v, want users.delete", auditor.Entries)
	}
}

func TestDeleteProtectsYaweiAccount(t *testing.T) {
	store := &fakeStore{user: &User{ID: "user-123", Name: "Yawei", Email: "yawei@example.com", IsActive: true}}
	req := adminRequest(http.MethodDelete, "/api/v1/system-management/users/user-123", "")
	req = withURLParam(req, "user_id", "user-123")
	rec := httptest.NewRecorder()

	NewHandler(store, audit.NewMockService()).Delete(rec, req)

	assertResponse(t, rec, http.StatusForbidden, `{"detail":"Yawei 账号不允许删除"}`)
	if store.deactivateCalled {
		t.Error("Deactivate() called for protected account")
	}
}

type fakeStore struct {
	listRows         []User
	total            int
	page             int
	pageSize         int
	listCalls        int
	user             *User
	created          *User
	updated          *User
	deactivated      *User
	createInput      CreateInput
	createCalls      int
	updateInput      UpdateInput
	updateCalls      int
	deactivateCalled bool
	err              error
}

func (s *fakeStore) List(_ context.Context, page, pageSize int) ([]User, int, error) {
	s.listCalls++
	s.page = page
	s.pageSize = pageSize
	return s.listRows, s.total, s.err
}

func (s *fakeStore) GetByID(context.Context, string) (*User, error) {
	return s.user, s.err
}

func (s *fakeStore) Create(_ context.Context, input CreateInput) (*User, error) {
	s.createCalls++
	s.createInput = input
	return s.created, s.err
}

func (s *fakeStore) Update(_ context.Context, _ string, input UpdateInput) (*User, error) {
	s.updateCalls++
	s.updateInput = input
	return s.updated, s.err
}

func (s *fakeStore) Deactivate(context.Context, string) (*User, error) {
	s.deactivateCalled = true
	return s.deactivated, s.err
}

func adminRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	return req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{
		UserID:   "admin-1",
		Email:    "admin@example.com",
		Operator: "Admin",
		IsAdmin:  true,
	}))
}

func withURLParam(req *http.Request, key, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}

func assertResponse(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status || rec.Body.String() != body {
		t.Fatalf("response = (%d, %s), want (%d, %s)", rec.Code, rec.Body.String(), status, body)
	}
}

func testStringPointer(value string) *string {
	return &value
}

var _ Store = (*fakeStore)(nil)
