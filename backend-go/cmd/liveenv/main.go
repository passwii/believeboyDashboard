// Command liveenv prints "export KEY=value" lines for a .env file.
//
// shell "source" cannot read backend/.env.test because values contain spaces and
// parentheses, so the live-contract runner asks this helper instead. Only the
// keys needed for the contract are printed; secrets never reach the log.
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/livecontract"
)

// printableKeys is an allowlist: the runner needs these and nothing else, so a
// stray value in the env file cannot leak into the shell or the log.
var printableKeys = []string{
	"API_KEY",
	"DATABASE_URL",
	"TEST_DATABASE_URL",
	"REDIS_URL",
	"REDIS_HOST",
	"REDIS_PORT",
	"REDIS_DB",
	"APP_ENV",
	"GO_API_TEST_DATABASE_URL",
	"LIVE_CONTRACT_API_KEY",
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "liveenv:", err)
		os.Exit(1)
	}
}

func run() error {
	envFile := flag.String("env-file", "", "env file to read")
	flag.Parse()
	if strings.TrimSpace(*envFile) == "" {
		return fmt.Errorf("--env-file is required")
	}

	values, err := livecontract.LoadEnvFile(*envFile)
	if err != nil {
		return err
	}
	database := firstNonEmpty(values, "TEST_DATABASE_URL", "DATABASE_URL")
	if database != "" {
		if err := livecontract.RequireDisposableDatabase(database); err != nil {
			return err
		}
	}

	sort.Strings(printableKeys)
	for _, key := range printableKeys {
		value, ok := values[key]
		if !ok || value == "" {
			continue
		}
		fmt.Printf("export %s=%s\n", key, shellQuote(value))
	}
	return nil
}

func firstNonEmpty(values map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(values[key]); value != "" {
			return value
		}
	}
	return ""
}

// shellQuote emits a single-quoted POSIX shell word.
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
