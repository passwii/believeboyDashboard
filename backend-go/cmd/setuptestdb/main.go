// Command setuptestdb prepares the dedicated local test database in one shot.
//
// It is the Go replacement for backend/scripts/setup_test_db.py:
//
//  1. ensure the database named by TEST_DATABASE_URL exists (best effort);
//  2. clone the schema from DATABASE_URL with pg_dump --schema-only | psql;
//  3. seed migration-owned reference data (CRM categories + workflow templates);
//  4. seed the test accounts (admin / operator / businessdev).
//
// The schema is cloned rather than replayed through the migration chain because
// the historical Alembic chain assumes the bootstrap tables already exist.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "setuptestdb:", err)
		os.Exit(1)
	}
}

func run() error {
	envFile := flag.String("env-file", "backend/.env", "env file with DATABASE_URL (the schema source)")
	envTestFile := flag.String("env-test-file", "backend/.env.test", "env file with TEST_DATABASE_URL + TEST_*_PASSWORD (overrides -env-file)")
	resetPassword := flag.Bool("reset-password", false, "force-reset test account passwords while seeding")
	skipCreate := flag.Bool("skip-create", false, "do not attempt CREATE DATABASE")
	flag.Parse()

	repoRoot, err := findRepoRoot()
	if err != nil {
		return err
	}
	env, err := loadEnv(repoRoot, *envFile, *envTestFile)
	if err != nil {
		return err
	}
	testURL := strings.TrimSpace(env["TEST_DATABASE_URL"])
	if testURL == "" {
		return errors.New("TEST_DATABASE_URL is not set; add it to backend/.env.test")
	}
	sourceURL := strings.TrimSpace(env["DATABASE_URL"])
	if sourceURL == "" {
		return errors.New("DATABASE_URL (the schema source) is not set in backend/.env or the shell")
	}

	if *skipCreate {
		fmt.Println("[1/4] skipping CREATE DATABASE (-skip-create)")
	} else {
		step(1, 4, "ensuring database exists")
		if err := ensureDatabase(context.Background(), testURL); err != nil {
			return err
		}
	}

	step(2, 4, "cloning schema (pg_dump --schema-only)")
	if err := cloneSchema(sourceURL, testURL, env); err != nil {
		return err
	}

	step(3, 4, "seeding reference data")
	if err := runGoCommand(repoRoot, env, "./cmd/seedtestreference"); err != nil {
		return err
	}

	step(4, 4, "seeding test accounts")
	seedArgs := []string{"./cmd/seedtestaccounts"}
	if *resetPassword {
		seedArgs = append(seedArgs, "--reset-password")
	}
	if err := runGoCommand(repoRoot, env, seedArgs...); err != nil {
		return err
	}

	fmt.Println("\nTest database is ready. Point the test suites at it with TEST_DATABASE_URL.")
	return nil
}

func step(index, total int, label string) {
	fmt.Printf("[%d/%d] %s...\n", index, total, label)
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "go.work")); statErr == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("could not find repo root (go.work); run from inside the repository")
		}
		dir = parent
	}
}

// loadEnv reads the source env file first and the test env file second so the
// test values win, mirroring the Python helper this replaces.
func loadEnv(repoRoot, envFile, envTestFile string) (map[string]string, error) {
	env := make(map[string]string)
	for _, name := range []string{envFile, envTestFile} {
		path := name
		if !filepath.IsAbs(path) {
			path = filepath.Join(repoRoot, path)
		}
		payload, err := os.ReadFile(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		for _, raw := range strings.Split(string(payload), "\n") {
			line := strings.TrimSpace(raw)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, value, found := strings.Cut(line, "=")
			if !found {
				continue
			}
			env[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), "\"'")
		}
	}
	return env, nil
}

// ensureDatabase attempts CREATE DATABASE against the maintenance database.
// Managed providers (Supabase) reject this; that is only a warning because the
// database may already exist or be created out of band.
func ensureDatabase(ctx context.Context, testURL string) error {
	libpqURL := toLibpqURL(testURL)
	config, err := pgx.ParseConfig(libpqURL)
	if err != nil {
		return fmt.Errorf("parse TEST_DATABASE_URL: %w", err)
	}
	database := config.Database
	if database == "" {
		return errors.New("TEST_DATABASE_URL has no database name")
	}
	adminConfig, err := pgx.ParseConfig(libpqURL)
	if err != nil {
		return err
	}
	adminConfig.Database = "postgres"
	adminConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	adminCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(adminCtx, adminConfig)
	if err != nil {
		fmt.Printf("      create skipped (connect: %v)\n", err)
		return nil
	}
	defer conn.Close(adminCtx)

	// CREATE DATABASE cannot run inside a transaction block.
	if _, err := conn.Exec(adminCtx, "CREATE DATABASE "+quoteIdentifier(database)); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "already exists") {
			fmt.Printf("      %s already exists - skipping create\n", database)
			return nil
		}
		fmt.Printf("      create skipped (%v)\n", err)
		fmt.Printf("      for managed databases create %s in the console, then re-run\n", database)
		return nil
	}
	fmt.Printf("      created %s\n", database)
	return nil
}

// cloneSchema pipes pg_dump --schema-only from the source database into psql on
// the test database. --clean --if-exists keeps re-runs idempotent.
func cloneSchema(sourceURL, testURL string, env map[string]string) error {
	source := toLibpqURL(sourceURL)
	target := toLibpqURL(testURL)
	dump := exec.Command("pg_dump", "-d", source, "--schema-only", "--no-owner", "--no-privileges", "--clean", "--if-exists")
	dump.Env = commandEnv(env)
	dump.Stderr = os.Stderr
	load := exec.Command("psql", "-d", target, "--single-transaction", "--quiet")
	load.Env = commandEnv(env)
	load.Stderr = os.Stderr

	pipe, err := dump.StdoutPipe()
	if err != nil {
		return err
	}
	load.Stdin = pipe
	if err := load.Start(); err != nil {
		return fmt.Errorf("start psql: %w", err)
	}
	if err := dump.Run(); err != nil {
		_ = load.Wait()
		return fmt.Errorf("pg_dump failed: %w", err)
	}
	if err := load.Wait(); err != nil {
		return fmt.Errorf("psql restore failed: %w", err)
	}
	fmt.Println("      schema cloned")
	return nil
}

func runGoCommand(repoRoot string, env map[string]string, args ...string) error {
	goDir := filepath.Join(repoRoot, "backend-go")
	command := exec.Command("go", append([]string{"run"}, args...)...)
	command.Dir = goDir
	command.Env = commandEnv(env)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("go run %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

func commandEnv(env map[string]string) []string {
	merged := make(map[string]string, len(env))
	for key, value := range env {
		merged[key] = value
	}
	// The real environment wins so an operator can override any value.
	for _, pair := range os.Environ() {
		key, value, found := strings.Cut(pair, "=")
		if found {
			merged[key] = value
		}
	}
	out := make([]string, 0, len(merged))
	for key, value := range merged {
		out = append(out, key+"="+value)
	}
	return out
}

// toLibpqURL strips the SQLAlchemy driver suffix; pg_dump and psql speak libpq.
func toLibpqURL(databaseURL string) string {
	for _, suffix := range []string{"postgresql+psycopg://", "postgresql+psycopg2://", "postgresql+asyncpg://"} {
		if strings.HasPrefix(databaseURL, suffix) {
			return "postgresql://" + strings.TrimPrefix(databaseURL, suffix)
		}
	}
	for _, suffix := range []string{"postgres+psycopg://", "postgres+psycopg2://", "postgres+asyncpg://"} {
		if strings.HasPrefix(databaseURL, suffix) {
			return "postgres://" + strings.TrimPrefix(databaseURL, suffix)
		}
	}
	return databaseURL
}

func quoteIdentifier(name string) string {
	return "\"" + strings.ReplaceAll(name, "\"", "\"\"") + "\""
}
