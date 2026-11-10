package product_analysis_reports

import (
	"bytes"
	"context"
	"encoding/json"
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
	"github.com/passwii/believeboyDashboard/backend-go/internal/testutil"
)

type fakeStore struct {
	createResult *Task
	createErr    error
	createInput  CreateInput

	getResult   *Task
	getErr      error
	getTaskID   int64
	getOperator string
	getIsAdmin  bool

	failedTaskID  int64
	failedMessage string
	markErr       error
}

func (store *fakeStore) CreateTask(
	_ context.Context,
	input CreateInput,
) (*Task, error) {
	store.createInput = input
	return store.createResult, store.createErr
}

func (store *fakeStore) GetTask(
	_ context.Context,
	taskID int64,
	operator string,
	isAdmin bool,
) (*Task, error) {
	store.getTaskID = taskID
	store.getOperator = operator
	store.getIsAdmin = isAdmin
	return store.getResult, store.getErr
}

func (store *fakeStore) MarkTaskFailed(
	_ context.Context,
	taskID int64,
	message string,
) error {
	store.failedTaskID = taskID
	store.failedMessage = message
	if store.getResult != nil {
		store.getResult.Status = StatusFailed
	}
	return store.markErr
}

type fakeEnqueuer struct {
	ids []int64
	err error
}

func (enqueuer *fakeEnqueuer) EnqueueProductAnalysisReport(
	_ context.Context,
	taskID int64,
) error {
	enqueuer.ids = append(enqueuer.ids, taskID)
	return enqueuer.err
}

type fakeObjectURLBuilder struct {
	key string
	url string
	err error
}

func (builder *fakeObjectURLBuilder) PublicURL(
	_ context.Context,
	key string,
) (string, error) {
	builder.key = key
	return builder.url, builder.err
}

func productAnalysisContext(operator string, isAdmin bool) context.Context {
	return auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: operator,
		IsAdmin:  isAdmin,
	})
}

func productAnalysisRequest(
	method string,
	target string,
	body string,
	operator string,
	isAdmin bool,
) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	request = request.WithContext(productAnalysisContext(operator, isAdmin))
	request.Header.Set("X-API-Key", "test-key")
	request.Header.Set("Content-Type", "application/json")
	return request
}

func productAnalysisRouter(
	store Store,
	auditor audit.Service,
	enqueuer Enqueuer,
	resultRoot string,
	objectURLs ObjectURLBuilder,
) http.Handler {
	router := chi.NewRouter()
	NewRegistrarWithDependencies(
		store,
		auditor,
		enqueuer,
		resultRoot,
		objectURLs,
	).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.TrimSpace(r.Header.Get("X-API-Key")) == "" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"detail":"Missing API key"}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	})
	return router
}

func successfulCreateTask() *Task {
	message := "处理中：任务已接收"
	return &Task{
		ID:                42,
		Status:            StatusPending,
		Stage:             "started",
		Progress:          1,
		Message:           &message,
		PersistenceStatus: "idle",
		CreatedAt:         "2026-11-08T01:02:03Z",
		UpdatedAt:         "2026-11-08T01:02:03Z",
		ProjectID:         7,
		ProjectName:       "Project A",
	}
}

func TestProductAnalysisReportCreateSuccess(t *testing.T) {
	store := &fakeStore{createResult: successfulCreateTask()}
	enqueuer := &fakeEnqueuer{}
	auditor := audit.NewMockService()
	router := productAnalysisRouter(store, auditor, enqueuer, t.TempDir(), nil)

	request := productAnalysisRequest(
		http.MethodPost,
		"/api/v1/product-analysis-reports",
		`{
		  "project_name":" Project A ",
		  "report_start_date":"2026-10-01",
		  "report_end_date":"2026-10-31",
		  "business_report_file_id":"business.csv",
		  "payment_report_file_id":"payment.csv",
		  "ad_report_file_id":"ads.xlsx",
		  "inventory_report_file_id":"inventory.txt",
		  "country":"USA"
		}`,
		"alice",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(enqueuer.ids) != 1 || enqueuer.ids[0] != 42 {
		t.Fatalf("enqueued ids = %#v", enqueuer.ids)
	}
	if store.createInput.ProjectName != "Project A" ||
		store.createInput.Country != "US" ||
		store.createInput.Operator != "alice" ||
		store.createInput.IsAdmin {
		t.Fatalf("create input = %#v", store.createInput)
	}
	if store.createInput.InventoryReportFileID == nil ||
		*store.createInput.InventoryReportFileID != "inventory.txt" {
		t.Fatalf("inventory file id = %#v", store.createInput.InventoryReportFileID)
	}

	var response CreateResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.JobID != 42 ||
		response.Status != StatusPending ||
		response.StatusEndpoint == nil ||
		*response.StatusEndpoint != "/api/v1/product-analysis-reports/tasks/42" ||
		response.ResultEndpoint == nil ||
		*response.ResultEndpoint != "/api/v1/product-analysis-reports/tasks/42/result" {
		t.Fatalf("response = %#v", response)
	}
	if len(auditor.Entries) != 1 ||
		auditor.Entries[0].Action != "product_analysis_reports.create" ||
		auditor.Entries[0].Result != "success" {
		t.Fatalf("audit entries = %#v", auditor.Entries)
	}
}

func TestProductAnalysisReportCreateValidationStatuses(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		status int
	}{
		{
			name:   "malformed json",
			body:   `{`,
			status: http.StatusUnprocessableEntity,
		},
		{
			name: "unknown field",
			body: `{
			  "project_name":"Project A",
			  "report_start_date":"2026-10-01",
			  "report_end_date":"2026-10-31",
			  "business_report_file_id":"business.csv",
			  "payment_report_file_id":"payment.csv",
			  "ad_report_file_id":"ads.xlsx",
			  "unexpected":true
			}`,
			status: http.StatusUnprocessableEntity,
		},
		{
			name: "blank project",
			body: `{
			  "project_name":" ",
			  "report_start_date":"2026-10-01",
			  "report_end_date":"2026-10-31",
			  "business_report_file_id":"business.csv",
			  "payment_report_file_id":"payment.csv",
			  "ad_report_file_id":"ads.xlsx"
			}`,
			status: http.StatusUnprocessableEntity,
		},
		{
			name: "invalid date",
			body: `{
			  "project_name":"Project A",
			  "report_start_date":"2026-13-01",
			  "report_end_date":"2026-10-31",
			  "business_report_file_id":"business.csv",
			  "payment_report_file_id":"payment.csv",
			  "ad_report_file_id":"ads.xlsx"
			}`,
			status: http.StatusBadRequest,
		},
		{
			name: "reversed dates",
			body: `{
			  "project_name":"Project A",
			  "report_start_date":"2026-11-01",
			  "report_end_date":"2026-10-31",
			  "business_report_file_id":"business.csv",
			  "payment_report_file_id":"payment.csv",
			  "ad_report_file_id":"ads.xlsx"
			}`,
			status: http.StatusBadRequest,
		},
		{
			name: "invalid country",
			body: `{
			  "project_name":"Project A",
			  "report_start_date":"2026-10-01",
			  "report_end_date":"2026-10-31",
			  "business_report_file_id":"business.csv",
			  "payment_report_file_id":"payment.csv",
			  "ad_report_file_id":"ads.xlsx",
			  "country":"JP"
			}`,
			status: http.StatusUnprocessableEntity,
		},
		{
			name: "unsafe file id",
			body: `{
			  "project_name":"Project A",
			  "report_start_date":"2026-10-01",
			  "report_end_date":"2026-10-31",
			  "business_report_file_id":"../../secret.csv",
			  "payment_report_file_id":"payment.csv",
			  "ad_report_file_id":"ads.xlsx"
			}`,
			status: http.StatusUnprocessableEntity,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeStore{createResult: successfulCreateTask()}
			router := productAnalysisRouter(
				store,
				nil,
				&fakeEnqueuer{},
				t.TempDir(),
				nil,
			)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(
				recorder,
				productAnalysisRequest(
					http.MethodPost,
					"/api/v1/product-analysis-reports",
					test.body,
					"alice",
					false,
				),
			)
			if recorder.Code != test.status {
				t.Fatalf(
					"status = %d, want %d; body = %s",
					recorder.Code,
					test.status,
					recorder.Body.String(),
				)
			}
		})
	}
}

func TestProductAnalysisReportCreateMissingEnqueuerFailsClosed(t *testing.T) {
	store := &fakeStore{createResult: successfulCreateTask()}
	auditor := audit.NewMockService()
	router := productAnalysisRouter(store, auditor, nil, t.TempDir(), nil)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodPost,
			"/api/v1/product-analysis-reports",
			validCreateBody(),
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.failedTaskID != 42 ||
		!strings.Contains(store.failedMessage, "not configured") {
		t.Fatalf("failed task = %d %q", store.failedTaskID, store.failedMessage)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Result != "failure" {
		t.Fatalf("audit = %#v", auditor.Entries)
	}
}

func TestProductAnalysisReportCreateEnqueueFailureMarksTaskFailed(t *testing.T) {
	store := &fakeStore{createResult: successfulCreateTask()}
	router := productAnalysisRouter(
		store,
		nil,
		&fakeEnqueuer{err: errors.New("redis unavailable")},
		t.TempDir(),
		nil,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodPost,
			"/api/v1/product-analysis-reports",
			validCreateBody(),
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.failedTaskID != 42 || store.failedMessage != "redis unavailable" {
		t.Fatalf("failed task = %d %q", store.failedTaskID, store.failedMessage)
	}
}

func TestProductAnalysisReportCreateStoreAccessErrors(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
	}{
		{name: "project not found", err: ErrProjectNotFound, status: http.StatusNotFound},
		{name: "project forbidden", err: ErrProjectForbidden, status: http.StatusForbidden},
		{name: "invalid stored path", err: ErrInvalidStoredPath, status: http.StatusUnprocessableEntity},
		{name: "storage missing", err: ErrStorageNotConfigured, status: http.StatusServiceUnavailable},
		{name: "internal", err: errors.New("database down"), status: http.StatusInternalServerError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeStore{createErr: test.err}
			router := productAnalysisRouter(
				store,
				nil,
				&fakeEnqueuer{},
				t.TempDir(),
				nil,
			)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(
				recorder,
				productAnalysisRequest(
					http.MethodPost,
					"/api/v1/product-analysis-reports",
					validCreateBody(),
					"alice",
					false,
				),
			)
			if recorder.Code != test.status {
				t.Fatalf(
					"status = %d, want %d; body = %s",
					recorder.Code,
					test.status,
					recorder.Body.String(),
				)
			}
		})
	}
}

func TestProductAnalysisReportStatus(t *testing.T) {
	message := "处理中：开始执行核算逻辑"
	errorMessage := "parser warning"
	persistenceMessage := "pt1 stored"
	task := &Task{
		ID:                 42,
		Status:             StatusRunning,
		Stage:              "processing",
		Progress:           60,
		Message:            &message,
		ErrorMessage:       &errorMessage,
		PersistenceStatus:  "success",
		PersistenceMessage: &persistenceMessage,
		CreatedAt:          "2026-11-08T01:02:03Z",
		UpdatedAt:          "2026-11-08T01:03:03Z",
	}
	store := &fakeStore{getResult: task}
	router := productAnalysisRouter(store, nil, &fakeEnqueuer{}, t.TempDir(), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42",
			"",
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.getTaskID != 42 || store.getOperator != "alice" || store.getIsAdmin {
		t.Fatalf("get task args = %d %q %v", store.getTaskID, store.getOperator, store.getIsAdmin)
	}
	var response TaskStatusResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.TaskID != 42 ||
		response.Status != StatusRunning ||
		response.Stage != "processing" ||
		response.Progress != 60 ||
		response.PersistenceStatus != "success" ||
		response.Message == nil || *response.Message != message ||
		response.PersistenceMessage == nil || *response.PersistenceMessage != persistenceMessage {
		t.Fatalf("response = %#v", response)
	}
}

func TestProductAnalysisReportStatusErrors(t *testing.T) {
	tests := []struct {
		name   string
		task   *Task
		err    error
		status int
	}{
		{name: "not found", err: ErrTaskNotFound, status: http.StatusNotFound},
		{name: "forbidden", err: ErrProjectForbidden, status: http.StatusForbidden},
		{name: "nil task", status: http.StatusNotFound},
		{name: "internal", err: errors.New("database down"), status: http.StatusInternalServerError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeStore{getResult: test.task, getErr: test.err}
			router := productAnalysisRouter(store, nil, &fakeEnqueuer{}, t.TempDir(), nil)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(
				recorder,
				productAnalysisRequest(
					http.MethodGet,
					"/api/v1/product-analysis-reports/tasks/42",
					"",
					"alice",
					false,
				),
			)
			if recorder.Code != test.status {
				t.Fatalf(
					"status = %d, want %d; body = %s",
					recorder.Code,
					test.status,
					recorder.Body.String(),
				)
			}
		})
	}
}

func TestProductAnalysisReportRoutesRequireAPIKey(t *testing.T) {
	store := &fakeStore{getResult: successfulCreateTask()}
	router := productAnalysisRouter(store, nil, &fakeEnqueuer{}, t.TempDir(), nil)
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/product-analysis-reports/tasks/42",
		nil,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestProductAnalysisReportTaskIDValidation(t *testing.T) {
	store := &fakeStore{getResult: successfulCreateTask()}
	router := productAnalysisRouter(store, nil, &fakeEnqueuer{}, t.TempDir(), nil)
	tests := []struct {
		taskID string
		status int
	}{
		{taskID: "not-a-number", status: http.StatusUnprocessableEntity},
		{taskID: "0", status: http.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.taskID, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(
				recorder,
				productAnalysisRequest(
					http.MethodGet,
					"/api/v1/product-analysis-reports/tasks/"+test.taskID,
					"",
					"alice",
					false,
				),
			)
			if recorder.Code != test.status {
				t.Fatalf(
					"status = %d, want %d; body = %s",
					recorder.Code,
					test.status,
					recorder.Body.String(),
				)
			}
		})
	}
}

func TestProductAnalysisReportResultNotFinished(t *testing.T) {
	store := &fakeStore{getResult: successfulCreateTask()}
	router := productAnalysisRouter(store, nil, &fakeEnqueuer{}, t.TempDir(), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestProductAnalysisReportResultErrors(t *testing.T) {
	tests := []struct {
		name   string
		task   *Task
		err    error
		root   string
		status int
	}{
		{
			name:   "task not found",
			err:    ErrTaskNotFound,
			root:   t.TempDir(),
			status: http.StatusNotFound,
		},
		{
			name:   "forbidden",
			err:    ErrProjectForbidden,
			root:   t.TempDir(),
			status: http.StatusForbidden,
		},
		{
			name:   "nil task",
			root:   t.TempDir(),
			status: http.StatusNotFound,
		},
		{
			name:   "internal",
			err:    errors.New("database down"),
			root:   t.TempDir(),
			status: http.StatusInternalServerError,
		},
		{
			name: "missing result path",
			task: func() *Task {
				task := successfulCreateTask()
				task.Status = StatusSuccess
				return task
			}(),
			root:   t.TempDir(),
			status: http.StatusNotFound,
		},
		{
			name: "missing result root",
			task: func() *Task {
				task := successfulCreateTask()
				task.Status = StatusSuccess
				path := "/absolute/result.xlsx"
				task.ResultPath = &path
				return task
			}(),
			root:   "",
			status: http.StatusServiceUnavailable,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeStore{getResult: test.task, getErr: test.err}
			router := productAnalysisRouter(
				store,
				nil,
				&fakeEnqueuer{},
				test.root,
				nil,
			)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(
				recorder,
				productAnalysisRequest(
					http.MethodGet,
					"/api/v1/product-analysis-reports/tasks/42/result",
					"",
					"alice",
					false,
				),
			)
			if recorder.Code != test.status {
				t.Fatalf(
					"status = %d, want %d; body = %s",
					recorder.Code,
					test.status,
					recorder.Body.String(),
				)
			}
		})
	}
}

func TestProductAnalysisReportResultServesControlledLocalFile(t *testing.T) {
	root := t.TempDir()
	filename := filepath.Join(root, "result.xlsx")
	if err := os.WriteFile(filename, []byte("xlsx-bytes"), 0o600); err != nil {
		t.Fatalf("write result: %v", err)
	}
	task := successfulCreateTask()
	task.Status = StatusSuccess
	task.ResultPath = &filename
	store := &fakeStore{getResult: task}
	auditor := audit.NewMockService()
	router := productAnalysisRouter(store, auditor, &fakeEnqueuer{}, root, nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != "xlsx-bytes" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
	if !strings.Contains(
		recorder.Header().Get("Content-Disposition"),
		"result.xlsx",
	) {
		t.Fatalf("content disposition = %q", recorder.Header().Get("Content-Disposition"))
	}
	if len(auditor.Entries) != 1 ||
		auditor.Entries[0].Action != "product_analysis_reports.result.export" {
		t.Fatalf("audit = %#v", auditor.Entries)
	}
}

func TestProductAnalysisReportResultRejectsUnsafePaths(t *testing.T) {
	root := t.TempDir()
	task := successfulCreateTask()
	task.Status = StatusSuccess
	store := &fakeStore{getResult: task}

	tests := []struct {
		name string
		path string
	}{
		{name: "traversal", path: "../secret.xlsx"},
		{name: "absolute escape", path: "/tmp/secret.xlsx"},
		{name: "http url", path: "http://example.com/result.xlsx"},
		{name: "credentials", path: "https://user:pass@example.com/result.xlsx"},
		{name: "crlf", path: "https://example.com/result.xlsx\r\nX-Test: yes"},
		{name: "file url", path: "file:///tmp/result.xlsx"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := test.path
			store.getResult.ResultPath = &path
			router := productAnalysisRouter(
				store,
				nil,
				&fakeEnqueuer{},
				root,
				nil,
			)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(
				recorder,
				productAnalysisRequest(
					http.MethodGet,
					"/api/v1/product-analysis-reports/tasks/42/result",
					"",
					"alice",
					false,
				),
			)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf(
					"status = %d, want 404; body = %s",
					recorder.Code,
					recorder.Body.String(),
				)
			}
		})
	}
}

func TestProductAnalysisReportResultRejectsSymlinkEscape(t *testing.T) {
	testutil.RequireSymlink(t)
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.xlsx")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	link := filepath.Join(root, "linked.xlsx")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("create symlink: %v", err)
	}

	task := successfulCreateTask()
	task.Status = StatusSuccess
	task.ResultPath = &link
	store := &fakeStore{getResult: task}
	router := productAnalysisRouter(store, nil, &fakeEnqueuer{}, root, nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "secret") {
		t.Fatalf("sensitive file content leaked: %s", recorder.Body.String())
	}
}

func TestProductAnalysisReportResultRedirectsSafeHTTPSURL(t *testing.T) {
	task := successfulCreateTask()
	task.Status = StatusSuccess
	resultPath := "https://objects.example.com/result.xlsx?signature=abc"
	task.ResultPath = &resultPath
	store := &fakeStore{getResult: task}
	router := productAnalysisRouter(store, nil, &fakeEnqueuer{}, t.TempDir(), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if location := recorder.Header().Get("Location"); location != resultPath {
		t.Fatalf("location = %q, want %q", location, resultPath)
	}
}

func TestProductAnalysisReportResultRequiresObjectStorageForR2Key(t *testing.T) {
	task := successfulCreateTask()
	task.Status = StatusSuccess
	resultPath := "project-a/product-analysis/42/result.xlsx"
	task.ResultPath = &resultPath
	store := &fakeStore{getResult: task}

	router := productAnalysisRouter(store, nil, &fakeEnqueuer{}, t.TempDir(), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	builder := &fakeObjectURLBuilder{
		url: "https://objects.example.com/project-a/product-analysis/42/result.xlsx",
	}
	router = productAnalysisRouter(store, nil, &fakeEnqueuer{}, t.TempDir(), builder)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(
		recorder,
		productAnalysisRequest(
			http.MethodGet,
			"/api/v1/product-analysis-reports/tasks/42/result",
			"",
			"alice",
			false,
		),
	)
	if recorder.Code != http.StatusFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if builder.key != resultPath {
		t.Fatalf("object key = %q, want %q", builder.key, resultPath)
	}
}

func TestSafeHTTPSURLRejectsUnsafeValues(t *testing.T) {
	for _, raw := range []string{
		"",
		"http://example.com/file",
		"https://user@example.com/file",
		"https://example.com/file\r\nInjected: yes",
		"https:///missing-host",
		"file:///tmp/file",
	} {
		if _, ok := safeHTTPSURL(raw); ok {
			t.Fatalf("safeHTTPSURL(%q) = true, want false", raw)
		}
	}
}

func validCreateBody() string {
	return `{
	  "project_name":"Project A",
	  "report_start_date":"2026-10-01",
	  "report_end_date":"2026-10-31",
	  "business_report_file_id":"business.csv",
	  "payment_report_file_id":"payment.csv",
	  "ad_report_file_id":"ads.xlsx"
	}`
}
