package store

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
)

func TestAlertStoreDetectRequiresTransaction(t *testing.T) {
	_, err := NewAlertStore(&fakeDB{}).Detect(
		context.Background(),
		alerts.DetectionInput{Today: "2026-11-08"},
	)
	if !errors.Is(err, alerts.ErrDetectionUnavailable) {
		t.Fatalf("Detect() error = %v, want ErrDetectionUnavailable", err)
	}
}

func TestAlertStoreDetectReturnsConflictWhenAdvisoryLockIsBusy(t *testing.T) {
	db := newAlertDetectDB(false)
	_, err := NewAlertStore(db).Detect(
		context.Background(),
		alerts.DetectionInput{Today: "2026-11-08"},
	)
	if !errors.Is(err, alerts.ErrDetectionConflict) {
		t.Fatalf("Detect() error = %v, want ErrDetectionConflict", err)
	}
	if db.tx.committed || !db.tx.rolledBack {
		t.Fatalf("transaction committed=%v rolledBack=%v, want rollback", db.tx.committed, db.tx.rolledBack)
	}
}

func TestAlertStoreDetectCreatesEventAndAuditInOneTransaction(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	ruleValues := alertRuleScanValues(7, createdAt)
	ruleValues[4] = "sales_amount"
	ruleValues[6] = "drop_pct"
	ruleValues[7] = float64(20)
	db := newAlertDetectDB(true)
	db.rows = &fakeRows{batches: [][]any{ruleValues}}
	db.baseline = 100
	db.current = 70
	db.duplicate = false
	entry := alerts.AuditContext{
		Action:     "alerts.detect",
		TargetType: "alert_detection",
		Operator:   stringPointerForTest("admin-a"),
	}

	result, err := NewAlertStore(db).Detect(
		context.Background(),
		alerts.DetectionInput{Today: "2026-11-08", Audit: entry},
	)
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if result.RulesEvaluated != 1 || result.EventsCreated != 1 || result.MessagesSent != 1 {
		t.Fatalf("Detect() = %#v, want one evaluated/created/sent", result)
	}
	if !db.tx.committed || db.tx.rolledBack {
		t.Fatalf("transaction committed=%v rolledBack=%v", db.tx.committed, db.tx.rolledBack)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("rules Query() calls = %#v, want one locked rule query", db.queryCalls)
	}
	rulesQuery := strings.ToLower(db.queryCalls[0].sql)
	if !strings.Contains(rulesQuery, "from public.alert_rules") ||
		!strings.Contains(rulesQuery, "is_active = true") ||
		!strings.Contains(rulesQuery, "for update") {
		t.Errorf("rules SQL = %s, want active rules FOR UPDATE", rulesQuery)
	}

	metricFound := false
	for _, call := range db.tx.queryRowCalls {
		query := strings.ToLower(call.sql)
		if strings.Contains(query, "analysis_business_rows") {
			metricFound = true
			if len(call.args) != 4 ||
				call.args[0] != int64(3) ||
				call.args[1] != "US" ||
				call.args[2] != "2026-11-08" ||
				call.args[3] != 7 {
				t.Errorf("metric args = %#v (%T,%T,%T,%T), want project/country/date/window",
					call.args, call.args[0], call.args[1], call.args[2], call.args[3])
			}
		}
	}
	if !metricFound {
		t.Fatalf("metric query missing from %#v", db.tx.queryRowCalls)
	}

	eventCall := alertDetectExecCall(t, db.tx.execCalls, "insert into public.alert_events")
	if len(eventCall.args) != 8 ||
		eventCall.args[0] != int64(7) ||
		eventCall.args[2] != "sales_amount" ||
		eventCall.args[3] != 70.0 ||
		eventCall.args[4] != 100.0 ||
		math.Abs(eventCall.args[5].(float64)-(-30.0)) > 0.000001 ||
		eventCall.args[7] != "销售额下降 -30.0%，当前 70，基线 100" {
		t.Errorf(
			"event mismatch len=%d id=%v metric=%v current=%v baseline=%v deviation=%v message=%q want_message=%q",
			len(eventCall.args),
			eventCall.args[0],
			eventCall.args[2],
			eventCall.args[3],
			eventCall.args[4],
			eventCall.args[5],
			eventCall.args[7],
			"销售额下降 -30.0%，当前 70，基线 100",
		)
	}

	auditCall := alertDetectExecCall(t, db.tx.execCalls, "operation_audit_logs")
	if len(auditCall.args) < 12 || auditCall.args[1] != "alerts.detect" ||
		auditCall.args[2] != "alert_detection" {
		t.Fatalf("audit args = %#v", auditCall.args)
	}
	after := decodeAuditJSON(t, auditCall.args[11])
	if after["rules_evaluated"] != float64(1) ||
		after["events_created"] != float64(1) ||
		after["messages_sent"] != float64(1) {
		t.Fatalf("detect audit after = %#v", after)
	}
}

func TestAlertStoreDetectSkipsDuplicateActiveEvent(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	ruleValues := alertRuleScanValues(7, createdAt)
	ruleValues[4] = "sales_amount"
	ruleValues[6] = "drop_pct"
	ruleValues[7] = float64(20)
	db := newAlertDetectDB(true)
	db.rows = &fakeRows{batches: [][]any{ruleValues}}
	db.baseline = 100
	db.current = 70
	db.duplicate = true

	result, err := NewAlertStore(db).Detect(
		context.Background(),
		alerts.DetectionInput{Today: "2026-11-08"},
	)
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if result.RulesEvaluated != 1 || result.EventsCreated != 0 || result.MessagesSent != 0 {
		t.Fatalf("Detect() = %#v, want duplicate skipped", result)
	}
	for _, call := range db.tx.execCalls {
		if strings.Contains(call.sql, "insert into public.alert_events") {
			t.Fatalf("duplicate detection inserted event: %#v", call)
		}
	}
}

func TestAlertStoreDetectIgnoresUnsupportedMetrics(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	ruleValues := alertRuleScanValues(8, createdAt)
	ruleValues[4] = "return_rate"
	db := newAlertDetectDB(true)
	db.rows = &fakeRows{batches: [][]any{ruleValues}}

	result, err := NewAlertStore(db).Detect(
		context.Background(),
		alerts.DetectionInput{Today: "2026-11-08"},
	)
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if result.RulesEvaluated != 1 || result.EventsCreated != 0 {
		t.Fatalf("Detect() = %#v, want evaluated unsupported rule", result)
	}
	for _, call := range db.tx.queryRowCalls {
		if strings.Contains(call.sql, "analysis_") {
			t.Fatalf("unsupported metric queried data: %#v", call)
		}
	}
}

type alertDetectDB struct {
	rows          Rows
	lock          bool
	duplicate     bool
	baseline      float64
	current       float64
	queryCalls    []queryCall
	execCalls     []queryCall
	queryRowCalls []queryCall
	tx            *alertDetectTx
	auditErr      error
}

func newAlertDetectDB(lock bool) *alertDetectDB {
	db := &alertDetectDB{
		lock: lock,
		rows: &fakeRows{},
	}
	return db
}

func (db *alertDetectDB) Query(_ context.Context, sql string, args ...any) (Rows, error) {
	db.queryCalls = append(db.queryCalls, queryCall{sql: sql, args: args})
	return db.rows, nil
}

func (db *alertDetectDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.queryRowCalls = append(db.queryRowCalls, queryCall{sql: sql, args: args})
	query := strings.ToLower(sql)
	switch {
	case strings.Contains(query, "pg_try_advisory_xact_lock"):
		return fakeRow{values: []any{db.lock}}
	case strings.Contains(query, "analysis_business_rows") ||
		strings.Contains(query, "ad_campaign_report_rows"):
		return fakeRow{values: []any{db.baseline, db.current}}
	case strings.Contains(query, "select exists"):
		return fakeRow{values: []any{db.duplicate}}
	default:
		return fakeRow{err: errors.New("unexpected QueryRow SQL: " + sql)}
	}
}

func (*alertDetectDB) Ping(context.Context) error { return nil }

func (db *alertDetectDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execCalls = append(db.execCalls, queryCall{sql: sql, args: args})
	return pgconn.NewCommandTag("INSERT 1"), nil
}

func (db *alertDetectDB) Begin(context.Context) (pgx.Tx, error) {
	db.tx = &alertDetectTx{db: db}
	return db.tx, nil
}

type alertDetectTx struct {
	db            *alertDetectDB
	queryRowCalls []queryCall
	execCalls     []queryCall
	committed     bool
	rolledBack    bool
}

func (tx *alertDetectTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := tx.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return fakePgxRows{rows: rows}, nil
}

func (tx *alertDetectTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	tx.queryRowCalls = append(tx.queryRowCalls, queryCall{sql: sql, args: args})
	return tx.db.QueryRow(ctx, sql, args...)
}

func (tx *alertDetectTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.execCalls = append(tx.execCalls, queryCall{sql: sql, args: args})
	if tx.db.auditErr != nil && strings.Contains(sql, "operation_audit_logs") {
		return pgconn.CommandTag{}, tx.db.auditErr
	}
	return pgconn.NewCommandTag("INSERT 1"), nil
}

func (tx *alertDetectTx) Commit(context.Context) error {
	tx.committed = true
	return nil
}

func (tx *alertDetectTx) Rollback(context.Context) error {
	if !tx.committed {
		tx.rolledBack = true
	}
	return nil
}

func (*alertDetectTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}

func (*alertDetectTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}

func (*alertDetectTx) LargeObjects() pgx.LargeObjects {
	return pgx.LargeObjects{}
}

func (*alertDetectTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (*alertDetectTx) Conn() *pgx.Conn { return nil }

func (tx *alertDetectTx) Begin(context.Context) (pgx.Tx, error) {
	return tx, nil
}

func alertDetectExecCall(t *testing.T, calls []queryCall, fragment string) queryCall {
	t.Helper()
	for _, call := range calls {
		if strings.Contains(strings.ToLower(call.sql), strings.ToLower(fragment)) {
			return call
		}
	}
	t.Fatalf("%q not found in %#v", fragment, calls)
	return queryCall{}
}
