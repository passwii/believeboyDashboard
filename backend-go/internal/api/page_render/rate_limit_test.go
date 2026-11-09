package page_render

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPublicRateLimiterRejectsRequestsOverWindow(t *testing.T) {
	now := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	limiter := newPublicRateLimiter(2, func() time.Time { return now })
	handler := limiter.middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	for index := 0; index < 2; index++ {
		req := httptest.NewRequest(http.MethodGet, "/public/p1", nil)
		req.RemoteAddr = "192.0.2.10:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d", index, rec.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/public/p1", nil)
	req.RemoteAddr = "192.0.2.10:1234"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
}
