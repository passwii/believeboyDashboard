package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

// TestAllModuleRouterCoversOpenAPIOperations guards the "no route silently
// falls back to FastAPI" invariant: every operation published by the FastAPI
// OpenAPI document must be served by the Go router. Without this check a
// registrar that forgets a route, or one whose chi pattern diverges from the
// OpenAPI template, only surfaces at request time as a gateway fallback.
func TestAllModuleRouterCoversOpenAPIOperations(t *testing.T) {
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
		t.Fatalf("newDependencies: %v", err)
	}
	t.Cleanup(deps.Close)
	router, err := httpserver.NewRouter(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), deps.Stores)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}

	registered := make(map[string][]string)
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		method = strings.ToUpper(method)
		registered[method] = append(registered[method], route)
		return nil
	}); err != nil {
		t.Fatalf("walk router: %v", err)
	}

	openAPIPath := filepath.Join("..", "..", "..", "frontend", "types", "api-generated", "openapi.json")
	payload, err := os.ReadFile(openAPIPath)
	if err != nil {
		t.Fatalf("read openapi: %v", err)
	}
	operations, err := openAPIOperations(payload)
	if err != nil {
		t.Fatalf("parse openapi: %v", err)
	}

	missing := make([]string, 0)
	for _, operation := range operations {
		parts := strings.SplitN(operation, " ", 2)
		method, path := parts[0], parts[1]
		if !anyRouteCovers(registered[method], path) {
			missing = append(missing, operation)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("Go router is missing %d OpenAPI operation(s):%s%s", len(missing), string(rune(10)), strings.Join(missing, string(rune(10))))
	}
	total := 0
	for _, routes := range registered {
		total += len(routes)
	}
	t.Logf("Go router covers %d OpenAPI operations with %d registered routes", len(operations), total)
}

// anyRouteCovers reports whether one chi pattern serves the OpenAPI path
// template. Both {param} and chi's trailing * wildcard count as matching, because
// SKU path segments may contain slashes that OpenAPI models as one placeholder.
func anyRouteCovers(routes []string, openAPIPath string) bool {
	for _, route := range routes {
		if routeMatches(route, openAPIPath) {
			return true
		}
	}
	return false
}

func routeMatches(route, openAPIPath string) bool {
	routeSegments := splitPath(route)
	targetSegments := splitPath(openAPIPath)
	for index, segment := range routeSegments {
		switch {
		case segment == "*":
			return index < len(targetSegments)
		case strings.Contains(segment, "{"):
			if index >= len(targetSegments) {
				return false
			}
		default:
			if index >= len(targetSegments) || targetSegments[index] != segment {
				return false
			}
		}
	}
	return len(routeSegments) == len(targetSegments)
}

func splitPath(path string) []string {
	path = strings.TrimSuffix(path, "/")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

func normalizeOperation(method, path string) string {
	return strings.ToUpper(method) + " " + strings.TrimSuffix(path, "/")
}

func openAPIOperations(payload []byte) ([]string, error) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	operations := make([]string, 0)
	for path, item := range document.Paths {
		for method := range item {
			method = strings.ToLower(method)
			if method == "parameters" {
				continue
			}
			operations = append(operations, normalizeOperation(method, path))
		}
	}
	sort.Strings(operations)
	return operations, nil
}
