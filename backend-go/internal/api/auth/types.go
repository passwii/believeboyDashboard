package auth

import "time"

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// Account is the authentication projection of a user_accounts row.
type Account struct {
	ID                string
	Name              string
	Email             string
	FullName          *string
	IsAdmin           bool
	IsActive          bool
	RoleType          string
	PasswordChangedAt *time.Time
}

type LoginResponse struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Email     string  `json:"email"`
	FullName  *string `json:"full_name"`
	IsAdmin   bool    `json:"is_admin"`
	IsActive  bool    `json:"is_active"`
	RoleType  string  `json:"role_type"`
	SessionID string  `json:"session_id"`
	APIKey    string  `json:"api_key"`
}

type MeResponse struct {
	ID                string  `json:"id"`
	Email             string  `json:"email"`
	Name              string  `json:"name"`
	FullName          *string `json:"full_name"`
	IsAdmin           bool    `json:"is_admin"`
	IsActive          bool    `json:"is_active"`
	RoleType          string  `json:"role_type"`
	PasswordChangedAt *string `json:"password_changed_at"`
}
