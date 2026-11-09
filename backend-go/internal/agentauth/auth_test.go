package agentauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestRequireAgentCredentialInjectsCredential(t *testing.T) {
	now := time.Now().UTC()
	store := &fakeCredentialStore{
		row: &CredentialRow{
			KeyID:         17,
			AgentID:       "agent-alpha",
			Label:         "Alpha Agent",
			BusinessScope: "shipments,order_info",
			ProjectScope:  "11, 42",
			LastUsedAt:    timePointer(now),
		},
	}
	var got AgentCredential
	handler := RequireAgentCredential(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ok bool
		got, ok = CredentialFromContext(r.Context())
		if !ok {
			t.Fatal("credential missing from request context")
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodGet, "/api/v1/agent/health", nil)
	request.Header.Set("Authorization", "Bearer bbx_secret")
	request.Header.Set("X-Agent-Id", "agent-alpha")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusNoContent, response.Body.String())
	}
	if store.findCalls != 1 {
		t.Fatalf("FindByHash calls = %d, want 1", store.findCalls)
	}
	if store.lastHash != HashAgentToken("bbx_secret") {
		t.Fatalf("hash = %q, want %q", store.lastHash, HashAgentToken("bbx_secret"))
	}
	if got.KeyID != 17 || got.AgentID != "agent-alpha" || got.Label != "Alpha Agent" {
		t.Fatalf("unexpected credential: %+v", got)
	}
	if got.BusinessScope != "shipments,order_info" || got.ProjectScope != "11, 42" {
		t.Fatalf("unexpected scopes: %+v", got)
	}
	if store.touchCalls != 0 {
		t.Fatalf("TouchLastUsed calls = %d, want 0 for a recent timestamp", store.touchCalls)
	}
}

func TestRequireAgentCredentialThrottlesLastUsed(t *testing.T) {
	tests := []struct {
		name       string
		lastUsedAt *time.Time
		wantTouch  int
	}{
		{name: "never used", lastUsedAt: nil, wantTouch: 1},
		{name: "stale", lastUsedAt: timePointer(time.Now().UTC().Add(-time.Minute - time.Second)), wantTouch: 1},
		{name: "recent", lastUsedAt: timePointer(time.Now().UTC().Add(-30 * time.Second)), wantTouch: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeCredentialStore{
				row: &CredentialRow{
					KeyID:         1,
					AgentID:       "agent",
					Label:         "Agent",
					BusinessScope: "*",
					ProjectScope:  "*",
					LastUsedAt:    tt.lastUsedAt,
				},
			}

			handler := RequireAgentCredential(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("Authorization", "Bearer bbx_secret")
			request.Header.Set("X-Agent-Id", "agent")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want 204: %s", response.Code, response.Body.String())
			}
			if store.touchCalls != tt.wantTouch {
				t.Fatalf("TouchLastUsed calls = %d, want %d", store.touchCalls, tt.wantTouch)
			}
		})
	}
}

func TestRequireAgentCredentialHeaderFailures(t *testing.T) {
	tests := []struct {
		name       string
		authHeader string
		agentID    string
		detail     string
	}{
		{name: "missing authorization", agentID: "agent", detail: DetailTokenInvalid},
		{name: "wrong scheme", authHeader: "Basic abc", agentID: "agent", detail: DetailTokenInvalid},
		{name: "empty bearer token", authHeader: "Bearer   ", agentID: "agent", detail: DetailTokenInvalid},
		{name: "missing agent id", authHeader: "Bearer bbx_secret", detail: DetailAgentIDMismatch},
		{name: "blank agent id", authHeader: "Bearer bbx_secret", agentID: "   ", detail: DetailAgentIDMismatch},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeCredentialStore{}
			handler := RequireAgentCredential(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("next handler must not be called")
			}))
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.authHeader != "" {
				request.Header.Set("Authorization", tt.authHeader)
			}
			if tt.agentID != "" {
				request.Header.Set("X-Agent-Id", tt.agentID)
			}
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			assertErrorResponse(t, response, http.StatusUnauthorized, ErrorCodeAgentAuthFailed, tt.detail)
			if store.findCalls != 0 {
				t.Fatalf("FindByHash calls = %d, want 0", store.findCalls)
			}
		})
	}
}

func TestRequireAgentCredentialStoreFailures(t *testing.T) {
	expired := time.Now().UTC().Add(-time.Second)
	revoked := true
	deleted := time.Now().UTC()
	tests := []struct {
		name    string
		row     *CredentialRow
		findErr error
		detail  string
	}{
		{name: "not found", detail: DetailTokenInvalid},
		{name: "deleted", row: &CredentialRow{AgentID: "agent", DeletedAt: &deleted}, detail: DetailTokenInvalid},
		{name: "revoked", row: &CredentialRow{AgentID: "agent", IsRevoked: revoked}, detail: DetailTokenRevoked},
		{name: "expired", row: &CredentialRow{AgentID: "agent", ExpiresAt: &expired}, detail: DetailTokenExpired},
		{name: "agent mismatch", row: &CredentialRow{AgentID: "someone-else"}, detail: DetailAgentIDMismatch},
		{name: "lookup error", findErr: errors.New("database unavailable"), detail: DetailTokenInvalid},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeCredentialStore{row: tt.row, findErr: tt.findErr}
			handler := RequireAgentCredential(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("next handler must not be called")
			}))
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("Authorization", "Bearer bbx_secret")
			request.Header.Set("X-Agent-Id", "agent")
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			assertErrorResponse(t, response, http.StatusUnauthorized, ErrorCodeAgentAuthFailed, tt.detail)
		})
	}
}

func TestRequireAgentCredentialTouchFailureFailsClosed(t *testing.T) {
	store := &fakeCredentialStore{
		row: &CredentialRow{
			KeyID:         1,
			AgentID:       "agent",
			Label:         "Agent",
			BusinessScope: "*",
			ProjectScope:  "*",
		},
		touchErr: errors.New("write failed"),
	}
	handler := RequireAgentCredential(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler must not be called")
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Bearer bbx_secret")
	request.Header.Set("X-Agent-Id", "agent")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	assertErrorResponse(t, response, http.StatusUnauthorized, ErrorCodeAgentAuthFailed, DetailTokenInvalid)
}

func TestPGXCredentialStoreFindByHash(t *testing.T) {
	now := time.Date(2026, time.November, 8, 9, 0, 0, 0, time.UTC)
	expires := pgtype.Timestamptz{Time: now.Add(time.Hour), Valid: true}
	db := &fakeCredentialDB{
		row: fakeCredentialRow{values: []any{
			int64(9),
			"Agent Nine",
			pgtype.Text{String: "agent-nine", Valid: true},
			"shipments,pricing_calculation",
			"1,2,3",
			false,
			expires,
			pgtype.Timestamptz{},
			pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true},
		}},
	}
	store := NewPGXCredentialStore(db)

	row, err := store.FindByHash(context.Background(), "abc123")
	if err != nil {
		t.Fatalf("FindByHash returned error: %v", err)
	}
	if row == nil {
		t.Fatal("FindByHash returned nil row")
	}
	if row.KeyID != 9 || row.AgentID != "agent-nine" || row.Label != "Agent Nine" {
		t.Fatalf("unexpected row: %+v", row)
	}
	if row.BusinessScope != "shipments,pricing_calculation" || row.ProjectScope != "1,2,3" {
		t.Fatalf("unexpected scopes: %+v", row)
	}
	if !strings.Contains(db.queryRowSQL, "public.agent_api_keys") || !strings.Contains(db.queryRowSQL, "key_hash = $1") {
		t.Fatalf("unexpected lookup SQL: %s", db.queryRowSQL)
	}
}

func TestPGXCredentialStoreFindByHashNotFound(t *testing.T) {
	store := NewPGXCredentialStore(&fakeCredentialDB{rowErr: pgx.ErrNoRows})
	row, err := store.FindByHash(context.Background(), "missing")
	if err != nil {
		t.Fatalf("FindByHash returned error: %v", err)
	}
	if row != nil {
		t.Fatalf("row = %+v, want nil", row)
	}
}

func TestPGXCredentialStoreTouchLastUsed(t *testing.T) {
	now := time.Date(2026, time.November, 8, 9, 30, 0, 0, time.UTC)
	db := &fakeCredentialDB{}
	store := NewPGXCredentialStore(db)

	if err := store.TouchLastUsed(context.Background(), 42, now); err != nil {
		t.Fatalf("TouchLastUsed returned error: %v", err)
	}
	if !strings.Contains(db.execSQL, "last_used_at = $2") ||
		!strings.Contains(db.execSQL, "interval '60 seconds'") {
		t.Fatalf("unexpected touch SQL: %s", db.execSQL)
	}
	if len(db.execArgs) != 2 || db.execArgs[0] != int64(42) || db.execArgs[1] != now {
		t.Fatalf("unexpected touch args: %#v", db.execArgs)
	}
}

type fakeCredentialStore struct {
	row        *CredentialRow
	findErr    error
	touchErr   error
	findCalls  int
	touchCalls int
	lastHash   string
}

func (s *fakeCredentialStore) FindByHash(_ context.Context, keyHash string) (*CredentialRow, error) {
	s.findCalls++
	s.lastHash = keyHash
	return s.row, s.findErr
}

func (s *fakeCredentialStore) TouchLastUsed(context.Context, int64, time.Time) error {
	s.touchCalls++
	return s.touchErr
}

type fakeCredentialDB struct {
	row         fakeCredentialRow
	rowErr      error
	queryRowSQL string
	execSQL     string
	execArgs    []any
	execErr     error
}

func (db *fakeCredentialDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	db.queryRowSQL = sql
	return fakeScannableRow{values: db.row.values, err: db.rowErr}
}

func (db *fakeCredentialDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execSQL = sql
	db.execArgs = append([]any(nil), args...)
	if db.execErr != nil {
		return pgconn.CommandTag{}, db.execErr
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

type fakeCredentialRow struct {
	values []any
}

type fakeScannableRow struct {
	values []any
	err    error
}

func (r fakeScannableRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return errors.New("scan destination count mismatch")
	}
	for i, value := range r.values {
		switch target := dest[i].(type) {
		case *int64:
			*target = value.(int64)
		case *string:
			*target = value.(string)
		case *bool:
			*target = value.(bool)
		case *pgtype.Text:
			*target = value.(pgtype.Text)
		case *pgtype.Timestamptz:
			*target = value.(pgtype.Timestamptz)
		default:
			return errors.New("unsupported scan destination")
		}
	}
	return nil
}

func assertErrorResponse(t *testing.T, response *httptest.ResponseRecorder, status int, code, detail string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d: %s", response.Code, status, response.Body.String())
	}
	var payload struct {
		OK        bool   `json:"ok"`
		ErrorCode string `json:"error_code"`
		Detail    string `json:"detail"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, response.Body.String())
	}
	if payload.OK || payload.ErrorCode != code || payload.Detail != detail {
		t.Fatalf("payload = %+v, want ok=false code=%s detail=%s", payload, code, detail)
	}
}

func timePointer(value time.Time) *time.Time {
	return &value
}
