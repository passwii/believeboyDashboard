package alerts

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type detectionFakeStore struct {
	*fakeStore
	input  DetectionInput
	result DetectionResult
	err    error
	calls  int
}

func (s *detectionFakeStore) Detect(_ context.Context, input DetectionInput) (DetectionResult, error) {
	s.calls++
	s.input = input
	return s.result, s.err
}

func TestDetectRequiresAdminAndRunsRealDetector(t *testing.T) {
	store := &detectionFakeStore{
		fakeStore: &fakeStore{},
		result: DetectionResult{
			RulesEvaluated: 3,
			EventsCreated:  2,
			MessagesSent:   2,
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/detect", nil)
	req.Header.Set("X-Is-Admin", "true")
	req.Header.Set("X-Operator", "admin-a")
	req = withRequestIdentity(req)
	rec := httptest.NewRecorder()

	NewHandler(store).Detect(rec, req)

	assertResponse(
		t,
		rec,
		http.StatusOK,
		`{"rules_evaluated":3,"events_created":2,"messages_sent":2}`,
	)
	if store.calls != 1 {
		t.Fatalf("Detect() calls = %d, want 1", store.calls)
	}
	if store.input.Audit.Action != "alerts.detect" ||
		store.input.Audit.TargetType != "alert_detection" ||
		store.input.Audit.Operator == nil ||
		*store.input.Audit.Operator != "admin-a" ||
		store.input.Audit.RequestMethod == nil ||
		*store.input.Audit.RequestMethod != http.MethodPost ||
		store.input.Audit.RequestPath == nil ||
		*store.input.Audit.RequestPath != "/api/v1/alerts/detect" {
		t.Errorf("detect audit = %#v, want admin actor and request metadata", store.input.Audit)
	}
}

func TestDetectRejectsNonAdminAndInvalidAdminHeader(t *testing.T) {
	t.Run("non admin", func(t *testing.T) {
		store := &detectionFakeStore{fakeStore: &fakeStore{}}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/detect", nil)
		req.Header.Set("X-Is-Admin", "false")
		req.Header.Set("X-Operator", "operator-a")
		rec := httptest.NewRecorder()

		NewHandler(store).Detect(rec, withRequestIdentity(req))

		assertResponse(t, rec, http.StatusForbidden, `{"detail":"Admin only"}`)
		if store.calls != 0 {
			t.Fatalf("Detect() calls = %d, want 0", store.calls)
		}
	})

	t.Run("invalid header", func(t *testing.T) {
		store := &detectionFakeStore{fakeStore: &fakeStore{}}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/detect", nil)
		req.Header.Set("X-Is-Admin", "maybe")
		rec := httptest.NewRecorder()

		NewHandler(store).Detect(rec, withRequestIdentity(req))

		assertResponse(
			t,
			rec,
			http.StatusUnprocessableEntity,
			`{"detail":[{"type":"bool_parsing","loc":["header","X-Is-Admin"],"msg":"Input should be a valid boolean, unable to interpret input","input":"maybe"}]}`,
		)
		if store.calls != 0 {
			t.Fatalf("Detect() calls = %d, want 0", store.calls)
		}
	})
}

func TestDetectMapsDependencyAndIdempotencyErrors(t *testing.T) {
	t.Run("missing detector dependency", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/detect", nil)
		req.Header.Set("X-Is-Admin", "true")
		rec := httptest.NewRecorder()

		NewHandler(&fakeStore{}).Detect(rec, withRequestIdentity(req))

		assertResponse(t, rec, http.StatusServiceUnavailable, `{"detail":"Alert detection dependency unavailable"}`)
	})

	t.Run("concurrent detection conflict", func(t *testing.T) {
		store := &detectionFakeStore{fakeStore: &fakeStore{}, err: ErrDetectionConflict}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/detect", nil)
		req.Header.Set("X-Is-Admin", "true")
		rec := httptest.NewRecorder()

		NewHandler(store).Detect(rec, withRequestIdentity(req))

		assertResponse(t, rec, http.StatusConflict, `{"detail":"Alert detection already in progress"}`)
	})

	t.Run("unavailable detector", func(t *testing.T) {
		store := &detectionFakeStore{fakeStore: &fakeStore{}, err: ErrDetectionUnavailable}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/detect", nil)
		req.Header.Set("X-Is-Admin", "true")
		rec := httptest.NewRecorder()

		NewHandler(store).Detect(rec, withRequestIdentity(req))

		assertResponse(t, rec, http.StatusServiceUnavailable, `{"detail":"Alert detection dependency unavailable"}`)
	})
}

func TestDetectReturnsInternalErrorForUnexpectedFailure(t *testing.T) {
	store := &detectionFakeStore{fakeStore: &fakeStore{}, err: errors.New("unexpected")}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/detect", nil)
	req.Header.Set("X-Is-Admin", "true")
	rec := httptest.NewRecorder()

	NewHandler(store).Detect(rec, withRequestIdentity(req))

	assertInternalError(t, rec)
}
