package store

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
)

// TestScheduledReportStoreListSubscriptionsIntegration is the BLF-1556
// regression gate. The production snapshot held 23 subscriptions with a NULL
// integer user_id while the dashboard identity is a user_accounts UUID, so the
// list endpoint returned [] for admins. This test writes an owned and an
// unowned subscription into BLF_test and asserts the scope rules against a real
// database: admins see everything, operators see only their own account.
func TestScheduledReportStoreListSubscriptionsIntegration(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection for integration coverage")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}
	db := NewPGXDB(pool)

	var accountID string
	if err := db.QueryRow(
		ctx,
		`select id::text from public.user_accounts where is_active order by created_at limit 1`,
	).Scan(&accountID); err != nil {
		t.Fatalf("select test account: %v", err)
	}

	var ownedID, unownedID int64
	if err := db.QueryRow(
		ctx,
		`insert into public.scheduled_report_subscriptions (
		   user_account_id, email, project_ids, country, frequency,
		   dispatch_hour, dispatch_minute, enabled, created_at, updated_at
		 ) values ($1::uuid, 'owned@example.com', '1', 'US', 'daily', 15, 0, false, now(), now())
		 returning id`,
		accountID,
	).Scan(&ownedID); err != nil {
		t.Fatalf("insert owned subscription: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		`insert into public.scheduled_report_subscriptions (
		   email, project_ids, country, frequency,
		   dispatch_hour, dispatch_minute, enabled, created_at, updated_at
		 ) values ('legacy-null@example.com', '1', 'US', 'daily', 15, 0, false, now(), now())
		 returning id`,
	).Scan(&unownedID); err != nil {
		t.Fatalf("insert unowned subscription: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx,
			`delete from public.scheduled_report_subscriptions where id = any($1::int[])`,
			[]int32{int32(ownedID), int32(unownedID)},
		)
	})

	subscriptionStore := NewScheduledReportStore(db)

	// The dashboard admin path sends its own UUID; it must still see the
	// unowned legacy row because admins are not scoped by account.
	adminSubscriptions, err := subscriptionStore.ListSubscriptions(
		ctx,
		scheduled_reports.Scope{UserAccountID: &accountID, IsAdmin: true},
		nil,
	)
	if err != nil {
		t.Fatalf("admin ListSubscriptions() error = %v", err)
	}
	if !containsSubscriptionID(adminSubscriptions, ownedID) ||
		!containsSubscriptionID(adminSubscriptions, unownedID) {
		t.Fatalf("admin subscriptions = %d rows, want owned %d and unowned %d", len(adminSubscriptions), ownedID, unownedID)
	}

	// A non-admin session sees only its own account.
	operatorSubscriptions, err := subscriptionStore.ListSubscriptions(
		ctx,
		scheduled_reports.Scope{UserAccountID: &accountID},
		nil,
	)
	if err != nil {
		t.Fatalf("operator ListSubscriptions() error = %v", err)
	}
	if !containsSubscriptionID(operatorSubscriptions, ownedID) {
		t.Fatalf("operator subscriptions missed owned row %d", ownedID)
	}
	if containsSubscriptionID(operatorSubscriptions, unownedID) {
		t.Fatalf("operator subscriptions leaked unowned row %d", unownedID)
	}
}

// TestScheduledReportSubscriptionMigrationBackfillsUserAccountID guards the
// migration contract: the relationship uses user_accounts.id (uuid), and every
// row that was backfilled points at an active account.
func TestScheduledReportSubscriptionMigrationBackfillsUserAccountID(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection for integration coverage")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}
	db := NewPGXDB(pool)

	var columnType string
	if err := db.QueryRow(ctx,
		`select data_type from information_schema.columns
		 where table_schema = 'public'
		   and table_name = 'scheduled_report_subscriptions'
		   and column_name = 'user_account_id'`,
	).Scan(&columnType); err != nil {
		t.Fatalf("user_account_id column: %v", err)
	}
	if strings.TrimSpace(columnType) != "uuid" {
		t.Fatalf("user_account_id type = %q, want uuid", columnType)
	}

	var dangling int
	if err := db.QueryRow(ctx,
		`select count(*) from public.scheduled_report_subscriptions
		 where user_account_id is not null
		   and user_account_id not in (select id from public.user_accounts)`,
	).Scan(&dangling); err != nil {
		t.Fatalf("dangling account check: %v", err)
	}
	if dangling != 0 {
		t.Fatalf("dangling user_account_id rows = %d", dangling)
	}
}

func containsSubscriptionID(subscriptions []scheduled_reports.Subscription, id int64) bool {
	for _, subscription := range subscriptions {
		if subscription.ID == id {
			return true
		}
	}
	return false
}
