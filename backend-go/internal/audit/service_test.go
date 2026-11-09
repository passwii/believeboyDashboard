package audit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

type mockExecer struct {
	calls []execCall
}

type execCall struct {
	sql  string
	args []any
}

func (m *mockExecer) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	m.calls = append(m.calls, execCall{sql: sql, args: args})
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func TestPopulateFromRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", nil)
	req.Header.Set("X-Request-ID", "req-123")
	req.Header.Set("X-Forwarded-For", "192.168.1.100, 10.0.0.1")
	req.Header.Set("User-Agent", "TestClient/1.0")
	req.Header.Set("Idempotency-Key", "idem-456")

	entry := Entry{
		Action:     "projects.create",
		TargetType: "project",
	}
	entry.PopulateFromRequest(req)

	if entry.TraceID == nil || *entry.TraceID != "req-123" {
		t.Errorf("TraceID = %v, want req-123", entry.TraceID)
	}
	if entry.RequestMethod == nil || *entry.RequestMethod != "POST" {
		t.Errorf("RequestMethod = %v, want POST", entry.RequestMethod)
	}
	if entry.RequestPath == nil || *entry.RequestPath != "/api/v1/projects" {
		t.Errorf("RequestPath = %v, want /api/v1/projects", entry.RequestPath)
	}
	if entry.IPAddress == nil || *entry.IPAddress != "192.168.1.100" {
		t.Errorf("IPAddress = %v, want 192.168.1.100", entry.IPAddress)
	}
	if entry.UserAgent == nil || *entry.UserAgent != "TestClient/1.0" {
		t.Errorf("UserAgent = %v, want TestClient/1.0", entry.UserAgent)
	}
	if entry.IdempotencyKey == nil || *entry.IdempotencyKey != "idem-456" {
		t.Errorf("IdempotencyKey = %v, want idem-456", entry.IdempotencyKey)
	}
}

func TestLogActionMasksSensitiveKeysAndAppendsRisk(t *testing.T) {
	execer := &mockExecer{}
	svc := NewService(execer)

	operator := "test-operator"
	agentID := "agent-99"
	entry := Entry{
		Action:     "auth.update",
		TargetType: "user",
		Operator:   &operator,
		AgentID:    &agentID, // Has agent ID but NO idempotency key -> triggers risk: no_idempotency
		BeforeJSON: map[string]any{
			"password": "secret-password",
			"username": "user1",
		},
		AfterJSON: map[string]any{
			"api_key":  "secret-key",
			"username": "user1-updated",
		},
	}

	err := svc.LogAction(context.Background(), entry)
	if err != nil {
		t.Fatalf("LogAction error: %v", err)
	}

	if len(execer.calls) != 1 {
		t.Fatalf("execer calls count = %d, want 1", len(execer.calls))
	}
	call := execer.calls[0]
	if !strings.Contains(call.sql, "INSERT INTO public.operation_audit_logs") {
		t.Errorf("sql = %s, want insert statement", call.sql)
	}

	// Arg 10 is before_json, Arg 11 is after_json
	beforeBytes := call.args[10].([]byte)
	afterBytes := call.args[11].([]byte)

	var beforeMap, afterMap map[string]any
	if err := json.Unmarshal(beforeBytes, &beforeMap); err != nil {
		t.Fatalf("unmarshal before_json: %v", err)
	}
	if err := json.Unmarshal(afterBytes, &afterMap); err != nil {
		t.Fatalf("unmarshal after_json: %v", err)
	}

	if beforeMap["password"] != "***" {
		t.Errorf("password in before = %v, want ***", beforeMap["password"])
	}
	if beforeMap["username"] != "user1" {
		t.Errorf("username in before = %v, want user1", beforeMap["username"])
	}

	if afterMap["api_key"] != "***" {
		t.Errorf("api_key in after = %v, want ***", afterMap["api_key"])
	}
	if afterMap["risk"] != "no_idempotency" {
		t.Errorf("risk in after = %v, want no_idempotency", afterMap["risk"])
	}
}

func TestClipHelper(t *testing.T) {
	longStr := strings.Repeat("a", 300)
	clipped := clip(&longStr, 255)
	if clipped == nil || len(*clipped) != 255 {
		t.Errorf("len(clipped) = %d, want 255", len(*clipped))
	}

	empty := ""
	if clip(&empty, 10) != nil {
		t.Errorf("clip(empty) should be nil")
	}
}

func TestMockService(t *testing.T) {
	mock := NewMockService()
	op := "op1"
	entry := Entry{Action: "test", TargetType: "test", Operator: &op}
	_ = mock.LogAction(context.Background(), entry)
	_ = mock.LogView(context.Background(), "view", "test", &op, nil, nil)

	if len(mock.Entries) != 1 {
		t.Errorf("Entries len = %d, want 1", len(mock.Entries))
	}
	if len(mock.Views) != 1 {
		t.Errorf("Views len = %d, want 1", len(mock.Views))
	}
}
