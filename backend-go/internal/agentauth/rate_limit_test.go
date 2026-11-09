package agentauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseRateLimit(t *testing.T) {
	tests := []struct {
		spec    string
		want    RateLimit
		wantErr bool
	}{
		{spec: "5/minute", want: RateLimit{Requests: 5, Window: time.Minute}},
		{spec: " 60 / hour ", want: RateLimit{Requests: 60, Window: time.Hour}},
		{spec: "1/second", want: RateLimit{Requests: 1, Window: time.Second}},
		{spec: "100/day", want: RateLimit{Requests: 100, Window: 24 * time.Hour}},
		{spec: "", wantErr: true},
		{spec: "0/minute", wantErr: true},
		{spec: "ten/minute", wantErr: true},
		{spec: "10/fortnight", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.spec, func(t *testing.T) {
			got, err := ParseRateLimit(tt.spec)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ParseRateLimit(%q) error = nil, want error", tt.spec)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseRateLimit(%q) error = %v", tt.spec, err)
			}
			if got != tt.want {
				t.Fatalf("ParseRateLimit(%q) = %+v, want %+v", tt.spec, got, tt.want)
			}
		})
	}
}

func TestMemoryRateLimiterFixedWindow(t *testing.T) {
	now := time.Date(2026, time.November, 8, 10, 0, 0, 0, time.UTC)
	limiter := NewMemoryRateLimiter(
		RateLimit{Requests: 2, Window: time.Minute},
		WithMemoryRateLimitClock(func() time.Time { return now }),
	)

	first := limiter.Allow("agent:one")
	second := limiter.Allow("agent:one")
	third := limiter.Allow("agent:one")
	if !first.Allowed || !second.Allowed || third.Allowed {
		t.Fatalf("unexpected decisions: %+v %+v %+v", first, second, third)
	}
	if third.Remaining != 0 || third.RetryAfter != time.Minute {
		t.Fatalf("blocked decision = %+v", third)
	}

	now = now.Add(time.Minute)
	reset := limiter.Allow("agent:one")
	if !reset.Allowed || reset.Remaining != 1 {
		t.Fatalf("decision after reset = %+v", reset)
	}
}

func TestRequireRateLimitIsPerAgent(t *testing.T) {
	now := time.Date(2026, time.November, 8, 10, 0, 0, 0, time.UTC)
	limiter := NewMemoryRateLimiter(
		RateLimit{Requests: 1, Window: time.Minute},
		WithMemoryRateLimitClock(func() time.Time { return now }),
	)
	handler := RequireRateLimit(limiter)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	responseA1 := httptest.NewRecorder()
	handler.ServeHTTP(responseA1, rateLimitRequest("agent-a", "10.0.0.1:1234"))
	if responseA1.Code != http.StatusNoContent {
		t.Fatalf("agent A first status = %d, want 204", responseA1.Code)
	}

	responseA2 := httptest.NewRecorder()
	handler.ServeHTTP(responseA2, rateLimitRequest("agent-a", "10.0.0.1:1234"))
	assertErrorResponse(t, responseA2, http.StatusTooManyRequests, ErrorCodeAgentRateLimitExceeded, DetailRateLimitExceeded)
	if responseA2.Header().Get("Retry-After") != "60" {
		t.Fatalf("Retry-After = %q, want 60", responseA2.Header().Get("Retry-After"))
	}

	responseB := httptest.NewRecorder()
	handler.ServeHTTP(responseB, rateLimitRequest("agent-b", "10.0.0.2:1234"))
	if responseB.Code != http.StatusNoContent {
		t.Fatalf("agent B status = %d, want 204: %s", responseB.Code, responseB.Body.String())
	}
}

func TestRequireRateLimitFallsBackToRemoteIP(t *testing.T) {
	now := time.Date(2026, time.November, 8, 10, 0, 0, 0, time.UTC)
	limiter := NewMemoryRateLimiter(
		RateLimit{Requests: 1, Window: time.Minute},
		WithMemoryRateLimitClock(func() time.Time { return now }),
	)
	handler := RequireRateLimit(limiter)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	first := httptest.NewRequest(http.MethodGet, "/", nil)
	first.RemoteAddr = "192.0.2.10:4321"
	firstResponse := httptest.NewRecorder()
	handler.ServeHTTP(firstResponse, first)
	if firstResponse.Code != http.StatusNoContent {
		t.Fatalf("first status = %d, want 204", firstResponse.Code)
	}

	second := httptest.NewRequest(http.MethodGet, "/", nil)
	second.RemoteAddr = "192.0.2.10:9999"
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, second)
	assertErrorResponse(t, secondResponse, http.StatusTooManyRequests, ErrorCodeAgentRateLimitExceeded, DetailRateLimitExceeded)
}

func rateLimitRequest(agentID, remoteAddr string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = remoteAddr
	ctx := WithAgentCredential(context.Background(), AgentCredential{AgentID: agentID})
	return request.WithContext(ctx)
}
