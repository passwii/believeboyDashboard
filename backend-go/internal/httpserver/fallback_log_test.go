package httpserver

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

// recordingHandler captures slog records so the test can assert on the exact
// fallback event emitted for a proxied request.
type recordingHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

func (handler *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (handler *recordingHandler) Handle(_ context.Context, record slog.Record) error {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	handler.records = append(handler.records, record.Clone())
	return nil
}

func (handler *recordingHandler) WithAttrs([]slog.Attr) slog.Handler { return handler }
func (handler *recordingHandler) WithGroup(string) slog.Handler      { return handler }

func (handler *recordingHandler) find(message string) (slog.Record, bool) {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	for _, record := range handler.records {
		if record.Message == message {
			return record, true
		}
	}
	return slog.Record{}, false
}

func recordAttr(record slog.Record, key string) (string, bool) {
	var value string
	var found bool
	record.Attrs(func(attr slog.Attr) bool {
		if attr.Key == key {
			value = attr.Value.String()
			found = true
			return false
		}
		return true
	})
	return value, found
}

func fallbackTestConfig(upstreamURL string, owned bool) config.Config {
	modules := map[string]bool{}
	if owned {
		modules["exchange_rates"] = true
	}
	return config.Config{
		Addr:               "127.0.0.1:8200",
		FastAPIOrigin:      upstreamURL,
		APIKey:             "test-api-key",
		TrustedProxySecret: "test-proxy-secret",
		DatabaseURL:        "postgres://localhost/believeboy",
		RedisURL:           "redis://localhost:6379/0",
		OwnedModules:       modules,
	}
}

func TestFallbackLoggerRecordsProxiedRequest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(upstream.Close)

	logs := &recordingHandler{}
	handler, err := NewRouter(fallbackTestConfig(upstream.URL, true), slog.New(logs), OwnedStores{})
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/not-owned/route?x=1", nil)
	request.Header.Set("X-Request-ID", "req-1")
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTeapot {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusTeapot)
	}

	record, ok := logs.find("request fell back to FastAPI")
	if !ok {
		t.Fatalf("fallback log missing; records = %d", len(logs.records))
	}
	if record.Level != slog.LevelWarn {
		t.Errorf("level = %v, want WARN", record.Level)
	}
	if path, _ := recordAttr(record, "path"); path != "/api/v1/not-owned/route" {
		t.Errorf("path = %q", path)
	}
	if status, _ := recordAttr(record, "status"); status != "418" {
		t.Errorf("status = %q, want 418", status)
	}
	if requestID, _ := recordAttr(record, "request_id"); requestID != "req-1" {
		t.Errorf("request_id = %q", requestID)
	}
}

// Every proxied request is now a migration gap, so an empty GO_API_OWNED list
// (nothing owned, everything proxied) still logs the fallback.
func TestFallbackLoggerRecordsEvenWhenNoModulesOwned(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("fastapi"))
	}))
	t.Cleanup(upstream.Close)

	logs := &recordingHandler{}
	handler, err := NewRouter(fallbackTestConfig(upstream.URL, false), slog.New(logs), OwnedStores{})
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/anything", nil))

	if _, ok := logs.find("request fell back to FastAPI"); !ok {
		t.Fatal("fallback log missing while GO_API_OWNED is empty")
	}
}

func TestFallbackLoggerKeepsStreamingFlusher(t *testing.T) {
	written := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Errorf("upstream writer is not a flusher")
			return
		}
		_, _ = io.WriteString(w, "event: ping\ndata: {}\n\n")
		flusher.Flush()
		close(written)
	}))
	t.Cleanup(upstream.Close)

	handler, err := NewRouter(fallbackTestConfig(upstream.URL, true), slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)), OwnedStores{})
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}
	router, ok := handler.(chi.Router)
	if !ok {
		t.Fatalf("NewRouter() did not return a chi router")
	}

	recorder := &flushCountingRecorder{header: make(http.Header)}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/streaming", nil)
	done := make(chan struct{})
	go func() {
		defer close(done)
		router.ServeHTTP(recorder, request)
	}()

	select {
	case <-written:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream never wrote the streaming frame")
	}
	<-done
	if !recorder.flushed() {
		t.Fatal("fallback wrapper swallowed http.Flusher")
	}
}

type flushCountingRecorder struct {
	mu       sync.Mutex
	header   http.Header
	body     bytes.Buffer
	flushCnt int
}

func (recorder *flushCountingRecorder) Header() http.Header { return recorder.header }

func (recorder *flushCountingRecorder) Write(payload []byte) (int, error) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.body.Write(payload)
}

func (recorder *flushCountingRecorder) WriteHeader(int) {}

func (recorder *flushCountingRecorder) Flush() {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.flushCnt++
}

func (recorder *flushCountingRecorder) flushed() bool {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.flushCnt > 0
}
