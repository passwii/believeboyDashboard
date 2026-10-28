package notifications

import (
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Notification struct {
	ID        int64
	UserID    int64
	Type      string
	Title     string
	Message   *string
	Data      json.RawMessage
	Read      bool
	ReadAt    *time.Time
	CreatedAt time.Time
}

type ListParams struct {
	Type     *string
	Read     *bool
	Page     int
	PageSize int
}

type Store interface {
	List(ctx context.Context, userID string, params ListParams) ([]Notification, int, error)
	UnreadCount(ctx context.Context, userID string) (int, error)
}

type Handler struct {
	store Store
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	var notificationType *string
	if values, present := r.URL.Query()["type"]; present {
		raw := ""
		if len(values) > 0 {
			raw = values[len(values)-1]
		}
		if raw != "" {
			notificationType = &raw
		}
	}
	validationErrors := make([]httpapi.ValidationError, 0, 3)
	read, readErr := httpapi.ParseOptionalBoolQuery(r, "read")
	if readErr != nil {
		validationErrors = append(validationErrors, *readErr)
	}
	pageParam, pageErr := httpapi.ParseIntegerQuery(r, "page")
	if pageErr != nil {
		validationErrors = append(validationErrors, *pageErr)
	}
	page := 1
	if pageErr == nil && pageParam.Present {
		if validationErr := httpapi.ValidateIntegerMinimum(pageParam, "page", 1); validationErr != nil {
			validationErrors = append(validationErrors, *validationErr)
		}
		page = pageParam.IntSaturated()
	}
	pageSizeParam, pageSizeErr := httpapi.ParseIntegerQuery(r, "page_size")
	if pageSizeErr != nil {
		validationErrors = append(validationErrors, *pageSizeErr)
	}
	pageSize := 20
	if pageSizeErr == nil && pageSizeParam.Present {
		if validationErr := httpapi.ValidateIntegerMinimum(pageSizeParam, "page_size", 1); validationErr != nil {
			validationErrors = append(validationErrors, *validationErr)
		}
		if validationErr := httpapi.ValidateIntegerMaximum(pageSizeParam, "page_size", 100); validationErr != nil {
			validationErrors = append(validationErrors, *validationErr)
		}
		pageSize = int(pageSizeParam.Value.Int64())
	}
	if len(validationErrors) > 0 {
		httpapi.WriteValidationErrors(w, validationErrors)
		return
	}

	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	rows, total, err := h.store.List(r.Context(), userID, ListParams{
		Type:     notificationType,
		Read:     read,
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	items := make([]notificationResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, notificationResponse{
			ID:        row.ID,
			UserID:    row.UserID,
			Type:      row.Type,
			Title:     row.Title,
			Message:   row.Message,
			Data:      row.Data,
			Read:      row.Read,
			ReadAt:    httpapi.OptionalTimestamp(row.ReadAt),
			CreatedAt: httpapi.Timestamp(row.CreatedAt),
		})
	}
	pageNumber := pageParam.Canonical
	if !pageParam.Present {
		pageNumber = "1"
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, listResponse{
		Items:    items,
		Total:    total,
		Page:     json.Number(pageNumber),
		PageSize: pageSize,
	})
}

func (h *Handler) UnreadCount(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	count, err := h.store.UnreadCount(r.Context(), userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, unreadCountResponse{Count: count})
}

type listResponse struct {
	Items    []notificationResponse `json:"items"`
	Total    int                    `json:"total"`
	Page     json.Number            `json:"page"`
	PageSize int                    `json:"page_size"`
}

type notificationResponse struct {
	ID        int64           `json:"id"`
	UserID    int64           `json:"user_id"`
	Type      string          `json:"type"`
	Title     string          `json:"title"`
	Message   *string         `json:"message"`
	Data      json.RawMessage `json:"data"`
	Read      bool            `json:"read"`
	ReadAt    *string         `json:"read_at"`
	CreatedAt string          `json:"created_at"`
}

type unreadCountResponse struct {
	Count int `json:"count"`
}

func requireUserID(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := r.Header.Get("X-User-Id")
	if raw == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "X-User-Id required")
		return "", false
	}
	userID, ok := parseUserID(raw)
	if !ok {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid X-User-Id")
		return "", false
	}
	return userID, true
}

func parseUserID(raw string) (string, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", false
	}
	sign := ""
	if strings.HasPrefix(text, "+") {
		text = text[1:]
	} else if strings.HasPrefix(text, "-") {
		sign = "-"
		text = text[1:]
	}
	if text == "" || strings.HasPrefix(text, "_") || strings.HasSuffix(text, "_") {
		return "", false
	}
	previousUnderscore := false
	for i, char := range text {
		if char == '_' {
			if i == 0 || i == len(text)-1 || previousUnderscore {
				return "", false
			}
			previousUnderscore = true
			continue
		}
		if char < '0' || char > '9' {
			return "", false
		}
		previousUnderscore = false
	}
	canonical := sign + strings.ReplaceAll(text, "_", "")
	value, ok := new(big.Int).SetString(canonical, 10)
	if !ok {
		return "", false
	}
	return value.String(), true
}
