package health

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthReturnsFastAPIShapeAndAggregatesDependencies(t *testing.T) {
	now := time.Date(2026, 10, 27, 1, 2, 3, 0, time.UTC)
	db := &fakePinger{}
	replica := &fakeProbe{result: "ok (lag=0.4s)"}
	redis := &fakeRedisProbe{status: "ok (1.2ms)", memory: stringPtr("1.00M")}

	handler := NewHandler(HandlerConfig{
		Database:   db,
		Replica:    replica,
		Redis:      redis,
		Version:    "production",
		Now:        func() time.Time { return now },
		ReplicaURL: "postgres://replica",
	})
	rec := httptest.NewRecorder()
	handler.Health(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	wantKeys := []string{
		"status", "timestamp", "database", "database_replica",
		"redis", "redis_memory", "version",
	}
	for _, key := range wantKeys {
		if _, ok := got[key]; !ok {
			t.Errorf("response missing %q: %s", key, rec.Body.String())
		}
	}
	if got["status"] != "ok" ||
		got["database"] != "ok" ||
		got["database_replica"] != "ok (lag=0.4s)" ||
		got["redis"] != "ok (1.2ms)" ||
		got["redis_memory"] != "1.00M" ||
		got["version"] != "production" {
		t.Errorf("response = %#v, want aggregated successful health", got)
	}
	wantTimestamp := float64(now.UnixNano()) / 1e9
	if timestamp, ok := got["timestamp"].(float64); !ok || math.Abs(timestamp-wantTimestamp) > 1e-9 {
		t.Errorf("timestamp = %#v, want unix seconds for %s", got["timestamp"], now)
	}
	if db.pings != 1 {
		t.Errorf("database pings = %d, want 1", db.pings)
	}
	if replica.calls != 1 {
		t.Errorf("replica probes = %d, want 1", replica.calls)
	}
	if redis.calls != 1 {
		t.Errorf("redis probes = %d, want 1", redis.calls)
	}
}

func TestHealthDegradesWhenPrimaryFails(t *testing.T) {
	handler := NewHandler(HandlerConfig{
		Database:   &fakePinger{err: errors.New("connection refused")},
		Replica:    &fakeProbe{result: "ok"},
		Redis:      &fakeRedisProbe{status: "not configured"},
		Now:        fixedNow,
		ReplicaURL: "",
	})
	rec := httptest.NewRecorder()

	handler.Health(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

	var got healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Status != "degraded" {
		t.Errorf("status = %q, want degraded", got.Status)
	}
	if got.Database != "error: *errors.errorString" {
		t.Errorf("database = %q, want stable error type", got.Database)
	}
	if strings.Contains(got.Database, "connection refused") {
		t.Errorf("database = %q, leaks underlying error text", got.Database)
	}
}

func TestHealthDegradesWhenReplicaFailsButNotWhenRedisFails(t *testing.T) {
	tests := []struct {
		name        string
		replica     string
		redis       string
		wantOverall string
	}{
		{name: "replica error", replica: "error: TimeoutError", redis: "ok (1.0ms)", wantOverall: "degraded"},
		{name: "replica degraded", replica: "degraded (lag=11.0s > 10s)", redis: "ok (1.0ms)", wantOverall: "degraded"},
		{name: "redis error", replica: "ok", redis: "error: ConnectionError", wantOverall: "ok"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := NewHandler(HandlerConfig{
				Database:   &fakePinger{},
				Replica:    &fakeProbe{result: tt.replica},
				Redis:      &fakeRedisProbe{status: tt.redis},
				Now:        fixedNow,
				ReplicaURL: "postgres://replica",
			})
			rec := httptest.NewRecorder()
			handler.Health(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

			var got healthResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if got.Status != tt.wantOverall {
				t.Errorf("status = %q, want %q", got.Status, tt.wantOverall)
			}
		})
	}
}

func TestHealthLiveAndReadyShapes(t *testing.T) {
	handler := NewHandler(HandlerConfig{
		Database: &fakePinger{},
		Now:      fixedNow,
	})

	liveRec := httptest.NewRecorder()
	handler.HealthLive(liveRec, httptest.NewRequest(http.MethodGet, "/api/v1/health/live", nil))
	if liveRec.Code != http.StatusOK {
		t.Fatalf("live status = %d, want 200", liveRec.Code)
	}
	assertJSONObject(t, liveRec, map[string]any{
		"status":    "ok",
		"timestamp": float64(1793062800),
	})

	readyRec := httptest.NewRecorder()
	handler.HealthReady(readyRec, httptest.NewRequest(http.MethodGet, "/api/v1/health/ready", nil))
	if readyRec.Code != http.StatusOK {
		t.Fatalf("ready status = %d, want 200", readyRec.Code)
	}
	assertJSONObject(t, readyRec, map[string]any{
		"status":    "ok",
		"timestamp": float64(1793062800),
	})
}

func TestHealthReadyReturns503WhenDatabaseFails(t *testing.T) {
	handler := NewHandler(HandlerConfig{
		Database: &fakePinger{err: errors.New("db down")},
		Now:      fixedNow,
	})
	rec := httptest.NewRecorder()

	handler.HealthReady(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health/ready", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	assertJSONObject(t, rec, map[string]any{
		"status":    "unavailable",
		"timestamp": float64(1793062800),
	})
}

func TestHealthUsesNotConfiguredWithoutReplicaOrRedis(t *testing.T) {
	handler := NewHandler(HandlerConfig{
		Database:   &fakePinger{},
		Replica:    nil,
		Redis:      nil,
		Now:        fixedNow,
		ReplicaURL: "",
	})
	rec := httptest.NewRecorder()

	handler.Health(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

	var got healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.DatabaseReplica != "not configured" {
		t.Errorf("database_replica = %q, want not configured", got.DatabaseReplica)
	}
	if got.Redis != "not configured" {
		t.Errorf("redis = %q, want not configured", got.Redis)
	}
	if got.RedisMemory != nil {
		t.Errorf("redis_memory = %#v, want null", *got.RedisMemory)
	}
}

func TestHealthMissingPrimaryUsesStableErrorClass(t *testing.T) {
	handler := NewHandler(HandlerConfig{Now: fixedNow})
	rec := httptest.NewRecorder()

	handler.Health(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

	var got healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Database != "error: DatabaseNotConfigured" {
		t.Errorf("database = %q, want stable missing-primary error class", got.Database)
	}
}

func fixedNow() time.Time {
	return time.Unix(1793062800, 0).UTC()
}

func stringPtr(value string) *string {
	return &value
}

func assertJSONObject(t *testing.T, rec *httptest.ResponseRecorder, want map[string]any) {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(got) != len(want) {
		t.Errorf("response keys = %#v, want %#v", got, want)
	}
	for key, wantValue := range want {
		if got[key] != wantValue {
			t.Errorf("%s = %#v, want %#v", key, got[key], wantValue)
		}
	}
}

type fakePinger struct {
	err   error
	pings int
}

func (p *fakePinger) Ping(context.Context) error {
	p.pings++
	return p.err
}

type fakeProbe struct {
	result string
	calls  int
}

func (p *fakeProbe) Probe(context.Context) string {
	p.calls++
	return p.result
}

type fakeRedisProbe struct {
	status string
	memory *string
	calls  int
}

func (p *fakeRedisProbe) Probe(context.Context) (string, *string) {
	p.calls++
	return p.status, p.memory
}
