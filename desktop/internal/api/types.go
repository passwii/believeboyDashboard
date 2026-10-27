package api

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
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

// Project is the subset of /api/v1/projects/manage used by the native shell.
// That route stays on FastAPI during week one and reaches it through Gateway.
type Project struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	IsActive    bool    `json:"is_active"`
	Country     string  `json:"country"`
	CountryName *string `json:"country_name"`
}

func (c *Client) Health(ctx context.Context) (HealthResponse, error) {
	var result HealthResponse
	err := c.Get(ctx, "/api/v1/health", &result)
	return result, err
}

func (c *Client) UnreadCount(ctx context.Context) (UnreadCountResponse, error) {
	var result UnreadCountResponse
	err := c.Get(ctx, "/api/v1/notifications/unread-count", &result)
	return result, err
}

func (c *Client) AlertStats(ctx context.Context, projectID int) (AlertStats, error) {
	path := "/api/v1/alerts/stats"
	if projectID > 0 {
		path += "?project_id=" + strconv.Itoa(projectID)
	}
	var result AlertStats
	err := c.Get(ctx, path, &result)
	return result, err
}

func (c *Client) CurrentProfile(ctx context.Context) (Profile, error) {
	var result Profile
	err := c.Get(ctx, "/api/v1/system-management/profile", &result)
	return result, err
}

func (c *Client) ManagedProjects(ctx context.Context) ([]Project, error) {
	var result []Project
	err := c.Get(ctx, "/api/v1/projects/manage", &result)
	return result, err
}
