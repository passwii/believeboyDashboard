package httpserver_test

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_commerce"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_credentials"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

func realAgentRegistrars() map[string]httpserver.ModuleRegistrar {
	return map[string]httpserver.ModuleRegistrar{
		"agent":             agent.NewRegistrar(agent.Stores{}, agent.Options{}),
		"agent_commerce":    agent_commerce.NewRegistrar(nil, agent_commerce.Options{}),
		"agent_credentials": agent_credentials.NewRegistrar(nil, nil, agent_credentials.Options{}),
	}
}

func buildAgentRouter(t *testing.T, names ...string) chi.Router {
	t.Helper()
	all := realAgentRegistrars()
	owned := map[string]bool{}
	modules := make([]httpserver.ModuleRegistrar, 0, len(names))
	for _, name := range names {
		module, ok := all[name]
		if !ok {
			t.Fatalf("unknown module %q", name)
		}
		owned[name] = true
		modules = append(modules, module)
	}
	router, err := httpserver.NewRouter(config.Config{
		APIKey:        "test-api-key",
		FastAPIOrigin: "http://127.0.0.1:8100",
		OwnedModules:  owned,
	}, slog.Default(), httpserver.OwnedStores{CustomRegistrars: modules})
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}
	return router
}

func walkRoutes(t *testing.T, router chi.Router) map[string]bool {
	t.Helper()
	routes, ok := router.(chi.Routes)
	if !ok {
		t.Fatalf("router does not expose Routes()")
	}
	seen := map[string]bool{}
	if err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("chi.Walk() error = %v", err)
	}
	return seen
}

// TestAgentModulesShareSingleAgentSubrouterMount guards the P0 regression where
// agent, agent_commerce and agent_credentials each mounted /api/v1/agent on
// the same router and made chi panic at gateway startup.
func TestAgentModulesShareSingleAgentSubrouterMount(t *testing.T) {
	type expectation struct {
		name   string
		routes []string
	}
	moduleExpectations := map[string]expectation{
		"agent": {
			name: "agent",
			routes: []string{
				http.MethodGet + " /api/v1/agent/health",
				http.MethodGet + " /api/v1/agent/projects",
			},
		},
		"agent_commerce": {
			name: "agent_commerce",
			routes: []string{
				http.MethodGet + " /api/v1/agent/projects/{project_id}/sku-info",
			},
		},
		"agent_credentials": {
			name: "agent_credentials",
			routes: []string{
				http.MethodGet + " /api/v1/agent/provisioning/keys",
			},
		},
	}
	cases := [][]string{
		{"agent"},
		{"agent_commerce"},
		{"agent_credentials"},
		{"agent", "agent_commerce"},
		{"agent", "agent_credentials"},
		{"agent_commerce", "agent_credentials"},
		{"agent", "agent_commerce", "agent_credentials"},
	}
	for _, names := range cases {
		names := names
		t.Run("", func(t *testing.T) {
			router := buildAgentRouter(t, names...)
			routes := walkRoutes(t, router)
			if len(routes) == 0 {
				t.Fatalf("no routes registered for %v", names)
			}
			for _, name := range names {
				for _, want := range moduleExpectations[name].routes {
					if !routes[want] {
						t.Fatalf("module %s route %q missing with modules %v", name, want, names)
					}
				}
			}
			probe := moduleExpectations[names[0]].routes[0]
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, strings.TrimPrefix(strings.TrimPrefix(probe, http.MethodGet+" "), http.MethodPost+" "), nil))
			if rec.Code == http.StatusNotFound {
				t.Fatalf("agent subrouter unreachable for %v (probe=%q)", names, probe)
			}
			t.Logf("modules=%v routes=%d probe_status=%d", names, len(routes), rec.Code)
		})
	}
}

// TestAgentRegistrarsRemainUsableStandalone keeps the contract used by
// per-module router tests and contract tests working after the subrouter split.
func TestAgentRegistrarsRemainUsableStandalone(t *testing.T) {
	for name, registrar := range realAgentRegistrars() {
		name, registrar := name, registrar
		t.Run(name, func(t *testing.T) {
			router := chi.NewRouter()
			registrar.RegisterRoutes(router, nil)
			if len(walkRoutes(t, router)) == 0 {
				t.Fatalf("standalone registrar %s registered no routes", name)
			}
		})
	}
}
