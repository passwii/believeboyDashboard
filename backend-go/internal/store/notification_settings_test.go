package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notification_settings"
)

func TestNotificationSettingsStoreListAndGet(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	values := notificationSettingScanValues(4, createdAt)
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rows: &fakeRows{batches: [][]any{values}},
		row:  fakeRow{values: values},
	}}
	store := NewNotificationSettingsStore(db)

	items, err := store.ListSettings(context.Background(), "3")
	if err != nil || len(items) != 1 || items[0].ID != 4 {
		t.Fatalf("ListSettings() = %#v, %v, want setting 4", items, err)
	}
	if items[0].ProjectID != 3 || items[0].RuleName != "daily report" ||
		items[0].CreatedBy == nil || *items[0].CreatedBy != 12 ||
		len(items[0].ReportTypes) != 1 || items[0].ReportTypes[0] != "financial" {
		t.Errorf("ListSettings() item = %#v, want decoded subscription fields", items[0])
	}
	if len(db.queryCalls) != 1 || !strings.Contains(strings.ToLower(db.queryCalls[0].sql), "where project_id = $1::integer") {
		t.Fatalf("ListSettings SQL = %#v, want project filter", db.queryCalls)
	}
	if got, want := db.queryCalls[0].args, []any{"3"}; !assertWriteArgsEqual(got, want) {
		t.Errorf("ListSettings args = %#v, want %#v", got, want)
	}

	item, err := store.GetSetting(context.Background(), 4)
	if err != nil || item == nil || item.ID != 4 {
		t.Fatalf("GetSetting() = %#v, %v, want setting 4", item, err)
	}
}

func TestNotificationSettingsStoreCreateUpdateDelete(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	values := notificationSettingScanValues(4, createdAt)
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: values}}, execTag: pgconn.NewCommandTag("DELETE 1")}
	store := NewNotificationSettingsStore(db)
	input := notification_settings.Setting{
		ProjectID:   3,
		RuleName:    "daily report",
		Frequency:   "daily",
		ReportTypes: []string{"financial"},
		Recipients:  []string{"ops@example.com"},
		Enabled:     true,
	}

	created, err := store.CreateSetting(context.Background(), input)
	if err != nil || created == nil || created.ID != 4 {
		t.Fatalf("CreateSetting() = %#v, %v, want created row", created, err)
	}
	if query := strings.ToLower(db.queryRowCalls[0].sql); !strings.Contains(query, "insert into public.notification_subscriptions") || !strings.Contains(query, "returning") {
		t.Errorf("Create SQL = %s, want INSERT RETURNING", query)
	}
	if args := db.queryRowCalls[0].args; len(args) != 7 || args[0] != input.ProjectID || args[1] != input.RuleName {
		t.Errorf("Create args = %#v, want seven subscription values", args)
	}

	db.queryRowCalls = nil
	updated, err := store.UpdateSetting(context.Background(), 4, input)
	if err != nil || updated == nil || updated.ID != 4 {
		t.Fatalf("UpdateSetting() = %#v, %v, want updated row", updated, err)
	}
	if query := strings.ToLower(db.queryRowCalls[0].sql); !strings.Contains(query, "update public.notification_subscriptions") || !strings.Contains(query, "updated_at = now()") {
		t.Errorf("Update SQL = %s, want UPDATE with timestamp", query)
	}

	deleted, err := store.DeleteSetting(context.Background(), 4)
	if err != nil || !deleted {
		t.Fatalf("DeleteSetting() = %v, %v, want true", deleted, err)
	}
	if len(db.execCalls) != 1 || !strings.Contains(strings.ToLower(db.execCalls[0].sql), "delete from public.notification_subscriptions") {
		t.Fatalf("Delete Exec() = %#v, want subscription delete", db.execCalls)
	}
}

func TestNotificationSettingsStoreMissingRowsAndErrors(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}}
	store := NewNotificationSettingsStore(db)
	if got, err := store.GetSetting(context.Background(), 100); err != nil || got != nil {
		t.Errorf("GetSetting() = %#v, %v, want nil", got, err)
	}
	if got, err := store.UpdateSetting(context.Background(), 100, notification_settings.Setting{}); err != nil || got != nil {
		t.Errorf("UpdateSetting() = %#v, %v, want nil", got, err)
	}
	if got, err := store.DeleteSetting(context.Background(), 100); err != nil || got {
		t.Errorf("DeleteSetting() = %v, %v, want false", got, err)
	}

	wantErr := errors.New("database unavailable")
	db = &fakeWriteDB{fakeDB: &fakeDB{
		row:     fakeRow{err: wantErr},
		rowsErr: wantErr,
	}, execErr: wantErr}
	store = NewNotificationSettingsStore(db)
	if _, err := store.CreateSetting(context.Background(), notification_settings.Setting{}); !errors.Is(err, wantErr) {
		t.Errorf("CreateSetting() error = %v, want %v", err, wantErr)
	}
	if _, err := store.ListSettings(context.Background(), "3"); !errors.Is(err, wantErr) {
		t.Errorf("ListSettings() error = %v, want %v", err, wantErr)
	}
	if _, err := store.DeleteSetting(context.Background(), 4); !errors.Is(err, wantErr) {
		t.Errorf("DeleteSetting() error = %v, want %v", err, wantErr)
	}
}

func TestNotificationSettingsStoreFindTestEmailAttempt(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: []any{
		"success",
		[]byte(`{"fingerprint":"fp-1","resend_id":"email_123"}`),
	}}}}
	store := NewNotificationSettingsStore(db)

	attempt, err := store.FindTestEmailAttempt(context.Background(), "idem-1")
	if err != nil {
		t.Fatalf("FindTestEmailAttempt() error = %v", err)
	}
	if attempt == nil || attempt.Fingerprint != "fp-1" ||
		attempt.Result != "success" ||
		attempt.ResendID == nil || *attempt.ResendID != "email_123" {
		t.Fatalf("FindTestEmailAttempt() = %#v", attempt)
	}
	if len(db.queryRowCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "operation_audit_logs") ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "idempotency_key") {
		t.Fatalf("FindTestEmailAttempt SQL = %#v", db.queryRowCalls)
	}

	db.row = fakeRow{err: pgx.ErrNoRows}
	attempt, err = store.FindTestEmailAttempt(context.Background(), "missing")
	if err != nil || attempt != nil {
		t.Fatalf("missing FindTestEmailAttempt() = %#v, %v", attempt, err)
	}
}

func TestNotificationSettingsStoreRecordTestEmailAudit(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{}}
	store := NewNotificationSettingsStore(db)
	operator := "operator-a"
	key := "notification-test-1"
	resendID := "email_123"

	err := store.RecordTestEmailAudit(context.Background(), notification_settings.TestEmailAudit{
		SubscriptionID: 7,
		ProjectID:      3,
		Recipient:      "owner@example.com",
		Frequency:      "daily",
		Fingerprint:    "fp-1",
		Result:         "success",
		ResendID:       &resendID,
		Operator:       &operator,
		IdempotencyKey: &key,
	})
	if err != nil {
		t.Fatalf("RecordTestEmailAudit() error = %v", err)
	}
	if len(db.execCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.execCalls[0].sql), "operation_audit_logs") {
		t.Fatalf("RecordTestEmailAudit Exec() = %#v", db.execCalls)
	}
	args := db.execCalls[0].args
	if len(args) != 11 {
		t.Fatalf("RecordTestEmailAudit args = %#v", args)
	}
	operatorArg, operatorOK := args[0].(*string)
	keyArg, keyOK := args[9].(*string)
	if !operatorOK || *operatorArg != operator ||
		args[1] != "7" ||
		args[2] != "success" ||
		!keyOK || *keyArg != key {
		t.Fatalf("RecordTestEmailAudit args = %#v", args)
	}
}

func notificationSettingScanValues(id int64, timestamp time.Time) []any {
	return []any{
		id, int64(3), "daily report", "daily",
		[]byte(`["financial"]`), []byte(`["ops@example.com"]`), true,
		pgtype.Int4{Int32: 12, Valid: true}, timestamp, timestamp,
	}
}
