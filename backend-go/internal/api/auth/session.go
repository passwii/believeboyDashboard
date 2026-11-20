package auth

import (
	"context"
	"time"
)

// SessionManager owns the Redis-backed lifecycle of browser sessions.
// Implementations must fail closed when the session store is unavailable.
type SessionManager interface {
	CreateUserSession(ctx context.Context, userID, sessionID string, issuedAt time.Time) error
	SessionIssuedAt(ctx context.Context, userID, sessionID string) (time.Time, bool, error)
	ValidateSession(ctx context.Context, userID, sessionID string) (bool, error)
	DeleteUserSession(ctx context.Context, userID, sessionID string) error
	DeleteUserSessions(ctx context.Context, userID string) (int, error)
}
