package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
)

func TestScheduledReportStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()
	if err := NewScheduledReportStore(&scheduledTestDB{}).VerifyProjectAccess(ctx, 1, "", true); err != nil {
		t.Fatalf("admin access error = %v", err)
	}

	missing := NewScheduledReportStore(&scheduledTestDB{row: scheduledTestRow{err: pgx.ErrNoRows}})
	if err := missing.VerifyProjectAccess(ctx, 999, "operator-a", false); !errors.Is(err, scheduled_reports.ErrProjectNotFound) {
		t.Fatalf("missing project error = %v", err)
	}

	projectOperator := "operator-a,operator-b"
	assistantOperator := "operator-c"
	allowed := NewScheduledReportStore(&scheduledTestDB{row: scheduledTestRow{values: []any{
		&projectOperator,
		&assistantOperator,
	}}})
	if err := allowed.VerifyProjectAccess(ctx, 7, "operator-a", false); err != nil {
		t.Fatalf("project operator access error = %v", err)
	}
	if err := allowed.VerifyProjectAccess(ctx, 7, "operator-c", false); err != nil {
		t.Fatalf("assistant operator access error = %v", err)
	}
	if err := allowed.VerifyProjectAccess(ctx, 7, "operator-x", false); !errors.Is(err, scheduled_reports.ErrProjectForbidden) {
		t.Fatalf("forbidden operator error = %v", err)
	}
}

func TestScheduledReportStoreCreateAndUpdateUseRealTables(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	email := "owner@example.com"
	userID := 10
	weekday := 1
	rowValues := []any{
		int64(11),
		&userID,
		&email,
		"1,2",
		"US",
		"weekly",
		16,
		0,
		&weekday,
		nil,
		(*string)(nil),
		true,
		now,
		now,
	}
	db := &scheduledTestDB{row: scheduledTestRow{values: rowValues}}
	store := NewScheduledReportStore(db)

	created, err := store.CreateSubscription(context.Background(), scheduled_reports.SubscriptionCreateInput{
		UserID:          &userID,
		Email:           &email,
		ProjectIDs:      "1,2",
		Country:         "US",
		Frequency:       "weekly",
		DispatchHour:    16,
		DispatchMinute:  0,
		DispatchWeekday: &weekday,
	})
	if err != nil {
		t.Fatalf("CreateSubscription() error = %v", err)
	}
	if created.ID != 11 || created.UserID == nil || *created.UserID != 10 || created.Frequency != "weekly" {
		t.Fatalf("created subscription = %#v", created)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "insert into public.scheduled_report_subscriptions") ||
		!strings.Contains(query, "returning") {
		t.Fatalf("CreateSubscription SQL = %s", query)
	}

	enabled := false
	db.queryRowCalls = nil
	db.row = scheduledTestRow{values: rowValues}
	updated, err := store.UpdateSubscription(context.Background(), 11, scheduled_reports.SubscriptionPatch{
		Enabled: scheduled_reports.Optional[bool]{Set: true, Value: &enabled},
	})
	if err != nil {
		t.Fatalf("UpdateSubscription() error = %v", err)
	}
	if updated == nil || updated.ID != 11 {
		t.Fatalf("updated subscription = %#v", updated)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("Update QueryRow calls = %d", len(db.queryRowCalls))
	}
	updateSQL := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(updateSQL, "update public.scheduled_report_subscriptions") ||
		!strings.Contains(updateSQL, "enabled = $2") ||
		!strings.Contains(updateSQL, "updated_at = now()") {
		t.Fatalf("UpdateSubscription SQL = %s", updateSQL)
	}
}

func TestScheduledReportStorePrepareResendLocksLedgerAndCreatesManualLog(t *testing.T) {
	ctx := context.Background()
	userID := 10
	email := "owner@example.com"
	weekday := 1
	db := &scheduledTestDB{
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			scheduledTestRow{values: []any{
				9, 7, "weekly", "2026-11-03", &email, "1,2", "US", "failed", 3,
			}},
			scheduledTestRow{values: []any{
				7, &userID, &email, "1,2", "US", "weekly", 16, 0, &weekday, nil, (*string)(nil), true,
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			}},
			scheduledTestRow{values: []any{3, "failed", "auto", "failed"}},
			scheduledTestRow{values: []any{22}},
		},
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	store := NewScheduledReportStore(db)
	result, err := store.PrepareResend(ctx, scheduled_reports.ResendRequest{
		LedgerKey: "7:2026-11-03",
		Force:     true,
	})
	if err != nil {
		t.Fatalf("PrepareResend() error = %v", err)
	}
	if result.DeliveryLogID == nil || *result.DeliveryLogID != 22 ||
		result.SubscriptionID != 7 || result.ReportDate != "2026-11-03" ||
		result.OldLogID == nil || *result.OldLogID != 3 {
		t.Fatalf("resend result = %#v", result)
	}
	if len(db.queryRowCalls) != 5 {
		t.Fatalf("QueryRow calls = %d, want lock/ledger/subscription/log/insert", len(db.queryRowCalls))
	}
	wantFragments := []string{
		"pg_advisory_xact_lock",
		"public.scheduled_report_ledger_entries",
		"public.scheduled_report_subscriptions",
		"public.scheduled_report_delivery_logs",
		"insert into public.scheduled_report_delivery_logs",
	}
	for index, fragment := range wantFragments {
		if !strings.Contains(strings.ToLower(db.queryRowCalls[index].sql), fragment) {
			t.Errorf("QueryRow[%d] = %s, want %q", index, db.queryRowCalls[index].sql, fragment)
		}
	}
	if len(db.execCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.execCalls[0].sql), "update public.scheduled_report_ledger_entries") {
		t.Fatalf("ledger update Exec calls = %#v", db.execCalls)
	}
}

func TestScheduledReportStoreResendDeduplicatesInFlightLog(t *testing.T) {
	email := "owner@example.com"
	userID := 10
	db := &scheduledTestDB{
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			scheduledTestRow{values: []any{
				9, 7, "daily", "2026-11-07", &email, "*", "US", "missing", 3,
			}},
			scheduledTestRow{values: []any{
				7, &userID, &email, "*", "US", "daily", 15, 0, (*int)(nil), (*int)(nil), (*string)(nil), true,
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			}},
			scheduledTestRow{values: []any{3, "pending", "manual", "preparing"}},
		},
	}
	store := NewScheduledReportStore(db)
	result, err := store.PrepareResend(context.Background(), scheduled_reports.ResendRequest{
		LedgerKey: "7:2026-11-07",
	})
	if err != nil {
		t.Fatalf("PrepareResend() error = %v", err)
	}
	if !result.Reused || result.DeliveryLogID == nil || *result.DeliveryLogID != 3 {
		t.Fatalf("in-flight result = %#v, want reused log 3", result)
	}
	if len(db.execCalls) != 0 {
		t.Fatalf("in-flight resend wrote %d rows", len(db.execCalls))
	}

	db.rowsQueue = []pgx.Row{
		scheduledTestRow{values: []any{1}},
		scheduledTestRow{values: []any{
			9, 7, "daily", "2026-11-07", &email, "*", "US", "missing", 3,
		}},
		scheduledTestRow{values: []any{
			7, &userID, &email, "*", "US", "daily", 15, 0, (*int)(nil), (*int)(nil), (*string)(nil), true,
			time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
		}},
		scheduledTestRow{values: []any{3, "sent", "manual", "done"}},
	}
	_, err = NewScheduledReportStore(db).PrepareResend(context.Background(), scheduled_reports.ResendRequest{
		LedgerKey: "7:2026-11-07",
	})
	if !errors.Is(err, scheduled_reports.ErrAlreadySent) {
		t.Fatalf("stale sent ledger error = %v, want ErrAlreadySent", err)
	}
}

func TestScheduledReportStoreRegenerateSummaryRequiresSentLog(t *testing.T) {
	email := "owner@example.com"
	userID := 10
	insightRunID := "run-1"
	model := "model-a"
	db := &scheduledTestDB{
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			scheduledTestRow{values: []any{7, 22}},
			scheduledTestRow{values: []any{22, "sent", &insightRunID, &model}},
			scheduledTestRow{values: []any{
				7, &userID, &email, "1,2", "US", "weekly", 16, 0, (*int)(nil), (*int)(nil), &model, true,
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			}},
		},
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	result, err := NewScheduledReportStore(db).PrepareAISummaryRegeneration(
		context.Background(),
		scheduled_reports.RegenerateRequest{LedgerKey: "7:2026-11-03"},
	)
	if err != nil {
		t.Fatalf("PrepareAISummaryRegeneration() error = %v", err)
	}
	if result.DeliveryLogID == nil || *result.DeliveryLogID != 22 ||
		result.Status != "generating" || result.AIModel == nil || *result.AIModel != "model-a" {
		t.Fatalf("regenerate result = %#v", result)
	}
	if len(db.execCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.execCalls[0].sql), "ai_summary_status = 'pending'") {
		t.Fatalf("regenerate Exec calls = %#v", db.execCalls)
	}

	db.rowsQueue = []pgx.Row{
		scheduledTestRow{values: []any{1}},
		scheduledTestRow{values: []any{7, 22}},
		scheduledTestRow{values: []any{22, "pending", (*string)(nil), (*string)(nil)}},
	}
	_, err = NewScheduledReportStore(db).PrepareAISummaryRegeneration(
		context.Background(),
		scheduled_reports.RegenerateRequest{LedgerKey: "7:2026-11-03"},
	)
	if !errors.Is(err, scheduled_reports.ErrDeliveryNotSent) {
		t.Fatalf("pending delivery error = %v, want ErrDeliveryNotSent", err)
	}
}

func TestScheduledReportStoreFindIdempotencyRecord(t *testing.T) {
	db := &scheduledTestDB{row: scheduledTestRow{values: []any{
		[]byte(`{"fingerprint":"fp-1"}`),
		[]byte(`{"success":true}`),
	}}}
	record, err := NewScheduledReportStore(db).FindIdempotencyRecord(
		context.Background(),
		"scheduled_reports.ledger.resend",
		"idem-1",
	)
	if err != nil {
		t.Fatalf("FindIdempotencyRecord() error = %v", err)
	}
	if record == nil || record.Fingerprint != "fp-1" || string(record.Response) != `{"success":true}` {
		t.Fatalf("record = %#v", record)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow calls = %d", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "public.operation_audit_logs") ||
		!strings.Contains(query, "idempotency_key") ||
		!strings.Contains(query, "result = 'success'") {
		t.Fatalf("idempotency SQL = %s", query)
	}
}

func TestScheduledReportStoreRefreshLedgerUpsertsAndPagesByDay(t *testing.T) {
	email := "owner@example.com"
	userID := 10
	sentAt := time.Date(2026, 11, 2, 16, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	lastChecked := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	expectedAt := time.Date(2026, 11, 2, 15, 0, 0, 0, time.FixedZone("CST", 8*60*60))

	db := &scheduledTestDB{
		rowsQueueQuery: []Rows{
			&scheduledTestRows{batches: [][]any{{
				7,
				&userID,
				&email,
				"1,2",
				"US",
				"daily",
				15,
				0,
				(*int)(nil),
				(*int)(nil),
				(*string)(nil),
				true,
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60)),
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60)),
			}}},
			&scheduledTestRows{batches: [][]any{{"2026-11-02"}}},
			&scheduledTestRows{batches: [][]any{{
				9,
				"7:2026-11-02",
				"2026-11-02",
				expectedAt,
				"daily",
				7,
				&email,
				"1,2",
				"US",
				"missing",
				(*int)(nil),
				(*string)(nil),
				(*time.Time)(nil),
				lastChecked,
				(*string)(nil),
				(*string)(nil),
				(*string)(nil),
				"pending",
				(*string)(nil),
				(*string)(nil),
				(*string)(nil),
				(*time.Time)(nil),
			}}},
			&scheduledTestRows{batches: [][]any{{1, "项目一"}, {2, "项目二"}}},
		},
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			scheduledTestRow{err: pgx.ErrNoRows},
			scheduledTestRow{values: []any{1}},
			scheduledTestRow{values: []any{3, "sent", (*string)(nil), &sentAt}},
			scheduledTestRow{values: []any{2, 1, 0, 1}},
		},
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	response, err := NewScheduledReportStore(db).RefreshLedger(context.Background(), scheduled_reports.LedgerQuery{
		StartDate: "2026-11-01",
		EndDate:   "2026-11-02",
		Frequency: "all",
		Status:    "all",
		Limit:     100,
		Scope:     scheduled_reports.Scope{IsAdmin: true},
	})
	if err != nil {
		t.Fatalf("RefreshLedger() error = %v", err)
	}
	if response.Total != 2 || response.Summary.Sent != 1 || response.Summary.Missing != 1 {
		t.Fatalf("ledger summary = %#v", response)
	}
	if len(response.Items) != 1 || len(response.Items[0].ProjectNames) != 2 ||
		response.Items[0].ProjectNames[0] != "项目一" {
		t.Fatalf("ledger items = %#v", response.Items)
	}
	if len(db.execCalls) != 5 {
		t.Fatalf("Exec calls = %d, want cleanup + two upserts", len(db.execCalls))
	}
	for _, call := range db.execCalls {
		lower := strings.ToLower(call.sql)
		if !strings.Contains(lower, "public.scheduled_report_ledger_entries") {
			t.Errorf("unexpected Exec SQL = %s", call.sql)
		}
	}
	if !strings.Contains(strings.ToLower(db.execCalls[2].sql), "on conflict (ledger_key) do update") ||
		!strings.Contains(strings.ToLower(db.execCalls[2].sql), "last_checked_at = now()") {
		t.Fatalf("upsert SQL = %s", db.execCalls[2].sql)
	}
	if len(db.queryCalls) != 4 {
		t.Fatalf("Query calls = %d, want subscriptions/day/items/projects", len(db.queryCalls))
	}
}

func TestScheduledReportStoreRefreshAndTriggerUseAdvisoryLocks(t *testing.T) {
	if !strings.Contains(strings.ToLower(acquireAdvisoryLockSQL()), "pg_advisory_xact_lock") {
		t.Fatalf("advisory lock SQL missing")
	}
	if got := scheduled_reports.TriggerLockKey("daily"); got != "scheduled-report-trigger:daily" {
		t.Fatalf("trigger lock key = %q", got)
	}
}

func acquireAdvisoryLockSQL() string {
	return `select 1 from (select pg_advisory_xact_lock(hashtext($1))) as advisory_lock`
}
