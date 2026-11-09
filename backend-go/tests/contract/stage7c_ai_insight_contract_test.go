package contract

import (
	"fmt"
	"net/http"
	"sort"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_domains"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_observation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
)

func TestStage7CAIInsightRouteContract(t *testing.T) {
	router := chi.NewRouter()
	noAuth := func(next http.Handler) http.Handler { return next }
	ai_insight.NewRegistrar(nil, nil, ai_insight.DefaultConfig()).RegisterRoutes(router, noAuth)
	insight_runs.NewRegistrar(nil, nil, nil, nil, insight_runs.DefaultConfig()).RegisterRoutes(router, noAuth)
	insight_domains.NewRegistrar(nil, nil, nil, insight_domains.Config{}).RegisterRoutes(router, noAuth)
	insight_observation.NewRegistrar(nil, insight_observation.DefaultConfig()).RegisterRoutes(router, noAuth)

	got := make([]string, 0, 24)
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got = append(got, fmt.Sprintf("%s %s", method, route))
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	sort.Strings(got)
	want := []string{
		"DELETE /api/v1/ai-insights/schedules/{schedule_id}",
		"DELETE /api/v1/ai-insights/{insight_id}",
		"GET /api/v1/ai-insights",
		"GET /api/v1/ai-insights/ad-agent/evolution-report",
		"GET /api/v1/ai-insights/latest",
		"GET /api/v1/ai-insights/schedules",
		"GET /api/v1/ai-insights/{insight_id}",
		"GET /api/v1/ai-insights/{insight_id}/stream",
		"GET /api/v1/insight/observation/gate",
		"GET /api/v1/insight/observation/retirement-readiness",
		"GET /api/v1/insight/runs/{run_id}",
		"GET /api/v1/insight/runs/{run_id}/stream",
		"PATCH /api/v1/ai-insights/schedules/{schedule_id}",
		"POST /api/v1/ai-insights/generate",
		"POST /api/v1/ai-insights/schedules",
		"POST /api/v1/ai-insights/schedules/{schedule_id}/run-now",
		"POST /api/v1/ai-insights/schedules/{schedule_id}/toggle",
		"POST /api/v1/ai-insights/{insight_id}/retry",
		"POST /api/v1/insight/ad-analysis/runs",
		"POST /api/v1/insight/inventory-health/runs",
		"POST /api/v1/insight/runs",
		"POST /api/v1/insight/runs/{run_id}/cancel",
		"POST /api/v1/insight/runs/{run_id}/retry",
		"PUT /api/v1/ai-insights/{insight_id}",
	}
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("route count = %d, want %d\ngot=%#v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("route[%d] = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestStage7CAIInsightModuleNames(t *testing.T) {
	cases := []struct {
		name string
		got  string
	}{
		{"ai_insight", ai_insight.NewRegistrar(nil, nil, ai_insight.DefaultConfig()).ModuleName()},
		{"insight_runs", insight_runs.NewRegistrar(nil, nil, nil, nil, insight_runs.DefaultConfig()).ModuleName()},
		{"insight_domains", insight_domains.NewRegistrar(nil, nil, nil, insight_domains.Config{}).ModuleName()},
		{"insight_observation", insight_observation.NewRegistrar(nil, insight_observation.DefaultConfig()).ModuleName()},
	}
	for _, testCase := range cases {
		if testCase.got != testCase.name {
			t.Fatalf("ModuleName() = %q, want %q", testCase.got, testCase.name)
		}
	}
}
