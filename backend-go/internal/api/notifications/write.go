package notifications

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type WriteStore interface {
	MarkRead(context.Context, string, int64) (*Notification, error)
	MarkAllRead(context.Context, string) (int, error)
	Delete(context.Context, string, int64) (bool, error)
}

func (h *Handler) MarkRead(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	id, ok := notificationID(w, r)
	if !ok {
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	item, err := writer.MarkRead(r.Context(), userID, id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Notification not found")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializeNotification(*item))
}

func (h *Handler) MarkAllRead(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	count, err := writer.MarkAllRead(r.Context(), userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, unreadCountResponse{Count: count})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	id, ok := notificationID(w, r)
	if !ok {
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	deleted, err := writer.Delete(r.Context(), userID, id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !deleted {
		httpapi.WriteDetail(w, http.StatusNotFound, "Notification not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) RegisterWriteRoutes(
	router chi.Router,
	authMiddleware func(http.Handler) http.Handler,
) {
	writeRouter := router
	if authMiddleware != nil {
		writeRouter = router.With(authMiddleware)
	}
	writeRouter.Post("/api/v1/notifications/{notification_id}/read", h.MarkRead)
	writeRouter.Post("/api/v1/notifications/read-all", h.MarkAllRead)
	writeRouter.Post("/api/v1/notifications/mark-all-read", h.MarkAllRead)
	writeRouter.Delete("/api/v1/notifications/{notification_id}", h.Delete)
}

func notificationID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := chi.URLParam(r, "notification_id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid notification_id")
		return 0, false
	}
	return id, true
}

func serializeNotification(item Notification) notificationResponse {
	return notificationResponse{
		ID:        item.ID,
		UserID:    item.UserID,
		Type:      item.Type,
		Title:     item.Title,
		Message:   item.Message,
		Data:      item.Data,
		Read:      item.Read,
		ReadAt:    httpapi.OptionalTimestamp(item.ReadAt),
		CreatedAt: httpapi.Timestamp(item.CreatedAt),
	}
}
