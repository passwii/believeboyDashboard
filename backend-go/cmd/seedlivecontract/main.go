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
	fmt.Printf("Live contract fixture ready: project=%s, user_id=%d, exchange=%s/%s, profile=%s\n",
		liveProjectName, liveNotificationUser, liveExchangeCurrency, liveExchangeYearMonth, liveProfileEmail)
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
		return fmt.Errorf("test admin account is missing; run seed_test_accounts first: %w", err)
	}

	var projectID int64
	err := db.QueryRow(ctx,
		"select id from public.projects where project_name = $1 limit 1", liveProjectName).Scan(&projectID)
	if err != nil {
		projectID, err = insertReturningID(ctx, db,
			"insert into public.projects (project_name, project_operator, sort_order, is_active, country) "+
				"values ($1, 'live-contract-operator', 0, true, 'US') returning id", liveProjectName)
		if err != nil {
			return err
		}
	} else {
		if _, err := db.Exec(ctx,
			"update public.projects set project_operator = 'live-contract-operator', sort_order = 0, is_active = true, country = 'US', updated_at = now() where id = $1",
			projectID); err != nil {
			return err
		}
	}

	if _, err := db.Exec(ctx, "delete from public.alert_events where message = '[live-contract] fixture event'"); err != nil {
		return err
	}
	if _, err := db.Exec(ctx, "delete from public.alert_rules where name = $1", liveRuleName); err != nil {
		return err
	}
	ruleID, err := insertReturningID(ctx, db,
		"insert into public.alert_rules (name, project_id, country, metric, trigger_type, condition, threshold, window_days, severity, notification_channels, is_active, created_by, created_at, updated_at) "+
			"values ($1, $2, 'US', 'acos', 'threshold', 'above', 0.25, 7, 'warning', 'in_app', true, 'live-contract-operator', '2026-10-01T02:03:04.123+00:00', '2026-10-01T02:03:04.123+00:00') returning id",
		liveRuleName, projectID)
	if err != nil {
		return err
	}
	if _, err := db.Exec(ctx,
		"insert into public.alert_events (rule_id, project_id, metric, current_value, baseline_value, deviation_pct, severity, message, status, triggered_at) "+
			"values ($1, $2, 'acos', 0.3, 0.2, 50, 'warning', '[live-contract] fixture event', 'active', '2026-10-01T02:03:04.123+00:00')",
		ruleID, projectID); err != nil {
		return err
	}

	if _, err := db.Exec(ctx, "delete from public.notifications where title = $1", liveNotificationTitle); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"project_id": projectID})
	if _, err := db.Exec(ctx,
		"insert into public.notifications (user_id, type, title, message, data, read, created_at) "+
			"values ($1, 'alert', $2, 'live contract notification', $3::json, false, '2026-10-01T02:03:04.123+00:00')",
		liveNotificationUser, liveNotificationTitle, string(payload)); err != nil {
		return err
	}

	if _, err := db.Exec(ctx, "delete from public.exchange_rates where currency = $1 and year_month = $2", liveExchangeCurrency, liveExchangeYearMonth); err != nil {
		return err
	}
	if _, err := db.Exec(ctx,
		"insert into public.exchange_rates (currency, currency_name, year_month, rate, description, note_images, created_at, updated_at) "+
			"values ($1, 'Live Contract Currency', $2, 7.12345678, 'live contract exchange rate', '[]'::json, '2026-10-01T01:02:03.456+00:00', '2026-10-01T01:02:03.456+00:00')",
		liveExchangeCurrency, liveExchangeYearMonth); err != nil {
		return err
	}
	return nil
}

func insertReturningID(ctx context.Context, db store.FullDB, query string, args ...any) (int64, error) {
	var id int64
	if err := db.QueryRow(ctx, query, args...).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}
