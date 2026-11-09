package agent

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type stage5CredentialResolver struct {
	keyHash    string
	agentID    string
	credential *Credential
	err        error
}

func (r *stage5CredentialResolver) ResolveAgentCredential(
	_ context.Context,
	keyHash string,
	agentID string,
) (*Credential, error) {
	r.keyHash = keyHash
	r.agentID = agentID
	return r.credential, r.err
}

func TestStage5AgentCredentialRequiresBearerAndMatchingAgentID(t *testing.T) {
	resolver := &stage5CredentialResolver{
		credential: &Credential{
			KeyID:         7,
			AgentID:       "agent-1",
			Label:         "Agent One",
			ProjectScope:  "*",
			BusinessScope: "*",
		},
	}
	middleware := RequireAgentCredential(resolver)

	nextCalled := false
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		nextCalled = true
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/health", nil)
	rec := httptest.NewRecorder()
	middleware(next).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing credential status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if nextCalled {
		t.Fatal("next handler was called without credentials")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/agent/health", nil)
	req.Header.Set("Authorization", "Bearer bbx_test")
	req.Header.Set("X-Agent-Id", "agent-1")
	rec = httptest.NewRecorder()
	middleware(next).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !nextCalled {
		t.Fatalf("valid credential status = %d, next=%v; body=%s", rec.Code, nextCalled, rec.Body.String())
	}
	if resolver.agentID != "agent-1" {
		t.Fatalf("resolver agent id = %q, want agent-1", resolver.agentID)
	}
	if resolver.keyHash == "" || resolver.keyHash == "bbx_test" {
		t.Fatalf("resolver received key hash %q, want SHA-256 digest", resolver.keyHash)
	}
}

func TestStage5AgentCredentialFailsClosedOnResolverMismatch(t *testing.T) {
	resolver := &stage5CredentialResolver{credential: &Credential{
		KeyID:         7,
		AgentID:       "other-agent",
		ProjectScope:  "*",
		BusinessScope: "*",
	}}
	middleware := RequireAgentCredential(resolver)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/health", nil)
	req.Header.Set("Authorization", "Bearer bbx_test")
	req.Header.Set("X-Agent-Id", "agent-1")
	rec := httptest.NewRecorder()
	middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("next handler called for mismatched agent id")
	})).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("mismatch status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}

	resolver = &stage5CredentialResolver{err: errors.New("database unavailable")}
	middleware = RequireAgentCredential(resolver)
	rec = httptest.NewRecorder()
	middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("next handler called after resolver error")
	})).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("resolver error status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestStage5BusinessAndProjectScopeMiddleware(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/projects/2/sales/summary", nil)
	req = req.WithContext(WithCredential(req.Context(), Credential{
		KeyID:         8,
		AgentID:       "agent-1",
		ProjectScope:  "1",
		BusinessScope: "inventory, sales",
	}))
	routeCtx := contextWithRouteParam(req, "project_id", "2")

	rec := httptest.NewRecorder()
	RequireProjectScope(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("out-of-scope project reached next handler")
	})).ServeHTTP(rec, routeCtx)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("project scope status = %d, want 403; body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	RequireBusinessScope("ad_analysis")(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("out-of-scope business domain reached next handler")
	})).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("business scope status = %d, want 403; body=%s", rec.Code, rec.Body.String())
	}
}

func TestStage5ConfirmationStoreRejectsBodyMismatchAndExpiry(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	store := NewMemoryConfirmStore(func() time.Time { return now })
	record := ConfirmRecord{
		Token:          "cf_test",
		AgentID:        "agent-1",
		Action:         "test.action",
		IdempotencyKey: "idem-1",
		BodyHash:       HashConfirmBody([]byte(`{"value":1}`)),
		CreatedAt:      now,
	}
	if err := store.Put(context.Background(), record, 5*time.Minute); err != nil {
		t.Fatalf("put confirm record: %v", err)
	}

	_, err := store.Pop(context.Background(), "cf_missing")
	if !errors.Is(err, ErrConfirmTokenInvalid) {
		t.Fatalf("missing token error = %v, want ErrConfirmTokenInvalid", err)
	}

	now = now.Add(10 * time.Minute)
	_, err = store.Pop(context.Background(), "cf_test")
	if !errors.Is(err, ErrConfirmTokenExpired) {
		t.Fatalf("expired token error = %v, want ErrConfirmTokenExpired", err)
	}
}

func TestCanonicalRequestFingerprintBindsQueryAndPath(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/agent/projects/42/shipments?country=US&dry_run=true",
		nil,
	)
	if got := canonicalRequestFingerprint(request); got != "POST /api/v1/agent/projects/42/shipments?country=US&dry_run=true" {
		t.Fatalf("canonicalRequestFingerprint() = %q", got)
	}

	reordered := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/agent/projects/42/shipments?dry_run=true&country=US",
		nil,
	)
	if got := canonicalRequestFingerprint(reordered); got != canonicalRequestFingerprint(request) {
		t.Fatalf("query order changed fingerprint: %q != %q", got, canonicalRequestFingerprint(request))
	}

	changed := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/agent/projects/42/shipments?country=DE&dry_run=true",
		nil,
	)
	if got := canonicalRequestFingerprint(changed); got == canonicalRequestFingerprint(request) {
		t.Fatal("changed query retained the same fingerprint")
	}
}

func TestStage5OKResponseShellUsesDataEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()
	writeOK(rec, map[string]any{"value": "ok"}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != `{"ok":true,"data":{"value":"ok"}}` {
		t.Fatalf("body = %s", got)
	}
}

func contextWithRouteParam(
	req *http.Request,
	key string,
	value string,
) *http.Request {
	params := map[string]string{key: value}
	ctx := context.WithValue(req.Context(), routeParamsContextKey{}, params)
	return req.WithContext(ctx)
}
