package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestLoginReturnsAccountSessionAndUserAPIKey(t *testing.T) {
	account := &Account{
		ID:       "user-123",
		Name:     "operator",
		Email:    "person@example.com",
		FullName: stringPointer("Person Name"),
		IsAdmin:  true,
		IsActive: true,
		RoleType: "admin",
	}
	store := &fakeStore{account: account, valid: true, apiKey: "blf_secret"}
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/auth/login",
		strings.NewReader(`{"email":" Person@Example.com ","password":"correct horse"}`),
	)
	req.Header.Set("X-Client-Id", "mac-install-a")
	rec := httptest.NewRecorder()

	NewHandler(store).Login(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.loginEmail != "person@example.com" || store.loginPassword != "correct horse" ||
		store.issuedUserID != "user-123" || store.issuedClientID != "mac-install-a" {
		t.Errorf("store calls = %#v, want normalized credentials and selected client slot", store)
	}
	var got LoginResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID != "user-123" || got.Name != "operator" || got.Email != "person@example.com" ||
		got.FullName == nil || *got.FullName != "Person Name" || !got.IsAdmin ||
		!got.IsActive || got.RoleType != "admin" || got.SessionID == "" ||
		got.APIKey != "blf_secret" {
		t.Errorf("login response = %#v, want account with issued session and key", got)
	}
	if strings.Contains(rec.Body.String(), "password_hash") {
		t.Errorf("response leaks password hash: %s", rec.Body.String())
	}
}

func TestLoginReturnsSameInvalidCredentialsForMissingAndWrongPassword(t *testing.T) {
	tests := []struct {
		name  string
		store *fakeStore
	}{
		{name: "missing account", store: &fakeStore{}},
		{name: "wrong password", store: &fakeStore{account: &Account{ID: "user-123"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(
				http.MethodPost,
				"/api/v1/auth/login",
				strings.NewReader(`{"email":"person@example.com","password":"wrong"}`),
			)
			rec := httptest.NewRecorder()

			NewHandler(tt.store).Login(rec, req)

			assertResponse(
				t,
				rec,
				http.StatusUnauthorized,
				`{"detail":"Incorrect email or password","code":"INVALID_CREDENTIALS"}`,
			)
			if tt.store.issuedUserID != "" {
				t.Errorf("IssueUserAPIKey() called for invalid credentials: %#v", tt.store)
			}
		})
	}
}

func TestLoginRejectsDisabledAccountAndInvalidClientID(t *testing.T) {
	t.Run("disabled account", func(t *testing.T) {
		store := &fakeStore{
			account: &Account{ID: "user-123", IsActive: false},
			valid:   true,
		}
		req := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/auth/login",
			strings.NewReader(`{"email":"person@example.com","password":"correct horse"}`),
		)
		rec := httptest.NewRecorder()

		NewHandler(store).Login(rec, req)

		assertResponse(t, rec, http.StatusUnauthorized, `{"detail":"Account disabled","code":"ACCOUNT_DISABLED"}`)
		if store.issuedUserID != "" {
			t.Errorf("IssueUserAPIKey() called for disabled account: %#v", store)
		}
	})

	t.Run("invalid client id", func(t *testing.T) {
		store := &fakeStore{account: &Account{ID: "user-123", IsActive: true}, valid: true}
		req := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/auth/login",
			strings.NewReader(`{"email":"person@example.com","password":"correct horse"}`),
		)
		req.Header.Set("X-Client-Id", "bad client")
		rec := httptest.NewRecorder()

		NewHandler(store).Login(rec, req)

		assertResponse(t, rec, http.StatusBadRequest, `{"detail":"Invalid X-Client-Id","code":"INVALID_CLIENT_ID"}`)
		if store.issuedUserID != "" {
			t.Errorf("IssueUserAPIKey() called for invalid client id: %#v", store)
		}
	})
}

func TestMeRequiresAuthenticatedIdentityAndReturnsTimestamp(t *testing.T) {
	passwordChangedAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	store := &fakeStore{account: &Account{
		ID:                "user-123",
		Name:              "operator",
		Email:             "person@example.com",
		FullName:          stringPointer("Person Name"),
		IsAdmin:           true,
		IsActive:          true,
		RoleType:          "admin",
		PasswordChangedAt: &passwordChangedAt,
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req = req.WithContext(requestauth.WithUserContext(req.Context(), requestauth.UserContext{
		UserID: "user-123",
		Email:  "person@example.com",
	}))
	rec := httptest.NewRecorder()

	NewHandler(store).Me(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.meUserID != "user-123" || store.meEmail != "person@example.com" {
		t.Errorf("GetByIDAndEmail() args = (%q, %q), want authenticated identity", store.meUserID, store.meEmail)
	}
	want := `{"id":"user-123","email":"person@example.com","name":"operator","full_name":"Person Name","is_admin":true,"is_active":true,"role_type":"admin","password_changed_at":"2026-10-01T02:03:04.123000Z"}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}

func TestMeRejectsMissingIdentityAndDisabledAccount(t *testing.T) {
	t.Run("missing identity", func(t *testing.T) {
		store := &fakeStore{}
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		rec := httptest.NewRecorder()

		NewHandler(store).Me(rec, req)

		assertResponse(t, rec, http.StatusUnauthorized, `{"detail":"Not authenticated"}`)
		if store.meUserID != "" {
			t.Errorf("GetByIDAndEmail() called without identity: %#v", store)
		}
	})

	t.Run("disabled account", func(t *testing.T) {
		store := &fakeStore{account: &Account{ID: "user-123", IsActive: false}}
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		req = req.WithContext(requestauth.WithUserContext(req.Context(), requestauth.UserContext{
			UserID: "user-123",
			Email:  "person@example.com",
		}))
		rec := httptest.NewRecorder()

		NewHandler(store).Me(rec, req)

		assertResponse(t, rec, http.StatusUnauthorized, `{"detail":"Account disabled"}`)
	})
}

type fakeStore struct {
	account        *Account
	valid          bool
	apiKey         string
	err            error
	loginEmail     string
	loginPassword  string
	issuedUserID   string
	issuedClientID string
	meUserID       string
	meEmail        string
}

func (s *fakeStore) FindForLogin(_ context.Context, email, password string) (*Account, bool, error) {
	s.loginEmail = email
	s.loginPassword = password
	return s.account, s.valid, s.err
}

func (s *fakeStore) GetByIDAndEmail(_ context.Context, userID, email string) (*Account, error) {
	s.meUserID = userID
	s.meEmail = email
	return s.account, s.err
}

func (s *fakeStore) IssueUserAPIKey(_ context.Context, userID, clientID string) (string, error) {
	s.issuedUserID = userID
	s.issuedClientID = clientID
	return s.apiKey, s.err
}

func assertResponse(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status || rec.Body.String() != body {
		t.Fatalf("response = (%d, %s), want (%d, %s)", rec.Code, rec.Body.String(), status, body)
	}
}

func stringPointer(value string) *string {
	return &value
}

var _ Store = (*fakeStore)(nil)
