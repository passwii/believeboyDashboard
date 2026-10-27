package auth

import (
	"context"
	"net/http"
	"net/url"
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
	name := decodeHeaderValue(r.Header.Get("X-User-Name"))
	operator := decodeHeaderValue(r.Header.Get("X-Operator"))
	if operator == "" {
		operator = name
	}

	return UserContext{
		UserID:    decodeHeaderValue(r.Header.Get("X-User-Id")),
		Email:     decodeHeaderValue(r.Header.Get("X-User-Email")),
		Name:      name,
		Operator:  operator,
		RoleType:  decodeHeaderValue(r.Header.Get("X-Role-Type")),
		SessionID: decodeHeaderValue(r.Header.Get("X-Session-Id")),
		IsAdmin:   isTruthy(r.Header.Get("X-Is-Admin")),
	}
}

func decodeHeaderValue(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}

	if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	return strings.TrimSpace(value)
}

func isTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
