package store

import (
	"context"
	"encoding/json"
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
	userID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"
	weekday := 1
	rowValues := []any{
		int64(11),
		(*int)(nil),
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
		UserAccountID:   &userID,
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
	if created.ID != 11 || created.UserAccountID == nil || *created.UserAccountID != userID || created.Frequency != "weekly" {
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

func TestScheduledReportEmailSentFieldIsAlwaysSerialized(t *testing.T) {
	for _, value := range []any{
		scheduled_reports.DeliveryLog{},
		scheduled_reports.LedgerItem{},
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("json.Marshal(%T) error = %v", value, err)
		}
		if !strings.Contains(string(encoded), `"email_sent":false`) {
			t.Fatalf("%T JSON = %s, want email_sent=false without omitempty", value, encoded)
		}
	}
}

func TestScheduledReportEmailSentRequiresEmailAndSentAt(t *testing.T) {
	createdAt := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	expectedAt := time.Date(2026, 11, 3, 15, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	sentAt := time.Date(2026, 11, 3, 10, 5, 0, 0, time.UTC)
	email := "owner@example.com"

	deliveryLogValues := func(email *string, sentAt *time.Time) []any {
		return []any{
			9, 7, "daily", "2026-11-03", (*string)(nil), email,
			"sent", (*string)(nil), sentAt,
			(*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil),
			(*string)(nil), "done", (*string)(nil), (*string)(nil), (*string)(nil), (*time.Time)(nil),
			"done", createdAt,
		}
	}
	ledgerValues := func(email *string, sentAt *time.Time) []any {
		return []any{
			9, "7:2026-11-03", "2026-11-03", expectedAt, "daily", 7, email, "*", "US", "sent", 3,
			(*string)(nil), sentAt, createdAt, (*string)(nil), (*string)(nil), (*string)(nil), "done",
			(*string)(nil), (*string)(nil), (*string)(nil), (*time.Time)(nil),
		}
	}

	cases := []struct {
		name   string
		email  *string
		sentAt *time.Time
		want   bool
	}{
		// Legacy Python "generation only" rows may have sent_at even though
		// no email exists. They must not claim an email was sent.
		{"null email with sent_at", nil, &sentAt, false},
		{"email with sent_at", &email, &sentAt, true},
		{"email without sent_at", &email, nil, false},
	}
	scanners := []struct {
		name string
		scan func(email *string, sentAt *time.Time) (bool, error)
	}{
		{
			name: "delivery log",
			scan: func(email *string, sentAt *time.Time) (bool, error) {
				item, err := scanScheduledReportDeliveryLog(scheduledTestRow{
					values: deliveryLogValues(email, sentAt),
				})
				return item.EmailSent, err
			},
		},
		{
			name: "ledger item",
			scan: func(email *string, sentAt *time.Time) (bool, error) {
				item, err := scanLedgerItem(scheduledTestRow{
					values: ledgerValues(email, sentAt),
				})
				return item.EmailSent, err
			},
		},
	}
	for _, scanner := range scanners {
		for _, testCase := range cases {
			t.Run(scanner.name+"/"+testCase.name, func(t *testing.T) {
				got, err := scanner.scan(testCase.email, testCase.sentAt)
				if err != nil {
					t.Fatalf("scan error = %v", err)
				}
				if got != testCase.want {
					t.Fatalf("EmailSent = %v, want %v", got, testCase.want)
				}
			})
		}
	}
}

func TestScheduledReportStorePrepareResendLocksLedgerAndCreatesManualLog(t *testing.T) {
	ctx := context.Background()
	userID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"
	email := "owner@example.com"
	weekday := 1
	db := &scheduledTestDB{
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			scheduledTestRow{values: []any{
				9, 7, "weekly", "2026-11-03", &email, "1,2", "US", "failed", 3,
			}},
			scheduledTestRow{values: []any{
				7, (*int)(nil), &userID, &email, "1,2", "US", "weekly", 16, 0, &weekday, nil, (*string)(nil), true,
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			}},
			scheduledTestRow{values: []any{3, "failed", "auto", "failed", (*time.Time)(nil)}},
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
	userID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"
	db := &scheduledTestDB{
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			scheduledTestRow{values: []any{
				9, 7, "daily", "2026-11-07", &email, "*", "US", "missing", 3,
			}},
			scheduledTestRow{values: []any{
				7, (*int)(nil), &userID, &email, "*", "US", "daily", 15, 0, (*int)(nil), (*int)(nil), (*string)(nil), true,
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			}},
			scheduledTestRow{values: []any{3, "pending", "manual", "preparing", (*time.Time)(nil)}},
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

	sentAt := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	db.rowsQueue = []pgx.Row{
		scheduledTestRow{values: []any{1}},
		scheduledTestRow{values: []any{
			9, 7, "daily", "2026-11-07", &email, "*", "US", "missing", 3,
		}},
		scheduledTestRow{values: []any{
			7, (*int)(nil), &userID, &email, "*", "US", "daily", 15, 0, (*int)(nil), (*int)(nil), (*string)(nil), true,
			time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
		}},
		scheduledTestRow{values: []any{3, "sent", "manual", "done", &sentAt}},
	}
	_, err = NewScheduledReportStore(db).PrepareResend(context.Background(), scheduled_reports.ResendRequest{
		LedgerKey: "7:2026-11-07",
	})
	if !errors.Is(err, scheduled_reports.ErrAlreadySent) {
		t.Fatalf("stale sent ledger error = %v, want ErrAlreadySent", err)
	}
}

func TestScheduledReportStorePrepareResendFallsBackToCurrentSubscriptionEmail(t *testing.T) {
	ctx := context.Background()
	userID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"
	currentEmail := "current@example.com"
	weekday := 1
	db := &scheduledTestDB{
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			// Ledger snapshot was materialised before the subscription had an
			// email, so it is still NULL.
			scheduledTestRow{values: []any{
				9, 7, "weekly", "2026-11-03", (*string)(nil), "1,2", "US", "failed", (*int)(nil),
			}},
			scheduledTestRow{values: []any{
				7, (*int)(nil), &userID, &currentEmail, "1,2", "US", "weekly", 16, 0, &weekday, nil, (*string)(nil), true,
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			}},
			scheduledTestRow{values: []any{22}},
		},
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	result, err := NewScheduledReportStore(db).PrepareResend(ctx, scheduled_reports.ResendRequest{
		LedgerKey: "7:2026-11-03",
	})
	if err != nil {
		t.Fatalf("PrepareResend() error = %v", err)
	}
	if result.Email == nil || *result.Email != currentEmail {
		t.Fatalf("result.Email = %#v, want current subscription email %q", result.Email, currentEmail)
	}
	insertCall := db.queryRowCalls[len(db.queryRowCalls)-1]
	if len(insertCall.args) < 5 || insertCall.args[4] == nil || insertCall.args[4].(*string) == nil ||
		*insertCall.args[4].(*string) != currentEmail {
		t.Fatalf("delivery log insert email arg = %#v, want %q", insertCall.args, currentEmail)
	}
}

func TestScheduledReportStorePrepareResendAllowsNoEmailAndGeneratedOnlyRows(t *testing.T) {
	ctx := context.Background()
	userID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"
	db := &scheduledTestDB{
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			// Generated-only ledger row: status sent but the latest delivery
			// log has sent_at NULL, and no email exists anywhere.
			scheduledTestRow{values: []any{
				9, 7, "daily", "2026-11-07", (*string)(nil), "*", "US", "sent", 3,
			}},
			scheduledTestRow{values: []any{
				7, (*int)(nil), &userID, (*string)(nil), "*", "US", "daily", 15, 0, (*int)(nil), (*int)(nil), (*string)(nil), true,
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
				time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC),
			}},
			scheduledTestRow{values: []any{3, "sent", "auto", "done", (*time.Time)(nil)}},
			scheduledTestRow{values: []any{22}},
		},
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	result, err := NewScheduledReportStore(db).PrepareResend(ctx, scheduled_reports.ResendRequest{
		LedgerKey: "7:2026-11-07",
	})
	if err != nil {
		t.Fatalf("PrepareResend() error = %v, want generation allowed without email", err)
	}
	if result.DeliveryLogID == nil || *result.DeliveryLogID != 22 {
		t.Fatalf("result = %#v, want new delivery log 22", result)
	}
	if result.Email != nil {
		t.Fatalf("result.Email = %#v, want nil", result.Email)
	}
	if result.Status != "processing" {
		t.Fatalf("result.Status = %q, want processing", result.Status)
	}
}

func TestScheduledReportStoreRegenerateSummaryRequiresSentLog(t *testing.T) {
	email := "owner@example.com"
	userID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"
	insightRunID := "run-1"
	model := "model-a"
	db := &scheduledTestDB{
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1}},
			scheduledTestRow{values: []any{7, 22}},
			scheduledTestRow{values: []any{22, "sent", &insightRunID, &model}},
			scheduledTestRow{values: []any{
				7, (*int)(nil), &userID, &email, "1,2", "US", "weekly", 16, 0, (*int)(nil), (*int)(nil), &model, true,
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
	userID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"
	sentAt := time.Date(2026, 11, 2, 16, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	lastChecked := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	expectedAt := time.Date(2026, 11, 2, 15, 0, 0, 0, time.FixedZone("CST", 8*60*60))

	db := &scheduledTestDB{
		rowsQueueQuery: []Rows{
			&scheduledTestRows{batches: [][]any{{
				7,
				(*int)(nil),
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

func TestScheduledReportStoreQueryLedgerAllowsResendForGeneratedOnlyRow(t *testing.T) {
	email := "owner@example.com"
	expectedAt := time.Date(2026, 11, 2, 15, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	lastChecked := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	db := &scheduledTestDB{
		rowsQueueQuery: []Rows{
			&scheduledTestRows{batches: [][]any{{"2026-11-02"}}},
			&scheduledTestRows{batches: [][]any{{
				9,
				"7:2026-11-02",
				"2026-11-02",
				expectedAt,
				"daily",
				7,
				&email,
				"*",
				"US",
				"sent",
				3,
				(*string)(nil),
				// Generated-only delivery log: status sent, sent_at NULL.
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
		},
		rowsQueue: []pgx.Row{
			scheduledTestRow{values: []any{1, 1, 0, 0}},
		},
	}
	response, err := NewScheduledReportStore(db).queryLedger(context.Background(), scheduled_reports.LedgerQuery{
		StartDate: "2026-11-01",
		EndDate:   "2026-11-02",
		Limit:     100,
		Scope:     scheduled_reports.Scope{IsAdmin: true},
	})
	if err != nil {
		t.Fatalf("queryLedger() error = %v", err)
	}
	if len(response.Items) != 1 {
		t.Fatalf("items = %#v", response.Items)
	}
	item := response.Items[0]
	if item.EmailSent {
		t.Fatalf("EmailSent = true, want false for sent_at NULL")
	}
	if !item.CanResend {
		t.Fatalf("CanResend = false, want true for a generated-only row")
	}
	if item.Status != scheduled_reports.StatusSent {
		t.Fatalf("status = %q, want sent", item.Status)
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

// BLF-1556: b43a5ba6 dropped the admin branch from ListSubscriptions, so an
// admin session filtered on its own account id and saw nothing. Admins must
// list every subscription, mirroring ledger and ListDeliveryLogs.
func TestScheduledReportStoreListSubscriptionsScope(t *testing.T) {
	operatorAccountID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"

	t.Run("admin without account id lists all", func(t *testing.T) {
		db := &scheduledTestDB{}
		subscriptions, err := NewScheduledReportStore(db).ListSubscriptions(
			context.Background(),
			scheduled_reports.Scope{IsAdmin: true},
			nil,
		)
		if err != nil {
			t.Fatalf("ListSubscriptions() error = %v", err)
		}
		if len(subscriptions) != 0 {
			t.Fatalf("subscriptions = %#v, want empty rows", subscriptions)
		}
		if len(db.queryCalls) != 1 {
			t.Fatalf("Query calls = %d, want 1", len(db.queryCalls))
		}
		query := strings.ToLower(db.queryCalls[0].sql)
		if strings.Contains(query, "where user_account_id") {
			t.Fatalf("admin ListSubscriptions filtered by account: %s", query)
		}
		if len(db.queryCalls[0].args) != 0 {
			t.Fatalf("admin ListSubscriptions args = %#v, want none", db.queryCalls[0].args)
		}
	})

	t.Run("admin with account id still lists all", func(t *testing.T) {
		db := &scheduledTestDB{}
		_, err := NewScheduledReportStore(db).ListSubscriptions(
			context.Background(),
			scheduled_reports.Scope{UserAccountID: &operatorAccountID, IsAdmin: true},
			nil,
		)
		if err != nil {
			t.Fatalf("ListSubscriptions() error = %v", err)
		}
		if strings.Contains(strings.ToLower(db.queryCalls[0].sql), "where user_account_id") {
			t.Fatalf("admin ListSubscriptions filtered by account: %s", db.queryCalls[0].sql)
		}
	})

	t.Run("operator filters on own account", func(t *testing.T) {
		db := &scheduledTestDB{}
		_, err := NewScheduledReportStore(db).ListSubscriptions(
			context.Background(),
			scheduled_reports.Scope{UserAccountID: &operatorAccountID},
			nil,
		)
		if err != nil {
			t.Fatalf("ListSubscriptions() error = %v", err)
		}
		query := strings.ToLower(db.queryCalls[0].sql)
		if !strings.Contains(query, "where user_account_id = $1") {
			t.Fatalf("operator ListSubscriptions SQL = %s", query)
		}
		if len(db.queryCalls[0].args) != 1 || db.queryCalls[0].args[0] != operatorAccountID {
			t.Fatalf("operator ListSubscriptions args = %#v", db.queryCalls[0].args)
		}
	})

	t.Run("operator without account id sees nothing", func(t *testing.T) {
		db := &scheduledTestDB{}
		subscriptions, err := NewScheduledReportStore(db).ListSubscriptions(
			context.Background(),
			scheduled_reports.Scope{},
			nil,
		)
		if err != nil {
			t.Fatalf("ListSubscriptions() error = %v", err)
		}
		if len(subscriptions) != 0 || len(db.queryCalls) != 0 {
			t.Fatalf("subscriptions = %#v, queries = %d; want none", subscriptions, len(db.queryCalls))
		}
	})
}

func TestScheduledReportStoreSubscriptionQueriesUseUserAccountID(t *testing.T) {
	operatorAccountID := "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"

	t.Run("delivery logs scope by account", func(t *testing.T) {
		db := &scheduledTestDB{
			rowsQueue: []pgx.Row{scheduledTestRow{values: []any{0}}},
		}
		_, err := NewScheduledReportStore(db).ListDeliveryLogs(
			context.Background(),
			scheduled_reports.Scope{UserAccountID: &operatorAccountID},
			nil,
			10,
			0,
		)
		if err != nil {
			t.Fatalf("ListDeliveryLogs() error = %v", err)
		}
		query := strings.ToLower(db.queryCalls[0].sql)
		if !strings.Contains(query, "user_account_id = $1") {
			t.Fatalf("ListDeliveryLogs SQL = %s", query)
		}
	})

	t.Run("ledger scope by account", func(t *testing.T) {
		where := buildLedgerWhere(scheduled_reports.LedgerQuery{
			StartDate: "2026-11-01",
			EndDate:   "2026-11-02",
			Scope:     scheduled_reports.Scope{UserAccountID: &operatorAccountID},
		})
		if !strings.Contains(where.sql, "s.user_account_id = $3") {
			t.Fatalf("ledger where SQL = %s", where.sql)
		}
		if len(where.args) != 3 || where.args[2] != operatorAccountID {
			t.Fatalf("ledger where args = %#v", where.args)
		}
	})
}

func acquireAdvisoryLockSQL() string {
	return `select 1 from (select pg_advisory_xact_lock(hashtext($1))) as advisory_lock`
}
