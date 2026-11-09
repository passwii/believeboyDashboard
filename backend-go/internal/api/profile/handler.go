package profile

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Profile struct {
	ID                string
	Email             string
	Name              string
	FullName          *string
	IsAdmin           bool
	IsActive          bool
	RoleType          string
	AvatarURL         *string
	PasswordChangedAt *time.Time
	CreatedAt         *time.Time
	UpdatedAt         *time.Time
}

type Store interface {
	GetByUserID(ctx context.Context, userID string) (*Profile, error)
}

type UpdateInput struct {
	Name        *string
	FullName    *string
	SetFullName bool
	Operator    *string
	Request     *http.Request
}

type UpdateStore interface {
	UpdateByUserID(ctx context.Context, userID string, input UpdateInput) (*Profile, error)
}

type Handler struct {
	store   Store
	blobs   BlobStore
	auditor Auditor
}

type Option func(*Handler)

func WithBlobStore(blobs BlobStore) Option {
	return func(handler *Handler) {
		handler.blobs = blobs
	}
}

func WithAuditor(auditor Auditor) Option {
	return func(handler *Handler) {
		handler.auditor = auditor
	}
}

type profileResponse struct {
	ID                string  `json:"id"`
	Email             string  `json:"email"`
	Name              string  `json:"name"`
	FullName          *string `json:"full_name"`
	IsAdmin           bool    `json:"is_admin"`
	IsActive          bool    `json:"is_active"`
	RoleType          string  `json:"role_type"`
	AvatarURL         *string `json:"avatar_url"`
	PasswordChangedAt *string `json:"password_changed_at"`
	CreatedAt         *string `json:"created_at"`
	UpdatedAt         *string `json:"updated_at"`
}

func NewHandler(store Store, options ...Option) *Handler {
	handler := &Handler{store: store}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	return handler
}

func (h *Handler) GetProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	userID := truncateHeaderValue(user.UserID, 64)
	if userID == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}

	row, err := h.store.GetByUserID(r.Context(), userID)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if row == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, serializeProfile(row))
}

func (h *Handler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	userID := truncateHeaderValue(user.UserID, 64)
	if userID == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}

	writer, ok := h.store.(UpdateStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	var payload struct {
		Name     *string `json:"name"`
		FullName *string `json:"full_name"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	var rawFields map[string]json.RawMessage
	if err := json.Unmarshal(body, &rawFields); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	rawFullName, fullNamePresent := rawFields["full_name"]
	setFullName := fullNamePresent && strings.TrimSpace(string(rawFullName)) != "null"

	if payload.Name != nil {
		if utf8.RuneCountInString(*payload.Name) < 1 {
			httpapi.WriteValidationErrors(w, []httpapi.ValidationError{{
				Type:  "string_too_short",
				Loc:   []string{"body", "name"},
				Msg:   "String should have at least 1 character",
				Input: *payload.Name,
				Ctx:   map[string]int{"min_length": 1},
			}})
			return
		}
		if utf8.RuneCountInString(*payload.Name) > 255 {
			httpapi.WriteValidationErrors(w, []httpapi.ValidationError{{
				Type:  "string_too_long",
				Loc:   []string{"body", "name"},
				Msg:   "String should have at most 255 characters",
				Input: *payload.Name,
				Ctx:   map[string]int{"max_length": 255},
			}})
			return
		}
		cleaned := strings.TrimSpace(*payload.Name)
		if cleaned == "" {
			httpapi.WriteDetail(w, http.StatusBadRequest, "姓名不能为空")
			return
		}
		payload.Name = &cleaned
	}
	if payload.FullName != nil {
		if utf8.RuneCountInString(*payload.FullName) > 255 {
			httpapi.WriteValidationErrors(w, []httpapi.ValidationError{{
				Type:  "string_too_long",
				Loc:   []string{"body", "full_name"},
				Msg:   "String should have at most 255 characters",
				Input: *payload.FullName,
				Ctx:   map[string]int{"max_length": 255},
			}})
			return
		}
		cleaned := strings.TrimSpace(*payload.FullName)
		if cleaned == "" {
			payload.FullName = nil
		} else {
			payload.FullName = &cleaned
		}
	}

	var operator *string
	if value := strings.TrimSpace(user.Operator); value != "" {
		operator = &value
	}
	row, err := writer.UpdateByUserID(r.Context(), userID, UpdateInput{
		Name:        payload.Name,
		FullName:    payload.FullName,
		SetFullName: setFullName,
		Operator:    operator,
		Request:     r,
	})
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if row == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializeProfile(row))
}

func serializeProfile(row *Profile) profileResponse {
	role := row.RoleType
	if role == "" {
		if row.IsAdmin {
			role = "admin"
		} else {
			role = "operator"
		}
	}
	return profileResponse{
		ID:                row.ID,
		Email:             row.Email,
		Name:              row.Name,
		FullName:          row.FullName,
		IsAdmin:           row.IsAdmin,
		IsActive:          row.IsActive,
		RoleType:          role,
		AvatarURL:         row.AvatarURL,
		PasswordChangedAt: optionalTimestamp(row.PasswordChangedAt),
		CreatedAt:         optionalTimestamp(row.CreatedAt),
		UpdatedAt:         optionalTimestamp(row.UpdatedAt),
	}
}

func truncateHeaderValue(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func optionalTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := isoformat(*value)
	return &formatted
}

func isoformat(value time.Time) string {
	value = value.UTC()
	base := value.Format("2006-01-02T15:04:05")
	if value.Nanosecond() != 0 {
		base += "." + formatFraction(value.Nanosecond())
	}
	return base + "+00:00"
}

func formatFraction(nanoseconds int) string {
	fraction := strings.TrimRight(leftPad(nanoseconds, 9), "0")
	for len(fraction) < 6 {
		fraction += "0"
	}
	return fraction
}

func leftPad(value, width int) string {
	raw := strings.Repeat("0", width) + itoa(value)
	return raw[len(raw)-width:]
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[i:])
}
