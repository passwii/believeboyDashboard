package ai_insight

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

func MutationMetaFromRequest(r *http.Request, operator string) MutationMeta {
	traceID := ""
	if r != nil {
		traceID = httpserver.RequestIDFromContext(r.Context())
		if traceID == "" {
			traceID = r.Header.Get("X-Request-ID")
		}
	}
	meta := MutationMeta{Operator: operator, TraceID: traceID}
	if r == nil {
		return meta
	}
	meta.RequestMethod = r.Method
	meta.RequestPath = r.URL.Path
	meta.UserAgent = r.UserAgent()
	meta.IdempotencyKey = r.Header.Get("Idempotency-Key")
	if meta.IdempotencyKey == "" {
		meta.IdempotencyKey = r.Header.Get("X-Idempotency-Key")
	}
	ip := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	if ip == "" {
		host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
		if err == nil {
			ip = host
		} else {
			ip = strings.TrimSpace(r.RemoteAddr)
		}
	}
	meta.IPAddress = ip
	return meta
}

func AuditEntry(meta MutationMeta, action, targetType, targetID string, before, after any, err error) audit.Entry {
	operator := strings.TrimSpace(meta.Operator)
	entry := audit.Entry{
		Action:     action,
		TargetType: targetType,
		BeforeJSON: before,
		AfterJSON:  after,
		Result:     "success",
	}
	if operator != "" {
		entry.Operator = &operator
	}
	if targetID != "" {
		entry.TargetID = &targetID
	}
	if meta.RequestMethod != "" {
		entry.RequestMethod = &meta.RequestMethod
	}
	if meta.RequestPath != "" {
		entry.RequestPath = &meta.RequestPath
	}
	if meta.IPAddress != "" {
		entry.IPAddress = &meta.IPAddress
	}
	if meta.UserAgent != "" {
		entry.UserAgent = &meta.UserAgent
	}
	if meta.TraceID != "" {
		entry.TraceID = &meta.TraceID
	}
	if meta.IdempotencyKey != "" {
		entry.IdempotencyKey = &meta.IdempotencyKey
	}
	if err != nil {
		entry.Result = "failure"
		message := err.Error()
		entry.ErrorMessage = &message
	}
	return entry
}

func NewUUID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate uuid: %w", err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(raw[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" +
		encoded[16:20] + "-" + encoded[20:32], nil
}

func CalculateDateRange(strategy string, reference time.Time) (time.Time, time.Time) {
	location := reference.Location()
	today := time.Date(reference.Year(), reference.Month(), reference.Day(), 0, 0, 0, 0, location)
	yesterday := today.AddDate(0, 0, -1)
	switch strategy {
	case "last_7d":
		return today.AddDate(0, 0, -7), yesterday
	case "last_30d":
		return today.AddDate(0, 0, -30), yesterday
	case "prev_month":
		first := time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, location)
		end := first.AddDate(0, 0, -1)
		start := time.Date(end.Year(), end.Month(), 1, 0, 0, 0, 0, location)
		return start, end
	case "current_month":
		return time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, location), yesterday
	case "last_week":
		offset := (int(today.Weekday()) + 6) % 7
		lastMonday := today.AddDate(0, 0, -offset-7)
		return lastMonday, lastMonday.AddDate(0, 0, 6)
	default:
		return yesterday, yesterday
	}
}

func DateOnly(value time.Time) string {
	return value.Format("2006-01-02")
}
