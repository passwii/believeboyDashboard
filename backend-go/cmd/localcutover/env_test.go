package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTempEnv(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.env")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}
	return path
}

func TestParseEnvFile(t *testing.T) {
	path := writeTempEnv(t, `# comment
API_KEY=abc123
export DATABASE_URL="postgresql+psycopg://u:p@localhost:5432/BLF_TEST"
EMPTY=
QUOTED='single'
`)

	values, err := parseEnvFile(path)
	if err != nil {
		t.Fatalf("parseEnvFile() error = %v", err)
	}
	if values["API_KEY"] != "abc123" {
		t.Errorf("API_KEY = %q", values["API_KEY"])
	}
	if values["DATABASE_URL"] != "postgresql+psycopg://u:p@localhost:5432/BLF_TEST" {
		t.Errorf("DATABASE_URL = %q", values["DATABASE_URL"])
	}
	if values["QUOTED"] != "single" {
		t.Errorf("QUOTED = %q", values["QUOTED"])
	}
	if _, ok := values["# comment"]; ok {
		t.Error("comment line was parsed")
	}
}

func TestNormalizeDatabaseURL(t *testing.T) {
	cases := map[string]string{
		"postgresql+psycopg://u:p@h:5432/db":   "postgres://u:p@h:5432/db",
		"postgresql+asyncpg://u:p@h:5432/db":   "postgres://u:p@h:5432/db",
		"postgresql://u:p@h:5432/db":           "postgres://u:p@h:5432/db",
		"postgres://u:p@h:5432/db":             "postgres://u:p@h:5432/db",
		"host=localhost port=5432 dbname=test": "host=localhost port=5432 dbname=test",
	}
	for input, want := range cases {
		if got := normalizeDatabaseURL(input); got != want {
			t.Errorf("normalizeDatabaseURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestDatabaseURLFromEnv(t *testing.T) {
	url, err := databaseURLFromEnv(map[string]string{
		"DATABASE_URL": "postgresql+psycopg://user:secret@localhost:5432/BLF_TEST",
	})
	if err != nil {
		t.Fatalf("databaseURLFromEnv() error = %v", err)
	}
	if url != "postgres://user:secret@localhost:5432/BLF_TEST" {
		t.Errorf("url = %q", url)
	}

	url, err = databaseURLFromEnv(map[string]string{
		"PGHOST":     "localhost",
		"PGPORT":     "5432",
		"PGDATABASE": "BLF_TEST",
		"PGUSER":     "postgres",
		"PGPASSWORD": "p@ss word",
	})
	if err != nil {
		t.Fatalf("databaseURLFromEnv() error = %v", err)
	}
	if !strings.Contains(url, "postgres://postgres:p%40ss%20word@localhost:5432/BLF_TEST") {
		t.Errorf("url = %q", url)
	}
}

func TestDatabaseURLFromEnvRequiresCredentials(t *testing.T) {
	if _, err := databaseURLFromEnv(map[string]string{"PGHOST": "localhost"}); err == nil {
		t.Fatal("databaseURLFromEnv() error = nil, want missing credentials error")
	}
}

func TestRedisURLFromEnv(t *testing.T) {
	if got := redisURLFromEnv(map[string]string{"REDIS_URL": "redis://h:6380/2"}); got != "redis://h:6380/2" {
		t.Errorf("redis url = %q", got)
	}
	if got := redisURLFromEnv(map[string]string{"REDIS_HOST": "127.0.0.1", "REDIS_PORT": "6379"}); got != "redis://127.0.0.1:6379/0" {
		t.Errorf("redis url = %q", got)
	}
}

func TestDeriveProcessEnvOverridesStorageAndAuth(t *testing.T) {
	env := deriveProcessEnv(map[string]string{
		"API_KEY":                   "from-file",
		"DATABASE_URL":              "postgresql+psycopg://u:p@h:5432/db",
		"AI_CHAT_PROVIDER_BASE_URL": "http://provider",
	}, processEnvOptions{
		apiKey:        "api-key",
		databaseURL:   "postgres://u:p@h:5432/db",
		redisURL:      "redis://127.0.0.1:6379/0",
		gatewayAddr:   "127.0.0.1:18200",
		fastapiOrigin: "http://127.0.0.1:8100",
		owned:         "all",
		proxySecret:   "secret",
		storageDir:    "/tmp/state/storage",
	})

	wants := map[string]string{
		"API_KEY":                     "api-key",
		"DATABASE_URL":                "postgres://u:p@h:5432/db",
		"GO_API_ADDR":                 "127.0.0.1:18200",
		"GO_API_OWNED":                "all",
		"GO_API_TRUSTED_PROXY_SECRET": "secret",
		"UPLOAD_ROOT":                 "/tmp/state/storage/uploads",
		"MONTHLY_REPORT_RESULT_ROOT":  "/tmp/state/storage/results",
		"AI_CHAT_PROVIDER_BASE_URL":   "http://provider",
	}
	for key, want := range wants {
		if env[key] != want {
			t.Errorf("env[%q] = %q, want %q", key, env[key], want)
		}
	}
}
