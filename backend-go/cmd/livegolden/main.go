// Command livegolden records the Week 1 live-contract responses from FastAPI
// into a golden file.
//
// It is the one-shot capture step that removed FastAPI from CI: after the
// recording exists, tests/contract compares the Go gateway against the golden
// file instead of starting a Python service.
//
// Usage (FastAPI must be running, e.g. via backend/.venv/bin/uvicorn):
//
//	go run ./cmd/livegolden --fastapi http://127.0.0.1:18100 --database-url DB --api-key KEY
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/livecontract"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "livegolden:", err)
		os.Exit(1)
	}
}

func run() error {
	fastAPI := flag.String("fastapi", "http://127.0.0.1:18100", "FastAPI base URL to record from")
	databaseURL := flag.String("database-url", "", "database holding the seeded live-contract fixtures")
	apiKey := flag.String("api-key", "", "X-API-Key sent to FastAPI")
	out := flag.String("out", "tests/contract/testdata/week1_live_golden.json", "golden file destination")
	flag.Parse()

	if strings.TrimSpace(*databaseURL) == "" {
		return fmt.Errorf("--database-url is required")
	}
	if strings.TrimSpace(*apiKey) == "" {
		return fmt.Errorf("--api-key is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, *databaseURL)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer pool.Close()
	fixtures, err := loadFixtures(ctx, pool)
	if err != nil {
		return err
	}

	base := strings.TrimRight(strings.TrimSpace(*fastAPI), "/")
	client := &http.Client{Timeout: 15 * time.Second}
	cases := livecontract.BuildCases(fixtures)
	golden := livecontract.GoldenFile{
		Source: fmt.Sprintf("fastapi %s captured %s", base, time.Now().UTC().Format(time.RFC3339)),
	}
	for _, item := range cases {
		body, status, err := fetch(ctx, client, base+item.RequestPath, *apiKey, fixtures, item.HeaderRole)
		if err != nil {
			return fmt.Errorf("record %s: %w", item.Name, err)
		}
		if status < 200 || status >= 400 {
			return fmt.Errorf("record %s: FastAPI returned %d: %s", item.Name, status, string(body))
		}
		golden.Cases = append(golden.Cases, livecontract.GoldenCase{
			Name:   item.Name,
			Route:  item.Route,
			Status: status,
			Body:   string(livecontract.ApplyTokens(body, fixtures)),
		})
		fmt.Printf("recorded %-28s %d %s\n", item.Name, status, item.Route)
	}
	if err := golden.Validate(); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(golden, "", "  ")
	if err != nil {
		return fmt.Errorf("encode golden: %w", err)
	}
	payload = append(payload, '\n')
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(*out, payload, 0o644); err != nil {
		return fmt.Errorf("write golden: %w", err)
	}
	fmt.Printf("\nwrote %d cases to %s\n", len(golden.Cases), *out)
	return nil
}

func fetch(
	ctx context.Context,
	client *http.Client,
	target, apiKey string,
	fixtures livecontract.Fixtures,
	role livecontract.HeaderRole,
) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("X-API-Key", apiKey)
	for key, value := range headersFor(role, fixtures) {
		request.Header.Set(key, value)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, 0, err
	}
	return body, response.StatusCode, nil
}

// headersFor mirrors the identity headers the Go gateway sees from the web
// proxy, so both sides answer the same request.
func headersFor(role livecontract.HeaderRole, fixtures livecontract.Fixtures) map[string]string {
	headers := map[string]string{}
	switch role {
	case livecontract.RoleNotification:
		headers["X-User-Id"] = fixtures.NotificationUserID
	case livecontract.RoleAlertAdmin:
		headers["X-Is-Admin"] = "true"
	case livecontract.RoleAlertOperator:
		headers["X-Operator"] = "live-contract-operator"
		headers["X-Is-Admin"] = "false"
	case livecontract.RoleProfile:
		headers["X-User-Id"] = fixtures.ProfileUserID
	}
	return headers
}

func loadFixtures(ctx context.Context, pool *pgxpool.Pool) (livecontract.Fixtures, error) {
	fixtures := livecontract.Fixtures{}
	queries := []struct {
		target *string
		query  string
		args   []any
	}{
		{&fixtures.NotificationUserID, "select user_id::text from public.notifications where title = $1", []any{livecontract.NotificationTitle}},
		{&fixtures.ProjectID, "select id::text from public.projects where project_name = $1", []any{livecontract.ProjectName}},
		{&fixtures.ExchangeRateID, "select id::text from public.exchange_rates where currency = $1 and year_month = $2", []any{livecontract.ExchangeCurrency, livecontract.ExchangeYearMonth}},
		{&fixtures.ProfileUserID, "select id::text from public.user_accounts where lower(email) = lower($1) limit 1", []any{livecontract.ProfileEmail}},
		{&fixtures.NotificationID, "select id::text from public.notifications where title = $1", []any{livecontract.NotificationTitle}},
		{&fixtures.AlertRuleID, "select id::text from public.alert_rules where name = $1", []any{livecontract.AlertRuleName}},
		{&fixtures.AlertEventID, "select id::text from public.alert_events where message = $1", []any{livecontract.AlertEventMessage}},
	}
	for _, item := range queries {
		if err := pool.QueryRow(ctx, item.query, item.args...).Scan(item.target); err != nil {
			if err == pgx.ErrNoRows {
				return livecontract.Fixtures{}, fmt.Errorf("live-contract fixture missing; run go run ./cmd/seedlivecontract first")
			}
			return livecontract.Fixtures{}, fmt.Errorf("load fixture: %w", err)
		}
	}
	return fixtures, nil
}
