package profile

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
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

	NewHandler(store).GetProfile(rec, req)

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

	NewHandler(store).GetProfile(rec, req)

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

	NewHandler(&fakeStore{}).GetProfile(rec, req)

	assertDetail(t, rec, http.StatusNotFound, "User not found")
}

func TestGetProfileStoreErrorReturns500(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	req.Header.Set("X-User-Id", "user-123")
	rec := httptest.NewRecorder()

	NewHandler(&fakeStore{err: errors.New("database down")}).GetProfile(rec, req)

	assertDetail(t, rec, http.StatusInternalServerError, "Internal Server Error")
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
	row       *Profile
	err       error
	getUserID string
}

func (s *fakeStore) GetByUserID(_ context.Context, userID string) (*Profile, error) {
	s.getUserID = userID
	return s.row, s.err
}

func stringPtr(value string) *string {
	return &value
}
