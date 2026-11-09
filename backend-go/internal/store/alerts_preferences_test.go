package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
)

func TestAlertStoreGetPreferenceUpsertsDefaults(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{
		true,
		true,
		"warning",
		pgtype.Text{},
		pgtype.Text{},
	}}}

	got, err := NewAlertStore(db).GetPreference(context.Background(), 42)
	if err != nil {
		t.Fatalf("GetPreference() error = %v", err)
	}
	if got == nil || !got.EmailEnabled || !got.InAppEnabled || got.MinSeverity != "warning" ||
		got.QuietHoursStart != nil || got.QuietHoursEnd != nil {
		t.Fatalf("GetPreference() = %#v, want defaults", got)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	for _, fragment := range []string{
		"insert into public.alert_preferences",
		"on conflict (user_id)",
		"returning",
		"to_char(quiet_hours_start, 'hh24:mi')",
	} {
		if !strings.Contains(query, fragment) {
			t.Errorf("SQL = %s, want %q", query, fragment)
		}
	}
	if !assertWriteArgsEqual(db.queryRowCalls[0].args, []any{int64(42)}) {
		t.Errorf("args = %#v, want user id", db.queryRowCalls[0].args)
	}
}

func TestAlertStoreUpdatePreferenceCommitsPatchAndAudit(t *testing.T) {
	quietStart := "22:30"
	emailEnabled := false
	minSeverity := "critical"
	db := newAlertPreferenceWriteDB(
		fakeRow{values: []any{
			true,
			true,
			"warning",
			pgtype.Text{String: "21:00", Valid: true},
			pgtype.Text{},
		}},
		fakeRow{values: []any{
			false,
			true,
			"critical",
			pgtype.Text{String: "22:30", Valid: true},
			pgtype.Text{},
		}},
	)
	auditEntry := alerts.AuditContext{
		Action:     "alerts.preferences.update",
		TargetType: "alert_preference",
		Operator:   stringPointerForTest("operator-a"),
	}

	got, err := NewAlertStore(db).UpdatePreference(
		context.Background(),
		42,
		alerts.UpdatePreferenceInput{
			Patch: alerts.PreferencePatch{
				EmailEnabled:       &emailEnabled,
				MinSeverity:        &minSeverity,
				QuietHoursStart:    &quietStart,
				QuietHoursEnd:      nil,
				QuietHoursStartSet: true,
				QuietHoursEndSet:   true,
			},
			Audit: auditEntry,
		},
	)
	if err != nil {
		t.Fatalf("UpdatePreference() error = %v", err)
	}
	if got == nil || got.EmailEnabled || !got.InAppEnabled || got.MinSeverity != "critical" ||
		got.QuietHoursStart == nil || *got.QuietHoursStart != "22:30" || got.QuietHoursEnd != nil {
		t.Fatalf("UpdatePreference() = %#v, want patched preference", got)
	}
	if !db.tx.committed || db.tx.rolledBack {
		t.Fatalf("transaction committed=%v rolledBack=%v", db.tx.committed, db.tx.rolledBack)
	}
	if len(db.tx.queryRowCalls) != 2 {
		t.Fatalf("tx QueryRow calls = %#v, want select + update", db.tx.queryRowCalls)
	}
	selectQuery := strings.ToLower(db.tx.queryRowCalls[0].sql)
	if !strings.Contains(selectQuery, "for update") ||
		!strings.Contains(selectQuery, "from public.alert_preferences") {
		t.Errorf("select SQL = %s, want locked current row", selectQuery)
	}
	updateQuery := strings.ToLower(db.tx.queryRowCalls[1].sql)
	for _, fragment := range []string{
		"update public.alert_preferences",
		"email_enabled = coalesce",
		"quiet_hours_start = case",
		"updated_at = now()",
		"returning",
	} {
		if !strings.Contains(updateQuery, fragment) {
			t.Errorf("update SQL = %s, want %q", updateQuery, fragment)
		}
	}

	auditCall := alertPreferenceAuditCall(t, db.tx.execCalls)
	if len(auditCall.args) < 12 || auditCall.args[1] != "alerts.preferences.update" ||
		auditCall.args[2] != "alert_preference" {
		t.Fatalf("audit args = %#v, want action/target", auditCall.args)
	}
	targetID, _ := auditCall.args[3].(*string)
	if targetID == nil || *targetID != "42" {
		t.Fatalf("audit target = %#v, want 42", auditCall.args[3])
	}
	before := decodeAuditJSON(t, auditCall.args[10])
	after := decodeAuditJSON(t, auditCall.args[11])
	if before["min_severity"] != "warning" || after["min_severity"] != "critical" ||
		after["quiet_hours_end"] != nil {
		t.Fatalf("audit before=%#v after=%#v", before, after)
	}
}

func TestAlertStoreUpdatePreferenceCreatesDefaultRowInsideTransaction(t *testing.T) {
	db := newAlertPreferenceWriteDB(
		fakeRow{err: pgx.ErrNoRows},
		fakeRow{values: []any{
			false,
			true,
			"warning",
			pgtype.Text{},
			pgtype.Text{},
		}},
	)
	emailEnabled := false

	got, err := NewAlertStore(db).UpdatePreference(
		context.Background(),
		42,
		alerts.UpdatePreferenceInput{
			Patch: alerts.PreferencePatch{EmailEnabled: &emailEnabled},
			Audit: alerts.AuditContext{
				Action:     "alerts.preferences.update",
				TargetType: "alert_preference",
			},
		},
	)
	if err != nil {
		t.Fatalf("UpdatePreference() error = %v", err)
	}
	if got == nil || got.EmailEnabled || got.MinSeverity != "warning" {
		t.Fatalf("UpdatePreference() = %#v, want patched default preference", got)
	}
	if !db.tx.committed {
		t.Fatal("transaction did not commit")
	}
	insertFound := false
	for _, call := range db.tx.execCalls {
		if strings.Contains(strings.ToLower(call.sql), "insert into public.alert_preferences") {
			insertFound = true
		}
	}
	if !insertFound {
		t.Fatalf("exec calls = %#v, want default preference insert", db.tx.execCalls)
	}
	alertPreferenceAuditCall(t, db.tx.execCalls)
}

func TestAlertStoreUpdatePreferenceRollsBackWhenAuditFails(t *testing.T) {
	db := newAlertPreferenceWriteDB(
		fakeRow{values: []any{
			true,
			true,
			"warning",
			pgtype.Text{},
			pgtype.Text{},
		}},
		fakeRow{values: []any{
			false,
			true,
			"warning",
			pgtype.Text{},
			pgtype.Text{},
		}},
	)
	db.auditErr = errors.New("audit unavailable")
	emailEnabled := false

	_, err := NewAlertStore(db).UpdatePreference(
		context.Background(),
		42,
		alerts.UpdatePreferenceInput{
			Patch: alerts.PreferencePatch{EmailEnabled: &emailEnabled},
			Audit: alerts.AuditContext{
				Action:     "alerts.preferences.update",
				TargetType: "alert_preference",
			},
		},
	)
	if err == nil || !strings.Contains(err.Error(), "audit unavailable") {
		t.Fatalf("UpdatePreference() error = %v, want audit failure", err)
	}
	if db.tx.committed || !db.tx.rolledBack {
		t.Fatalf("transaction committed=%v rolledBack=%v, want rollback", db.tx.committed, db.tx.rolledBack)
	}
}

func TestAlertStoreUpdatePreferenceRequiresTransaction(t *testing.T) {
	_, err := NewAlertStore(&fakeDB{}).UpdatePreference(
		context.Background(),
		42,
		alerts.UpdatePreferenceInput{},
	)
	if !errors.Is(err, alerts.ErrPreferencesUnavailable) {
		t.Fatalf("UpdatePreference() error = %v, want ErrPreferencesUnavailable", err)
	}
}

type alertPreferenceWriteDB struct {
	rowQueue  []pgx.Row
	execTag   pgconn.CommandTag
	tx        *alertPreferenceWriteTx
	execCalls []queryCall
	auditErr  error
}

func newAlertPreferenceWriteDB(rows ...pgx.Row) *alertPreferenceWriteDB {
	return &alertPreferenceWriteDB{
		rowQueue: rows,
		execTag:  pgconn.NewCommandTag("UPDATE 1"),
	}
}

func (db *alertPreferenceWriteDB) Query(context.Context, string, ...any) (Rows, error) {
	return &fakeRows{}, nil
}

func (db *alertPreferenceWriteDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.execCalls = append(db.execCalls, queryCall{sql: sql, args: args})
	if len(db.rowQueue) == 0 {
		return fakeRow{err: pgx.ErrNoRows}
	}
	row := db.rowQueue[0]
	db.rowQueue = db.rowQueue[1:]
	return row
}

func (*alertPreferenceWriteDB) Ping(context.Context) error { return nil }

func (db *alertPreferenceWriteDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execCalls = append(db.execCalls, queryCall{sql: sql, args: args})
	return db.execTag, nil
}

func (db *alertPreferenceWriteDB) Begin(context.Context) (pgx.Tx, error) {
	db.tx = &alertPreferenceWriteTx{db: db, execTag: db.execTag, auditErr: db.auditErr}
	return db.tx, nil
}

type alertPreferenceWriteTx struct {
	db            *alertPreferenceWriteDB
	execTag       pgconn.CommandTag
	queryRowCalls []queryCall
	execCalls     []queryCall
	committed     bool
	rolledBack    bool
	auditErr      error
}

func (tx *alertPreferenceWriteTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := tx.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return fakePgxRows{rows: rows}, nil
}

func (tx *alertPreferenceWriteTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	tx.queryRowCalls = append(tx.queryRowCalls, queryCall{sql: sql, args: args})
	return tx.db.QueryRow(ctx, sql, args...)
}

func (tx *alertPreferenceWriteTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.execCalls = append(tx.execCalls, queryCall{sql: sql, args: args})
	if tx.auditErr != nil && strings.Contains(sql, "operation_audit_logs") {
		return pgconn.CommandTag{}, tx.auditErr
	}
	return tx.execTag, nil
}

func (tx *alertPreferenceWriteTx) Commit(context.Context) error {
	tx.committed = true
	return nil
}

func (tx *alertPreferenceWriteTx) Rollback(context.Context) error {
	if !tx.committed {
		tx.rolledBack = true
	}
	return nil
}

func (*alertPreferenceWriteTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}

func (*alertPreferenceWriteTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}

func (*alertPreferenceWriteTx) LargeObjects() pgx.LargeObjects {
	return pgx.LargeObjects{}
}

func (*alertPreferenceWriteTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (*alertPreferenceWriteTx) Conn() *pgx.Conn { return nil }

func (tx *alertPreferenceWriteTx) Begin(context.Context) (pgx.Tx, error) {
	return tx, nil
}

func alertPreferenceAuditCall(t *testing.T, calls []queryCall) queryCall {
	t.Helper()
	for _, call := range calls {
		if strings.Contains(call.sql, "operation_audit_logs") {
			return call
		}
	}
	t.Fatalf("audit call not found in %#v", calls)
	return queryCall{}
}

func decodeAuditJSON(t *testing.T, raw any) map[string]any {
	t.Helper()
	bytesValue, ok := raw.([]byte)
	if !ok {
		t.Fatalf("audit JSON = %#v, want []byte", raw)
	}
	var result map[string]any
	if err := json.Unmarshal(bytesValue, &result); err != nil {
		t.Fatalf("decode audit JSON: %v", err)
	}
	return result
}

func stringPointerForTest(value string) *string {
	return &value
}
