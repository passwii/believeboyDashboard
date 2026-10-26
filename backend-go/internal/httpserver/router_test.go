package httpserver

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestNewRouterAddsGeneratedRequestID(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)
	gateway := newTestGateway(t, upstream.URL)

	resp, err := gateway.Client().Get(gateway.URL + "/api/v1/unknown")
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("X-Request-ID"); got == "" {
		t.Fatal("X-Request-ID is empty, want generated request ID")
	}
}

func TestNewRouterFallbackHandlesRootPath(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("fastapi root"))
	}))
	t.Cleanup(upstream.Close)
	gateway := newTestGateway(t, upstream.URL)

	resp, err := gateway.Client().Get(gateway.URL + "/")
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	if string(body) != "fastapi root" {
		t.Errorf("body = %q, want %q", body, "fastapi root")
	}
}

func TestNewRouterRejectsInvalidFastAPIOrigin(t *testing.T) {
	_, err := NewRouter(config.Config{
		Addr:          "127.0.0.1:8200",
		FastAPIOrigin: "localhost:8100",
		APIKey:        "test-api-key",
		DatabaseURL:   "postgres://localhost/believeboy",
		RedisURL:      "redis://localhost:6379/0",
		OwnedModules:  map[string]bool{},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("NewRouter() error = nil, want invalid FASTAPI_ORIGIN error")
	}
	if !strings.Contains(err.Error(), "FASTAPI_ORIGIN") {
		t.Errorf("NewRouter() error = %q, want it to mention FASTAPI_ORIGIN", err)
	}
}

func TestNewRouterOwnedRouteTakesPrecedenceOverFallback(t *testing.T) {
	var upstreamHit atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamHit.Store(true)
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(upstream.Close)

	router, err := NewRouter(config.Config{
		Addr:          "127.0.0.1:8200",
		FastAPIOrigin: upstream.URL,
		APIKey:        "test-api-key",
		DatabaseURL:   "postgres://localhost/believeboy",
		RedisURL:      "redis://localhost:6379/0",
		OwnedModules:  map[string]bool{"health": true},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}
	router.Get("/api/v1/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("go health"))
	})

	gateway := httptest.NewServer(router)
	t.Cleanup(gateway.Close)
	resp, err := gateway.Client().Get(gateway.URL + "/api/v1/health")
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	if string(body) != "go health" {
		t.Errorf("body = %q, want %q", body, "go health")
	}
	if upstreamHit.Load() {
		t.Error("FastAPI fallback was called for a Go-owned route")
	}
	if got := resp.Header.Get("X-Request-ID"); got == "" {
		t.Error("X-Request-ID is empty, want generated request ID")
	}
}
