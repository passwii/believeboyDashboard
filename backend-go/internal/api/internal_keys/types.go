package internal_keys

import (
	"errors"
	"time"
)

var (
	ErrAPIKeyUpdateConflict = errors.New("active provisioning credential already exists")
	ErrAPIKeyConflict       = errors.New("agent API key conflicts with an active provisioning credential")
	ErrAPIKeyNotFound       = errors.New("API key not found")
)

type APIKey struct {
	ID            int64
	KeyPrefix     string
	Label         string
	Scope         string
	ProjectScope  string
	BusinessScope string
	AgentID       *string
	ItemKey       *string
	IsRevoked     bool
	ExpiresAt     *time.Time
	CreatedAt     time.Time
	LastUsedAt    *time.Time
	DeletedAt     *time.Time
}

type APIKeyCreateInput struct {
	Label         string
	Scope         string
	ProjectScope  string
	BusinessScope string
	ExpiresAt     *time.Time
	AgentID       *string
	ItemKey       *string
}

type APIKeyCreateRequest struct {
	Label         string     `json:"label"`
	Scope         string     `json:"scope"`
	ProjectScope  string     `json:"project_scope"`
	BusinessScope string     `json:"business_scope"`
	ExpiresAt     *time.Time `json:"expires_at"`
	AgentID       *string    `json:"agent_id"`
	ItemKey       *string    `json:"item_key"`
}

type APIKeyUpdateInput struct {
	Label         *string
	ProjectScope  *string
	BusinessScope *string
	ItemKey       *string
}

type APIKeyUpdateRequest struct {
	Label         *string `json:"label"`
	ProjectScope  *string `json:"project_scope"`
	BusinessScope *string `json:"business_scope"`
	ItemKey       *string `json:"item_key"`
}

type APIKeyItem struct {
	ID            int64   `json:"id"`
	KeyPrefix     string  `json:"key_prefix"`
	Label         string  `json:"label"`
	Scope         string  `json:"scope"`
	ProjectScope  string  `json:"project_scope"`
	BusinessScope string  `json:"business_scope"`
	AgentID       *string `json:"agent_id"`
	ItemKey       *string `json:"item_key"`
	IsRevoked     bool    `json:"is_revoked"`
	ExpiresAt     *string `json:"expires_at"`
	CreatedAt     string  `json:"created_at"`
	LastUsedAt    *string `json:"last_used_at"`
	DeletedAt     *string `json:"deleted_at"`
}

type APIKeyCreateResponse struct {
	ID            int64   `json:"id"`
	KeyPrefix     string  `json:"key_prefix"`
	Label         string  `json:"label"`
	Scope         string  `json:"scope"`
	ProjectScope  string  `json:"project_scope"`
	BusinessScope string  `json:"business_scope"`
	AgentID       *string `json:"agent_id"`
	ItemKey       *string `json:"item_key"`
	ExpiresAt     *string `json:"expires_at"`
	CreatedAt     string  `json:"created_at"`
	PlaintextKey  string  `json:"plaintext_key"`
}

type UserAPIKey struct {
	ID         int64
	UserID     string
	ClientID   string
	KeyPrefix  string
	RevokedAt  *time.Time
	CreatedAt  *time.Time
	RevokedNow bool
}

type UserAPIKeyCreateRequest struct {
	UserID   string `json:"user_id"`
	ClientID string `json:"client_id"`
}

type UserAPIKeyItem struct {
	ID        int64   `json:"id"`
	UserID    string  `json:"user_id"`
	ClientID  string  `json:"client_id"`
	KeyPrefix string  `json:"key_prefix"`
	RevokedAt *string `json:"revoked_at"`
	CreatedAt *string `json:"created_at"`
}

type UserAPIKeyCreateResponse struct {
	UserID       string `json:"user_id"`
	ClientID     string `json:"client_id"`
	KeyPrefix    string `json:"key_prefix"`
	PlaintextKey string `json:"plaintext_key"`
}
