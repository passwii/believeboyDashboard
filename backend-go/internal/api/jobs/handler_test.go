package jobs

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestCreateJobRequiresConfiguredEnqueuer(t *testing.T) {
	handler := NewHandler(&handlerStore{}, nil, t.TempDir(), audit.NewMockService())
	rec := httptest.NewRecorder()
	handler.Create(rec, httptest.NewRequest(http.MethodPost, "/api/v1/jobs",
		strings.NewReader(`{"job_type":"monthly_report","file_id":"file-1","params":{}}`)))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCreateJobCreatesAndEnqueues(t *testing.T) {
	store := &handlerStore{job: Job{ID: 9, JobType: "monthly_report", Status: "pending", PayloadJSON: map[string]any{}}}
	enqueuer := &fakeEnqueuer{}
	auditor := audit.NewMockService()
	handler := NewHandler(store, enqueuer, t.TempDir(), auditor)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/jobs",
		strings.NewReader(`{"job_type":"monthly_report","file_id":"file-1","params":{"month":10}}`))
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{Operator: "运营甲"}))
	rec := httptest.NewRecorder()
	handler.Create(rec, req)
	if rec.Code != http.StatusOK || enqueuer.jobID != 9 || len(auditor.Entries) != 1 {
		t.Fatalf("response = %d %s, enqueued=%d audit=%#v", rec.Code, rec.Body.String(), enqueuer.jobID, auditor.Entries)
	}
}

func TestCreateJobMarksFailedWhenQueueIsDown(t *testing.T) {
	store := &handlerStore{job: Job{ID: 9, JobType: "x", Status: "pending", PayloadJSON: map[string]any{}}}
	handler := NewHandler(store, &fakeEnqueuer{err: errors.New("redis down")}, t.TempDir(), nil)
	rec := httptest.NewRecorder()
	handler.Create(rec, httptest.NewRequest(http.MethodPost, "/api/v1/jobs",
		strings.NewReader(`{"job_type":"x","file_id":"f","params":{}}`)))
	if rec.Code != http.StatusServiceUnavailable || store.failedJobID != 9 {
		t.Fatalf("response = %d, failed=%d", rec.Code, store.failedJobID)
	}
}

func TestGetJobReturnsDetailAnd404(t *testing.T) {
	store := &handlerStore{job: Job{ID: 9, JobType: "x", Status: "success", PayloadJSON: map[string]any{}}, runs: []JobRun{{ID: 2}}}
	handler := NewHandler(store, &fakeEnqueuer{}, t.TempDir(), nil)
	req := withChiParam(httptest.NewRequest(http.MethodGet, "/api/v1/jobs/9", nil), "job_id", "9")
	rec := httptest.NewRecorder()
	handler.Get(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"runs":[{"id":2`) {
		t.Fatalf("response = %d %s", rec.Code, rec.Body.String())
	}

	store.notFound = true
	rec = httptest.NewRecorder()
	handler.Get(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestDownloadResultIsRestrictedToResultRoot(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "job.txt")
	if err := os.WriteFile(inside, []byte("result"), 0o600); err != nil {
		t.Fatal(err)
	}
	relative := "job.txt"
	store := &handlerStore{
		job: Job{ID: 9, Status: "success", PayloadJSON: map[string]any{}},
		run: &JobRun{ID: 1, ResultPath: &relative},
	}
	handler := NewHandler(store, &fakeEnqueuer{}, root, nil)
	req := withChiParam(httptest.NewRequest(http.MethodGet, "/api/v1/jobs/9/result", nil), "job_id", "9")
	rec := httptest.NewRecorder()
	handler.DownloadResult(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "result" {
		t.Fatalf("response = %d %q", rec.Code, rec.Body.String())
	}

	outside := filepath.Join(t.TempDir(), "secret.txt")
	store.run.ResultPath = &outside
	rec = httptest.NewRecorder()
	handler.DownloadResult(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("outside status = %d", rec.Code)
	}
}

type handlerStore struct {
	job         Job
	runs        []JobRun
	run         *JobRun
	notFound    bool
	failedJobID int64
}

func (s *handlerStore) CreateJob(_ context.Context, _ CreateInput, _ *string) (Job, error) {
	return s.job, nil
}
func (s *handlerStore) GetJob(context.Context, int64) (*Job, error) {
	if s.notFound {
		return nil, NewAPIError(http.StatusNotFound, "Job not found")
	}
	return &s.job, nil
}
func (s *handlerStore) ListRuns(context.Context, int64) ([]JobRun, error) { return s.runs, nil }
func (s *handlerStore) LatestRun(context.Context, int64) (*JobRun, error) { return s.run, nil }
func (s *handlerStore) MarkEnqueueFailed(_ context.Context, id int64, _ string) error {
	s.failedJobID = id
	return nil
}

type fakeEnqueuer struct {
	jobID int64
	err   error
}

func (enqueuer *fakeEnqueuer) EnqueueJob(_ context.Context, jobID int64) error {
	enqueuer.jobID = jobID
	return enqueuer.err
}

func withChiParam(request *http.Request, key, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(key, value)
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}
