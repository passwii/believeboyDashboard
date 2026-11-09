package ai_insight

import (
	"errors"
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type TypedError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func WriteTypedDetail(w http.ResponseWriter, status int, code, message string) {
	_ = httpapi.WriteJSON(w, status, map[string]any{
		"detail": TypedError{Code: code, Message: message},
	})
}

func WriteAccessError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	default:
		httpapi.WriteInternalServerError(w)
	}
}

func IsKnownInsightType(value string) bool {
	switch value {
	case "daily", "weekly", "monthly", "custom", "ad_analysis":
		return true
	default:
		return false
	}
}

func NormalizeInsightType(value string) string {
	value = strings.TrimSpace(value)
	if IsKnownInsightType(value) {
		return value
	}
	return "custom"
}

func CanonicalDomains(raw string) map[string]bool {
	enabled := make(map[string]bool)
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "ad_analysis" || item == "inventory_health" {
			enabled[item] = true
		}
	}
	return enabled
}

func IsDomainCanonical(raw, roleID string) bool {
	return CanonicalDomains(raw)[roleID]
}
