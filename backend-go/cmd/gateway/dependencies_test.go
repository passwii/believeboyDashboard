package main

import (
	"context"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestNewDependenciesWiresOwnedModules(t *testing.T) {
	cfg := config.Config{
		APIKey:          "test-api-key",
		DatabaseURL:     "postgres://localhost/test",
		DatabaseReadURL: "postgres://localhost/replica",
		RedisURL:        "redis://localhost:6379/0",
		AppEnv:          "test",
		OwnedModules: map[string]bool{
			"health":         true,
			"exchange_rates": true,
			"notifications":  true,
			"alerts":         true,
			"profile":        true,
		},
	}

	deps, err := newDependencies(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newDependencies() error = %v", err)
	}
	t.Cleanup(deps.Close)

	if deps.Stores.APIKeys == nil || deps.Stores.ExchangeRates == nil ||
		deps.Stores.Notifications == nil || deps.Stores.Alerts == nil ||
		deps.Stores.Profile == nil || deps.Stores.HealthDatabase == nil ||
		deps.Stores.HealthReplica == nil || deps.Stores.HealthRedis == nil {
		t.Fatalf("NewRouter stores were not fully wired: %#v", deps.Stores)
	}
}

func TestNewDependenciesSkipsDisabledOwnedModules(t *testing.T) {
	cfg := config.Config{
		APIKey:       "test-api-key",
		DatabaseURL:  "postgres://localhost/test",
		RedisURL:     "redis://localhost:6379/0",
		OwnedModules: map[string]bool{},
	}

	deps, err := newDependencies(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newDependencies() error = %v", err)
	}
	t.Cleanup(deps.Close)
}

func TestNewDependenciesWiresPostStage6Modules(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		APIKey:                     "test-api-key",
		DatabaseURL:                "postgres://localhost/test",
		RedisURL:                   "redis://localhost:6379/0",
		InsightStreamRedisURL:      "redis://localhost:6379/4",
		UploadRoot:                 root,
		MonthlyReportResultRoot:    root,
		AgentMonthlyReportRoot:     root,
		ProjectLaunchDocumentsRoot: root,
		CRMFollowUpReminderDays:    7,
		OwnedModules: map[string]bool{
			"ai_chat":                  true,
			"ai_chat_v2":               true,
			"ai_chat_usage":            true,
			"ai_file_upload":           true,
			"crm":                      true,
			"system_management":        true,
			"digital_employees":        true,
			"digital_office":           true,
			"digital_display":          true,
			"agent_ops":                true,
			"presence":                 true,
			"uploads":                  true,
			"page_render":              true,
			"jobs":                     true,
			"external_retired":         true,
			"agent_inspection":         true,
			"agent_credentials":        true,
			"inspections":              true,
			"amazon_review_tracking":   true,
			"agent_monthly_reports":    true,
			"ai_insight":               true,
			"insight_runs":             true,
			"insight_domains":          true,
			"insight_observation":      true,
			"agent_commerce":           true,
			"agent_review_tracking":    true,
			"product_analysis":         true,
			"product_analysis_reports": true,
			"internal_jobs":            true,
		},
	}

	deps, err := newDependencies(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newDependencies() error = %v", err)
	}
	t.Cleanup(deps.Close)

	if len(deps.Stores.CustomRegistrars) < 25 {
		t.Fatalf("CustomRegistrars = %d, want all post-stage-6 domain registrars", len(deps.Stores.CustomRegistrars))
	}
}
