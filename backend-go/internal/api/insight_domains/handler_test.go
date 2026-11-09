package insight_domains

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

const domainRunID = "22222222-2222-4222-8222-222222222222"

type fakeDomainStore struct {
	accessErr error
	adRun     *insight_runs.Run
	invRun    *insight_runs.Run
	replayed  bool
	createErr error
	retryRun  *insight_runs.Run
	retryErr  error
}

func (fake *fakeDomainStore) VerifyProjectAccess(context.Context, int64, string, bool) (ai_insight.ProjectInfo, error) {
	if fake.accessErr != nil {
		return ai_insight.ProjectInfo{}, fake.accessErr
	}
	return ai_insight.ProjectInfo{ID: 1, Country: "US"}, nil
}
func (fake *fakeDomainStore) CreateAdAnalysisRun(context.Context, AdAnalysisInput, ai_insight.MutationMeta) (*insight_runs.Run, bool, error) {
	return fake.adRun, fake.replayed, fake.createErr
}
func (fake *fakeDomainStore) CreateInventoryHealthRun(context.Context, InventoryHealthInput, ai_insight.MutationMeta) (*insight_runs.Run, bool, error) {
	return fake.invRun, fake.replayed, fake.createErr
}
func (fake *fakeDomainStore) RetryRun(context.Context, string, ai_insight.MutationMeta) (*insight_runs.Run, error) {
	return fake.retryRun, fake.retryErr
}
func (fake *fakeDomainStore) RunTransition(context.Context, string, int, string, string, int, *insight_runs.Usage, map[string]insight_runs.Output, *string, *insight_runs.Error) (bool, error) {
	return true, nil
}

type fakeDomainEnqueuer struct {
	jobs []ai_insight.ExecuteRunJob
	err  error
}

func (fake *fakeDomainEnqueuer) EnqueueGenerate(context.Context, ai_insight.GenerateJob) error {
	return nil
}
func (fake *fakeDomainEnqueuer) EnqueueExecuteRun(_ context.Context, job ai_insight.ExecuteRunJob) error {
	fake.jobs = append(fake.jobs, job)
	return fake.err
}

type fakeDomainProvider struct{ configured bool }

func (fake *fakeDomainProvider) Configured() bool { return fake.configured }
func (fake *fakeDomainProvider) AvailableModels(context.Context) ([]string, error) {
	return []string{"test"}, nil
}
func (fake *fakeDomainProvider) Complete(context.Context, ai.ChatRequest) (string, ai.Usage, error) {
	return "ok", ai.Usage{}, nil
}
func (fake *fakeDomainProvider) Stream(context.Context, ai.ChatRequest, func(ai.Chunk) error) (ai.Usage, error) {
	return ai.Usage{}, nil
}

func setupDomainRouter(store Store, enqueuer ai_insight.JobEnqueuer, provider ai.Provider, cfg Config) http.Handler {
	router := chi.NewRouter()
	NewRegistrar(store, enqueuer, provider, cfg).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func domainRequest(path string, body []byte) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	return request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{Operator: "admin", IsAdmin: true}))
}

func TestDomainSwitchEnqueuerAndProviderFailClosed(t *testing.T) {
	store := &fakeDomainStore{}
	enqueuer := &fakeDomainEnqueuer{}
	provider := &fakeDomainProvider{configured: true}
	body := []byte(`{"project_id":1,"country":"US","start_date":"2026-01-01","end_date":"2026-01-02"}`)

	router := setupDomainRouter(store, enqueuer, provider, Config{})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/ad-analysis/runs", body))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("disabled domain status=%d: %s", recorder.Code, recorder.Body.String())
	}
	router = setupDomainRouter(store, nil, provider, Config{CanonicalDomains: "ad_analysis"})
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/ad-analysis/runs", body))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing enqueuer status=%d", recorder.Code)
	}
	router = setupDomainRouter(store, enqueuer, &fakeDomainProvider{configured: false}, Config{CanonicalDomains: "ad_analysis"})
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/ad-analysis/runs", body))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing provider status=%d", recorder.Code)
	}
}

func TestAdAnalysisRunValidationPermissionsAndCreate(t *testing.T) {
	run := &insight_runs.Run{RunID: domainRunID, Attempt: 1, RoleID: "ad_analysis", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "queued", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	store := &fakeDomainStore{adRun: run}
	enqueuer := &fakeDomainEnqueuer{}
	router := setupDomainRouter(store, enqueuer, &fakeDomainProvider{configured: true}, Config{CanonicalDomains: "ad_analysis,inventory_health"})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/ad-analysis/runs", []byte(`{"project_id":1,"country":"US","start_date":"2026-01-03","end_date":"2026-01-01"}`)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("reversed date status=%d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/ad-analysis/runs", []byte(`{"project_id":1,"country":"US","start_date":"2026-01-01","end_date":"2026-01-02","extra":true}`)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown field status=%d", recorder.Code)
	}
	store.accessErr = insight_runs.ErrProjectOutOfScope
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/ad-analysis/runs", []byte(`{"project_id":1,"country":"US","start_date":"2026-01-01","end_date":"2026-01-02"}`)))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d: %s", recorder.Code, recorder.Body.String())
	}
	store.accessErr = nil
	store.replayed = false
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/ad-analysis/runs", []byte(`{"project_id":1,"country":"US","start_date":"2026-01-01","end_date":"2026-01-02"}`)))
	if recorder.Code != http.StatusCreated || len(enqueuer.jobs) != 1 {
		t.Fatalf("create status=%d jobs=%#v: %s", recorder.Code, enqueuer.jobs, recorder.Body.String())
	}
}

func TestInventoryHealthCreateAndDeadRunRetry(t *testing.T) {
	run := &insight_runs.Run{RunID: domainRunID, Attempt: 1, RoleID: "inventory_health", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "failed", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	retried := &insight_runs.Run{RunID: domainRunID, Attempt: 2, RoleID: "inventory_health", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "queued", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	store := &fakeDomainStore{invRun: run, replayed: true, retryRun: retried}
	enqueuer := &fakeDomainEnqueuer{}
	router := setupDomainRouter(store, enqueuer, &fakeDomainProvider{configured: true}, Config{CanonicalDomains: "inventory_health"})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/inventory-health/runs", []byte(`{"project_id":1,"country":"US","report_date":"2026-01-02"}`)))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("inventory status=%d: %s", recorder.Code, recorder.Body.String())
	}
	if len(enqueuer.jobs) != 1 || enqueuer.jobs[0].Attempt != 2 {
		t.Fatalf("replayed failed run enqueues=%#v, want attempt 2", enqueuer.jobs)
	}
	var response insight_runs.RunResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || response.Attempt != 2 || !response.Replayed {
		t.Fatalf("response=%#v err=%v", response, err)
	}
}

func TestDomainRetryErrors(t *testing.T) {
	run := &insight_runs.Run{RunID: domainRunID, Attempt: 1, RoleID: "ad_analysis", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "failed"}
	store := &fakeDomainStore{adRun: run, replayed: true, retryErr: insight_runs.ErrRunTerminal}
	router := setupDomainRouter(store, &fakeDomainEnqueuer{}, &fakeDomainProvider{configured: true}, Config{CanonicalDomains: "ad_analysis"})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, domainRequest("/api/v1/insight/ad-analysis/runs", []byte(`{"project_id":1,"country":"US","start_date":"2026-01-01","end_date":"2026-01-01"}`)))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("retry terminal status=%d: %s", recorder.Code, recorder.Body.String())
	}
}
