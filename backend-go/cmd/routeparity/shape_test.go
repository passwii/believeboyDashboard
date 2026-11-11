package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestExtractGETRoutesSkipsPathParams(t *testing.T) {
	document := map[string]any{
		"paths": map[string]any{
			"/api/v1/alpha":     map[string]any{"get": map[string]any{}, "post": map[string]any{}},
			"/api/v1/beta/{id}": map[string]any{"get": map[string]any{}},
			"/api/v1/gamma":     map[string]any{"post": map[string]any{}},
			"/api/v1/delta":     map[string]any{"get": map[string]any{}},
		},
	}
	payload, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	routes, skipped, err := extractGETRoutes(payload)
	if err != nil {
		t.Fatalf("extractGETRoutes() error = %v", err)
	}
	if skipped != 1 {
		t.Errorf("skipped = %d, want 1", skipped)
	}
	if len(routes) != 2 || routes[0] != "/api/v1/alpha" || routes[1] != "/api/v1/delta" {
		t.Errorf("routes = %#v", routes)
	}
}

func TestJSONShapeIgnoresValues(t *testing.T) {
	left, ok := decodeJSON([]byte(`{"id":1,"items":[{"name":"a"}]}`))
	if !ok {
		t.Fatal("decode left failed")
	}
	right, ok := decodeJSON([]byte(`{"id":99,"items":[{"name":"other"}]}`))
	if !ok {
		t.Fatal("decode right failed")
	}
	if jsonShape(left) != jsonShape(right) {
		t.Errorf("shapes differ: %s vs %s", jsonShape(left), jsonShape(right))
	}
}

func TestJSONShapeDetectsStructuralDrift(t *testing.T) {
	left, _ := decodeJSON([]byte(`{"id":1}`))
	right, _ := decodeJSON([]byte(`{"id":1,"extra":true}`))
	if jsonShape(left) == jsonShape(right) {
		t.Fatal("shapes should differ when a key is added")
	}
}

func TestCompareRouteReportsMismatches(t *testing.T) {
	fastapi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"a":1}`))
	}))
	t.Cleanup(fastapi.Close)
	goServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"a":1,"b":2}`))
	}))
	t.Cleanup(goServer.Close)

	item := compareRoute(http.DefaultClient, fastapi.URL, goServer.URL, http.Header{}, parityRoute{path: "/api/v1/x", requestPath: "/api/v1/x"})
	if item.problem != "JSON shape differs" {
		t.Fatalf("problem = %q", item.problem)
	}

	statusMismatch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(statusMismatch.Close)
	item = compareRoute(http.DefaultClient, fastapi.URL, statusMismatch.URL, http.Header{}, parityRoute{path: "/api/v1/x", requestPath: "/api/v1/x"})
	if item.problem != "status differs" {
		t.Fatalf("problem = %q", item.problem)
	}
}

func TestReadEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.env"
	content := "API_KEY=abc\nQUOTED='value with spaces'\n# comment\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	values, err := readEnvFile(path)
	if err != nil {
		t.Fatalf("readEnvFile() error = %v", err)
	}
	if values["API_KEY"] != "abc" {
		t.Errorf("API_KEY = %q", values["API_KEY"])
	}
	if values["QUOTED"] != "value with spaces" {
		t.Errorf("QUOTED = %q", values["QUOTED"])
	}
}
