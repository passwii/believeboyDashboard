package insight_runs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

const testRunID = "11111111-1111-4111-8111-111111111111"

type fakeRunStore struct {
	accessErr     error
	createRun     *Run
	replayed      bool
	createErr     error
	run           *Run
	cancelRun     *Run
	cancelReplay  bool
	cancelErr     error
	retryRun      *Run
	retryErr      error
	transitionErr error
	transitions   []string
	streamCalls   int
}

func (fake *fakeRunStore) VerifyProjectAccess(context.Context, int64, string, bool) (ai_insight.ProjectInfo, error) {
	if fake.accessErr != nil {
		return ai_insight.ProjectInfo{}, fake.accessErr
	}
	return ai_insight.ProjectInfo{ID: 1, Country: "US"}, nil
}

func (fake *fakeRunStore) CreateRun(context.Context, CreateRunInput, ai_insight.MutationMeta) (*Run, bool, error) {
	return fake.createRun, fake.replayed, fake.createErr
}

func (fake *fakeRunStore) GetRun(context.Context, string) (*Run, error) {
	if fake.run == nil {
		return nil, ErrRunNotFound
	}
	copyRun := *fake.run
	return &copyRun, nil
}

func (fake *fakeRunStore) CancelRun(context.Context, string, ai_insight.MutationMeta) (*Run, bool, error) {
	return fake.cancelRun, fake.cancelReplay, fake.cancelErr
}

func (fake *fakeRunStore) RetryRun(context.Context, string, ai_insight.MutationMeta) (*Run, error) {
	return fake.retryRun, fake.retryErr
}

func (fake *fakeRunStore) RecordStreamMetric(context.Context, string, bool, bool) error {
	fake.streamCalls++
	return nil
}

func (fake *fakeRunStore) LoadRunExecution(context.Context, string) (*Run, error) {
	if fake.run == nil {
		return nil, ErrRunNotFound
	}
	copyRun := *fake.run
	return &copyRun, nil
}

func (fake *fakeRunStore) RunTransition(_ context.Context, _ string, attempt int, target, stage string, progress int, usage *Usage, outputs map[string]Output, content *string, runErr *Error) (bool, error) {
	if fake.transitionErr != nil {
		return false, fake.transitionErr
	}
	if fake.run == nil || fake.run.Attempt != attempt {
		return false, nil
	}
	fake.transitions = append(fake.transitions, target)
	fake.run.Status = target
	if stage != "" {
		fake.run.Stage = stage
	}
	fake.run.ProgressPercent = progress
	if usage != nil {
		raw, _ := json.Marshal(usage)
		fake.run.UsageJSON = raw
	}
	if outputs != nil {
		raw, _ := json.Marshal(outputs)
		fake.run.OutputsJSON = raw
	}
	if content != nil {
		copyContent := *content
		fake.run.ContentMarkdown = &copyContent
	}
	if runErr != nil {
		raw, _ := json.Marshal(runErr)
		fake.run.ErrorJSON = raw
	}
	return true, nil
}

type fakeRunEnqueuer struct {
	generate int
	runs     []ai_insight.ExecuteRunJob
	err      error
}

func (fake *fakeRunEnqueuer) EnqueueGenerate(context.Context, ai_insight.GenerateJob) error {
	fake.generate++
	return fake.err
}
func (fake *fakeRunEnqueuer) EnqueueExecuteRun(_ context.Context, job ai_insight.ExecuteRunJob) error {
	fake.runs = append(fake.runs, job)
	return fake.err
}

type fakeEventStore struct {
	availableErr error
	events       []Event
	appended     []Event
	reads        int
	resets       int
	readErr      error
}

func (fake *fakeEventStore) Available(context.Context) error { return fake.availableErr }
func (fake *fakeEventStore) Append(_ context.Context, runID string, event Event) (Event, error) {
	event.RunID = runID
	event.SchemaVersion = 1
	event.Seq = len(fake.appended) + 1
	fake.appended = append(fake.appended, event)
	return event, nil
}
func (fake *fakeEventStore) ReadAfter(context.Context, string, *Cursor) ([]Event, error) {
	fake.reads++
	return fake.events, fake.readErr
}
func (fake *fakeEventStore) Reset(context.Context, string) error {
	fake.resets++
	return nil
}

type fakeRunProvider struct {
	configured bool
	content    string
	usage      ai.Usage
	err        error
}

func (fake *fakeRunProvider) Configured() bool { return fake.configured }
func (fake *fakeRunProvider) AvailableModels(context.Context) ([]string, error) {
	return []string{"test-model"}, nil
}
func (fake *fakeRunProvider) Complete(context.Context, ai.ChatRequest) (string, ai.Usage, error) {
	return fake.content, fake.usage, fake.err
}
func (fake *fakeRunProvider) Stream(ctx context.Context, _ ai.ChatRequest, emit func(ai.Chunk) error) (ai.Usage, error) {
	if fake.err != nil {
		return ai.Usage{}, fake.err
	}
	if err := ctx.Err(); err != nil {
		return ai.Usage{}, err
	}
	if err := emit(ai.Chunk{Type: ai.ChunkContent, Text: fake.content}); err != nil {
		return ai.Usage{}, err
	}
	return fake.usage, nil
}

func setupInsightRunRouter(store Store, enqueuer ai_insight.JobEnqueuer, provider ai.Provider, events EventStore, cfg Config) http.Handler {
	router := chi.NewRouter()
	NewRegistrar(store, enqueuer, provider, events, cfg).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func runAdminRequest(method, path string, body []byte) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	return request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{Operator: "admin", IsAdmin: true}))
}

func validCreateBody() []byte {
	return []byte(`{
		"schema_version":1,
		"role_id":"schedule_report_summary",
		"role_version":1,
		"project_id":1,
		"country":"US",
		"slots":{
			"report.context":{"slot_version":1,"frequency":"daily","report_date":"2026-01-02","date_range_start":"2026-01-01","date_range_end":"2026-01-02","project_ids":[1],"country":"US"},
			"report.data":{"slot_version":1,"encoding":"json","payload":{"rows":[]}}
		},
		"idempotency_key":"idem-1"
	}`)
}

func TestCreateRunStatusesAndEnqueue(t *testing.T) {
	created := &Run{RunID: testRunID, Attempt: 1, RoleID: "schedule_report_summary", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "queued", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	store := &fakeRunStore{createRun: created}
	enqueuer := &fakeRunEnqueuer{}
	provider := &fakeRunProvider{configured: true}
	router := setupInsightRunRouter(store, enqueuer, provider, &fakeEventStore{}, DefaultConfig())

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs", validCreateBody()))
	if recorder.Code != http.StatusCreated || len(enqueuer.runs) != 1 {
		t.Fatalf("create status=%d enqueues=%#v body=%s", recorder.Code, enqueuer.runs, recorder.Body.String())
	}

	router = setupInsightRunRouter(store, nil, provider, &fakeEventStore{}, DefaultConfig())
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs", validCreateBody()))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing enqueuer status=%d", recorder.Code)
	}
	router = setupInsightRunRouter(store, enqueuer, &fakeRunProvider{configured: false}, &fakeEventStore{}, DefaultConfig())
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs", validCreateBody()))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing provider status=%d", recorder.Code)
	}
}

func TestCreateRunValidationPermissionsAndConflict(t *testing.T) {
	store := &fakeRunStore{createRun: &Run{RunID: testRunID, Attempt: 1, Status: "queued"}}
	router := setupInsightRunRouter(store, &fakeRunEnqueuer{}, &fakeRunProvider{configured: true}, &fakeEventStore{}, DefaultConfig())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs", []byte(`{}`)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid status=%d: %s", recorder.Code, recorder.Body.String())
	}
	badScope := bytes.Replace(validCreateBody(), []byte(`"project_ids":[1]`), []byte(`"project_ids":[2]`), 1)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs", badScope))
	if recorder.Code != http.StatusUnprocessableEntity || !strings.Contains(recorder.Body.String(), "SCOPE_MISMATCH") {
		t.Fatalf("scope mismatch status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	store.accessErr = ErrProjectOutOfScope
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs", validCreateBody()))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d: %s", recorder.Code, recorder.Body.String())
	}
	store.accessErr = ErrProjectNotFound
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs", validCreateBody()))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("not found status=%d: %s", recorder.Code, recorder.Body.String())
	}
	store.accessErr = nil
	store.createErr = ErrIdempotencyConflict
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs", validCreateBody()))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("conflict status=%d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestGetCancelRetryAndInvalidUUID(t *testing.T) {
	run := &Run{RunID: testRunID, Attempt: 1, RoleID: "schedule_report_summary", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "failed", Stage: "generating", CreatedAt: time.Now(), UpdatedAt: time.Now(), OutputsJSON: []byte(`{}`)}
	store := &fakeRunStore{run: run, cancelRun: &Run{RunID: testRunID, Attempt: 1, Status: "cancelled"}, retryRun: &Run{RunID: testRunID, Attempt: 2, Status: "queued"}}
	events := &fakeEventStore{}
	router := setupInsightRunRouter(store, &fakeRunEnqueuer{}, &fakeRunProvider{configured: true}, events, DefaultConfig())

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodGet, "/api/v1/insight/runs/bad", nil))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad uuid status=%d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("get status=%d: %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs/"+testRunID+"/cancel", nil))
	if recorder.Code != http.StatusOK || len(events.appended) == 0 {
		t.Fatalf("cancel status=%d appended=%d", recorder.Code, len(events.appended))
	}

	enqueuer := &fakeRunEnqueuer{}
	router = setupInsightRunRouter(store, enqueuer, &fakeRunProvider{configured: true}, events, DefaultConfig())
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodPost, "/api/v1/insight/runs/"+testRunID+"/retry", nil))
	if recorder.Code != http.StatusOK || len(enqueuer.runs) != 1 || enqueuer.runs[0].Attempt != 2 {
		t.Fatalf("retry status=%d enqueues=%#v", recorder.Code, enqueuer.runs)
	}

	store.run = nil
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID, nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing run status=%d", recorder.Code)
	}
}

func TestRunSSESnapshotTerminalTransportAndCursor(t *testing.T) {
	completed := &Run{RunID: testRunID, Attempt: 1, RoleID: "schedule_report_summary", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "completed", Stage: "finalizing", ProgressPercent: 100, CreatedAt: time.Now(), UpdatedAt: time.Now(), OutputsJSON: []byte(`{"main":{"format":"markdown","content":"hello","content_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}`), ContentMarkdown: stringPtr("hello")}
	store := &fakeRunStore{run: completed}
	events := &fakeEventStore{}
	router := setupInsightRunRouter(store, &fakeRunEnqueuer{}, &fakeRunProvider{configured: true}, events, Config{SSEPollInterval: time.Millisecond, SSETimeout: time.Second})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID+"/stream", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"type":"snapshot"`) || !strings.Contains(recorder.Body.String(), `"type":"done"`) {
		t.Fatalf("SSE status=%d headers=%v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request := runAdminRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID+"/stream", nil)
	request.Header.Set("Last-Event-ID", "not-a-cursor")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("bad cursor status=%d: %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	request = runAdminRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID+"/stream", nil)
	request.Header.Set("Last-Event-ID", testRunID+":2:1")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("future cursor status=%d: %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	request = runAdminRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID+"/stream", nil)
	request.Header.Set("Last-Event-ID", testRunID+":1:5")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"type":"done"`) {
		t.Fatalf("resume status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	events.availableErr = ErrStreamUnavailable
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID+"/stream", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable status=%d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestRunSSEReplaysBusEventsAndDisconnect(t *testing.T) {
	run := &Run{RunID: testRunID, Attempt: 1, RoleID: "schedule_report_summary", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "generating", Stage: "generating", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	store := &fakeRunStore{run: run}
	events := &fakeEventStore{events: []Event{
		{SchemaVersion: 1, RunID: testRunID, Attempt: 1, Seq: 1, Type: "snapshot", Status: "queued", Stage: "queued", ProgressPercent: intPointer(0)},
		{SchemaVersion: 1, RunID: testRunID, Attempt: 1, Seq: 2, Type: "status", Status: "generating", Stage: "generating", ProgressPercent: intPointer(20)},
	}}
	router := setupInsightRunRouter(store, &fakeRunEnqueuer{}, &fakeRunProvider{configured: true}, events, Config{SSEPollInterval: time.Millisecond, SSETimeout: time.Millisecond})
	recorder := httptest.NewRecorder()
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID+"/stream", nil).WithContext(auth.WithUserContext(ctx, auth.UserContext{Operator: "admin", IsAdmin: true}))
	start := time.Now()
	router.ServeHTTP(recorder, request)
	cancel()
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"type":"status"`) {
		t.Fatalf("replay status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if time.Since(start) > time.Second {
		t.Fatalf("SSE did not terminate promptly")
	}
}

func TestRunSSEErrorTerminalAndClientDisconnect(t *testing.T) {
	runErr := `{"code":"PROVIDER_UNAVAILABLE","message":"provider down","retryable":true,"partial_available":false}`
	failed := &Run{
		RunID: testRunID, Attempt: 1, RoleID: "schedule_report_summary", RoleVersion: 1,
		ProjectID: 1, Country: "US", Status: "failed", Stage: "generating",
		ErrorJSON: []byte(runErr), CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	store := &fakeRunStore{run: failed}
	events := &fakeEventStore{}
	router := setupInsightRunRouter(store, &fakeRunEnqueuer{}, &fakeRunProvider{configured: true}, events, Config{SSEPollInterval: time.Millisecond, SSETimeout: time.Second})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, runAdminRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID+"/stream", nil))
	if !strings.Contains(recorder.Body.String(), `"type":"error"`) || !strings.Contains(recorder.Body.String(), "provider down") {
		t.Fatalf("error SSE body=%s", recorder.Body.String())
	}

	store.run = &Run{RunID: testRunID, Attempt: 1, ProjectID: 1, Status: "generating", Stage: "generating", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/insight/runs/"+testRunID+"/stream", nil)
	request = request.WithContext(auth.WithUserContext(ctx, auth.UserContext{Operator: "admin", IsAdmin: true}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("disconnect status=%d", recorder.Code)
	}
}

func TestInsightRunsRegistrar401(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrar(nil, nil, nil, nil, DefaultConfig()).RegisterRoutes(router, auth.RequireAPIKey("master", "secret", nil))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/insight/runs", bytes.NewReader(validCreateBody())))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", recorder.Code)
	}
}

func TestExecutorUsesProviderAndEmitsCanonicalEvents(t *testing.T) {
	slots, _ := json.Marshal(map[string]any{"report.context": map[string]any{}, "report.data": map[string]any{}})
	run := &Run{RunID: testRunID, Attempt: 1, RoleID: "schedule_report_summary", RoleVersion: 1, ProjectID: 1, Country: "US", Status: "queued", Stage: "queued", SlotsJSON: slots, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	store := &fakeRunStore{run: run}
	events := &fakeEventStore{}
	provider := &fakeRunProvider{configured: true, content: "# Result\ncontent", usage: ai.Usage{InputTokens: 2, OutputTokens: 3, TotalTokens: 5}}
	executor := NewExecutor(store, provider, events)
	if err := executor.Execute(context.Background(), testRunID, 1); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if store.run.Status != "completed" || store.run.ProgressPercent != 100 {
		t.Fatalf("run = %#v", store.run)
	}
	if len(store.transitions) != 4 {
		t.Fatalf("transitions = %#v", store.transitions)
	}
	foundDone := false
	for _, event := range events.appended {
		if event.Type == "done" {
			foundDone = true
		}
	}
	if !foundDone {
		t.Fatalf("events = %#v, want done", events.appended)
	}

	store.run.Status, store.run.Stage, store.run.ProgressPercent = "queued", "queued", 0
	store.transitions = nil
	events.appended = nil
	executor = NewExecutor(store, &fakeRunProvider{configured: false}, events)
	if !errors.Is(executor.Execute(context.Background(), testRunID, 1), ErrProviderNotConfigured) {
		t.Fatalf("unconfigured executor did not fail closed")
	}
}

func stringPtr(value string) *string { return &value }
