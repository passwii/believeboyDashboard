package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
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

// TestAllModulesWireAndBuildRouter is the "every module enabled" gate the
// 2026-11-09 readiness review asked for. It constructs the real dependency set
// (no database connection is opened eagerly) and the real chi router with
// config.AllModules enabled, so mount conflicts, missing wiring and module-list
// drift fail here instead of during a local cutover.
func TestAllModulesWireAndBuildRouter(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		APIKey:                     "test-api-key",
		FastAPIOrigin:              "http://127.0.0.1:8100",
		DatabaseURL:                "postgres://localhost/test",
		DatabaseReadURL:            "postgres://localhost/replica",
		RedisURL:                   "redis://localhost:6379/0",
		InsightStreamRedisURL:      "redis://localhost:6379/4",
		UploadRoot:                 root,
		MonthlyReportResultRoot:    root,
		AgentMonthlyReportRoot:     root,
		ProjectLaunchDocumentsRoot: root,
		CRMTaskReminderLeadHours:   24,
		CRMFollowUpReminderDays:    7,
		AppEnv:                     "test",
		OwnedModules:               config.AllModulesSet(),
	}

	deps, err := newDependencies(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newDependencies(all modules) error = %v", err)
	}
	t.Cleanup(deps.Close)

	all := config.AllModulesSet()
	core := make(map[string]bool)
	for _, module := range httpserver.CoreModuleNames() {
		core[module] = true
		if !all[module] {
			t.Errorf("CoreModuleNames lists %q which is missing from config.AllModules", module)
		}
	}
	registrars := make(map[string]bool)
	for _, registrar := range deps.Stores.CustomRegistrars {
		name := registrar.ModuleName()
		registrars[name] = true
		if !all[name] {
			t.Errorf("wired registrar %q is missing from config.AllModules", name)
		}
	}
	for _, module := range config.AllModules {
		if core[module] || registrars[module] {
			continue
		}
		t.Errorf("config.AllModules lists %q but no core switch or registrar implements it", module)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router, err := httpserver.NewRouter(cfg, logger, deps.Stores)
	if err != nil {
		t.Fatalf("NewRouter(all modules) error = %v", err)
	}

	var routes []string
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		routes = append(routes, method+" "+route)
		return nil
	}); err != nil {
		t.Fatalf("walk router: %v", err)
	}
	t.Logf("all-module gate: %d core modules, %d registrars, %d routes", len(core), len(registrars), len(routes))
	if len(routes) < 623 {
		t.Fatalf("registered routes = %d, want at least the 623 FastAPI operations", len(routes))
	}
	found := make(map[string]bool, len(routes))
	for _, route := range routes {
		found[route] = true
	}
	for _, want := range []string{
		"GET /api/v1/health/live",
		"GET /api/v1/projects/manage",
		"GET /api/v1/ai/conversations",
	} {
		if !found[want] {
			t.Errorf("all-module router is missing %q (registered route count %d)", want, len(routes))
		}
	}
}
