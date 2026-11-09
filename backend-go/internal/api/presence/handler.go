package presence

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const defaultAvatarURL = "/avatars/default.svg"

type Store interface {
	UpsertPresence(context.Context, UpsertInput, time.Time) error
	ListActivePresence(context.Context, string, time.Time) ([]UserItem, error)
	ServerTime(context.Context) (time.Time, error)
}

type Handler struct {
	store Store
	now   func() time.Time
}

func NewHandler(store Store, now func() time.Time) *Handler {
	if now == nil {
		now = time.Now
	}
	return &Handler{store: store, now: now}
}

func (handler *Handler) Heartbeat(w http.ResponseWriter, r *http.Request) {
	var payload HeartbeatRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	payload.CurrentPath = strings.TrimSpace(payload.CurrentPath)
	payload.CurrentPageTitle = strings.TrimSpace(payload.CurrentPageTitle)
	if payload.CurrentPath == "" || payload.CurrentPageTitle == "" ||
		utf8.RuneCountInString(payload.CurrentPath) > 255 ||
		utf8.RuneCountInString(payload.CurrentPageTitle) > 255 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "current_path and current_page_title must contain 1 to 255 characters")
		return
	}

	identity, ok := requestIdentity(w, r)
	if !ok {
		return
	}
	now := handler.now().UTC()
	displayName := strings.TrimSpace(identity.Name)
	if displayName == "" {
		displayName = strings.TrimSpace(identity.Operator)
	}
	if identity.UserID != "" && displayName != "" {
		avatar := defaultAvatarURL
		input := UpsertInput{
			UserID:           identity.UserID,
			DisplayName:      displayName,
			Email:            optionalValue(identity.Email),
			AvatarURL:        &avatar,
			CurrentPath:      payload.CurrentPath,
			CurrentPageTitle: payload.CurrentPageTitle,
		}
		if err := handler.store.UpsertPresence(r.Context(), input, now); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	handler.writeResponse(w, r, identity.UserID, 90, now)
}

func (handler *Handler) Get(w http.ResponseWriter, r *http.Request) {
	staleAfter := 90
	if raw := strings.TrimSpace(r.URL.Query().Get("stale_after_seconds")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 30 || parsed > 300 {
			httpapi.WriteDetail(w, http.StatusBadRequest, "stale_after_seconds must be between 30 and 300")
			return
		}
		staleAfter = parsed
	}
	identity, ok := requestIdentity(w, r)
	if !ok {
		return
	}
	handler.writeResponse(w, r, identity.UserID, staleAfter, handler.now().UTC())
}

func (handler *Handler) writeResponse(
	w http.ResponseWriter,
	r *http.Request,
	currentUserID string,
	staleAfter int,
	now time.Time,
) {
	items, err := handler.store.ListActivePresence(
		r.Context(),
		currentUserID,
		now.Add(-time.Duration(staleAfter)*time.Second),
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if items == nil {
		items = []UserItem{}
	}

	serverTime := now
	if value, err := handler.store.ServerTime(r.Context()); err == nil && !value.IsZero() {
		serverTime = value
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, Response{
		ServerTime: httpapi.Timestamp(serverTime),
		Items:      items,
	})
}

func requestIdentity(w http.ResponseWriter, r *http.Request) (auth.UserContext, bool) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok || strings.TrimSpace(identity.UserID) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "未登录")
		return auth.UserContext{}, false
	}
	return identity, true
}

func optionalValue(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
