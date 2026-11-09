package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
)

const (
	ScopeAll                  = "*"
	lastAgentKeyUsedThrottle  = time.Minute
	agentProvisioningBusiness = "agent_provisioning"
)

type credentialContextKey struct{}
type routeParamsContextKey struct{}

func WithCredential(ctx context.Context, credential Credential) context.Context {
	return context.WithValue(ctx, credentialContextKey{}, credential)
}

func CredentialFromContext(ctx context.Context) (Credential, bool) {
	credential, ok := ctx.Value(credentialContextKey{}).(Credential)
	return credential, ok
}

func HashAgentKey(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func RequireAgentCredential(
	resolver CredentialResolver,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := bearerToken(r)
			if token == "" {
				writeAPIError(w, ErrorWithReason(ErrAgentAuthFailed, "token_invalid"))
				return
			}
			agentID := strings.TrimSpace(r.Header.Get("X-Agent-Id"))
			if agentID == "" {
				writeAPIError(w, ErrorWithReason(ErrAgentAuthFailed, "agent_id_mismatch"))
				return
			}
			if resolver == nil {
				writeAPIError(w, ErrorWithReason(ErrAgentAuthFailed, "token_invalid"))
				return
			}
			credential, err := resolver.ResolveAgentCredential(
				r.Context(),
				HashAgentKey(token),
				agentID,
			)
			if err != nil || credential == nil || credential.AgentID != agentID {
				writeAPIError(w, ErrorWithReason(ErrAgentAuthFailed, "token_invalid"))
				return
			}
			ctx := WithCredential(r.Context(), *credential)
			ctx = agentauth.WithAgentCredential(ctx, agentauth.AgentCredential{
				KeyID:         credential.KeyID,
				AgentID:       credential.AgentID,
				Label:         credential.Label,
				BusinessScope: credential.BusinessScope,
				ProjectScope:  credential.ProjectScope,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func RequireBusinessScope(domain string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			credential, ok := CredentialFromContext(r.Context())
			if !ok {
				writeAPIError(w, ErrorWithReason(ErrAgentAuthFailed, "token_invalid"))
				return
			}
			scope := strings.TrimSpace(credential.BusinessScope)
			if scope == "" {
				scope = ScopeAll
			}
			if scope == ScopeAll {
				if domain == agentProvisioningBusiness {
					writeAPIError(w, ErrorWithReason(ErrAgentBusinessOutOfScope, "business_not_in_scope"))
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			if !containsBusinessScope(scope, domain) {
				writeAPIError(w, ErrorWithReason(ErrAgentBusinessOutOfScope, "business_not_in_scope"))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func RequireProjectScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		credential, ok := CredentialFromContext(r.Context())
		if !ok {
			writeAPIError(w, ErrorWithReason(ErrAgentAuthFailed, "token_invalid"))
			return
		}
		projectID, err := projectIDFromRequest(r)
		if err != nil {
			writeValidationError(w, "project_id must be a positive integer", nil)
			return
		}
		if !ProjectInScope(credential.ProjectScope, projectID) {
			writeAPIError(w, ErrorWithReason(
				ErrAgentProjectOutOfScope,
				"project_not_in_scope",
			))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func ProjectInScope(scope string, projectID int64) bool {
	scope = strings.TrimSpace(scope)
	if scope == "" || scope == ScopeAll {
		return true
	}
	for _, part := range strings.Split(scope, ",") {
		value, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err == nil && value == projectID {
			return true
		}
	}
	return false
}

func FilterProjectsByScope(
	items []projects.ProjectItem,
	scope string,
) []projects.ProjectItem {
	if strings.TrimSpace(scope) == "" || strings.TrimSpace(scope) == ScopeAll {
		return items
	}
	filtered := make([]projects.ProjectItem, 0, len(items))
	for _, item := range items {
		if ProjectInScope(scope, item.ID) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func CurrentIdentity(r *http.Request) (Credential, bool) {
	return CredentialFromContext(r.Context())
}

func bearerToken(r *http.Request) string {
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(authorization) < len("bearer ") ||
		!strings.EqualFold(authorization[:len("bearer ")], "bearer ") {
		return ""
	}
	return strings.TrimSpace(authorization[len("bearer "):])
}

func containsBusinessScope(scope, domain string) bool {
	for _, part := range strings.Split(scope, ",") {
		if strings.TrimSpace(part) == domain {
			return true
		}
	}
	return false
}

func projectIDFromRequest(r *http.Request) (int64, error) {
	raw := chi.URLParam(r, "project_id")
	if raw == "" {
		if params, ok := r.Context().Value(routeParamsContextKey{}).(map[string]string); ok {
			raw = params["project_id"]
		}
	}
	if raw == "" {
		raw = r.URL.Query().Get("project_id")
	}
	projectID, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || projectID < 1 {
		return 0, errors.New("invalid project_id")
	}
	return projectID, nil
}

type dbCredentialResolver struct {
	db  CredentialDB
	now func() time.Time
}

func NewDBCredentialResolver(db CredentialDB, now func() time.Time) CredentialResolver {
	if now == nil {
		now = time.Now
	}
	return &dbCredentialResolver{db: db, now: now}
}

func (r *dbCredentialResolver) ResolveAgentCredential(
	ctx context.Context,
	keyHash string,
	agentID string,
) (*Credential, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("credential database is nil")
	}
	var (
		id            int64
		label         string
		projectScope  *string
		businessScope *string
		storedAgentID *string
		isRevoked     bool
		expiresAt     *time.Time
		deletedAt     *time.Time
		lastUsedAt    *time.Time
	)
	err := r.db.QueryRow(
		ctx,
		`select id, label, project_scope, business_scope, agent_id,
		        is_revoked, expires_at, deleted_at, last_used_at
		 from public.agent_api_keys
		 where key_hash = $1`,
		keyHash,
	).Scan(
		&id,
		&label,
		&projectScope,
		&businessScope,
		&storedAgentID,
		&isRevoked,
		&expiresAt,
		&deletedAt,
		&lastUsedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	now := r.now().UTC()
	if deletedAt != nil || isRevoked || (expiresAt != nil && !expiresAt.After(now)) {
		return nil, nil
	}
	if storedAgentID == nil || *storedAgentID != agentID {
		return nil, nil
	}
	if lastUsedAt == nil || now.Sub(lastUsedAt.UTC()) >= lastAgentKeyUsedThrottle {
		_, _ = r.db.Exec(
			ctx,
			`update public.agent_api_keys set last_used_at = $2 where id = $1`,
			id,
			now,
		)
	}
	project := ScopeAll
	if projectScope != nil && strings.TrimSpace(*projectScope) != "" {
		project = *projectScope
	}
	business := ScopeAll
	if businessScope != nil && strings.TrimSpace(*businessScope) != "" {
		business = *businessScope
	}
	return &Credential{
		KeyID:         id,
		AgentID:       agentID,
		Label:         label,
		ProjectScope:  project,
		BusinessScope: business,
	}, nil
}

func parseProjectScopeIDs(scope string) []int64 {
	scope = strings.TrimSpace(scope)
	if scope == "" || scope == ScopeAll {
		return nil
	}
	var ids []int64
	for _, part := range strings.Split(scope, ",") {
		val, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err == nil && val > 0 {
			ids = append(ids, val)
		}
	}
	return ids
}
