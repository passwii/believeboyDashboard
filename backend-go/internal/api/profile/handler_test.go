package profile

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestGetProfileRequiresUserHeader(t *testing.T) {
	store := &fakeStore{}
	rec := httptest.NewRecorder()

	NewHandler(store).GetProfile(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil),
	)

	assertDetail(t, rec, http.StatusUnauthorized, "Not authenticated")
	if store.getUserID != "" {
		t.Errorf("store called with user id %q, want no call", store.getUserID)
	}
}

func TestGetProfileDecodesUserHeaderAndReturnsResponseShape(t *testing.T) {
	passwordChangedAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	createdAt := time.Date(2026, 9, 1, 2, 3, 4, 123000000, time.UTC)
	updatedAt := createdAt.Add(time.Hour)
	store := &fakeStore{row: &Profile{
		ID:                "user-123",
		Email:             "person@example.com",
		Name:              "operator",
		FullName:          stringPtr("运营 A"),
		IsAdmin:           true,
		IsActive:          true,
		RoleType:          "admin",
		AvatarURL:         stringPtr("https://example.com/avatar.webp"),
		PasswordChangedAt: &passwordChangedAt,
		CreatedAt:         &createdAt,
		UpdatedAt:         &updatedAt,
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req.Header.Set("X-User-Id", url.PathEscape("user-123"))
	rec := httptest.NewRecorder()

	NewHandler(store).GetProfile(rec, withRequestIdentity(req))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.getUserID != "user-123" {
		t.Errorf("store user id = %q, want user-123", store.getUserID)
	}
	var got profileResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID != "user-123" || got.Email != "person@example.com" ||
		got.Name != "operator" || got.FullName == nil || *got.FullName != "运营 A" ||
		!got.IsAdmin || !got.IsActive || got.RoleType != "admin" {
		t.Errorf("response = %#v, want persisted profile", got)
	}
	if got.PasswordChangedAt == nil || *got.PasswordChangedAt != "2026-10-01T02:03:04+00:00" {
		t.Errorf("password_changed_at = %#v, want ISO-8601", got.PasswordChangedAt)
	}
	if got.CreatedAt == nil || *got.CreatedAt != "2026-09-01T02:03:04.123000+00:00" {
		t.Errorf("created_at = %#v, want ISO-8601 microseconds", got.CreatedAt)
	}
}

func TestGetProfileUsesAuthenticatedContextInsteadOfForgedHeader(t *testing.T) {
	store := &fakeStore{row: &Profile{ID: "authoritative-user", Email: "owner@example.com", Name: "owner"}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "authoritative-user"}))
	req.Header.Set("X-User-Id", "victim-user")
	rec := httptest.NewRecorder()

	NewHandler(store).GetProfile(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.getUserID != "authoritative-user" {
		t.Errorf("store user id = %q, want authenticated context user", store.getUserID)
	}
}

func TestGetProfileFallsBackRoleFromAdminFlag(t *testing.T) {
	store := &fakeStore{row: &Profile{
		ID:       "user-456",
		Email:    "admin@example.com",
		Name:     "admin",
		IsAdmin:  true,
		IsActive: true,
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req.Header.Set("X-User-Id", "user-456")
	rec := httptest.NewRecorder()

	NewHandler(store).GetProfile(rec, withRequestIdentity(req))

	var got profileResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.RoleType != "admin" {
		t.Errorf("role_type = %q, want admin fallback", got.RoleType)
	}
}

func TestGetProfileUnknownUserReturns404(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req.Header.Set("X-User-Id", "00000000-0000-0000-0000-000000000000")
	rec := httptest.NewRecorder()

	NewHandler(&fakeStore{}).GetProfile(rec, withRequestIdentity(req))

	assertDetail(t, rec, http.StatusNotFound, "User not found")
}

func TestGetProfileDecodesBase64UserID(t *testing.T) {
	store := &fakeStore{row: &Profile{ID: "user-123", Email: "u@example.com", Name: "u"}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req.Header.Set("X-User-Id", base64.StdEncoding.EncodeToString([]byte("user-123")))
	rec := httptest.NewRecorder()

	NewHandler(store).GetProfile(rec, withRequestIdentity(req))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.getUserID != "user-123" {
		t.Errorf("store user id = %q, want Base64-decoded user-123", store.getUserID)
	}
}

func TestGetProfileDecodesURLEncodedUnicodeAndCapsUserID(t *testing.T) {
	store := &fakeStore{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req.Header.Set("X-User-Id", url.PathEscape("用户 123"))
	rec := httptest.NewRecorder()

	NewHandler(store).GetProfile(rec, withRequestIdentity(req))

	if store.getUserID != "用户 123" {
		t.Errorf("store user id = %q, want URL-decoded Unicode", store.getUserID)
	}

	longID := strings.Repeat("用", 70)
	store.getUserID = ""
	req = httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req.Header.Set("X-User-Id", longID)
	rec = httptest.NewRecorder()
	NewHandler(store).GetProfile(rec, withRequestIdentity(req))
	if got := store.getUserID; got != strings.Repeat("用", 64) {
		t.Errorf("capped user id = %q, want Python-style first 64 code points", got)
	}
	if !utf8.ValidString(store.getUserID) {
		t.Errorf("capped user id is invalid UTF-8: %q", store.getUserID)
	}
}

func TestGetProfileStoreErrorReturns500(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req.Header.Set("X-User-Id", "user-123")
	rec := httptest.NewRecorder()

	NewHandler(&fakeStore{err: errors.New("database down")}).GetProfile(rec, withRequestIdentity(req))

	assertDetail(t, rec, http.StatusInternalServerError, "Internal Server Error")
}

func TestUpdateProfileUpdatesAuthenticatedUserAndClearsBlankFullName(t *testing.T) {
	store := &fakeStore{row: &Profile{
		ID:       "user-123",
		Email:    "person@example.com",
		Name:     "new-login",
		FullName: nil,
		IsActive: true,
	}}
	req := httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/system-management/profile",
		bytes.NewBufferString(`{"name":" new-login ","full_name":"   "}`),
	)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{
		UserID:   "user-123",
		Operator: "operator-a",
	}))
	req.Header.Set("X-User-Id", "victim-user")
	rec := httptest.NewRecorder()

	NewHandler(store).UpdateProfile(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.updateUserID != "user-123" {
		t.Errorf("update user id = %q, want authenticated user", store.updateUserID)
	}
	if store.updateInput.Name == nil || *store.updateInput.Name != "new-login" {
		t.Errorf("update name = %#v, want trimmed new-login", store.updateInput.Name)
	}
	if !store.updateInput.SetFullName || store.updateInput.FullName != nil {
		t.Errorf("update full_name = set:%v value:%#v, want clear", store.updateInput.SetFullName, store.updateInput.FullName)
	}
	if store.updateInput.Operator == nil || *store.updateInput.Operator != "operator-a" {
		t.Errorf("update operator = %#v, want operator-a", store.updateInput.Operator)
	}
	if store.updateInput.Request != req {
		t.Errorf("update request = %p, want original request %p", store.updateInput.Request, req)
	}
	var got profileResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID != "user-123" || got.Name != "new-login" || got.FullName != nil {
		t.Errorf("response = %#v, want updated profile", got)
	}
}

func TestUpdateProfileValidationContracts(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		status int
		detail string
	}{
		{name: "missing body", body: "", status: http.StatusUnprocessableEntity, detail: "Invalid request body"},
		{name: "invalid json", body: "{", status: http.StatusUnprocessableEntity, detail: "Invalid request body"},
		{name: "empty name", body: `{"name":""}`, status: http.StatusUnprocessableEntity},
		{name: "blank name", body: `{"name":"   "}`, status: http.StatusBadRequest, detail: "姓名不能为空"},
		{name: "long name", body: `{"name":"` + strings.Repeat("x", 256) + `"}`, status: http.StatusUnprocessableEntity},
		{name: "long full name", body: `{"full_name":"` + strings.Repeat("x", 256) + `"}`, status: http.StatusUnprocessableEntity},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(
				http.MethodPatch,
				"/api/v1/system-management/profile",
				bytes.NewBufferString(tt.body),
			)
			req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "user-123"}))
			rec := httptest.NewRecorder()
			NewHandler(&fakeStore{}).UpdateProfile(rec, req)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.status, rec.Body.String())
			}
			if tt.detail != "" &&
				rec.Body.String() != `{"detail":"`+tt.detail+`"}` {
				t.Errorf("body = %s, want detail %q", rec.Body.String(), tt.detail)
			}
		})
	}
}

func TestUpdateProfileNullFullNameDoesNotClearExistingValue(t *testing.T) {
	store := &fakeStore{row: &Profile{
		ID:       "user-123",
		Email:    "person@example.com",
		Name:     "operator",
		FullName: stringPtr("Existing"),
		IsActive: true,
	}}
	req := httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/system-management/profile",
		bytes.NewBufferString(`{"full_name":null}`),
	)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "user-123"}))
	rec := httptest.NewRecorder()

	NewHandler(store).UpdateProfile(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.updateInput.SetFullName {
		t.Error("explicit null full_name must behave like FastAPI None and leave the field unchanged")
	}
}

func TestUpdateProfileRequiresAuthenticatedContext(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/system-management/profile",
		bytes.NewBufferString(`{"name":"new-login"}`),
	)
	req.Header.Set("X-User-Id", "forged-user")
	rec := httptest.NewRecorder()
	NewHandler(&fakeStore{}).UpdateProfile(rec, req)
	assertDetail(t, rec, http.StatusUnauthorized, "Not authenticated")
}

func assertDetail(t *testing.T, rec *httptest.ResponseRecorder, status int, detail string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, status, rec.Body.String())
	}
	if got, want := rec.Body.String(), `{"detail":"`+detail+`"}`; got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}

type fakeStore struct {
	row          *Profile
	err          error
	getUserID    string
	updateUserID string
	updateInput  UpdateInput
	updateErr    error
}

func withRequestIdentity(req *http.Request) *http.Request {
	return req.WithContext(auth.WithUserContext(req.Context(), auth.UserContextFromRequest(req)))
}

func (s *fakeStore) GetByUserID(_ context.Context, userID string) (*Profile, error) {
	s.getUserID = userID
	return s.row, s.err
}

func (s *fakeStore) UpdateByUserID(
	_ context.Context,
	userID string,
	input UpdateInput,
) (*Profile, error) {
	s.updateUserID = userID
	s.updateInput = input
	return s.row, s.updateErr
}

func stringPtr(value string) *string {
	return &value
}
