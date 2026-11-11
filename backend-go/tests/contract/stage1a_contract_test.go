package contract

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	apiauth "github.com/passwii/believeboyDashboard/backend-go/internal/api/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_keys"
	apiusers "github.com/passwii/believeboyDashboard/backend-go/internal/api/users"
	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestStage1AContractRegistersAuthUsersAndCredentialRoutes(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	account := &apiauth.Account{
		ID:       "user-123",
		Name:     "operator",
		Email:    "person@example.com",
		FullName: ptr("Person Name"),
		IsAdmin:  true,
		IsActive: true,
		RoleType: "admin",
	}
	user := apiusers.User{
		ID:        account.ID,
		Name:      account.Name,
		Email:     account.Email,
		FullName:  account.FullName,
		IsAdmin:   account.IsAdmin,
		IsActive:  account.IsActive,
		RoleType:  account.RoleType,
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}
	apiKey := internal_keys.APIKey{
		ID:            7,
		KeyPrefix:     "bbx_12345678",
		Label:         "agent",
		Scope:         "read",
		ProjectScope:  "*",
		BusinessScope: "*",
		CreatedAt:     createdAt,
	}
	userKey := internal_keys.UserAPIKey{
		ID:        8,
		UserID:    account.ID,
		ClientID:  "mac-install-a",
		KeyPrefix: "blf_12345678",
		CreatedAt: &createdAt,
	}

	router := chi.NewRouter()
	authRegistrar := apiauth.NewRegistrar(&contractStage1AAuthStore{account: account})
	usersRegistrar := apiusers.NewRegistrar(&contractStage1AUsersStore{
		user: user,
	})
	keysRegistrar := internal_keys.NewRegistrar(&contractStage1AKeysStore{
		apiKey:  apiKey,
		userKey: userKey,
	})
	if authRegistrar.ModuleName() != "auth" ||
		usersRegistrar.ModuleName() != "users" ||
		keysRegistrar.ModuleName() != "internal_keys" {
		t.Fatal("Phase 1A registrar module names do not match owned module names")
	}
	authRegistrar.RegisterRoutes(router, stage1AIdentityMiddleware)
	usersRegistrar.RegisterRoutes(router, stage1AIdentityMiddleware)
	keysRegistrar.RegisterRoutes(router, stage1AIdentityMiddleware)

	login := stage1ARequest(router, http.MethodPost, "/api/v1/auth/login",
		`{"email":"person@example.com","password":"correct horse"}`, nil)
	assertStatusAndKeys(t, login, http.StatusOK, []string{
		"id", "name", "email", "full_name", "is_admin", "is_active", "role_type", "session_id", "api_key",
	})
	var loginBody map[string]any
	if err := json.Unmarshal(login.Body.Bytes(), &loginBody); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if loginBody["id"] != account.ID || loginBody["api_key"] != "blf_contract_key" {
		t.Errorf("login response = %#v, want account id and issued API key", loginBody)
	}

	identity := requestauth.UserContext{UserID: account.ID, Email: account.Email}
	me := stage1ARequest(router, http.MethodGet, "/api/v1/auth/me", "", &identity)
	assertStatusAndKeys(t, me, http.StatusOK, []string{
		"id", "email", "name", "full_name", "is_admin", "is_active", "role_type", "password_changed_at",
	})

	usersList := stage1ARequest(
		router,
		http.MethodGet,
		"/api/v1/system-management/users?page=2&page_size=5",
		"",
		nil,
	)
	assertStatusAndKeys(t, usersList, http.StatusOK, []string{"items"})
	var usersBody apiusers.ListResponse
	if err := json.Unmarshal(usersList.Body.Bytes(), &usersBody); err != nil {
		t.Fatalf("decode users response: %v", err)
	}
	if len(usersBody.Items) != 1 || usersBody.Items[0].Email != account.Email {
		t.Errorf("users response = %#v, want paginated account", usersBody)
	}

	apiKeysList := stage1ARequest(router, http.MethodGet, "/api/v1/internal/api-keys", "", nil)
	assertArrayItemKeys(t, apiKeysList, http.StatusOK, []string{
		"id", "key_prefix", "label", "scope", "project_scope", "business_scope", "agent_id",
		"item_key", "is_revoked", "expires_at", "created_at", "last_used_at", "deleted_at",
	})
	userKeysList := stage1ARequest(router, http.MethodGet, "/api/v1/internal/user-api-keys", "", nil)
	assertArrayItemKeys(t, userKeysList, http.StatusOK, []string{
		"id", "user_id", "client_id", "key_prefix", "revoked_at", "created_at",
	})

	apiKeyCreate := stage1ARequest(
		router,
		http.MethodPost,
		"/api/v1/internal/api-keys",
		`{"label":"agent"}`,
		nil,
	)
	assertStatusAndKeys(t, apiKeyCreate, http.StatusCreated, []string{
		"id", "key_prefix", "label", "scope", "project_scope", "business_scope", "agent_id",
		"item_key", "expires_at", "created_at", "plaintext_key",
	})

	userKeyCreate := stage1ARequest(
		router,
		http.MethodPost,
		"/api/v1/internal/user-api-keys",
		`{"user_id":"user-123","client_id":"mac-install-a"}`,
		nil,
	)
	assertStatusAndKeys(t, userKeyCreate, http.StatusCreated, []string{
		"user_id", "client_id", "key_prefix", "plaintext_key",
	})

	apiKeyDelete := stage1ARequest(router, http.MethodDelete, "/api/v1/internal/api-keys/7", "", nil)
	if apiKeyDelete.Code != http.StatusNoContent {
		t.Errorf("DELETE /internal/api-keys/{id} status = %d, want 204", apiKeyDelete.Code)
	}
	userKeyDelete := stage1ARequest(router, http.MethodDelete, "/api/v1/internal/user-api-keys/8", "", nil)
	if userKeyDelete.Code != http.StatusNoContent {
		t.Errorf("DELETE /internal/user-api-keys/{id} status = %d, want 204", userKeyDelete.Code)
	}
}

type contractStage1AAuthStore struct {
	account *apiauth.Account
}

func (s *contractStage1AAuthStore) FindForLogin(context.Context, string, string) (*apiauth.Account, bool, error) {
	return s.account, s.account != nil, nil
}

func (s *contractStage1AAuthStore) GetByIDAndEmail(context.Context, string, string) (*apiauth.Account, error) {
	return s.account, nil
}

func (s *contractStage1AAuthStore) IssueUserAPIKey(context.Context, string, string) (string, error) {
	return "blf_contract_key", nil
}

type contractStage1AUsersStore struct {
	user apiusers.User
}

func (s *contractStage1AUsersStore) List(context.Context, int, int) ([]apiusers.User, int, error) {
	return []apiusers.User{s.user}, 1, nil
}

func (s *contractStage1AUsersStore) GetByID(context.Context, string) (*apiusers.User, error) {
	return &s.user, nil
}

func (s *contractStage1AUsersStore) Create(context.Context, apiusers.CreateInput) (*apiusers.User, error) {
	return &s.user, nil
}

func (s *contractStage1AUsersStore) Update(context.Context, string, apiusers.UpdateInput) (*apiusers.User, error) {
	return &s.user, nil
}

func (s *contractStage1AUsersStore) Deactivate(context.Context, string) (*apiusers.User, error) {
	s.user.IsActive = false
	return &s.user, nil
}

type contractStage1AKeysStore struct {
	apiKey  internal_keys.APIKey
	userKey internal_keys.UserAPIKey
}

func (s *contractStage1AKeysStore) ListAPIKeys(context.Context, bool) ([]internal_keys.APIKey, error) {
	return []internal_keys.APIKey{s.apiKey}, nil
}

func (s *contractStage1AKeysStore) CreateAPIKey(context.Context, internal_keys.APIKeyCreateInput, string) (*internal_keys.APIKey, string, error) {
	return &s.apiKey, "bbx_contract_key", nil
}

func (s *contractStage1AKeysStore) DeleteAPIKey(context.Context, int64) (*internal_keys.APIKey, error) {
	return &s.apiKey, nil
}

func (s *contractStage1AKeysStore) ListUserAPIKeys(context.Context) ([]internal_keys.UserAPIKey, error) {
	return []internal_keys.UserAPIKey{s.userKey}, nil
}

func (s *contractStage1AKeysStore) CreateUserAPIKey(context.Context, string, string) (*internal_keys.UserAPIKey, string, error) {
	return &s.userKey, "blf_contract_key", nil
}

func (s *contractStage1AKeysStore) DeleteUserAPIKey(context.Context, int64) (*internal_keys.UserAPIKey, error) {
	return &s.userKey, nil
}

func (s *contractStage1AKeysStore) RevokeUserAPIKeys(context.Context, string, *string) ([]internal_keys.UserAPIKey, error) {
	return []internal_keys.UserAPIKey{s.userKey}, nil
}

func (s *contractStage1AKeysStore) RotateUserAPIKey(context.Context, string, *string) (*internal_keys.UserAPIKey, string, error) {
	return &s.userKey, "blf_contract_key", nil
}

func stage1AIdentityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requestauth.UserContextFromContext(r.Context()); !ok {
			r = r.WithContext(requestauth.WithUserContext(r.Context(), requestauth.UserContext{
				UserID:   "admin-1",
				Email:    "admin@example.com",
				Operator: "Admin",
				IsAdmin:  true,
			}))
		}
		next.ServeHTTP(w, r)
	})
}

func stage1ARequest(
	router http.Handler,
	method string,
	path string,
	body string,
	identity *requestauth.UserContext,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if identity != nil {
		request = request.WithContext(requestauth.WithUserContext(request.Context(), *identity))
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func assertArrayItemKeys(t *testing.T, recorder *httptest.ResponseRecorder, status int, keys []string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, status, recorder.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode response array: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("response items = %#v, want one item", items)
	}
	for _, key := range keys {
		if _, ok := items[0][key]; !ok {
			t.Errorf("response item missing %q: %s", key, recorder.Body.String())
		}
	}
}
