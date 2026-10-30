package profile

import (
	"context"
	"net/http"
	"strings"
	"time"

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

type Handler struct {
	store Store
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

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
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

	role := row.RoleType
	if role == "" {
		if row.IsAdmin {
			role = "admin"
		} else {
			role = "operator"
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, profileResponse{
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
	})
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
