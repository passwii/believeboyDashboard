package alerts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type preferencePatchRequest struct {
	EmailEnabled    json.RawMessage `json:"email_enabled"`
	InAppEnabled    json.RawMessage `json:"in_app_enabled"`
	MinSeverity     json.RawMessage `json:"min_severity"`
	QuietHoursStart json.RawMessage `json:"quiet_hours_start"`
	QuietHoursEnd   json.RawMessage `json:"quiet_hours_end"`
}

type preferenceResponse struct {
	EmailEnabled    bool    `json:"email_enabled"`
	InAppEnabled    bool    `json:"in_app_enabled"`
	MinSeverity     string  `json:"min_severity"`
	QuietHoursStart *string `json:"quiet_hours_start"`
	QuietHoursEnd   *string `json:"quiet_hours_end"`
}

func (h *Handler) GetPreferences(w http.ResponseWriter, r *http.Request) {
	userID, ok := preferenceIdentity(w, r)
	if !ok {
		return
	}

	store, available := h.store.(PreferenceStore)
	if !available {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Alert preferences dependency unavailable")
		return
	}
	preference, err := store.GetPreference(r.Context(), userID)
	if err != nil {
		if errors.Is(err, ErrPreferencesUnavailable) {
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Alert preferences dependency unavailable")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	if preference == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializePreference(*preference))
}

func (h *Handler) UpdatePreferences(w http.ResponseWriter, r *http.Request) {
	userID, ok := preferenceIdentity(w, r)
	if !ok {
		return
	}

	patch, err := decodePreferencePatch(r)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}

	store, available := h.store.(PreferenceStore)
	if !available {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Alert preferences dependency unavailable")
		return
	}
	targetID := strconv.FormatInt(userID, 10)
	entry := newAuditContext(r, "alerts.preferences.update", "alert_preference", &targetID)
	preference, err := store.UpdatePreference(r.Context(), userID, UpdatePreferenceInput{
		Patch: patch,
		Audit: entry,
	})
	if err != nil {
		if errors.Is(err, ErrPreferencesUnavailable) {
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Alert preferences dependency unavailable")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	if preference == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializePreference(*preference))
}

func preferenceIdentity(w http.ResponseWriter, r *http.Request) (int64, bool) {
	operator := requestOperator(r)
	if operator == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Operator required")
		return 0, false
	}

	user, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return 0, false
	}
	userID, ok := parsePreferenceUserID(user.UserID)
	if !ok || userID == 0 {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return 0, false
	}
	return userID, true
}

func parsePreferenceUserID(raw string) (int64, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, false
	}

	negative := false
	switch value[0] {
	case '+':
		value = value[1:]
	case '-':
		negative = true
		value = value[1:]
	}
	if value == "" || value[0] == '_' || value[len(value)-1] == '_' {
		return 0, false
	}

	previousUnderscore := false
	for _, char := range value {
		if char == '_' {
			if previousUnderscore {
				return 0, false
			}
			previousUnderscore = true
			continue
		}
		if char < '0' || char > '9' {
			return 0, false
		}
		previousUnderscore = false
	}

	number := strings.ReplaceAll(value, "_", "")
	if negative {
		number = "-" + number
	}
	parsed, err := strconv.ParseInt(number, 10, 32)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func decodePreferencePatch(r *http.Request) (PreferencePatch, error) {
	var raw json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := decoder.Decode(&raw); err != nil {
		return PreferencePatch{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return PreferencePatch{}, errors.New("multiple JSON values")
		}
		return PreferencePatch{}, err
	}
	if isJSONNull(raw) {
		return PreferencePatch{}, errors.New("request body cannot be null")
	}

	var request preferencePatchRequest
	strictDecoder := json.NewDecoder(bytes.NewReader(raw))
	strictDecoder.DisallowUnknownFields()
	if err := strictDecoder.Decode(&request); err != nil {
		return PreferencePatch{}, err
	}

	var patch PreferencePatch
	var err error
	if raw := request.EmailEnabled; len(raw) > 0 {
		if isJSONNull(raw) {
			return PreferencePatch{}, errors.New("email_enabled cannot be null")
		}
		patch.EmailEnabled, err = decodeBool(raw)
		if err != nil {
			return PreferencePatch{}, fmt.Errorf("email_enabled: %w", err)
		}
	}
	if raw := request.InAppEnabled; len(raw) > 0 {
		if isJSONNull(raw) {
			return PreferencePatch{}, errors.New("in_app_enabled cannot be null")
		}
		patch.InAppEnabled, err = decodeBool(raw)
		if err != nil {
			return PreferencePatch{}, fmt.Errorf("in_app_enabled: %w", err)
		}
	}
	if raw := request.MinSeverity; len(raw) > 0 {
		if isJSONNull(raw) {
			return PreferencePatch{}, errors.New("min_severity cannot be null")
		}
		value, decodeErr := decodeString(raw)
		if decodeErr != nil || len(value) > 16 || !validMinSeverity(value) {
			return PreferencePatch{}, errors.New("min_severity must be info, warning or critical")
		}
		patch.MinSeverity = &value
	}
	if raw := request.QuietHoursStart; len(raw) > 0 {
		patch.QuietHoursStartSet = true
		if !isJSONNull(raw) {
			value, decodeErr := decodeString(raw)
			if decodeErr != nil || !validClockTime(value) {
				return PreferencePatch{}, errors.New("quiet_hours_start must use HH:MM")
			}
			patch.QuietHoursStart = &value
		}
	}
	if raw := request.QuietHoursEnd; len(raw) > 0 {
		patch.QuietHoursEndSet = true
		if !isJSONNull(raw) {
			value, decodeErr := decodeString(raw)
			if decodeErr != nil || !validClockTime(value) {
				return PreferencePatch{}, errors.New("quiet_hours_end must use HH:MM")
			}
			patch.QuietHoursEnd = &value
		}
	}
	return patch, nil
}

func decodeBool(raw json.RawMessage) (*bool, error) {
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func decodeString(raw json.RawMessage) (string, error) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	return value, nil
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func validClockTime(value string) bool {
	if len(value) != 5 || value[2] != ':' {
		return false
	}
	for _, index := range []int{0, 1, 3, 4} {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	hour, _ := strconv.Atoi(value[:2])
	minute, _ := strconv.Atoi(value[3:])
	return hour <= 23 && minute <= 59
}

func validMinSeverity(value string) bool {
	switch value {
	case "info", "warning", "critical":
		return true
	default:
		return false
	}
}

func serializePreference(value Preference) preferenceResponse {
	return preferenceResponse{
		EmailEnabled:    value.EmailEnabled,
		InAppEnabled:    value.InAppEnabled,
		MinSeverity:     value.MinSeverity,
		QuietHoursStart: value.QuietHoursStart,
		QuietHoursEnd:   value.QuietHoursEnd,
	}
}
