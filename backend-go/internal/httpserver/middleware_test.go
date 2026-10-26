package httpserver

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddlewareRecoversPanicWithRequestIDAndLogging(t *testing.T) {
	var logs strings.Builder
	logger := slog.New(slog.NewTextHandler(&logs, nil))

	handler := RequestID(RequestLogger(logger)(PanicRecovery(logger)(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("boom")
		}),
	)))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/panic", nil)
	req.Header.Set("X-Request-ID", "request-123")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	if got := rec.Header().Get("X-Request-ID"); got != "request-123" {
		t.Errorf("X-Request-ID = %q, want %q", got, "request-123")
	}
	for _, want := range []string{"http request", "status=500", "request_id=request-123", "panic recovered"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("logs = %q, want it to contain %q", logs.String(), want)
		}
	}
}
