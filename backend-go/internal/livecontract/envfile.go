package livecontract

import (
	"fmt"
	"os"
	"strings"
)

// LoadEnvFile parses a KEY=VALUE env file the same way the deployment scripts
// do: comments and blank lines are skipped, surrounding quotes are stripped and
// the first "=" splits the pair. It exists so the live-contract tooling can be
// driven from backend/.env.test without a Python interpreter or shell sourcing
// (the file contains values with spaces and parentheses that break "source").
func LoadEnvFile(path string) (map[string]string, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read env file %s: %w", path, err)
	}
	values := make(map[string]string)
	for _, raw := range strings.Split(string(payload), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		values[key] = value
	}
	return values, nil
}

// RequireDisposableDatabase rejects any database whose name is not a known
// throwaway test database. The live contract seeds and reads rows, so pointing
// it at production would be destructive.
func RequireDisposableDatabase(databaseURL string) error {
	lowered := strings.ToLower(databaseURL)
	for _, suffix := range []string{"/blf_test", "/blf_ci"} {
		if strings.HasSuffix(lowered, suffix) || strings.Contains(lowered, suffix+"?") {
			return nil
		}
	}
	return fmt.Errorf("refused: DATABASE_URL/TEST_DATABASE_URL must target BLF_test or BLF_ci")
}
