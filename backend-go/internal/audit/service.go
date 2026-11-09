package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

// Execer matches the database execution surface needed for writing audit logs.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Entry describes a discrete mutation event to record in operation_audit_logs.
type Entry struct {
	Action         string
	TargetType     string
	TargetID       *string
	Operator       *string
	Result         string // "success" or "failure"
	TraceID        *string
	RequestMethod  *string
	RequestPath    *string
	IPAddress      *string
	UserAgent      *string
	BeforeJSON     any
	AfterJSON      any
	AgentID        *string
	AgentName      *string
	IdempotencyKey *string
	ErrorMessage   *string
}

// PopulateFromRequest extracts standard metadata from an HTTP request.
func (e *Entry) PopulateFromRequest(r *http.Request) {
	if r == nil {
		return
	}
	if e.TraceID == nil {
		traceID := httpserver.RequestIDFromContext(r.Context())
		if traceID == "" {
			traceID = r.Header.Get("X-Request-ID")
		}
		if traceID != "" {
			e.TraceID = &traceID
		}
	}
	if e.RequestMethod == nil {
		method := r.Method
		e.RequestMethod = &method
	}
	if e.RequestPath == nil {
		path := r.URL.Path
		e.RequestPath = &path
	}
	if e.IPAddress == nil {
		ip := extractClientIP(r)
		if ip != "" {
			e.IPAddress = &ip
		}
	}
	if e.UserAgent == nil {
		ua := r.UserAgent()
		if ua != "" {
			e.UserAgent = &ua
		}
	}
	if e.IdempotencyKey == nil {
		ik := r.Header.Get("Idempotency-Key")
		if ik == "" {
			ik = r.Header.Get("X-Idempotency-Key")
		}
		if ik != "" {
			e.IdempotencyKey = &ik
		}
	}
}

// Service is the shared interface for auditing mutating operations and views.
type Service interface {
	LogAction(ctx context.Context, entry Entry) error
	LogActionTx(ctx context.Context, tx pgx.Tx, entry Entry) error
	LogView(ctx context.Context, action string, targetType string, operator *string, after any, r *http.Request) error
}

type AuditService struct {
	db Execer
}

func NewService(db Execer) *AuditService {
	return &AuditService{db: db}
}

const insertAuditLogSQL = `
INSERT INTO public.operation_audit_logs (
	operator, action, target_type, target_id, result, trace_id,
	request_method, request_path, ip_address, user_agent,
	before_json, after_json, agent_id, agent_name, idempotency_key,
	error_message, created_at
) VALUES (
	$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now()
)`

func (s *AuditService) LogAction(ctx context.Context, entry Entry) error {
	if s.db == nil {
		return fmt.Errorf("audit database is nil")
	}
	args, err := prepareAuditArgs(entry)
	if err != nil {
		return fmt.Errorf("prepare audit args: %w", err)
	}
	_, err = s.db.Exec(ctx, insertAuditLogSQL, args...)
	return err
}

func (s *AuditService) LogActionTx(ctx context.Context, tx pgx.Tx, entry Entry) error {
	if tx == nil {
		return fmt.Errorf("tx is nil")
	}
	args, err := prepareAuditArgs(entry)
	if err != nil {
		return fmt.Errorf("prepare audit args: %w", err)
	}
	_, err = tx.Exec(ctx, insertAuditLogSQL, args...)
	return err
}

func (s *AuditService) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	// Matches FastAPI append_operation_view_log: view events are not persisted by default
	// to avoid excessive database noise, while preserving stable call sites.
	return nil
}

func prepareAuditArgs(entry Entry) ([]any, error) {
	result := "success"
	if entry.Result == "failure" {
		result = "failure"
	}

	afterPayload := entry.AfterJSON
	if entry.AgentID != nil && entry.IdempotencyKey == nil {
		marker := map[string]string{"risk": "no_idempotency"}
		if dict, ok := afterPayload.(map[string]any); ok {
			merged := make(map[string]any, len(dict)+1)
			for k, v := range dict {
				merged[k] = v
			}
			merged["risk"] = "no_idempotency"
			afterPayload = merged
		} else if afterPayload == nil {
			afterPayload = marker
		}
	}

	beforeBytes, err := sanitizeAndMarshal(entry.BeforeJSON)
	if err != nil {
		return nil, fmt.Errorf("marshal before_json: %w", err)
	}
	afterBytes, err := sanitizeAndMarshal(afterPayload)
	if err != nil {
		return nil, fmt.Errorf("marshal after_json: %w", err)
	}

	return []any{
		clip(entry.Operator, 255),
		defaultIfEmpty(clip(&entry.Action, 128), "unknown"),
		defaultIfEmpty(clip(&entry.TargetType, 64), "unknown"),
		clip(entry.TargetID, 128),
		result,
		clip(entry.TraceID, 64),
		clip(entry.RequestMethod, 16),
		clip(entry.RequestPath, 255),
		clip(entry.IPAddress, 64),
		clip(entry.UserAgent, 512),
		beforeBytes,
		afterBytes,
		clip(entry.AgentID, 128),
		clip(entry.AgentName, 128),
		clip(entry.IdempotencyKey, 64),
		clip(entry.ErrorMessage, 4000),
	}, nil
}

var sensitiveKeys = map[string]bool{
	"password":      true,
	"password_hash": true,
	"token":         true,
	"access_token":  true,
	"refresh_token": true,
	"authorization": true,
	"cookie":        true,
	"set-cookie":    true,
	"secret":        true,
	"api_key":       true,
	"x-api-key":     true,
}

func sanitizeAndMarshal(val any) ([]byte, error) {
	if val == nil {
		return nil, nil
	}
	cleaned := sanitizeValue(val)
	return json.Marshal(cleaned)
}

func sanitizeValue(val any) any {
	if val == nil {
		return nil
	}
	switch typed := val.(type) {
	case map[string]any:
		res := make(map[string]any, len(typed))
		for k, v := range typed {
			if sensitiveKeys[strings.ToLower(k)] {
				res[k] = "***"
			} else {
				res[k] = sanitizeValue(v)
			}
		}
		return res
	case []any:
		res := make([]any, len(typed))
		for i, v := range typed {
			res[i] = sanitizeValue(v)
		}
		return res
	default:
		// Attempt round-trip if struct or custom type
		bytes, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprint(typed)
		}
		var generic any
		if err := json.Unmarshal(bytes, &generic); err == nil {
			if _, isMap := generic.(map[string]any); isMap {
				return sanitizeValue(generic)
			}
			if _, isSlice := generic.([]any); isSlice {
				return sanitizeValue(generic)
			}
		}
		return typed
	}
}

func clip(val *string, maxLen int) *string {
	if val == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*val)
	if trimmed == "" {
		return nil
	}
	runes := []rune(trimmed)
	if len(runes) > maxLen {
		s := string(runes[:maxLen])
		return &s
	}
	return &trimmed
}

func defaultIfEmpty(val *string, fallback string) string {
	if val == nil || *val == "" {
		return fallback
	}
	return *val
}

func extractClientIP(r *http.Request) string {
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded != "" {
		parts := strings.Split(forwarded, ",")
		return strings.TrimSpace(parts[0])
	}
	addr := r.RemoteAddr
	if idx := strings.LastIndex(addr, ":"); idx != -1 {
		addr = addr[:idx]
	}
	return strings.Trim(addr, "[]")
}
