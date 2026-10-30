package auth

import (
	"context"
	"net/http"
	"strings"
)

// UserContext is the typed identity attached by the authentication middleware.
// Trusted proxy requests derive it from forwarded headers; device-key requests
// derive it exclusively from the resolved database record.
type UserContext struct {
	UserID               string
	Email                string
	Name                 string
	Operator             string
	RoleType             string
	SessionID            string
	IsAdmin              bool
	IsAdminHeader        string
	IsAdminHeaderPresent bool
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
	adminValues, adminPresent := r.Header[http.CanonicalHeaderKey("X-Is-Admin")]
	adminHeader := ""
	if len(adminValues) > 0 {
		adminHeader = adminValues[0]
	}

	return UserContext{
		UserID:               truncate(DecodeHeaderValue(r.Header.Get("X-User-Id")), 64),
		Email:                DecodeHeaderValue(r.Header.Get("X-User-Email")),
		Name:                 name,
		Operator:             truncate(operator, 255),
		RoleType:             truncate(DecodeHeaderValue(r.Header.Get("X-Role-Type")), 32),
		SessionID:            DecodeHeaderValue(r.Header.Get("X-Session-Id")),
		IsAdmin:              isTruthy(adminHeader),
		IsAdminHeader:        adminHeader,
		IsAdminHeaderPresent: adminPresent,
	}
}

// UserContextFromUserKey binds identity to the database row resolved from the
// device key. Client-supplied identity headers are deliberately not consulted.
func UserContextFromUserKey(record UserKeyRecord) UserContext {
	displayName := truncate(strings.TrimSpace(record.FullName), 255)
	return UserContext{
		UserID:   truncate(record.UserID, 64),
		Email:    record.Email,
		Name:     displayName,
		Operator: displayName,
		RoleType: truncate(record.RoleType, 32),
		IsAdmin:  record.IsAdmin,
	}
}

func truncate(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func isTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
