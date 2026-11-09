package ai_chat

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

// RequestUserID reads the authenticated proxy identity. It falls back to the
// raw header only for isolated handler tests; production requests always carry
// the middleware-bound context.
func RequestUserID(request *http.Request) *int64 {
	if identity, ok := auth.UserContextFromContext(request.Context()); ok {
		return ParseUserID(identity.UserID)
	}
	return ParseUserID(request.Header.Get("X-User-Id"))
}

func ParseUserID(raw string) *int64 {
	text := strings.TrimSpace(raw)
	if text == "" {
		return nil
	}
	sign := ""
	if strings.HasPrefix(text, "+") {
		text = text[1:]
	} else if strings.HasPrefix(text, "-") {
		sign = "-"
		text = text[1:]
	}
	if text == "" || strings.HasPrefix(text, "_") || strings.HasSuffix(text, "_") {
		return nil
	}
	previousUnderscore := false
	for _, char := range text {
		if char == '_' {
			if previousUnderscore {
				return nil
			}
			previousUnderscore = true
			continue
		}
		if char < '0' || char > '9' {
			return nil
		}
		previousUnderscore = false
	}
	value, err := strconv.ParseInt(sign+strings.ReplaceAll(text, "_", ""), 10, 64)
	if err != nil {
		return nil
	}
	return &value
}
