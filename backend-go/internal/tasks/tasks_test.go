package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

type stage6ADB struct {
	execSQL      string
	execArgs     []any
	execTag      pgconn.CommandTag
	execErr      error
	querySQL     string
	queryArgs    []any
	queryRow     pgx.Row
	queryRowSQL  string
	queryRowArgs []any
}

func (db *stage6ADB) Query(_ context.Context, sql string, args ...any) (store.Rows, error) {
	db.querySQL = sql
	db.queryArgs = append([]any(nil), args...)
	return &stage6ARows{}, nil
}

func (db *stage6ADB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.queryRowSQL = sql
	db.queryRowArgs = append([]any(nil), args...)
	if db.queryRow != nil {
		return db.queryRow
	}
	return stage6ARow{err: pgx.ErrNoRows}
}

func (db *stage6ADB) Ping(context.Context) error { return nil }

func (db *stage6ADB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execSQL = sql
	db.execArgs = append([]any(nil), args...)
	if db.execErr != nil {
		return pgconn.CommandTag{}, db.execErr
	}
	if db.execTag.String() == "" {
		return pgconn.NewCommandTag("DELETE 0"), nil
	}
	return db.execTag, nil
}

func (db *stage6ADB) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("transactions are not used by this test double")
}

type stage6ARows struct{}

func (r *stage6ARows) Next() bool        { return false }
func (r *stage6ARows) Scan(...any) error { return pgx.ErrNoRows }
func (r *stage6ARows) Err() error        { return nil }
func (r *stage6ARows) Close()            {}

type stage6ARow struct {
	values []any
	err    error
}

func (r stage6ARow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return errors.New("stage6ARow scan destination mismatch")
	}
	for i, value := range r.values {
		switch target := dest[i].(type) {
		case *int:
			v, ok := value.(int)
			if !ok {
				return errors.New("stage6ARow value is not int")
			}
			*target = v
		case *int64:
			switch v := value.(type) {
			case int64:
				*target = v
			case int:
				*target = int64(v)
			default:
				return errors.New("stage6ARow value is not int64-compatible")
			}
		case *string:
			v, ok := value.(string)
			if !ok {
				return errors.New("stage6ARow value is not string")
			}
			*target = v
		default:
			return errors.New("unsupported stage6ARow scan destination")
		}
	}
	return nil
}

type stage6AExecutor struct {
	calls  []stage6AExecutorCall
	result any
	err    error
}

type stage6AExecutorCall struct {
	taskType string
	payload  any
}

func (e *stage6AExecutor) Execute(_ context.Context, taskType string, payload any) (any, error) {
	e.calls = append(e.calls, stage6AExecutorCall{taskType: taskType, payload: payload})
	return e.result, e.err
}

type stage6ARegistrar struct {
	taskTypes []string
}

func (r *stage6ARegistrar) RegisterHandler(taskType string, _ asynq.HandlerFunc) {
	r.taskTypes = append(r.taskTypes, taskType)
}

func stage6ANewTask(t *testing.T, taskType string, payload any) *asynq.Task {
	t.Helper()
	encoded, err := queue.MarshalPayload(payload)
	if err != nil {
		t.Fatalf("MarshalPayload() error = %v", err)
	}
	return asynq.NewTask(taskType, encoded)
}

func TestStage6AOperationAuditCleanupUsesPayloadRetentionAndAgentScope(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	db := &stage6ADB{execTag: pgconn.NewCommandTag("DELETE 2")}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		OperationAuditRetentionDays: 90,
		Now:                         func() time.Time { return now },
	})

	task := stage6ANewTask(t, queue.TypeOperationAuditCleanup, OperationAuditCleanupPayload{
		RetentionDays: stage6AIntPointer(7),
	})
	if err := handler.HandleOperationAuditCleanup(context.Background(), task); err != nil {
		t.Fatalf("HandleOperationAuditCleanup() error = %v", err)
	}
	if !strings.Contains(db.execSQL, "operation_audit_logs") ||
		!strings.Contains(db.execSQL, "agent_id IS NOT NULL") {
		t.Fatalf("cleanup SQL does not preserve agent-only scope: %s", db.execSQL)
	}
	wantCutoff := now.AddDate(0, 0, -7)
	if len(db.execArgs) != 1 || !reflect.DeepEqual(db.execArgs[0], wantCutoff) {
		t.Fatalf("cleanup args = %#v, want cutoff %s", db.execArgs, wantCutoff)
	}
}

func TestStage6AAgentAPIAuditCleanupExecutesRangeDelete(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	db := &stage6ADB{execTag: pgconn.NewCommandTag("DELETE 5")}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		AgentAPIAuditRetentionDays: 90,
		Now:                        func() time.Time { return now },
	})

	task := stage6ANewTask(t, queue.TypeAgentAPIAuditCleanup, AgentAPIAuditCleanupPayload{})
	if err := handler.HandleAgentAPIAuditCleanup(context.Background(), task); err != nil {
		t.Fatalf("HandleAgentAPIAuditCleanup() error = %v", err)
	}
	if !strings.Contains(db.execSQL, "agent_api_audit_log") ||
		!strings.Contains(db.execSQL, "created_at <") {
		t.Fatalf("cleanup SQL = %s", db.execSQL)
	}
	if len(db.execArgs) != 1 || !reflect.DeepEqual(db.execArgs[0], now.AddDate(0, 0, -90)) {
		t.Fatalf("cleanup args = %#v", db.execArgs)
	}
}

func TestStage6ACRMSeaReclaimReturnsCountsAndWritesFollowLedger(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	db := &stage6ADB{queryRow: stage6ARow{values: []any{int64(2), int64(1)}}}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		CRMSeaReclaimDays: 15,
		Now:               func() time.Time { return now },
	})
	task := stage6ANewTask(t, queue.TypeCRMSeaReclaim, CRMSeaReclaimPayload{
		Days: stage6AIntPointer(15),
	})

	if err := handler.HandleCRMSeaReclaim(context.Background(), task); err != nil {
		t.Fatalf("HandleCRMSeaReclaim() error = %v", err)
	}
	if !strings.Contains(db.queryRowSQL, "UPDATE crm_customers") ||
		!strings.Contains(db.queryRowSQL, "INSERT INTO crm_follows") ||
		!strings.Contains(db.queryRowSQL, "UPDATE crm_leads") {
		t.Fatalf("reclaim SQL does not cover customers, follows and leads: %s", db.queryRowSQL)
	}
	wantCutoff := now.AddDate(0, 0, -15)
	if len(db.queryRowArgs) != 2 ||
		!reflect.DeepEqual(db.queryRowArgs[0], wantCutoff) ||
		!strings.Contains(db.queryRowArgs[1].(string), "15 天") {
		t.Fatalf("reclaim args = %#v", db.queryRowArgs)
	}
}

func TestStage6ACRMTaskReminderUpdatesOnlyDueUnremindedTasks(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	db := &stage6ADB{execTag: pgconn.NewCommandTag("UPDATE 3")}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{Now: func() time.Time { return now }})
	task := stage6ANewTask(t, queue.TypeCRMTaskReminder, CRMTaskReminderPayload{
		LeadHours: stage6AIntPointer(24),
	})

	if err := handler.HandleCRMTaskReminder(context.Background(), task); err != nil {
		t.Fatalf("HandleCRMTaskReminder() error = %v", err)
	}
	if !strings.Contains(db.execSQL, "crm_tasks") ||
		!strings.Contains(db.execSQL, "reminded_at IS NULL") ||
		!strings.Contains(db.execSQL, "reminded_at = $1") {
		t.Fatalf("reminder SQL = %s", db.execSQL)
	}
	if len(db.execArgs) != 2 ||
		!reflect.DeepEqual(db.execArgs[0], now) ||
		!reflect.DeepEqual(db.execArgs[1], now.Add(24*time.Hour)) {
		t.Fatalf("reminder args = %#v", db.execArgs)
	}
}

func TestStage6ACRMFollowUpReminderIsIdempotentAndSelfHealing(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	db := &stage6ADB{queryRow: stage6ARow{values: []any{int64(2), int64(1), int64(3)}}}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{Now: func() time.Time { return now }})
	task := stage6ANewTask(t, queue.TypeCRMFollowUpReminder, CRMFollowUpReminderPayload{
		Days: stage6AIntPointer(7),
	})

	if err := handler.HandleCRMFollowUpReminder(context.Background(), task); err != nil {
		t.Fatalf("HandleCRMFollowUpReminder() error = %v", err)
	}
	if !strings.Contains(db.queryRowSQL, "crm_reminder_logs") ||
		!strings.Contains(db.queryRowSQL, "NOT EXISTS") ||
		!strings.Contains(db.queryRowSQL, "resolved") {
		t.Fatalf("follow-up SQL = %s", db.queryRowSQL)
	}
	wantCutoff := now.AddDate(0, 0, -7)
	if len(db.queryRowArgs) != 2 ||
		!reflect.DeepEqual(db.queryRowArgs[0], wantCutoff) ||
		!reflect.DeepEqual(db.queryRowArgs[1], now) {
		t.Fatalf("follow-up args = %#v", db.queryRowArgs)
	}
}

func TestStage6AAIChatTokenUsageRefreshUsesShanghaiDayWindow(t *testing.T) {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("LoadLocation() error = %v", err)
	}
	db := &stage6ADB{execTag: pgconn.NewCommandTag("INSERT 0 4")}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		Location: location,
		Now:      func() time.Time { return time.Date(2026, 11, 8, 12, 0, 0, 0, location) },
	})
	task := stage6ANewTask(t, queue.TypeAIChatTokenUsageRefreshDaily, AIChatTokenUsageRefreshPayload{
		TargetDate: stage6AStringPointer("2026-11-07"),
	})

	if err := handler.HandleAIChatTokenUsageRefreshDaily(context.Background(), task); err != nil {
		t.Fatalf("HandleAIChatTokenUsageRefreshDaily() error = %v", err)
	}
	if !strings.Contains(db.execSQL, "ai_chat_token_usage_snapshots") ||
		!strings.Contains(db.execSQL, "ON CONFLICT") {
		t.Fatalf("token usage SQL = %s", db.execSQL)
	}
	startUTC := time.Date(2026, 11, 6, 16, 0, 0, 0, time.UTC)
	endUTC := time.Date(2026, 11, 7, 16, 0, 0, 0, time.UTC)
	if len(db.execArgs) < 3 ||
		!reflect.DeepEqual(db.execArgs[0], startUTC) ||
		!reflect.DeepEqual(db.execArgs[1], endUTC) ||
		!reflect.DeepEqual(db.execArgs[2], "2026-11-07") {
		t.Fatalf("token usage args = %#v", db.execArgs)
	}
}

func TestStage6AExecutorDispatchReceivesTypedPayload(t *testing.T) {
	executor := &stage6AExecutor{result: map[string]any{"events": 2}}
	handler := NewTaskHandlerWithDB(&stage6ADB{}, HandlerConfig{Executor: executor})
	task := stage6ANewTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{
		InsightID: stage6AInt64Pointer(11),
	})

	if err := handler.HandleGenerateInsight(context.Background(), task); err != nil {
		t.Fatalf("HandleGenerateInsight() error = %v", err)
	}
	if len(executor.calls) != 1 {
		t.Fatalf("executor calls = %d, want 1", len(executor.calls))
	}
	if executor.calls[0].taskType != queue.TypeGenerateInsight {
		t.Fatalf("executor task type = %q", executor.calls[0].taskType)
	}
	if _, ok := executor.calls[0].payload.(*GenerateInsightPayload); !ok {
		t.Fatalf("executor payload type = %T, want *GenerateInsightPayload", executor.calls[0].payload)
	}
}

func TestStage6AInvalidPayloadAndMissingDBReturnErrors(t *testing.T) {
	handler := NewTaskHandlerWithDB(nil, DefaultHandlerConfig())
	invalid := asynq.NewTask(queue.TypeOperationAuditCleanup, []byte(`{"retention_days":`))
	if err := handler.HandleOperationAuditCleanup(context.Background(), invalid); err == nil {
		t.Fatal("invalid payload error = nil")
	}

	valid := stage6ANewTask(t, queue.TypeOperationAuditCleanup, OperationAuditCleanupPayload{})
	if err := handler.HandleOperationAuditCleanup(context.Background(), valid); err == nil ||
		!strings.Contains(err.Error(), "database") {
		t.Fatalf("missing DB error = %v, want database configuration error", err)
	}
}

func TestStage6ARegisterAllRegistersExactlyEighteenHandlers(t *testing.T) {
	handler := NewTaskHandlerWithDB(nil, DefaultHandlerConfig())
	registrar := &stage6ARegistrar{}
	if err := handler.RegisterAll(registrar); err != nil {
		t.Fatalf("RegisterAll() error = %v", err)
	}
	if len(registrar.taskTypes) != 18 {
		t.Fatalf("registered %d handlers, want 18", len(registrar.taskTypes))
	}
	seen := make(map[string]struct{}, len(registrar.taskTypes))
	for _, taskType := range registrar.taskTypes {
		if _, duplicate := seen[taskType]; duplicate {
			t.Fatalf("duplicate registration for %q", taskType)
		}
		seen[taskType] = struct{}{}
	}
	for _, taskType := range queue.AllTaskTypes() {
		if _, ok := seen[taskType]; !ok {
			t.Fatalf("missing registration for %q", taskType)
		}
	}
}

func TestStage6ANilTaskDoesNotPanic(t *testing.T) {
	handler := NewTaskHandlerWithDB(&stage6ADB{}, DefaultHandlerConfig())
	if err := handler.HandleAlertDetect(context.Background(), nil); err == nil {
		t.Fatal("nil task error = nil")
	}
}

func TestStage6APayloadJSONTagsAreStable(t *testing.T) {
	payload := DispatchOnePayload{
		SubscriptionID: 9,
		Email:          "ops@example.com",
		ProjectIDs:     []int64{1, 2},
		Country:        "US",
		Frequency:      "daily",
		TriggeredBy:    "auto",
		ReportDate:     "2026-11-08",
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	for _, key := range []string{
		`"subscription_id"`,
		`"email"`,
		`"project_ids"`,
		`"country"`,
		`"frequency"`,
		`"triggered_by"`,
		`"report_date"`,
	} {
		if !strings.Contains(string(encoded), key) {
			t.Fatalf("payload %s missing key %s", encoded, key)
		}
	}
}

func stage6AIntPointer(value int) *int          { return &value }
func stage6AInt64Pointer(value int64) *int64    { return &value }
func stage6AStringPointer(value string) *string { return &value }
