package httpserver_test

import (
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_commerce"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_credentials"
)

// moduleRegistrar mirrors httpserver.ModuleRegistrar without importing the
// package under test back into itself.
type moduleRegistrar interface {
	RegisterRoutes(router chi.Router, requireAPIKey func(http.Handler) http.Handler)
}

// TestAgentRegistrarsCanCoexist is the regression gate for the P0 startup crash
// where every Agent-domain registrar called router.Route("/api/v1/agent", ...).
//
// chi's Route proxies to Mount, and Mount panics with
// "attempting to Mount() a handler on an existing path" once the same pattern is
// mounted a second time. Because GO_API_OWNED is a free-form module list, any
// two of {agent, agent_commerce, agent_credentials} could be enabled together
// and kill the gateway inside NewRouter, before any request was served.
//
// The gate constructs every Agent registrar on one router, so re-introducing a
// Mount-based registration fails here instead of in production.
func TestAgentRegistrarsCanCoexist(t *testing.T) {
	registrars := []moduleRegistrar{
		// Nil/zero stores are fine: handlers fail closed at request time and the
		// registration path must not depend on wired dependencies.
		agent.NewRegistrar(agent.Stores{}, agent.Options{}),
		agent_commerce.NewRegistrar(nil, agent_commerce.Options{}),
		agent_credentials.NewRegistrar(nil, nil, agent_credentials.Options{}),
	}

	router := chi.NewRouter()
	for index, registrar := range registrars {
		func(index int, registrar moduleRegistrar) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf(
						"registrar #%d panicked while registering on a shared router: %v",
						index,
						recovered,
					)
				}
			}()
			registrar.RegisterRoutes(router, nil)
		}(index, registrar)
	}

	registered := make(map[string]struct{})
	for _, route := range router.Routes() {
		registered[route.Pattern] = struct{}{}
	}
	for _, want := range []string{
		// Owned by agent.
		"/api/v1/agent/health",
		"/api/v1/agent/projects",
		// Owned by agent_credentials.
		"/api/v1/agent/provisioning/keys",
		// Owned by agent_commerce.
		"/api/v1/agent/projects/{project_id}/sku-info",
	} {
		if _, ok := registered[want]; !ok {
			t.Errorf("route %q was not registered; all Agent registrars must share one tree", want)
		}
	}
}

// TestAgentRegistrarsDoNotMountPrefix ensures the Agent namespace is registered
// as flat patterns rather than as a mounted sub-router. A mounted prefix makes
// every unimplemented path under it return 404 instead of falling through to the
// FastAPI catch-all, which would break gradual cutover.
func TestAgentRegistrarsDoNotMountPrefix(t *testing.T) {
	registrars := []moduleRegistrar{
		agent.NewRegistrar(agent.Stores{}, agent.Options{}),
		agent_commerce.NewRegistrar(nil, agent_commerce.Options{}),
		agent_credentials.NewRegistrar(nil, nil, agent_credentials.Options{}),
	}

	router := chi.NewRouter()
	for _, registrar := range registrars {
		func(registrar moduleRegistrar) {
			defer func() { _ = recover() }()
			registrar.RegisterRoutes(router, nil)
		}(registrar)
	}

	for _, route := range router.Routes() {
		if route.Pattern == "/api/v1/agent/*" || route.Pattern == "/api/v1/agent" {
			t.Fatalf(
				"the Agent namespace is mounted as %q; flat registration is required so unowned paths can fall back to FastAPI",
				route.Pattern,
			)
		}
	}
}
