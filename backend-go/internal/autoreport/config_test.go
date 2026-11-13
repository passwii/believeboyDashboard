package autoreport

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testConfig(t *testing.T, root string) Config {
	t.Helper()
	config := Config{
		WatchRoot:         root,
		Projects:          []string{"博朗姆", "卡斯摩"},
		ProcessedSubdir:   ProcessedSubdir,
		AdProcessedSubdir: AdProcessedSubdir,
		Extensions:        map[string]bool{".txt": true, ".csv": true, ".xlsx": true},
		IgnoredDirs:       map[string]bool{"sync.ffs_db": true},
		Workers:           1,
		StableSamples:     1,
		StablePoll:        time.Millisecond,
		MaxAttempts:       1,
		PollInterval:      time.Second,
		DrainTimeout:      time.Second,
		BaseURL:           "http://127.0.0.1:8200",
		APIKey:            "test-key",
		Operator:          DefaultOperator,
		Country:           DefaultCountry,
		RequestTimeout:    time.Second,
		Now:               time.Now,
		Logf:              func(string, ...any) {},
	}
	return config
}

func TestLoadConfigDefaultsAndOverrides(t *testing.T) {
	config, err := LoadConfig(map[string]string{"API_KEY": "k"})
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if config.WatchRoot != DefaultWatchRoot {
		t.Fatalf("watch root = %q, want %q", config.WatchRoot, DefaultWatchRoot)
	}
	if config.Workers != DefaultWorkers || config.StableSamples != DefaultStableSamples {
		t.Fatalf("defaults not applied: %+v", config)
	}
	if len(config.Projects) != len(LegacyProjectNames) {
		t.Fatalf("projects = %d, want %d", len(config.Projects), len(LegacyProjectNames))
	}

	config, err = LoadConfig(map[string]string{
		"API_KEY":                "k",
		"WATCH_ROOT":             "/tmp/rpa",
		"AUTORUN_WATCH_WORKERS":  "2",
		"AUTORUN_STABLE_SAMPLES": "3",
		"AUTORUN_PROJECTS":       "甲, 乙",
		"GO_API_BASE_URL":        "http://127.0.0.1:9999",
		"AUTORUN_DRY_RUN":        "true",
		"CHECK_INTERVAL_MINUTES": "0.5",
	})
	if err != nil {
		t.Fatalf("LoadConfig overrides: %v", err)
	}
	if config.Workers != 2 || config.StableSamples != 3 {
		t.Fatalf("overrides not applied: %+v", config)
	}
	if len(config.Projects) != 2 || config.Projects[0] != "甲" || config.Projects[1] != "乙" {
		t.Fatalf("projects = %#v", config.Projects)
	}
	if !config.DryRun {
		t.Fatal("dry run not parsed")
	}
	if config.PollInterval != 30*time.Second {
		t.Fatalf("poll interval = %s, want 30s", config.PollInterval)
	}
}

func TestLoadConfigRejectsMissingAPIKey(t *testing.T) {
	if _, err := LoadConfig(map[string]string{}); err == nil {
		t.Fatal("missing API_KEY must be rejected")
	}
}

func TestLoadConfigRejectsBadNumbers(t *testing.T) {
	for _, env := range []map[string]string{
		{"API_KEY": "k", "AUTORUN_WATCH_WORKERS": "0"},
		{"API_KEY": "k", "AUTORUN_STABLE_SAMPLES": "-1"},
		{"API_KEY": "k", "AUTORUN_STABLE_POLL_SECONDS": "abc"},
		{"API_KEY": "k", "GO_API_BASE_URL": "ftp://nope"},
	} {
		if _, err := LoadConfig(env); err == nil {
			t.Fatalf("expected error for %#v", env)
		}
	}
}

func TestEligibleResolvesProjectAndCountry(t *testing.T) {
	root := t.TempDir()
	config := testConfig(t, root)

	rootFile := filepath.Join(root, "博朗姆", "report.xlsx")
	file, err := config.Eligible(rootFile)
	if err != nil {
		t.Fatalf("Eligible(root file): %v", err)
	}
	if file.ProjectName != "博朗姆" || file.Country != "US" {
		t.Fatalf("file = %+v", file)
	}

	countryFile := filepath.Join(root, "卡斯摩", "美国", "report.csv")
	file, err = config.Eligible(countryFile)
	if err != nil {
		t.Fatalf("Eligible(country file): %v", err)
	}
	if file.ProjectName != "卡斯摩" || file.Country != "US" {
		t.Fatalf("file = %+v", file)
	}

	if _, err := config.Eligible(filepath.Join(root, "未知项目", "report.xlsx")); err == nil {
		t.Fatal("unknown project must be rejected")
	}
}

func TestCollectSkipsArchivesAndUnsupportedExtensions(t *testing.T) {
	root := t.TempDir()
	config := testConfig(t, root)
	write := func(path string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(root, "博朗姆", "a.xlsx"))
	write(filepath.Join(root, "博朗姆", "b.csv"))
	write(filepath.Join(root, "博朗姆", "c.json"))
	write(filepath.Join(root, "博朗姆", "processed", "old.xlsx"))
	write(filepath.Join(root, "博朗姆", "广告Processed", "old.xlsx"))
	write(filepath.Join(root, "卡斯摩", "美国", "d.xlsx"))
	write(filepath.Join(root, "未在名单", "e.xlsx"))

	files, errs := config.Collect()
	if len(errs) != 0 {
		t.Fatalf("collect errors: %v", errs)
	}
	if len(files) != 3 {
		t.Fatalf("files = %d (%+v), want 3", len(files), files)
	}
	names := map[string]bool{}
	for _, file := range files {
		names[filepath.Base(file.Path)] = true
	}
	for _, want := range []string{"a.xlsx", "b.csv", "d.xlsx"} {
		if !names[want] {
			t.Fatalf("missing %s in %+v", want, names)
		}
	}
}
