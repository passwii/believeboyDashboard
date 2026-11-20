package auth

import (
	"net/http"
	"strings"
	"time"

	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	identity, ok := requestauth.UserContextFromContext(r.Context())
	if !ok || strings.TrimSpace(identity.UserID) == "" || strings.TrimSpace(identity.Email) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	var issuedAt time.Time
	var err error
	authKind := requestauth.AuthKindFromContext(r.Context())
	isDeviceAPIKey := authKind == requestauth.RequestAuthKindUserAPIKey
	isTrustedProxy := authKind == requestauth.RequestAuthKindTrustedProxy
	if h.sessionsRequired && !isDeviceAPIKey && !isTrustedProxy {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	if h.sessionsRequired && h.sessions == nil && !isDeviceAPIKey {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session validation unavailable")
		return
	}
	if isTrustedProxy {
		if h.sessions == nil {
			if h.sessionsRequired {
				httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session validation unavailable")
				return
			}
		} else {
			if strings.TrimSpace(identity.SessionID) == "" {
				httpapi.WriteDetail(w, http.StatusUnauthorized, "Session revoked")
				return
			}
			var valid bool
			issuedAt, valid, err = h.sessions.SessionIssuedAt(
				r.Context(),
				strings.TrimSpace(identity.UserID),
				strings.TrimSpace(identity.SessionID),
			)
			if err != nil {
				httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session validation unavailable")
				return
			}
			if !valid {
				httpapi.WriteDetail(w, http.StatusUnauthorized, "Session revoked")
				return
			}
			if issuedAt.IsZero() && identity.SessionIssuedAt > 0 {
				issuedAt = time.Unix(identity.SessionIssuedAt, 0).UTC()
			}
			if issuedAt.IsZero() {
				httpapi.WriteDetail(w, http.StatusUnauthorized, "Session issue time unavailable")
				return
			}
		}
	}

	account, err := h.store.GetByIDAndEmail(
		r.Context(),
		strings.TrimSpace(identity.UserID),
		strings.TrimSpace(identity.Email),
	)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if account == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}
	if !account.IsActive {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Account disabled")
		return
	}
	if isTrustedProxy && h.sessions != nil {
		if account.PasswordChangedAt != nil && !account.PasswordChangedAt.Before(issuedAt) {
			httpapi.WriteDetail(w, http.StatusUnauthorized, "Password changed")
			return
		}
		// Only the trusted Next server-side identity-refresh call sets this
		// marker. Session existence, active-account and password-change checks
		// above still apply before allowing authoritative claims to be returned.
		identityRefresh := strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Auth-Identity-Refresh")), "true")
		if !identityRefresh {
			if identity.IsAdmin != account.IsAdmin ||
				strings.TrimSpace(identity.RoleType) != normalizedRole(account.RoleType, account.IsAdmin) {
				httpapi.WriteDetail(w, http.StatusUnauthorized, "Account role changed")
				return
			}
			expectedOperator := ""
			if account.FullName != nil {
				expectedOperator = strings.TrimSpace(*account.FullName)
			}
			if strings.TrimSpace(identity.Operator) != expectedOperator {
				httpapi.WriteDetail(w, http.StatusUnauthorized, "Account identity changed")
				return
			}
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, MeResponse{
		ID:                account.ID,
		Email:             account.Email,
		Name:              account.Name,
		FullName:          normalizedFullName(account.FullName),
		IsAdmin:           account.IsAdmin,
		IsActive:          account.IsActive,
		RoleType:          normalizedRole(account.RoleType, account.IsAdmin),
		PasswordChangedAt: httpapi.OptionalTimestamp(account.PasswordChangedAt),
	})
}
