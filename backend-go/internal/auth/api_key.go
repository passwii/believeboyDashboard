package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

const (
	missingAPIKeyDetail = "Missing API key"
	invalidAPIKeyDetail = "Invalid API key"
)

// UserKeyRecord is the authentication-relevant projection of user_api_keys.
type UserKeyRecord struct {
	UserID    string
	RevokedAt *time.Time
}

// UserKeyResolver looks up a SHA-256 hex digest. A nil record means no key was
// found; infrastructure errors must be returned to the caller.
type UserKeyResolver interface {
	ResolveUserKey(ctx context.Context, keyHash string) (*UserKeyRecord, error)
}

// RequireAPIKey validates the master key first, then user device keys. The
// resolver is never called for a master-key request.
func RequireAPIKey(masterKey string, resolver UserKeyResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			candidates := apiKeyCandidates(r)
			if len(candidates) == 0 {
				writeAuthError(w, http.StatusUnauthorized, missingAPIKeyDetail)
				return
			}

			for _, candidate := range candidates {
				if constantTimeKeyEqual(candidate, masterKey) {
					serveAuthenticated(next, w, r)
					return
				}
			}

			if resolver != nil {
				for _, candidate := range candidates {
					record, err := resolver.ResolveUserKey(r.Context(), hashAPIKey(candidate))
					if err != nil || (record != nil && record.RevokedAt != nil) {
						writeAuthError(w, http.StatusForbidden, invalidAPIKeyDetail)
						return
					}
					if record != nil {
						serveAuthenticated(next, w, r)
						return
					}
				}
			}

			writeAuthError(w, http.StatusForbidden, invalidAPIKeyDetail)
		})
	}
}

func apiKeyCandidates(r *http.Request) []string {
	candidates := make([]string, 0, 3)

	authorization := r.Header.Get("Authorization")
	if len(authorization) >= len("bearer ") && strings.EqualFold(authorization[:len("bearer ")], "bearer ") {
		if token := strings.TrimSpace(authorization[len("bearer "):]); token != "" {
			candidates = append(candidates, token)
		}
	}
	if key := r.Header.Get("X-API-Key"); key != "" {
		candidates = append(candidates, key)
	}
	if key := r.URL.Query().Get("api_key"); key != "" {
		candidates = append(candidates, key)
	}

	return candidates
}

func serveAuthenticated(next http.Handler, w http.ResponseWriter, r *http.Request) {
	ctx := WithUserContext(r.Context(), UserContextFromRequest(r))
	next.ServeHTTP(w, r.WithContext(ctx))
}

func hashAPIKey(candidate string) string {
	sum := sha256.Sum256([]byte(candidate))
	return hex.EncodeToString(sum[:])
}

func constantTimeKeyEqual(candidate, masterKey string) bool {
	if candidate == "" || masterKey == "" {
		return false
	}
	candidateHash := sha256.Sum256([]byte(candidate))
	masterHash := sha256.Sum256([]byte(masterKey))
	return subtle.ConstantTimeCompare(candidateHash[:], masterHash[:]) == 1
}

func writeAuthError(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"detail":"` + detail + `"}`))
}
