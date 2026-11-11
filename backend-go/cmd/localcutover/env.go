package main

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// parseEnvFile reads a KEY=VALUE env file (the same shape as backend/.env.test)
// and returns its values. Comments, blank lines and an optional "export "
// prefix are ignored; surrounding single or double quotes are stripped.
func parseEnvFile(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	values := make(map[string]string)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		values[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return values, nil
}

// normalizeDatabaseURL converts the SQLAlchemy style URL used by the Python
// test env into the plain postgres URL pgx accepts.
func normalizeDatabaseURL(raw string) string {
	for _, prefix := range []string{
		"postgresql+psycopg://",
		"postgresql+psycopg2://",
		"postgresql+asyncpg://",
		"postgresql://",
	} {
		if strings.HasPrefix(raw, prefix) {
			return "postgres://" + strings.TrimPrefix(raw, prefix)
		}
	}
	return raw
}

func databaseURLFromEnv(values map[string]string) (string, error) {
	if raw := strings.TrimSpace(values["DATABASE_URL"]); raw != "" {
		return normalizeDatabaseURL(raw), nil
	}
	host := firstNonEmpty(values["PGHOST"], "localhost")
	port := firstNonEmpty(values["PGPORT"], "5432")
	database := firstNonEmpty(values["PGDATABASE"], "BLF_TEST")
	user := values["PGUSER"]
	password := values["PGPASSWORD"]
	if user == "" || password == "" || database == "" {
		return "", errors.New("env file needs DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD")
	}
	if _, err := strconv.Atoi(port); err != nil {
		return "", fmt.Errorf("PGPORT=%q is not a number", port)
	}
	parsed := &url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(user, password),
		Host:     net.JoinHostPort(host, port),
		Path:     "/" + database,
		RawQuery: "sslmode=disable",
	}
	return parsed.String(), nil
}

func redisURLFromEnv(values map[string]string) string {
	if raw := strings.TrimSpace(values["REDIS_URL"]); raw != "" {
		return raw
	}
	host := firstNonEmpty(values["REDIS_HOST"], "127.0.0.1")
	port := firstNonEmpty(values["REDIS_PORT"], "6379")
	return "redis://" + net.JoinHostPort(host, port) + "/0"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
