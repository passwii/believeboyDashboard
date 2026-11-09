package agentauth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

const LastUsedThrottle = 60 * time.Second

// CredentialRow is the authentication-relevant projection of public.agent_api_keys.
type CredentialRow struct {
	KeyID         int64
	AgentID       string
	Label         string
	BusinessScope string
	ProjectScope  string
	IsRevoked     bool
	ExpiresAt     *time.Time
	DeletedAt     *time.Time
	LastUsedAt    *time.Time
}

// CredentialStore resolves key hashes and records throttled successful use.
type CredentialStore interface {
	FindByHash(ctx context.Context, keyHash string) (*CredentialRow, error)
	TouchLastUsed(ctx context.Context, keyID int64, at time.Time) error
}

// CredentialDB is the pgx surface used by PGXCredentialStore.
type CredentialDB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type PGXCredentialStore struct {
	db CredentialDB
}

func NewPGXCredentialStore(db CredentialDB) *PGXCredentialStore {
	return &PGXCredentialStore{db: db}
}

func (s *PGXCredentialStore) FindByHash(ctx context.Context, keyHash string) (*CredentialRow, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("credential store database is nil")
	}
	row := s.db.QueryRow(
		ctx,
		`select id,
		        label,
		        agent_id,
		        coalesce(business_scope, '*'),
		        coalesce(project_scope, '*'),
		        is_revoked,
		        expires_at,
		        deleted_at,
		        last_used_at
		   from public.agent_api_keys
		  where key_hash = $1
		  limit 1`,
		keyHash,
	)

	var (
		record     CredentialRow
		agentID    pgtype.Text
		expiresAt  pgtype.Timestamptz
		deletedAt  pgtype.Timestamptz
		lastUsedAt pgtype.Timestamptz
	)
	if err := row.Scan(
		&record.KeyID,
		&record.Label,
		&agentID,
		&record.BusinessScope,
		&record.ProjectScope,
		&record.IsRevoked,
		&expiresAt,
		&deletedAt,
		&lastUsedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	if agentID.Valid {
		record.AgentID = agentID.String
	}
	record.ExpiresAt = timestampPointer(expiresAt)
	record.DeletedAt = timestampPointer(deletedAt)
	record.LastUsedAt = timestampPointer(lastUsedAt)
	if strings.TrimSpace(record.BusinessScope) == "" {
		record.BusinessScope = ScopeAll
	}
	if strings.TrimSpace(record.ProjectScope) == "" {
		record.ProjectScope = ScopeAll
	}
	return &record, nil
}

// TouchLastUsed applies the same 60-second write throttle as the FastAPI resolver.
func (s *PGXCredentialStore) TouchLastUsed(ctx context.Context, keyID int64, at time.Time) error {
	if s == nil || s.db == nil {
		return errors.New("credential store database is nil")
	}
	_, err := s.db.Exec(
		ctx,
		`update public.agent_api_keys
		    set last_used_at = $2
		  where id = $1
		    and deleted_at is null
		    and is_revoked = false
		    and (
		      last_used_at is null
		      or last_used_at <= $2 - interval '60 seconds'
		    )`,
		keyID,
		at,
	)
	return err
}

// AgentCredential is attached to the request context after successful authentication.
type AgentCredential struct {
	KeyID         int64
	AgentID       string
	Label         string
	BusinessScope string
	ProjectScope  string
}

type credentialContextKey struct{}

func WithAgentCredential(ctx context.Context, credential AgentCredential) context.Context {
	return context.WithValue(ctx, credentialContextKey{}, credential)
}

func CredentialFromContext(ctx context.Context) (AgentCredential, bool) {
	credential, ok := ctx.Value(credentialContextKey{}).(AgentCredential)
	return credential, ok
}

func CredentialFromRequest(r *http.Request) (AgentCredential, bool) {
	if r == nil {
		return AgentCredential{}, false
	}
	return CredentialFromContext(r.Context())
}

// RequireAgentCredential authenticates Bearer + X-Agent-Id and fails closed on any store error.
func RequireAgentCredential(store CredentialStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := extractBearer(r.Header.Get("Authorization"))
			if !ok {
				writeAuthFailure(w, DetailTokenInvalid)
				return
			}
			agentID := strings.TrimSpace(r.Header.Get("X-Agent-Id"))
			if agentID == "" {
				writeAuthFailure(w, DetailAgentIDMismatch)
				return
			}
			if store == nil {
				writeAuthFailure(w, DetailTokenInvalid)
				return
			}

			row, err := store.FindByHash(r.Context(), HashAgentToken(token))
			if err != nil {
				writeAuthFailure(w, DetailTokenInvalid)
				return
			}
			now := time.Now().UTC()
			status := resolveCredentialStatus(row, agentID, now)
			if status != credentialStatusOK {
				writeAuthFailure(w, credentialFailureDetail(status))
				return
			}
			if shouldTouchLastUsed(row.LastUsedAt, now) {
				if err := store.TouchLastUsed(r.Context(), row.KeyID, now); err != nil {
					writeAuthFailure(w, DetailTokenInvalid)
					return
				}
			}

			credential := AgentCredential{
				KeyID:         row.KeyID,
				AgentID:       row.AgentID,
				Label:         row.Label,
				BusinessScope: defaultScope(row.BusinessScope),
				ProjectScope:  defaultScope(row.ProjectScope),
			}
			ctx := WithAgentCredential(r.Context(), credential)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// HashAgentToken returns the lowercase SHA-256 digest stored in agent_api_keys.key_hash.
func HashAgentToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

type credentialStatus string

const (
	credentialStatusOK            credentialStatus = "ok"
	credentialStatusNotFound      credentialStatus = "not_found"
	credentialStatusRevoked       credentialStatus = "revoked"
	credentialStatusExpired       credentialStatus = "expired"
	credentialStatusAgentMismatch credentialStatus = "agent_mismatch"
)

func resolveCredentialStatus(row *CredentialRow, agentID string, now time.Time) credentialStatus {
	if row == nil || row.DeletedAt != nil {
		return credentialStatusNotFound
	}
	if row.IsRevoked {
		return credentialStatusRevoked
	}
	if row.ExpiresAt != nil && !row.ExpiresAt.After(now) {
		return credentialStatusExpired
	}
	if strings.TrimSpace(row.AgentID) == "" || row.AgentID != agentID {
		return credentialStatusAgentMismatch
	}
	return credentialStatusOK
}

func credentialFailureDetail(status credentialStatus) string {
	switch status {
	case credentialStatusRevoked:
		return DetailTokenRevoked
	case credentialStatusExpired:
		return DetailTokenExpired
	case credentialStatusAgentMismatch:
		return DetailAgentIDMismatch
	default:
		return DetailTokenInvalid
	}
}

func shouldTouchLastUsed(lastUsedAt *time.Time, now time.Time) bool {
	return lastUsedAt == nil || now.Sub(*lastUsedAt) >= LastUsedThrottle
}

func extractBearer(authorization string) (string, bool) {
	const prefix = "bearer "
	if len(authorization) < len(prefix) || !strings.EqualFold(authorization[:len(prefix)], prefix) {
		return "", false
	}
	token := strings.TrimSpace(authorization[len(prefix):])
	return token, token != ""
}

func writeAuthFailure(w http.ResponseWriter, detail string) {
	WriteError(w, http.StatusUnauthorized, ErrorCodeAgentAuthFailed, detail)
}

func timestampPointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}

func defaultScope(scope string) string {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return ScopeAll
	}
	return scope
}
