package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

const testMasterKey = "master-key"

type fakeUserKeyResolver struct {
	records map[string]*UserKeyRecord
	err     error
	hashes  []string
}

func (f *fakeUserKeyResolver) ResolveUserKey(_ context.Context, keyHash string) (*UserKeyRecord, error) {
	f.hashes = append(f.hashes, keyHash)
	if f.err != nil {
		return nil, f.err
	}
	return f.records[keyHash], nil
}

func TestRequireAPIKeyAcceptsMasterKeyWithoutDatabaseLookup(t *testing.T) {
	for name, apply := range map[string]func(*http.Request){
		"x-api-key": func(req *http.Request) {
			req.Header.Set("X-API-Key", testMasterKey)
		},
		"bearer": func(req *http.Request) {
			req.Header.Set("Authorization", "Bearer "+testMasterKey)
		},
		"query": func(req *http.Request) {
			query := req.URL.Query()
			query.Set("api_key", testMasterKey)
			req.URL.RawQuery = query.Encode()
		},
	} {
		t.Run(name, func(t *testing.T) {
			resolver := &fakeUserKeyResolver{}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
			apply(req)

			rec := serveProtected(t, testMasterKey, resolver, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
			}
			if len(resolver.hashes) != 0 {
				t.Fatalf("resolver called with %q, want no database lookup", resolver.hashes)
			}
		})
	}
}

func TestRequireAPIKeyAcceptsBearerUserKeyAndHashesCandidate(t *testing.T) {
	const candidate = "blf_bearer-user-key"
	hash := sha256Hex(candidate)
	resolver := &fakeUserKeyResolver{
		records: map[string]*UserKeyRecord{
			hash: {UserID: "user-123"},
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	req.Header.Set("Authorization", "bearer "+candidate)

	rec := serveProtected(t, testMasterKey, resolver, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if len(resolver.hashes) != 1 || resolver.hashes[0] != hash {
		t.Fatalf("resolver hashes = %q, want [%s]", resolver.hashes, hash)
	}
	if resolver.hashes[0] == candidate {
		t.Fatal("resolver received the raw API key")
	}
}

func TestRequireAPIKeyFallsBackThroughCandidateOrder(t *testing.T) {
	const userKey = "blf_fallback-user-key"
	validHash := sha256Hex(userKey)
	resolver := &fakeUserKeyResolver{
		records: map[string]*UserKeyRecord{
			validHash: {UserID: "user-456"},
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health?api_key="+url.QueryEscape(userKey), nil)
	req.Header.Set("Authorization", "Bearer unknown-bearer-key")
	req.Header.Set("X-API-Key", "unknown-header-key")

	rec := serveProtected(t, testMasterKey, resolver, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	wantHashes := []string{
		sha256Hex("unknown-bearer-key"),
		sha256Hex("unknown-header-key"),
		validHash,
	}
	if len(resolver.hashes) != len(wantHashes) {
		t.Fatalf("resolver calls = %d, want %d", len(resolver.hashes), len(wantHashes))
	}
	for i := range wantHashes {
		if resolver.hashes[i] != wantHashes[i] {
			t.Errorf("resolver hash[%d] = %s, want %s", i, resolver.hashes[i], wantHashes[i])
		}
	}
}

func TestRequireAPIKeyMissingReturns401(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)

	rec := serveProtected(t, testMasterKey, &fakeUserKeyResolver{}, req)

	assertErrorResponse(t, rec, http.StatusUnauthorized, `{"detail":"Missing API key"}`)
}

func TestRequireAPIKeyInvalidReturns403(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-API-Key", "unknown-key")

	rec := serveProtected(t, testMasterKey, &fakeUserKeyResolver{}, req)

	assertErrorResponse(t, rec, http.StatusForbidden, `{"detail":"Invalid API key"}`)
}

func TestRequireAPIKeyRevokedReturns403(t *testing.T) {
	const candidate = "blf_revoked-key"
	revokedAt := time.Now()
	resolver := &fakeUserKeyResolver{
		records: map[string]*UserKeyRecord{
			sha256Hex(candidate): {UserID: "user-789", RevokedAt: &revokedAt},
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-API-Key", candidate)

	rec := serveProtected(t, testMasterKey, resolver, req)

	assertErrorResponse(t, rec, http.StatusForbidden, `{"detail":"Invalid API key"}`)
}

func TestRequireAPIKeyDatabaseErrorFailsClosed(t *testing.T) {
	resolver := &fakeUserKeyResolver{err: errors.New("database unavailable")}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-API-Key", "blf_any-key")

	rec := serveProtected(t, testMasterKey, resolver, req)

	assertErrorResponse(t, rec, http.StatusForbidden, `{"detail":"Invalid API key"}`)
}

func TestUserContextFromRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	req.Header.Set("X-User-Id", " user-123 ")
	req.Header.Set("X-User-Email", url.PathEscape("person+tag@example.com"))
	req.Header.Set("X-User-Name", url.PathEscape("测试用户"))
	req.Header.Set("X-Operator", url.PathEscape("运营 A"))
	req.Header.Set("X-Role-Type", "admin")
	req.Header.Set("X-Session-Id", "session-456")
	req.Header.Set("X-Is-Admin", "YES")

	got := UserContextFromRequest(req)

	want := UserContext{
		UserID:    "user-123",
		Email:     "person+tag@example.com",
		Name:      "测试用户",
		Operator:  "运营 A",
		RoleType:  "admin",
		SessionID: "session-456",
		IsAdmin:   true,
	}
	if got != want {
		t.Fatalf("UserContextFromRequest() = %#v, want %#v", got, want)
	}
}

func TestUserContextFromRequestSupportsBase64OperatorAndNameFallback(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	req.Header.Set("X-User-Name", base64.StdEncoding.EncodeToString([]byte("显示名")))
	req.Header.Set("X-Is-Admin", "false")

	got := UserContextFromRequest(req)

	if got.Operator != "显示名" {
		t.Errorf("Operator = %q, want %q", got.Operator, "显示名")
	}
	if got.IsAdmin {
		t.Error("IsAdmin = true, want false")
	}
}

func TestWithUserContext(t *testing.T) {
	want := UserContext{UserID: "user-123", Operator: "运营"}

	ctx := WithUserContext(context.Background(), want)
	got, ok := UserContextFromContext(ctx)

	if !ok {
		t.Fatal("UserContextFromContext() ok = false, want true")
	}
	if got != want {
		t.Fatalf("UserContextFromContext() = %#v, want %#v", got, want)
	}
}

func serveProtected(t *testing.T, masterKey string, resolver UserKeyResolver, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	handler := RequireAPIKey(masterKey, resolver)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := UserContextFromContext(r.Context())
		if !ok {
			t.Error("user context missing from authenticated request")
		}
		if user.UserID != r.Header.Get("X-User-Id") && r.Header.Get("X-User-Id") != "" {
			t.Errorf("user context id = %q, want header value", user.UserID)
		}
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func assertErrorResponse(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, status, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if got := rec.Body.String(); got != body {
		t.Errorf("body = %q, want %q", got, body)
	}
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
