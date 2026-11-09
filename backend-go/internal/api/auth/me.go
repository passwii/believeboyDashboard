package auth

import (
	"net/http"
	"strings"

	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	identity, ok := requestauth.UserContextFromContext(r.Context())
	if !ok || strings.TrimSpace(identity.UserID) == "" || strings.TrimSpace(identity.Email) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
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
