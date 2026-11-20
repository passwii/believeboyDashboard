package auth

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type passwordUpdater interface {
	UpdatePassword(ctx context.Context, userID, password string) (bool, error)
}

func (h *Handler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	identity, ok := requestauth.UserContextFromContext(r.Context())
	if !ok || strings.TrimSpace(identity.UserID) == "" || strings.TrimSpace(identity.Email) == "" ||
		requestauth.AuthKindFromContext(r.Context()) != requestauth.RequestAuthKindTrustedProxy {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	if h.sessions == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session service unavailable")
		return
	}
	if strings.TrimSpace(identity.SessionID) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	valid, err := h.sessions.ValidateSession(r.Context(), identity.UserID, identity.SessionID)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session validation unavailable")
		return
	}
	if !valid {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Session revoked")
		return
	}

	var body changePasswordRequest
	if !decodeLoginJSON(w, r, &body) {
		return
	}
	if body.CurrentPassword == "" || body.NewPassword == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "请填写完整信息")
		return
	}
	if utf8.RuneCountInString(body.NewPassword) < 8 || utf8.RuneCountInString(body.NewPassword) > 128 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "新密码长度须为 8 至 128 个字符")
		return
	}
	if body.CurrentPassword == body.NewPassword {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "新密码不能与当前密码一致")
		return
	}

	account, passwordValid, err := h.store.FindForLogin(
		r.Context(),
		strings.ToLower(strings.TrimSpace(identity.Email)),
		body.CurrentPassword,
	)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if account == nil || !passwordValid || account.ID != strings.TrimSpace(identity.UserID) {
		httpapi.WriteDetail(w, http.StatusBadRequest, "当前密码不正确")
		return
	}
	if !account.IsActive {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Account disabled")
		return
	}

	updater, ok := h.store.(passwordUpdater)
	if !ok {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Password change unavailable")
		return
	}
	updated, err := updater.UpdatePassword(r.Context(), account.ID, body.NewPassword)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !updated {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}

	// PasswordChangedAt is also checked by /auth/me, so a transient Redis
	// revocation failure cannot leave this browser session authorized.
	_, _ = h.sessions.DeleteUserSessions(r.Context(), account.ID)
	if h.auditor != nil {
		operator := strings.TrimSpace(identity.Operator)
		var operatorPtr *string
		if operator != "" {
			operatorPtr = &operator
		}
		targetID := account.ID
		entry := audit.Entry{
			Action:     "users.password_change_self",
			TargetType: "user_account",
			TargetID:   &targetID,
			Operator:   operatorPtr,
			AfterJSON:  map[string]any{"password_changed": true},
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteInternalServerError(w)
			return
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
	}{OK: true})
}
