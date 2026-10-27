package api

import (
	"bytes"
	"encoding/json"
)

type RoleType string

const (
	RoleAdmin       RoleType = "admin"
	RoleOperator    RoleType = "operator"
	RoleBusinessDev RoleType = "businessdev"
)

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// LoginResponse matches FastAPI's LoginResponse schema.
type LoginResponse struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Email     string   `json:"email"`
	FullName  *string  `json:"full_name"`
	IsAdmin   bool     `json:"is_admin"`
	IsActive  bool     `json:"is_active"`
	RoleType  RoleType `json:"role_type"`
	SessionID string   `json:"session_id"`
	APIKey    string   `json:"api_key"`

	isAdminPresent bool
}

func (r *LoginResponse) UnmarshalJSON(data []byte) error {
	type plain LoginResponse
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	raw, present := fields["is_admin"]
	present = present && !bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
	*r = LoginResponse(decoded)
	r.isAdminPresent = present
	return nil
}

func (r LoginResponse) HasIsAdmin() bool {
	return r.isAdminPresent
}

// The following response types cover the first native shell's read-only cards.
type HealthResponse struct {
	Status          string  `json:"status"`
	Timestamp       float64 `json:"timestamp"`
	Database        string  `json:"database"`
	DatabaseReplica string  `json:"database_replica"`
	Redis           string  `json:"redis"`
	RedisMemory     *string `json:"redis_memory"`
	Version         *string `json:"version"`
}

type UnreadCountResponse struct {
	Count int `json:"count"`
}

type AlertStats struct {
	TotalActive       int `json:"total_active"`
	CriticalCount     int `json:"critical_count"`
	WarningCount      int `json:"warning_count"`
	InfoCount         int `json:"info_count"`
	AcknowledgedToday int `json:"acknowledged_today"`
	ResolvedToday     int `json:"resolved_today"`
}

type Profile struct {
	ID                string   `json:"id"`
	Email             string   `json:"email"`
	Name              string   `json:"name"`
	FullName          *string  `json:"full_name"`
	IsAdmin           bool     `json:"is_admin"`
	IsActive          bool     `json:"is_active"`
	RoleType          RoleType `json:"role_type"`
	AvatarURL         *string  `json:"avatar_url"`
	PasswordChangedAt *string  `json:"password_changed_at"`
	CreatedAt         *string  `json:"created_at"`
	UpdatedAt         *string  `json:"updated_at"`
}
