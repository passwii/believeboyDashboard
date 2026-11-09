package insight_observation

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type fakeObservationStore struct {
	rows []ObservationRow
	err  error
}

func (fake *fakeObservationStore) ListObservationRows(context.Context, time.Time, *string) ([]ObservationRow, error) {
	return fake.rows, fake.err
}

func observationRequest(path string, admin bool) *http.Request {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	return request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{Operator: "user", IsAdmin: admin}))
}

func setupObservationRouter(store Store, cfg Config) http.Handler {
	router := chi.NewRouter()
	NewRegistrar(store, cfg).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func intObservation(value int) *int          { return &value }
func boolObservation(value bool) *bool       { return &value }
func stringObservation(value string) *string { return &value }

func TestGateRequiresAdminAndValidatesWindow(t *testing.T) {
	router := setupObservationRouter(&fakeObservationStore{}, DefaultConfig())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, observationRequest("/api/v1/insight/observation/gate", false))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-admin status=%d: %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, observationRequest("/api/v1/insight/observation/gate?window_days=0", true))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad window status=%d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestGateEmptyWindowIsNotEligible(t *testing.T) {
	router := setupObservationRouter(&fakeObservationStore{}, DefaultConfig())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, observationRequest("/api/v1/insight/observation/gate", true))
	if recorder.Code != http.StatusOK {
		t.Fatalf("gate status=%d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"eligible_for_retirement":false`) ||
		!strings.Contains(recorder.Body.String(), `insufficient_data:insight.runs=0`) {
		t.Fatalf("empty window response=%s", recorder.Body.String())
	}
}

func TestGateAggregatesRealMetricsAndAppliesThresholds(t *testing.T) {
	rows := []ObservationRow{
		{
			Source: SourceInsightRun, RunID: stringObservation("run-1"), Capability: "insight",
			Status: stringObservation("completed"), DurationMS: intObservation(1000), FirstDeltaMS: intObservation(100),
			TotalTokens: intObservation(50), StreamOpens: 2, StreamReconnects: 1, ReconnectCompleted: true,
			StreamFrames: 4, StreamBytes: intObservation(100), StreamXLen: intObservation(4),
		},
		{
			Source: SourceInsightRun, RunID: stringObservation("run-2"), Capability: "insight",
			Status: stringObservation("completed"), DurationMS: intObservation(1100), FirstDeltaMS: intObservation(120),
			TotalTokens: intObservation(60), StreamOpens: 1,
		},
		{
			Source: SourceInsightRun, RunID: stringObservation("run-3"), Capability: "insight",
			Status: stringObservation("failed"), DurationMS: intObservation(1200), FirstDeltaMS: intObservation(130),
			TotalTokens: intObservation(1000), ErrorCode: stringObservation("PROVIDER_UNAVAILABLE"),
			Retries: intObservation(1), CancelRequested: true, CancelSucceeded: boolObservation(false),
		},
		{
			Source: SourceLegacyFallback, Capability: "insight", Fallback: true,
		},
	}
	cfg := DefaultConfig()
	cfg.Thresholds.FirstDeltaMS = 5000
	cfg.Thresholds.DurationMS = 5000
	cfg.Thresholds.FallbackRatio = 0.2
	router := setupObservationRouter(&fakeObservationStore{rows: rows}, cfg)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, observationRequest("/api/v1/insight/observation/gate", true))
	if recorder.Code != http.StatusOK {
		t.Fatalf("gate status=%d: %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, want := range []string{
		`"runs":3`, `"completed":2`, `"failed":1`, `"fallback_events":1`,
		`"cancel_not_landed"`, `"cost_anomaly"`, `"failures_observed"`, `"retries_observed"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("gate body missing %s: %s", want, body)
		}
	}

	cfg.Thresholds.DurationMS = 100
	recorder = httptest.NewRecorder()
	router = setupObservationRouter(&fakeObservationStore{rows: rows}, cfg)
	router.ServeHTTP(recorder, observationRequest("/api/v1/insight/observation/gate", true))
	if !strings.Contains(recorder.Body.String(), `"duration_exceeded"`) || !strings.Contains(recorder.Body.String(), `"eligible_for_retirement":false`) {
		t.Fatalf("threshold gate response=%s", recorder.Body.String())
	}
}

func TestRetirementReadinessUsesGateReasonsAndSwitchState(t *testing.T) {
	rows := []ObservationRow{{
		Source: SourceInsightRun, RunID: stringObservation("run-1"), Capability: "insight",
		Status: stringObservation("completed"), DurationMS: intObservation(100), TotalTokens: intObservation(50),
	}}
	cfg := DefaultConfig()
	cfg.CanonicalDomains = "ad_analysis,inventory_health"
	router := setupObservationRouter(&fakeObservationStore{rows: rows}, cfg)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, observationRequest("/api/v1/insight/observation/retirement-readiness", true))
	if recorder.Code != http.StatusOK {
		t.Fatalf("readiness status=%d: %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, want := range []string{
		`"metrics_ok":true`, `"canonical_domains":["ad_analysis","inventory_health"]`,
		`"legacy_reads_preserved":true`, `"codegraph_verified":null`, `"eligible":false`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("readiness body missing %s: %s", want, body)
		}
	}
}

func TestAggregateEmptyAndPercentiles(t *testing.T) {
	if buckets := AggregateRows(nil, 5); len(buckets) != 0 {
		t.Fatalf("empty buckets=%#v", buckets)
	}
	rows := []ObservationRow{
		{Source: SourceInsightRun, Capability: "insight", Status: stringObservation("completed"), DurationMS: intObservation(10)},
		{Source: SourceInsightRun, Capability: "insight", Status: stringObservation("completed"), DurationMS: intObservation(20)},
		{Source: SourceInsightRun, Capability: "insight", Status: stringObservation("completed"), DurationMS: intObservation(100)},
	}
	buckets := AggregateRows(rows, 5)
	if len(buckets) != 1 || buckets[0].P95DurationMS == nil || *buckets[0].P95DurationMS != 100 || *buckets[0].MaxDurationMS != 100 {
		t.Fatalf("buckets=%#v", buckets)
	}
}
