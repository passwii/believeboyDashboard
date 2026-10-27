package auth

import (
	"context"
	"net/http"
	"strings"
)

// UserContext is the typed form of the user headers forwarded by the web proxy
// and the native desktop client.
type UserContext struct {
	UserID    string
	Email     string
	Name      string
	Operator  string
	RoleType  string
	SessionID string
	IsAdmin   bool
}

type userContextKey struct{}

func WithUserContext(ctx context.Context, user UserContext) context.Context {
	return context.WithValue(ctx, userContextKey{}, user)
}

func UserContextFromContext(ctx context.Context) (UserContext, bool) {
	user, ok := ctx.Value(userContextKey{}).(UserContext)
	return user, ok
}

func UserContextFromRequest(r *http.Request) UserContext {
	name := DecodeHeaderValue(r.Header.Get("X-User-Name"))
	operator := DecodeHeaderValue(r.Header.Get("X-Operator"))
	if operator == "" {
		operator = name
	}

	return UserContext{
		UserID:    truncate(DecodeHeaderValue(r.Header.Get("X-User-Id")), 64),
		Email:     DecodeHeaderValue(r.Header.Get("X-User-Email")),
		Name:      name,
		Operator:  truncate(operator, 255),
		RoleType:  truncate(DecodeHeaderValue(r.Header.Get("X-Role-Type")), 32),
		SessionID: DecodeHeaderValue(r.Header.Get("X-Session-Id")),
		IsAdmin:   isTruthy(r.Header.Get("X-Is-Admin")),
	}
}

func truncate(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func isTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
