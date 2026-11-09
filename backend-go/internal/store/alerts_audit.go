package store

import (
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func alertAuditEntry(value alerts.AuditContext) audit.Entry {
	return audit.Entry{
		Action:         value.Action,
		TargetType:     value.TargetType,
		TargetID:       value.TargetID,
		Operator:       value.Operator,
		TraceID:        value.TraceID,
		RequestMethod:  value.RequestMethod,
		RequestPath:    value.RequestPath,
		IPAddress:      value.IPAddress,
		UserAgent:      value.UserAgent,
		IdempotencyKey: value.IdempotencyKey,
		BeforeJSON:     value.BeforeJSON,
		AfterJSON:      value.AfterJSON,
	}
}

func alertPreferenceJSON(value *alerts.Preference) map[string]any {
	if value == nil {
		return nil
	}
	return map[string]any{
		"email_enabled":     value.EmailEnabled,
		"in_app_enabled":    value.InAppEnabled,
		"min_severity":      value.MinSeverity,
		"quiet_hours_start": value.QuietHoursStart,
		"quiet_hours_end":   value.QuietHoursEnd,
	}
}
