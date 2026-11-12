// Command seedlivecontract creates the deterministic fixtures the Week 1 live
// contract asserts on.
//
// Every fixture uses a fixed primary key from a private id range instead of a
// sequence value. The golden recording replaces ids with placeholders, so two
// fixtures sharing a number would make that mapping ambiguous — on a fresh CI
// database every sequence starts at 1, which is exactly what happened.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	liveProjectName       = "__live_contract_project__"
	liveRuleName          = "__live_contract_rule__"
	liveNotificationTitle = "__live_contract_notification__"
	liveNotificationUser  = int64(424242)
	liveExchangeCurrency  = "LVC"
	liveExchangeYearMonth = "2026-10"
	liveProfileEmail      = "test_admin@believeboy.com"

	// Fixture ids live in a reserved range so they never collide with each other
	// or with sequence-generated rows.
	liveProjectID      = int64(910001)
	liveAlertRuleID    = int64(910002)
	liveAlertEventID   = int64(910003)
	liveNotificationID = int64(910004)
	liveExchangeRateID = int64(910005)
)

func main() {
	databaseURL := flag.String("database-url", "", "exact database URL (BLF_test/BLF_ci)")
	flag.Parse()
	url := strings.TrimSpace(*databaseURL)
	if url == "" {
		for _, key := range []string{"LIVE_CONTRACT_DATABASE_URL", "TEST_DATABASE_URL", "DATABASE_URL"} {
			if value := strings.TrimSpace(os.Getenv(key)); value != "" {
				url = value
				break
			}
		}
	}
	if url == "" {
		fmt.Fprintln(os.Stderr, "seed_live_contract_data: TEST_DATABASE_URL or DATABASE_URL is required")
		os.Exit(1)
	}
	if err := validateDatabaseName(url); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open database:", err)
		os.Exit(1)
	}
	defer pool.Close()
	db := store.NewPGXDB(pool)
	if err := seed(ctx, db); err != nil {
		fmt.Fprintln(os.Stderr, "seed_live_contract_data failed:", err)
		os.Exit(1)
	}
	fmt.Printf(
		"Live contract fixture ready: project=%s, user_id=%d, exchange=%s/%s, profile=%s\n",
		liveProjectName, liveNotificationUser, liveExchangeCurrency, liveExchangeYearMonth, liveProfileEmail,
	)
}

func validateDatabaseName(url string) error {
	lower := strings.ToLower(url)
	database := ""
	if index := strings.LastIndex(lower, "/"); index >= 0 {
		database = lower[index+1:]
	}
	if question := strings.IndexByte(database, '?'); question >= 0 {
		database = database[:question]
	}
	if database != "blf_test" && database != "blf_ci" {
		return fmt.Errorf("seed_live_contract_data refused: database must be BLF_test or BLF_ci (got %q)", database)
	}
	return nil
}

func seed(ctx context.Context, db store.FullDB) error {
	var profileID string
	if err := db.QueryRow(ctx,
		"select id::text from public.user_accounts where lower(email) = lower($1) limit 1",
		liveProfileEmail).Scan(&profileID); err != nil {
		return fmt.Errorf("test admin account is missing; run seedtestaccounts first: %w", err)
	}

	// A row seeded by an earlier run may hold the same project name under a
	// different id; clear it so the fixed id wins.
	if _, err := db.Exec(ctx, "delete from public.projects where project_name = $1 and id <> $2", liveProjectName, liveProjectID); err != nil {
		return err
	}
	if _, err := db.Exec(ctx,
		// projects.id is GENERATED ALWAYS AS IDENTITY, so an explicit id needs
		// OVERRIDING SYSTEM VALUE.
		"insert into public.projects (id, project_name, project_operator, sort_order, is_active, country) "+
			"overriding system value "+
			"values ($1, $2, 'live-contract-operator', 0, true, 'US') "+
			"on conflict (id) do update set project_name = excluded.project_name, "+
			"project_operator = excluded.project_operator, sort_order = 0, is_active = true, "+
			"country = 'US', updated_at = now()",
		liveProjectID, liveProjectName); err != nil {
		return err
	}

	if _, err := db.Exec(ctx, "delete from public.alert_events where id = $1 or message = '[live-contract] fixture event'", liveAlertEventID); err != nil {
		return err
	}
	if _, err := db.Exec(ctx, "delete from public.alert_rules where id = $1 or name = $2", liveAlertRuleID, liveRuleName); err != nil {
		return err
	}
	if _, err := db.Exec(ctx,
		"insert into public.alert_rules (id, name, project_id, country, metric, trigger_type, condition, threshold, "+
			"window_days, severity, notification_channels, is_active, created_by, created_at, updated_at) "+
			"values ($1, $2, $3, 'US', 'acos', 'threshold', 'above', 0.25, 7, 'warning', 'in_app', true, "+
			"'live-contract-operator', '2026-10-01T02:03:04.123+00:00', '2026-10-01T02:03:04.123+00:00')",
		liveAlertRuleID, liveRuleName, liveProjectID); err != nil {
		return err
	}
	if _, err := db.Exec(ctx,
		"insert into public.alert_events (id, rule_id, project_id, metric, current_value, baseline_value, deviation_pct, "+
			"severity, message, status, triggered_at) "+
			"values ($1, $2, $3, 'acos', 0.3, 0.2, 50, 'warning', '[live-contract] fixture event', 'active', "+
			"'2026-10-01T02:03:04.123+00:00')",
		liveAlertEventID, liveAlertRuleID, liveProjectID); err != nil {
		return err
	}

	if _, err := db.Exec(ctx, "delete from public.notifications where id = $1 or title = $2", liveNotificationID, liveNotificationTitle); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"project_id": liveProjectID})
	if _, err := db.Exec(ctx,
		"insert into public.notifications (id, user_id, type, title, message, data, read, created_at) "+
			"values ($1, $2, 'alert', $3, 'live contract notification', $4::json, false, '2026-10-01T02:03:04.123+00:00')",
		liveNotificationID, liveNotificationUser, liveNotificationTitle, string(payload)); err != nil {
		return err
	}

	// Delete every row for the fixture currency, not just the expected month: a
	// leftover row from an earlier run would show up in the list endpoint and
	// silently change the recorded response.
	if _, err := db.Exec(ctx, "delete from public.exchange_rates where currency = $1 or id = $2", liveExchangeCurrency, liveExchangeRateID); err != nil {
		return err
	}
	if _, err := db.Exec(ctx,
		"insert into public.exchange_rates (id, currency, currency_name, year_month, rate, description, note_images, "+
			"created_at, updated_at) "+
			"values ($1, $2, 'Live Contract Currency', $3, 7.12345678, 'live contract exchange rate', '[]'::json, "+
			"'2026-10-01T01:02:03.456+00:00', '2026-10-01T01:02:03.456+00:00')",
		liveExchangeRateID, liveExchangeCurrency, liveExchangeYearMonth); err != nil {
		return err
	}
	return nil
}
