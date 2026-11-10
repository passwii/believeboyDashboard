package internal_keys

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestListAPIKeysRequiresAdminAndReturnsNoSecrets(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	store := &fakeStore{apiKeys: []APIKey{{
		ID:            7,
		KeyPrefix:     "bbx_12345678",
		Label:         "agent",
		Scope:         "read",
		ProjectScope:  "*",
		BusinessScope: "*",
		IsRevoked:     false,
		CreatedAt:     createdAt,
	}}}
	req := adminRequest(http.MethodGet, "/api/v1/internal/api-keys", "")
	rec := httptest.NewRecorder()

	NewHandler(store, audit.NewMockService()).ListAPIKeys(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	want := `[{"id":7,"key_prefix":"bbx_12345678","label":"agent","scope":"read","project_scope":"*","business_scope":"*","agent_id":null,"item_key":null,"is_revoked":false,"expires_at":null,"created_at":"2026-10-01T02:03:04.123000Z","last_used_at":null,"deleted_at":null}]`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
	if strings.Contains(rec.Body.String(), "key_hash") || strings.Contains(rec.Body.String(), "plaintext_key") {
		t.Errorf("list response exposes key material: %s", rec.Body.String())
	}

	unauthorized := httptest.NewRecorder()
	NewHandler(&fakeStore{}, audit.NewMockService()).ListAPIKeys(
		unauthorized,
		httptest.NewRequest(http.MethodGet, "/api/v1/internal/api-keys", nil),
	)
	assertResponse(t, unauthorized, http.StatusForbidden, `{"detail":"需要管理员权限"}`)
}

func TestCreateAPIKeyReturnsPlaintextOnceAndAudits(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	store := &fakeStore{createdAPIKey: &APIKey{
		ID:            9,
		KeyPrefix:     "bbx_abcd1234",
		Label:         "daily agent",
		Scope:         "read",
		ProjectScope:  "1,2",
		BusinessScope: "reports",
		CreatedAt:     createdAt,
	}}
	auditor := audit.NewMockService()
	req := adminRequest(
		http.MethodPost,
		"/api/v1/internal/api-keys",
		`{"label":" daily agent ","scope":"read","project_scope":"1,2","business_scope":"reports"}`,
	)
	rec := httptest.NewRecorder()

	NewHandler(store, auditor).CreateAPIKey(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	if store.createAPIKeyInput.Label != "daily agent" ||
		store.createAPIKeyInput.ProjectScope != "1,2" ||
		store.createAPIKeyOperator != "Admin" {
		t.Errorf("CreateAPIKey() = %#v operator %q, want normalized payload and operator", store.createAPIKeyInput, store.createAPIKeyOperator)
	}
	if !strings.Contains(rec.Body.String(), `"plaintext_key":"bbx_once_only"`) {
		t.Errorf("create response omits one-time key: %s", rec.Body.String())
	}
	if !store.createAPIKeyAudited || !store.createAPIKeyCommitted {
		t.Errorf("CreateAPIKey() did not run the transactional insert+audit path: %#v", store)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "api_key.create" {
		t.Errorf("audit entries = %#v, want api_key.create", auditor.Entries)
	}
}

func TestCreateAPIKeyMapsProvisioningSingletonConflictToConflictStatus(t *testing.T) {
	store := &fakeStore{createAPIKeyWithAuditErr: ErrAPIKeyConflict}
	auditor := audit.NewMockService()
	req := adminRequest(
		http.MethodPost,
		"/api/v1/internal/api-keys",
		`{"label":"agent","business_scope":"agent_provisioning"}`,
	)
	rec := httptest.NewRecorder()

	NewHandler(store, auditor).CreateAPIKey(rec, req)

	assertResponse(t, rec, http.StatusConflict, `{"detail":"`+provisioningSingletonConflictMessage+`"}`)
	if !store.createAPIKeyAudited {
		t.Errorf("CreateAPIKey() bypassed the transactional store")
	}
	if store.createAPIKeyCommitted {
		t.Errorf("CreateAPIKey() committed despite the provisioning singleton conflict")
	}
	if len(auditor.Entries) != 0 {
		t.Errorf("audit entries = %#v, want none for a rejected create", auditor.Entries)
	}
	if strings.Contains(rec.Body.String(), "plaintext_key") {
		t.Errorf("conflict response leaked a plaintext key: %s", rec.Body.String())
	}
}

func TestCreateAPIKeyDoesNotCommitWhenAuditWriteFails(t *testing.T) {
	store := &fakeStore{createdAPIKey: &APIKey{
		ID:            9,
		KeyPrefix:     "bbx_abcd1234",
		Label:         "daily agent",
		Scope:         "read",
		ProjectScope:  "*",
		BusinessScope: "*",
		CreatedAt:     time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC),
	}}
	auditor := failingAPIKeyAuditor{}
	req := adminRequest(http.MethodPost, "/api/v1/internal/api-keys", `{"label":"daily agent"}`)
	rec := httptest.NewRecorder()

	NewHandler(store, auditor).CreateAPIKey(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body = %s", rec.Code, rec.Body.String())
	}
	if store.createAPIKeyCommitted {
		t.Fatal("CreateAPIKey() committed a key even though the audit write failed")
	}
	if !store.createAPIKeyAuditFailed {
		t.Fatal("CreateAPIKey() never attempted the in-transaction audit write")
	}
	if strings.Contains(rec.Body.String(), "plaintext_key") {
		t.Errorf("failed create response leaked a plaintext key: %s", rec.Body.String())
	}
}

func TestDeleteAPIKeySoftDeletes(t *testing.T) {
	store := &fakeStore{deletedAPIKey: &APIKey{ID: 9, KeyPrefix: "bbx_abcd1234"}}
	auditor := audit.NewMockService()
	req := adminRequest(http.MethodDelete, "/api/v1/internal/api-keys/9", "")
	req = withURLParam(req, "key_id", "9")
	rec := httptest.NewRecorder()

	NewHandler(store, auditor).DeleteAPIKey(rec, req)

	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("response = (%d, %s), want empty 204", rec.Code, rec.Body.String())
	}
	if store.deleteAPIKeyID != 9 {
		t.Errorf("DeleteAPIKey() id = %d, want 9", store.deleteAPIKeyID)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "api_key.delete" {
		t.Errorf("audit entries = %#v, want api_key.delete", auditor.Entries)
	}
}

func TestAPIKeyStatusEndpointsAreAuditedAndRejectDeletedKeys(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		method func(*Handler, http.ResponseWriter, *http.Request)
		action string
		active bool
	}{
		{name: "revoke", method: (*Handler).RevokeAPIKey, action: "api_key.revoke", active: false},
		{name: "deactivate", method: (*Handler).DeactivateAPIKey, action: "api_key.deactivate", active: false},
		{name: "activate", method: (*Handler).ActivateAPIKey, action: "api_key.activate", active: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			store := &fakeStore{}
			auditor := audit.NewMockService()
			if testCase.active {
				store.activatedAPIKey = &APIKey{ID: 9}
			} else {
				store.revokedAPIKey = &APIKey{ID: 9, IsRevoked: true}
			}
			req := adminRequest(http.MethodPost, "/api/v1/internal/api-keys/9/"+testCase.name, "")
			req = withURLParam(req, "key_id", "9")
			rec := httptest.NewRecorder()

			testCase.method(NewHandler(store, auditor), rec, req)

			assertResponse(t, rec, http.StatusOK, `{"id":9,"is_revoked":`+strconv.FormatBool(!testCase.active)+`}`)
			if len(auditor.Entries) != 1 || auditor.Entries[0].Action != testCase.action {
				t.Fatalf("audit = %#v, want %s", auditor.Entries, testCase.action)
			}
		})
	}

	missing := &fakeStore{}
	req := adminRequest(http.MethodPost, "/api/v1/internal/api-keys/9/revoke", "")
	req = withURLParam(req, "key_id", "9")
	rec := httptest.NewRecorder()
	NewHandler(missing, audit.NewMockService()).RevokeAPIKey(rec, req)
	assertResponse(t, rec, http.StatusNotFound, `{"detail":"API key not found"}`)
}

func TestUserAPIKeyCRUDUsesRevocationAndSafeFields(t *testing.T) {
	t.Run("list", func(t *testing.T) {
		createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
		store := &fakeStore{userAPIKeys: []UserAPIKey{{
			ID:        5,
			UserID:    "user-123",
			ClientID:  "mac-install-a",
			KeyPrefix: "blf_12345678",
			CreatedAt: &createdAt,
		}}}
		req := adminRequest(http.MethodGet, "/api/v1/internal/user-api-keys", "")
		rec := httptest.NewRecorder()

		NewHandler(store, audit.NewMockService()).ListUserAPIKeys(rec, req)

		assertResponse(t, rec, http.StatusOK, `[{"id":5,"user_id":"user-123","client_id":"mac-install-a","key_prefix":"blf_12345678","revoked_at":null,"created_at":"2026-10-01T02:03:04Z"}]`)
		if strings.Contains(rec.Body.String(), "key_hash") {
			t.Errorf("list response exposes key hash: %s", rec.Body.String())
		}
	})

	t.Run("create", func(t *testing.T) {
		store := &fakeStore{createdUserAPIKey: &UserAPIKey{
			ID: 8, UserID: "user-123", ClientID: "mac-install-a", KeyPrefix: "blf_12345678",
		}}
		auditor := audit.NewMockService()
		req := adminRequest(
			http.MethodPost,
			"/api/v1/internal/user-api-keys",
			`{"user_id":"user-123","client_id":"mac-install-a"}`,
		)
		rec := httptest.NewRecorder()

		NewHandler(store, auditor).CreateUserAPIKey(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
		}
		if store.createUserID != "user-123" || store.createClientID != "mac-install-a" {
			t.Errorf("CreateUserAPIKey() args = (%q, %q), want requested user and slot", store.createUserID, store.createClientID)
		}
		if !strings.Contains(rec.Body.String(), `"plaintext_key":"blf_once_only"`) {
			t.Errorf("create response omits one-time key: %s", rec.Body.String())
		}
		if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "user_api_key.create" {
			t.Errorf("audit entries = %#v, want user_api_key.create", auditor.Entries)
		}
	})

	t.Run("delete revokes", func(t *testing.T) {
		store := &fakeStore{deletedUserAPIKey: &UserAPIKey{
			ID: 8, UserID: "user-123", ClientID: "mac-install-a", KeyPrefix: "blf_12345678",
		}}
		auditor := audit.NewMockService()
		req := adminRequest(http.MethodDelete, "/api/v1/internal/user-api-keys/8", "")
		req = withURLParam(req, "key_id", "8")
		rec := httptest.NewRecorder()

		NewHandler(store, auditor).DeleteUserAPIKey(rec, req)

		if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
			t.Fatalf("response = (%d, %s), want empty 204", rec.Code, rec.Body.String())
		}
		if store.deleteUserAPIKeyID != 8 {
			t.Errorf("DeleteUserAPIKey() id = %d, want 8", store.deleteUserAPIKeyID)
		}
		if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "user_api_key.revoke" {
			t.Errorf("audit entries = %#v, want user_api_key.revoke", auditor.Entries)
		}
	})
}

func TestRotateUserAPIKeyDefaultsToAllDeviceSlotsAndReturnsNotFoundWhenMissing(t *testing.T) {
	t.Run("not found", func(t *testing.T) {
		store := &fakeStore{}
		req := adminRequest(
			http.MethodPost,
			"/api/v1/internal/user-api-keys/user-123/rotate",
			"",
		)
		req = withURLParam(req, "user_id", "user-123")
		rec := httptest.NewRecorder()

		NewHandler(store, audit.NewMockService()).RotateUserAPIKey(rec, req)

		assertResponse(t, rec, http.StatusNotFound, `{"detail":"User API key not found"}`)
		if store.rotateClientID != nil {
			t.Errorf("RotateUserAPIKey() client id = %q, want nil for all devices", *store.rotateClientID)
		}
	})
}

type fakeStore struct {
	apiKeys                  []APIKey
	createdAPIKey            *APIKey
	deletedAPIKey            *APIKey
	revokedAPIKey            *APIKey
	activatedAPIKey          *APIKey
	userAPIKeys              []UserAPIKey
	createdUserAPIKey        *UserAPIKey
	deletedUserAPIKey        *UserAPIKey
	rotatedUserAPIKey        *UserAPIKey
	rotateClientID           *string
	createAPIKeyInput        APIKeyCreateInput
	createAPIKeyOperator     string
	createAPIKeyWithAuditErr error
	createAPIKeyAudited      bool
	createAPIKeyCommitted    bool
	createAPIKeyAuditFailed  bool
	deleteAPIKeyID           int64
	createUserID             string
	createClientID           string
	deleteUserAPIKeyID       int64
	err                      error
}

// failingAPIKeyAuditor simulates an audit backend outage; the handler must not
// return a created key when this fires inside the create transaction.
type failingAPIKeyAuditor struct{}

func (failingAPIKeyAuditor) LogAction(context.Context, audit.Entry) error {
	return errors.New("audit backend unavailable")
}

func (failingAPIKeyAuditor) LogActionTx(context.Context, pgx.Tx, audit.Entry) error {
	return errors.New("audit backend unavailable")
}

func (failingAPIKeyAuditor) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

func (s *fakeStore) CreateAPIKeyWithAudit(
	ctx context.Context,
	input APIKeyCreateInput,
	operator string,
	auditor audit.Service,
	entryFor func(*APIKey) audit.Entry,
) (*APIKey, string, error) {
	s.createAPIKeyAudited = true
	s.createAPIKeyInput = input
	s.createAPIKeyOperator = operator
	if s.createAPIKeyWithAuditErr != nil {
		return nil, "", s.createAPIKeyWithAuditErr
	}
	if s.err != nil || s.createdAPIKey == nil {
		return s.createdAPIKey, "bbx_once_only", s.err
	}
	if auditor != nil && entryFor != nil {
		if err := auditor.LogActionTx(ctx, nil, entryFor(s.createdAPIKey)); err != nil {
			s.createAPIKeyAuditFailed = true
			return nil, "", err
		}
	}
	s.createAPIKeyCommitted = true
	return s.createdAPIKey, "bbx_once_only", nil
}

func (s *fakeStore) ListAPIKeys(context.Context, bool) ([]APIKey, error) {
	return s.apiKeys, s.err
}

func (s *fakeStore) CreateAPIKey(_ context.Context, input APIKeyCreateInput, operator string) (*APIKey, string, error) {
	s.createAPIKeyInput = input
	s.createAPIKeyOperator = operator
	return s.createdAPIKey, "bbx_once_only", s.err
}

func (s *fakeStore) DeleteAPIKey(_ context.Context, id int64) (*APIKey, error) {
	s.deleteAPIKeyID = id
	return s.deletedAPIKey, s.err
}

func (s *fakeStore) RevokeAPIKey(context.Context, int64) (*APIKey, error) {
	return s.revokedAPIKey, s.err
}

func (s *fakeStore) ActivateAPIKey(context.Context, int64) (*APIKey, error) {
	return s.activatedAPIKey, s.err
}

func (s *fakeStore) ListUserAPIKeys(context.Context) ([]UserAPIKey, error) {
	return s.userAPIKeys, s.err
}

func (s *fakeStore) CreateUserAPIKey(_ context.Context, userID, clientID string) (*UserAPIKey, string, error) {
	s.createUserID = userID
	s.createClientID = clientID
	return s.createdUserAPIKey, "blf_once_only", s.err
}

func (s *fakeStore) DeleteUserAPIKey(_ context.Context, id int64) (*UserAPIKey, error) {
	s.deleteUserAPIKeyID = id
	return s.deletedUserAPIKey, s.err
}

func (s *fakeStore) RevokeUserAPIKeys(context.Context, string, *string) ([]UserAPIKey, error) {
	return s.userAPIKeys, s.err
}

func (s *fakeStore) RotateUserAPIKey(_ context.Context, _ string, clientID *string) (*UserAPIKey, string, error) {
	s.rotateClientID = clientID
	return s.rotatedUserAPIKey, "blf_rotated_once", s.err
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

var _ Store = (*fakeStore)(nil)
