package ai_insight

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
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type fakeAIInsightStore struct {
	accessErr            error
	project              ProjectInfo
	insights             []InsightItem
	total                int
	detail               *InsightDetail
	latest               *InsightDetail
	statusQueue          []*InsightStatusSnapshot
	statusIndex          int
	schedules            []Schedule
	schedule             *Schedule
	createdSchedule      *Schedule
	updatedSchedule      *Schedule
	runNow               *RunScheduleResult
	scheduled            *GenerationContext
	scheduledErr         error
	scheduleFailures     []string
	scheduledIDs         []int64
	scheduledStarts      []time.Time
	scheduledEnds        []time.Time
	scheduleFailureIDs   []int64
	generationFailures   []string
	generationFailureIDs []int64
	completedInsightIDs  []int64
	adRuns               []AdAgentRun
	createdInsight       *InsightDetail
	updatedInsight       *InsightDetail
	retriedInsight       *InsightDetail
	generation           *GenerationContext
	calls                map[string]int
}

func newFakeAIInsightStore() *fakeAIInsightStore {
	return &fakeAIInsightStore{calls: make(map[string]int)}
}

func (fake *fakeAIInsightStore) VerifyProjectAccess(context.Context, int64, string, bool) (ProjectInfo, error) {
	fake.calls["verify"]++
	if fake.accessErr != nil {
		return ProjectInfo{}, fake.accessErr
	}
	if fake.project.ID == 0 {
		return ProjectInfo{ID: 1, Name: "Project", Country: "US"}, nil
	}
	return fake.project, nil
}

func (fake *fakeAIInsightStore) AccessibleProjectIDs(context.Context, string, bool) ([]int64, error) {
	return []int64{1}, nil
}

func (fake *fakeAIInsightStore) ListInsights(context.Context, ListFilter) ([]InsightItem, int, error) {
	return fake.insights, fake.total, nil
}

func (fake *fakeAIInsightStore) GetInsight(context.Context, int64) (*InsightDetail, error) {
	if fake.detail == nil {
		return nil, ErrInsightNotFound
	}
	return fake.detail, nil
}

func (fake *fakeAIInsightStore) GetLatestInsight(context.Context, int64, string) (*InsightDetail, error) {
	if fake.latest == nil {
		return nil, ErrInsightNotFound
	}
	return fake.latest, nil
}

func (fake *fakeAIInsightStore) CreateInsight(context.Context, CreateInsightInput) (*InsightDetail, error) {
	fake.calls["create_insight"]++
	return fake.createdInsight, nil
}

func (fake *fakeAIInsightStore) UpdateInsightContent(context.Context, int64, UpdateInsightInput) (*InsightDetail, error) {
	return fake.updatedInsight, nil
}

func (fake *fakeAIInsightStore) DeleteInsight(context.Context, int64, string, bool, MutationMeta) (bool, error) {
	return true, nil
}

func (fake *fakeAIInsightStore) ResetInsightForRetry(context.Context, int64, string, bool, MutationMeta) (*InsightDetail, error) {
	if fake.detail != nil && fake.detail.Status == "completed" {
		return nil, ErrInsightCompleted
	}
	return fake.retriedInsight, nil
}

func (fake *fakeAIInsightStore) GetInsightStatus(context.Context, int64) (*InsightStatusSnapshot, error) {
	if len(fake.statusQueue) == 0 {
		return nil, ErrInsightNotFound
	}
	index := fake.statusIndex
	if index >= len(fake.statusQueue) {
		index = len(fake.statusQueue) - 1
	} else {
		fake.statusIndex++
	}
	return fake.statusQueue[index], nil
}

func (fake *fakeAIInsightStore) ListSchedules(context.Context, ScheduleFilter) ([]Schedule, error) {
	return fake.schedules, nil
}

func (fake *fakeAIInsightStore) GetSchedule(context.Context, int64) (*Schedule, error) {
	if fake.schedule == nil {
		return nil, ErrScheduleNotFound
	}
	return fake.schedule, nil
}

func (fake *fakeAIInsightStore) CreateSchedule(context.Context, CreateScheduleInput) (*Schedule, error) {
	return fake.createdSchedule, nil
}

func (fake *fakeAIInsightStore) UpdateSchedule(context.Context, int64, UpdateScheduleInput) (*Schedule, error) {
	return fake.updatedSchedule, nil
}

func (fake *fakeAIInsightStore) DeleteSchedule(context.Context, int64, string, bool, MutationMeta) (bool, error) {
	return true, nil
}

func (fake *fakeAIInsightStore) ToggleSchedule(context.Context, int64, string, bool, MutationMeta) (*Schedule, error) {
	updated := *fake.schedule
	updated.IsActive = !updated.IsActive
	return &updated, nil
}

func (fake *fakeAIInsightStore) RunScheduleNow(context.Context, int64, string, bool, MutationMeta) (*RunScheduleResult, error) {
	return fake.runNow, nil
}

func (fake *fakeAIInsightStore) CreateScheduledInsight(_ context.Context, scheduleID int64, start, end time.Time) (*GenerationContext, error) {
	fake.calls["create_scheduled"]++
	fake.scheduledIDs = append(fake.scheduledIDs, scheduleID)
	fake.scheduledStarts = append(fake.scheduledStarts, start)
	fake.scheduledEnds = append(fake.scheduledEnds, end)
	return fake.scheduled, fake.scheduledErr
}

func (fake *fakeAIInsightStore) FailScheduleRun(_ context.Context, _ int64, insightID int64, message string) error {
	fake.scheduleFailures = append(fake.scheduleFailures, message)
	fake.scheduleFailureIDs = append(fake.scheduleFailureIDs, insightID)
	return nil
}

func (fake *fakeAIInsightStore) ListAdAgentRuns(context.Context, *int64, int) ([]AdAgentRun, error) {
	return fake.adRuns, nil
}

func (fake *fakeAIInsightStore) LoadGenerationContext(context.Context, int64) (*GenerationContext, error) {
	return fake.generation, nil
}

func (fake *fakeAIInsightStore) SetGenerationStatus(context.Context, int64, string, string) error {
	fake.calls["generation_status"]++
	return nil
}

func (fake *fakeAIInsightStore) CompleteGeneration(_ context.Context, insightID int64, _, _ string) error {
	fake.calls["generation_complete"]++
	fake.completedInsightIDs = append(fake.completedInsightIDs, insightID)
	return nil
}

func (fake *fakeAIInsightStore) FailGeneration(_ context.Context, insightID int64, message string) error {
	fake.calls["generation_fail"]++
	fake.generationFailureIDs = append(fake.generationFailureIDs, insightID)
	fake.generationFailures = append(fake.generationFailures, message)
	return nil
}

type fakeAIInsightEnqueuer struct {
	generate int
	run      int
	err      error
}

func (fake *fakeAIInsightEnqueuer) EnqueueGenerate(context.Context, GenerateJob) error {
	fake.generate++
	return fake.err
}

func (fake *fakeAIInsightEnqueuer) EnqueueExecuteRun(context.Context, ExecuteRunJob) error {
	fake.run++
	return fake.err
}

type fakeAIProvider struct {
	configured bool
	content    string
	usage      ai.Usage
	err        error
	requests   []ai.ChatRequest
}

func (fake *fakeAIProvider) Configured() bool { return fake.configured }
func (fake *fakeAIProvider) AvailableModels(context.Context) ([]string, error) {
	return []string{"test-model"}, nil
}
func (fake *fakeAIProvider) Complete(_ context.Context, request ai.ChatRequest) (string, ai.Usage, error) {
	fake.requests = append(fake.requests, request)
	return fake.content, fake.usage, fake.err
}
func (fake *fakeAIProvider) Stream(ctx context.Context, _ ai.ChatRequest, emit func(ai.Chunk) error) (ai.Usage, error) {
	if fake.err != nil {
		return ai.Usage{}, fake.err
	}
	if err := emit(ai.Chunk{Type: ai.ChunkContent, Text: fake.content}); err != nil {
		return ai.Usage{}, err
	}
	return fake.usage, nil
}

func setupAIInsightRouter(store Store, enqueuer JobEnqueuer, cfg Config) http.Handler {
	router := chi.NewRouter()
	NewRegistrar(store, enqueuer, cfg).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func adminRequest(method, path string, body []byte) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	return request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{Operator: "admin", IsAdmin: true}))
}

func TestGenerateFailsClosedAndValidatesAccess(t *testing.T) {
	store := newFakeAIInsightStore()
	body, _ := json.Marshal(GenerateRequest{
		ProjectID: 1, Country: "US", DateRangeStart: "2026-01-01", DateRangeEnd: "2026-01-02",
	})
	router := setupAIInsightRouter(store, nil, DefaultConfig())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/generate", body))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing enqueuer status = %d, want 503", recorder.Code)
	}

	enqueuer := &fakeAIInsightEnqueuer{}
	router = setupAIInsightRouter(store, enqueuer, Config{CanonicalDomains: "ad_analysis"})
	body, _ = json.Marshal(GenerateRequest{
		ProjectID: 1, Country: "US", DateRangeStart: "2026-01-01", DateRangeEnd: "2026-01-02",
		InsightType: "ad_analysis",
	})
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/generate", body))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("frozen domain status = %d, want 409: %s", recorder.Code, recorder.Body.String())
	}
}

func TestGenerateRetryAndScheduleRunNowEnqueue(t *testing.T) {
	store := newFakeAIInsightStore()
	store.createdInsight = &InsightDetail{InsightItem: InsightItem{ID: 11, ProjectID: 1, Status: "pending"}}
	store.detail = &InsightDetail{InsightItem: InsightItem{ID: 11, ProjectID: 1, Status: "failed"}}
	store.retriedInsight = &InsightDetail{InsightItem: InsightItem{ID: 11, ProjectID: 1, Status: "pending"}}
	store.schedule = &Schedule{ID: 7, ProjectID: 1, InsightType: "daily", IsActive: true}
	store.runNow = &RunScheduleResult{ScheduleID: 7, InsightID: 12, Status: "pending", Message: "ok"}
	enqueuer := &fakeAIInsightEnqueuer{}
	router := setupAIInsightRouter(store, enqueuer, DefaultConfig())
	body, _ := json.Marshal(GenerateRequest{ProjectID: 1, Country: "US", DateRangeStart: "2026-01-01", DateRangeEnd: "2026-01-02"})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/generate", body))
	if recorder.Code != http.StatusOK {
		t.Fatalf("generate status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if enqueuer.generate != 1 {
		t.Fatalf("generate enqueues = %d, want 1", enqueuer.generate)
	}

	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/11/retry", nil))
	if recorder.Code != http.StatusOK || enqueuer.generate != 2 {
		t.Fatalf("retry status=%d enqueues=%d: %s", recorder.Code, enqueuer.generate, recorder.Body.String())
	}
	store.detail.Status = "completed"
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/11/retry", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("completed retry status = %d, want 400", recorder.Code)
	}
	store.detail.Status = "failed"

	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/schedules/7/run-now", nil))
	if recorder.Code != http.StatusOK || enqueuer.generate != 3 {
		t.Fatalf("run-now status=%d enqueues=%d: %s", recorder.Code, enqueuer.generate, recorder.Body.String())
	}
}

func TestScheduleCRUDAndProjectPermissions(t *testing.T) {
	store := newFakeAIInsightStore()
	store.createdSchedule = &Schedule{ID: 8, ProjectID: 1, Country: "US", InsightType: "daily", IsActive: true}
	store.updatedSchedule = &Schedule{ID: 8, ProjectID: 1, Country: "US", InsightType: "weekly", IsActive: true}
	store.schedule = &Schedule{ID: 8, ProjectID: 1, Country: "US", InsightType: "daily", IsActive: true}
	router := setupAIInsightRouter(store, &fakeAIInsightEnqueuer{}, DefaultConfig())
	body := []byte(`{"project_id":1,"country":"US","insight_type":"daily","cron_expression":"0 7 * * *","date_range_strategy":"yesterday"}`)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/schedules", body))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create schedule status = %d: %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPatch, "/api/v1/ai-insights/schedules/8", []byte(`{"insight_type":"weekly"}`)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("update schedule status = %d: %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/schedules/8/toggle", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("toggle status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodDelete, "/api/v1/ai-insights/schedules/8", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d", recorder.Code)
	}

	store.accessErr = ErrProjectForbidden
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/schedules", body))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status = %d, want 403", recorder.Code)
	}
	store.accessErr = ErrProjectNotFound
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodGet, "/api/v1/ai-insights/latest?project_id=99", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("not found status = %d, want 404", recorder.Code)
	}
	store.accessErr = nil
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodPost, "/api/v1/ai-insights/schedules", []byte(`{"project_id":1,"cron_expression":"bad"}`)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid schedule status = %d, want 422", recorder.Code)
	}
}

func TestLegacySSETerminalStatusDoneAndError(t *testing.T) {
	store := newFakeAIInsightStore()
	store.statusQueue = []*InsightStatusSnapshot{{
		ID: 1, ProjectID: 1, Title: "Done", Content: "# Report", Status: "completed",
	}}
	router := setupAIInsightRouter(store, &fakeAIInsightEnqueuer{}, DefaultConfig())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodGet, "/api/v1/ai-insights/1/stream", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("SSE completed status=%d content-type=%q", recorder.Code, recorder.Header().Get("Content-Type"))
	}
	if !strings.Contains(recorder.Body.String(), `"type":"status"`) || !strings.Contains(recorder.Body.String(), `"content":"# Report"`) {
		t.Fatalf("unexpected completed SSE: %s", recorder.Body.String())
	}

	message := "boom"
	store.statusQueue = []*InsightStatusSnapshot{{
		ID: 2, ProjectID: 1, Status: "failed", ErrorMessage: &message,
	}}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodGet, "/api/v1/ai-insights/2/stream", nil))
	if !strings.Contains(recorder.Body.String(), `"status":"failed"`) || !strings.Contains(recorder.Body.String(), "boom") {
		t.Fatalf("unexpected failed SSE: %s", recorder.Body.String())
	}
}

func TestLegacySSEPollsToDoneAndHonorsDisconnect(t *testing.T) {
	store := newFakeAIInsightStore()
	store.statusQueue = []*InsightStatusSnapshot{
		{ID: 3, ProjectID: 1, Status: "generating"},
		{ID: 3, ProjectID: 1, Status: "completed", Title: "Done", Content: "body"},
	}
	router := setupAIInsightRouter(store, &fakeAIInsightEnqueuer{}, Config{SSEPollInterval: time.Millisecond, SSETimeout: time.Second})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, adminRequest(http.MethodGet, "/api/v1/ai-insights/3/stream", nil))
	if !strings.Contains(recorder.Body.String(), `"type":"done"`) {
		t.Fatalf("expected done event, got %s", recorder.Body.String())
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store.statusQueue = []*InsightStatusSnapshot{{ID: 3, ProjectID: 1, Status: "pending"}}
	store.statusIndex = 0
	request := httptest.NewRequest(http.MethodGet, "/api/v1/ai-insights/3/stream", nil)
	request = request.WithContext(auth.WithUserContext(ctx, auth.UserContext{Operator: "admin", IsAdmin: true}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("disconnect status = %d", recorder.Code)
	}
}

func TestRegistrarUsesAPIKeyMiddlewareFor401(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrar(nil, nil, DefaultConfig()).RegisterRoutes(router, auth.RequireAPIKey("master", "secret", nil))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/ai-insights", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestProviderGeneratorFailsClosedAndCompletes(t *testing.T) {
	store := newFakeAIInsightStore()
	store.generation = &GenerationContext{InsightID: 5, ProjectID: 1, ProjectName: "P", Country: "US", InsightType: "daily", DateRangeStart: "2026-01-01", DateRangeEnd: "2026-01-01"}
	generator := NewProviderGenerator(store, &fakeAIProvider{configured: false})
	_, err := generator.Generate(context.Background(), 5)
	if !errors.Is(err, ErrProviderMissing) {
		t.Fatalf("unconfigured error = %v, want ErrProviderMissing", err)
	}
	if store.calls["generation_fail"] != 1 {
		t.Fatalf("missing provider must mark failure, calls=%#v", store.calls)
	}
	provider := &fakeAIProvider{configured: true, content: "# Good report\nbody", usage: ai.Usage{InputTokens: 3, OutputTokens: 5, TotalTokens: 8}}
	generator = NewProviderGenerator(store, provider)
	result, err := generator.Generate(context.Background(), 5)
	if err != nil || result.Title != "Good report" {
		t.Fatalf("Generate() = %#v, %v", result, err)
	}
	if store.calls["generation_complete"] != 1 {
		t.Fatalf("completion calls = %#v", store.calls)
	}
}
