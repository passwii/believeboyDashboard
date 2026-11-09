package users

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

var (
	ErrUserNotFound                 = errors.New("user not found")
	ErrSessionRevocationUnavailable = errors.New("session revocation unavailable")
)

type SessionRevoker interface {
	DeleteUserSessions(ctx context.Context, userID string) (int, error)
}

type SessionRevocationInput struct {
	UserID   string
	Operator *string
	Request  *http.Request
	Auditor  audit.Service
	Revoker  SessionRevoker
}

type SessionRevocationStore interface {
	RevokeSessions(ctx context.Context, input SessionRevocationInput) (int, error)
}

type revokeSessionsResponse struct {
	OK      bool `json:"ok"`
	Revoked int  `json:"revoked"`
}

func (h *Handler) RevokeSessions(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")
	if strings.TrimSpace(userID) == "" {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{{
			Type:  "string_too_short",
			Loc:   []string{"path", "user_id"},
			Msg:   "String should have at least 1 character",
			Input: userID,
			Ctx:   map[string]int{"min_length": 1},
		}})
		return
	}
	writer, ok := h.store.(SessionRevocationStore)
	if !ok || h.auditor == nil || h.sessionRevoker == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session revocation unavailable")
		return
	}

	revoked, err := writer.RevokeSessions(r.Context(), SessionRevocationInput{
		UserID:   userID,
		Operator: operator,
		Request:  r,
		Auditor:  h.auditor,
		Revoker:  h.sessionRevoker,
	})
	switch {
	case errors.Is(err, ErrUserNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "用户不存在")
	case errors.Is(err, ErrSessionRevocationUnavailable):
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Session revocation unavailable")
	case err != nil:
		httpapi.WriteInternalServerError(w)
	default:
		_ = httpapi.WriteJSON(w, http.StatusOK, revokeSessionsResponse{
			OK:      true,
			Revoked: revoked,
		})
	}
}
