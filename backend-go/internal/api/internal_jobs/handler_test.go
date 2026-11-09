package internal_jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type fakeInternalJobStore struct {
	idempotency *IdempotencyRecord
	lockKeys    []string
	runs        int
}

func (store *fakeInternalJobStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	store.runs++
	return fn(ctx, nil, store)
}

func (store *fakeInternalJobStore) AcquireJobLock(
	_ context.Context,
	lockKey string,
) error {
	store.lockKeys = append(store.lockKeys, lockKey)
	return nil
}

func (store *fakeInternalJobStore) FindIdempotencyRecord(
	context.Context,
	string,
	string,
) (*IdempotencyRecord, error) {
	return store.idempotency, nil
}

type fakeReturnAnalysisRunner struct {
	refreshResult RefreshResult
	rebuildResult RebuildResult
	err           error
	refreshCalls  int
	rebuildCalls  int
}

func (runner *fakeReturnAnalysisRunner) RefreshReturnAnalysis(
	context.Context,
	string,
	int,
) (RefreshResult, error) {
	runner.refreshCalls++
	return runner.refreshResult, runner.err
}

func (runner *fakeReturnAnalysisRunner) RebuildReturnAnalysis(
	context.Context,
) (RebuildResult, error) {
	runner.rebuildCalls++
	return runner.rebuildResult, runner.err
}

func setupInternalJobsRouter(
	store Store,
	runner Runner,
	auditor audit.Service,
) http.Handler {
	router := chi.NewRouter()
	NewRegistrar(store, runner, auditor).RegisterRoutes(
		router,
		func(next http.Handler) http.Handler { return next },
	)
	return router
}

func internalJobRequest(
	method string,
	target string,
	body string,
	isAdmin bool,
) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "admin",
		IsAdmin:  isAdmin,
	}))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestInternalJobsRefreshAndRebuild(t *testing.T) {
	store := &fakeInternalJobStore{}
	runner := &fakeReturnAnalysisRunner{
		refreshResult: RefreshResult{RowsWritten: 42, Projects: 3},
		rebuildResult: RebuildResult{
			RangeStart:      "2026-01-01",
			RangeEnd:        "2026-11-07",
			RowsWritten:     900,
			ProjectsTouched: 12,
		},
	}
	auditor := audit.NewMockService()
	router := setupInternalJobsRouter(store, runner, auditor)

	request := internalJobRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-refresh",
		`{"target_date":"2026-11-07","backfill_days":2}`,
		true,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("refresh status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var refresh ReturnAnalysisRefreshResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &refresh); err != nil {
		t.Fatalf("decode refresh: %v", err)
	}
	if refresh.TargetDate != "2026-11-07" || refresh.BackfillDays != 2 ||
		refresh.RowsWritten != 42 || refresh.Projects != 3 {
		t.Fatalf("refresh = %#v", refresh)
	}
	if got := store.lockKeys[0]; got != RefreshLockKey("2026-11-07", 2) {
		t.Fatalf("refresh lock = %q", got)
	}

	request = internalJobRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-rebuild",
		"",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("rebuild status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var rebuild ReturnAnalysisRebuildResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &rebuild); err != nil {
		t.Fatalf("decode rebuild: %v", err)
	}
	if rebuild.RowsWritten != 900 || rebuild.ProjectsTouched != 12 ||
		rebuild.RangeStart != "2026-01-01" || rebuild.RangeEnd != "2026-11-07" {
		t.Fatalf("rebuild = %#v", rebuild)
	}
	if got := store.lockKeys[1]; got != RebuildLockKey() {
		t.Fatalf("rebuild lock = %q", got)
	}
	if len(auditor.Entries) != 2 || runner.refreshCalls != 1 || runner.rebuildCalls != 1 {
		t.Fatalf("audit=%d refresh=%d rebuild=%d", len(auditor.Entries), runner.refreshCalls, runner.rebuildCalls)
	}
}

func TestInternalJobsStatusAndFailClosed(t *testing.T) {
	store := &fakeInternalJobStore{}
	runner := &fakeReturnAnalysisRunner{}
	router := setupInternalJobsRouter(store, runner, audit.NewMockService())

	cases := []struct {
		name   string
		method string
		target string
		body   string
		admin  bool
		status int
	}{
		{
			"403 non-admin",
			http.MethodPost,
			"/api/v1/internal/jobs/return-analysis-refresh",
			`{"backfill_days":1}`,
			false,
			http.StatusForbidden,
		},
		{
			"422 invalid backfill",
			http.MethodPost,
			"/api/v1/internal/jobs/return-analysis-refresh",
			`{"backfill_days":91}`,
			true,
			http.StatusUnprocessableEntity,
		},
		{
			"422 invalid date",
			http.MethodPost,
			"/api/v1/internal/jobs/return-analysis-refresh",
			`{"target_date":"11/07/2026","backfill_days":1}`,
			true,
			http.StatusUnprocessableEntity,
		},
		{
			"422 missing body",
			http.MethodPost,
			"/api/v1/internal/jobs/return-analysis-refresh",
			"",
			true,
			http.StatusUnprocessableEntity,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			request := internalJobRequest(test.method, test.target, test.body, test.admin)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}

	missingRunnerRouter := setupInternalJobsRouter(store, nil, audit.NewMockService())
	request := internalJobRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-rebuild",
		"",
		true,
	)
	recorder := httptest.NewRecorder()
	missingRunnerRouter.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing runner status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}
}

func TestInternalJobsRunnerFailureAndIdempotency(t *testing.T) {
	store := &fakeInternalJobStore{}
	runner := &fakeReturnAnalysisRunner{
		refreshResult: RefreshResult{RowsWritten: 10, Projects: 2},
	}
	router := setupInternalJobsRouter(store, runner, audit.NewMockService())

	request := internalJobRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-refresh",
		`{"target_date":"2026-11-07","backfill_days":1}`,
		true,
	)
	request.Header.Set("Idempotency-Key", "refresh-1")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("first status = %d: %s", recorder.Code, recorder.Body.String())
	}
	response := ReturnAnalysisRefreshResponse{
		TargetDate:   "2026-11-07",
		BackfillDays: 1,
		RowsWritten:  10,
		Projects:     2,
		Note:         "snapshot 已被覆盖，endpoint 25h 内会读到最新",
	}
	body, _ := json.Marshal(response)
	store.idempotency = &IdempotencyRecord{
		Fingerprint: requestFingerprint(map[string]any{
			"target_date":   "2026-11-07",
			"backfill_days": 1,
		}),
		Response: body,
	}
	request = internalJobRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-refresh",
		`{"target_date":"2026-11-07","backfill_days":1}`,
		true,
	)
	request.Header.Set("Idempotency-Key", "refresh-1")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("replay status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if runner.refreshCalls != 1 {
		t.Fatalf("refresh calls = %d, want replay without rerun", runner.refreshCalls)
	}

	store.idempotency = &IdempotencyRecord{
		Fingerprint: "different",
		Response:    body,
	}
	request = internalJobRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-refresh",
		`{"target_date":"2026-11-07","backfill_days":1}`,
		true,
	)
	request.Header.Set("Idempotency-Key", "refresh-1")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, want 409: %s", recorder.Code, recorder.Body.String())
	}

	runner.err = errors.New("materialization failed")
	store.idempotency = nil
	request = internalJobRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-refresh",
		`{"target_date":"2026-11-08","backfill_days":1}`,
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("runner failure status = %d, want 500: %s", recorder.Code, recorder.Body.String())
	}

	runner.err = ErrDependencyNotConfigured
	request = internalJobRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-refresh",
		`{"target_date":"2026-11-08","backfill_days":1}`,
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("dependency failure status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}
}
