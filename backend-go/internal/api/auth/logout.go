package auth

import (
	"net/http"
	"strings"

	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type logoutResponse struct {
	OK bool `json:"ok"`
}

// Logout revokes the Redis browser session that belongs to the current request.
// Auth.js sign-out only clears the browser cookie, so without this endpoint a
// copied JWT would keep passing /auth/me (and sliding the Redis TTL) until it
// expired. Revocation is idempotent: a missing session id is not an error because
// the caller's cookie is already gone.
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	identity, ok := requestauth.UserContextFromContext(r.Context())
	if !ok || strings.TrimSpace(identity.UserID) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}

	// Device API keys have no browser session; sign-out of a device key is a
	// no-op for the session store and must not fail the request.
	if requestauth.AuthKindFromContext(r.Context()) == requestauth.RequestAuthKindUserAPIKey {
		_ = httpapi.WriteJSON(w, http.StatusOK, logoutResponse{OK: true})
		return
	}

	if h.sessionsRequired && h.sessions == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session service unavailable")
		return
	}
	sessionID := strings.TrimSpace(identity.SessionID)
	if h.sessions == nil || sessionID == "" {
		_ = httpapi.WriteJSON(w, http.StatusOK, logoutResponse{OK: true})
		return
	}
	if err := h.sessions.DeleteUserSession(r.Context(), strings.TrimSpace(identity.UserID), sessionID); err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session revocation unavailable")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, logoutResponse{OK: true})
}
