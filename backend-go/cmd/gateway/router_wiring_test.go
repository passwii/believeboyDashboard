package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

// allRouterTestModules returns every module that the production gateway can
// construct, including built-in routes.go modules and write sub-modules.
// scheduled_reports is intentionally excluded: its dispatch_one /
// generate_delivery_summary task bridge is not ported yet, so the production
// module gate keeps it on the FastAPI fallback instead of enabling it in Go.
func allRouterTestModules() map[string]bool {
	return map[string]bool{
		"health": true, "exchange_rates": true, "exchange_rates_write": true,
		"notifications": true, "notifications_write": true,
		"alerts": true, "alerts_write": true, "profile": true,
		"agent": true, "agent_commerce": true, "agent_credentials": true,
		"agent_inspection": true, "agent_monthly_reports": true, "agent_ops": true,
		"agent_review_tracking": true, "ai_chat": true, "ai_chat_usage": true,
		"ai_chat_v2": true, "ai_file_upload": true, "ai_insight": true,
		"amazon_review_tracking": true, "auth": true, "category_research": true,
		"complaints": true, "crm": true, "daily_analysis": true,
		"digital_display": true, "digital_employees": true, "digital_office": true,
		"external_retired": true, "inspections": true, "internal_ad_data": true,
		"internal_jobs": true, "internal_keys": true, "inventory_ledger": true,
		"inventory_replenishment": true, "jobs": true, "monthly_reports": true,
		"new_product_calculations": true, "notification_settings": true,
		"order_info": true, "page_render": true, "platform_revenues": true,
		"presence": true, "pricing_calculation": true,
		"pricing_calculation_snapshots": true, "product_analysis": true,
		"product_analysis_reports": true, "product_label": true,
		"project_goals": true, "projects": true, "report_reconciliation": true,
		"return_analysis": true, "rpa_reports": true, "shipment_schedules": true,
		"shipping_plan": true, "shop_calculation": true, "sku_info": true,
		"system_management": true, "uploads": true, "users": true,
		"vat_invoices": true, "workflows": true, "insight_runs": true,
		"insight_domains": true, "insight_observation": true,
	}
}

// TestProductionRegistrarSetBuildsRouter is the runtime-wiring gate requested by
// the final review: it builds the real dependencies plus the real registrar
// collection and asserts that the gateway router can be constructed without
// panicking. It complements the static route manifest, which cannot detect
// duplicate mounts or registrar wiring errors.
func TestProductionRegistrarSetBuildsRouter(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"uploads", "results", "agent_monthly_reports", "project_launch_documents"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	cfg := config.Config{
		APIKey:                     "test-api-key",
		FastAPIOrigin:              "http://127.0.0.1:8100",
		DatabaseURL:                "postgres://localhost/test",
		DatabaseReadURL:            "postgres://localhost/replica",
		RedisURL:                   "redis://localhost:6379/0",
		InsightStreamRedisURL:      "redis://localhost:6379/4",
		UploadRoot:                 filepath.Join(root, "uploads"),
		MonthlyReportResultRoot:    filepath.Join(root, "results"),
		AgentMonthlyReportRoot:     filepath.Join(root, "agent_monthly_reports"),
		ProjectLaunchDocumentsRoot: filepath.Join(root, "project_launch_documents"),
		CRMFollowUpReminderDays:    7,
		OwnedModules:               allRouterTestModules(),
	}

	deps, err := newDependencies(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newDependencies() error = %v", err)
	}
	t.Cleanup(deps.Close)

	router, err := httpserver.NewRouter(cfg, slog.Default(), deps.Stores)
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}

	routes, ok := router.(chi.Routes)
	if !ok {
		t.Fatalf("router does not expose Routes()")
	}
	routeCount := 0
	if err := chi.Walk(routes, func(string, string, http.Handler, ...func(http.Handler) http.Handler) error {
		routeCount++
		return nil
	}); err != nil {
		t.Fatalf("chi.Walk() error = %v", err)
	}
	if routeCount == 0 {
		t.Fatalf("production router registered no routes")
	}

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/agent/projects", nil))
	if rec.Code == http.StatusNotFound {
		t.Fatalf("agent subrouter unreachable after production router construction: status=%d", rec.Code)
	}
	t.Logf("production registrar set built %d custom registrars / %d routes; agent probe status=%d", len(deps.Stores.CustomRegistrars), routeCount, rec.Code)
}
