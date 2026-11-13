// Package autoreport implements the Go replacement for the legacy
// autoReportUpload Python service: watch project folders for new report
// files, recognize them through the gateway, commit them, and archive them.
package autoreport

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Defaults mirror autoReportUpload/config.py so operators can switch binaries
// without touching their environment.
const (
	DefaultWatchRoot     = "/Users/damon/Documents/RPA"
	DefaultWorkers       = 3
	DefaultStableSamples = 2
	DefaultStablePoll    = time.Second
	DefaultMaxAttempts   = 3
	DefaultPollInterval  = 60 * time.Second
	DefaultDrainTimeout  = 15 * time.Minute
	DefaultOperator      = "autoReportUpload"
	DefaultCountry       = "US"
	ProcessedSubdir      = "processed"
	AdProcessedSubdir    = "广告Processed"
)

// LegacyProjectNames are the project folders the Python service watched.
var LegacyProjectNames = []string{
	"博朗姆", "卡斯摩", "创酷", "吕沃", "铨富",
	"骏成", "华洋泛航", "玥涵", "犀牛", "瑞迪特",
}

// CountrySubfolders maps a subfolder name to the country it represents.
// Only 美国 exists today; add entries when other country sites land.
var CountrySubfolders = map[string]string{
	"美国": "US",
}

// Config is the runtime configuration for the watcher.
type Config struct {
	WatchRoot         string
	Projects          []string
	ProcessedSubdir   string
	AdProcessedSubdir string
	Extensions        map[string]bool
	IgnoredDirs       map[string]bool
	Workers           int
	StableSamples     int
	StablePoll        time.Duration
	MaxAttempts       int
	PollInterval      time.Duration
	DrainTimeout      time.Duration
	DryRun            bool
	Once              bool

	// Gateway connection.
	BaseURL            string
	APIKey             string
	TrustedProxySecret string
	Operator           string
	Admin              bool
	Country            string
	RequestTimeout     time.Duration

	// Now/Logf are injectable for tests.
	Now  func() time.Time
	Logf func(format string, args ...any)
}

// LoadConfig reads configuration from the environment.
func LoadConfig(env map[string]string) (Config, error) {
	cfg := Config{
		WatchRoot:          firstNonEmpty(env["WATCH_ROOT"], env["AUTORUN_WATCH_ROOT"], DefaultWatchRoot),
		ProcessedSubdir:    firstNonEmpty(env["AUTORUN_PROCESSED_SUBDIR"], ProcessedSubdir),
		AdProcessedSubdir:  firstNonEmpty(env["AUTORUN_AD_PROCESSED_SUBDIR"], AdProcessedSubdir),
		Extensions:         map[string]bool{".txt": true, ".csv": true, ".xlsx": true},
		IgnoredDirs:        map[string]bool{"sync.ffs_db": true},
		BaseURL:            firstNonEmpty(env["GO_API_BASE_URL"], env["BACKEND_INTERNAL_URL"], "http://127.0.0.1:8200"),
		APIKey:             strings.TrimSpace(env["API_KEY"]),
		TrustedProxySecret: strings.TrimSpace(env["GO_API_TRUSTED_PROXY_SECRET"]),
		Operator:           firstNonEmpty(env["AUTORUN_OPERATOR"], DefaultOperator),
		Country:            strings.ToUpper(firstNonEmpty(env["AUTORUN_COUNTRY"], DefaultCountry)),
		RequestTimeout:     90 * time.Second,
		Now:                time.Now,
		Logf:               func(format string, args ...any) { fmt.Printf(format, args...); fmt.Println() },
	}
	cfg.WatchRoot = filepath.Clean(cfg.WatchRoot)

	workers, err := intEnv(env, "AUTORUN_WATCH_WORKERS", DefaultWorkers)
	if err != nil {
		return Config{}, err
	}
	cfg.Workers = workers
	samples, err := intEnv(env, "AUTORUN_STABLE_SAMPLES", DefaultStableSamples)
	if err != nil {
		return Config{}, err
	}
	cfg.StableSamples = samples
	attempts, err := intEnv(env, "AUTORUN_MAX_FILE_ATTEMPTS", DefaultMaxAttempts)
	if err != nil {
		return Config{}, err
	}
	cfg.MaxAttempts = attempts

	if raw := strings.TrimSpace(env["AUTORUN_STABLE_POLL_SECONDS"]); raw != "" {
		seconds, err := strconv.ParseFloat(raw, 64)
		if err != nil || seconds <= 0 {
			return Config{}, fmt.Errorf("AUTORUN_STABLE_POLL_SECONDS must be a positive number")
		}
		cfg.StablePoll = time.Duration(seconds * float64(time.Second))
	} else {
		cfg.StablePoll = DefaultStablePoll
	}

	if raw := strings.TrimSpace(env["CHECK_INTERVAL_MINUTES"]); raw != "" {
		minutes, err := strconv.ParseFloat(raw, 64)
		if err != nil || minutes <= 0 {
			return Config{}, fmt.Errorf("CHECK_INTERVAL_MINUTES must be a positive number")
		}
		cfg.PollInterval = time.Duration(minutes * float64(time.Minute))
	} else {
		cfg.PollInterval = DefaultPollInterval
	}

	if raw := strings.TrimSpace(env["AUTORUN_DRAIN_TIMEOUT_SECONDS"]); raw != "" {
		seconds, err := strconv.ParseFloat(raw, 64)
		if err != nil || seconds <= 0 {
			return Config{}, fmt.Errorf("AUTORUN_DRAIN_TIMEOUT_SECONDS must be a positive number")
		}
		cfg.DrainTimeout = time.Duration(seconds * float64(time.Second))
	} else {
		cfg.DrainTimeout = DefaultDrainTimeout
	}

	cfg.DryRun = truthy(env["AUTORUN_DRY_RUN"])
	cfg.Once = truthy(env["AUTORUN_ONCE"])
	cfg.Admin = !falsy(env["AUTORUN_ADMIN"])

	cfg.Projects = LegacyProjectNames
	if raw := strings.TrimSpace(env["AUTORUN_PROJECTS"]); raw != "" {
		parts := strings.Split(raw, ",")
		projects := make([]string, 0, len(parts))
		for _, part := range parts {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				projects = append(projects, trimmed)
			}
		}
		cfg.Projects = projects
	}

	if cfg.APIKey == "" {
		return Config{}, errors.New("API_KEY is required to call the gateway")
	}
	if !strings.HasPrefix(cfg.BaseURL, "http://") && !strings.HasPrefix(cfg.BaseURL, "https://") {
		return Config{}, fmt.Errorf("GO_API_BASE_URL must be an absolute http(s) URL, got %q", cfg.BaseURL)
	}
	return cfg, nil
}

func intEnv(env map[string]string, key string, fallback int) (int, error) {
	raw := strings.TrimSpace(env[key])
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func truthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func falsy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "0", "false", "no", "off":
		return true
	}
	return false
}

// ProjectByName reports whether name is a watched project.
func (c Config) ProjectByName(name string) bool {
	for _, project := range c.Projects {
		if project == name {
			return true
		}
	}
	return false
}

// SupportedExtension reports whether the file extension is handled.
func (c Config) SupportedExtension(ext string) bool { return c.Extensions[strings.ToLower(ext)] }
