package workflows

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestReadEndpointsShapeAndProjectPermission(t *testing.T) {
	store := newFakeWorkflowStore()
	projectsReader := newFakeProjects()
	router := chi.NewRouter()
	NewRegistrar(store, projectsReader).RegisterRoutes(router, passthrough)

	request := workflowRequest(
		http.MethodGet,
		"/api/v1/project-workflows/templates",
		"",
		"运营甲",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	assertWorkflowResponse(t, recorder, http.StatusOK)
	if !strings.Contains(recorder.Body.String(), `"templates":[{"key":"launch"`) {
		t.Fatalf("templates response = %s", recorder.Body.String())
	}

	request = workflowRequest(
		http.MethodGet,
		"/api/v1/projects/7/workflows",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	assertWorkflowResponse(t, recorder, http.StatusOK)
	if !strings.Contains(recorder.Body.String(), `"project_id":7`) ||
		!strings.Contains(recorder.Body.String(), `"contents":[]`) {
		t.Fatalf("list workflows response = %s", recorder.Body.String())
	}

	request = workflowRequest(
		http.MethodGet,
		"/api/v1/project-workflows/summary",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	assertWorkflowResponse(t, recorder, http.StatusOK)
	if !strings.Contains(recorder.Body.String(), `"project_id":7`) ||
		!strings.Contains(recorder.Body.String(), `"workflows":[`) {
		t.Fatalf("summary response = %s", recorder.Body.String())
	}

	request = workflowRequest(
		http.MethodGet,
		"/api/v1/projects/8/workflows",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("invisible project status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestProjectWriteHandlersUseStoreAndReturnWorkflow(t *testing.T) {
	store := newFakeWorkflowStore()
	projectsReader := newFakeProjects()
	blobs := &fakeBlobStore{}
	router := chi.NewRouter()
	NewRegistrarWithOptions(
		store,
		projectsReader,
		WithBlobStore(blobs),
	).RegisterRoutes(router, passthrough)

	operations := []struct {
		method string
		path   string
		body   string
		admin  bool
	}{
		{http.MethodPost, "/api/v1/projects/7/workflows", `{"kind":"store_launch","template_key":"launch"}`, false},
		{http.MethodPatch, "/api/v1/project-workflows/3", `{"title":"新标题","start_date":"2026-01-01"}`, true},
		{http.MethodPatch, "/api/v1/project-workflow-tasks/4", `{"status":"in_progress"}`, false},
		{http.MethodPost, "/api/v1/projects/7/workflows/3/tasks", `{"title":"新节点","duration_days":2,"sort_order":1}`, true},
		{http.MethodPatch, "/api/v1/project-workflow-tasks/4/definition", `{"title":"定义","duration_days":3}`, true},
		{http.MethodDelete, "/api/v1/project-workflow-tasks/4", "", true},
		{http.MethodPut, "/api/v1/projects/7/workflows/3/tasks/order", `{"task_ids":[5,4]}`, true},
		{http.MethodPost, "/api/v1/projects/7/workflow-tasks/4/contents", `{"body":"正文"}`, true},
		{http.MethodPatch, "/api/v1/project-workflow-task-contents/6", `{"body":"更新"}`, true},
		{http.MethodDelete, "/api/v1/project-workflow-task-contents/6", "", true},
	}
	for _, operation := range operations {
		request := workflowRequest(operation.method, operation.path, operation.body, "运营甲", operation.admin)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		assertWorkflowResponse(t, recorder, http.StatusOK)
	}

	store.mu.Lock()
	actions := append([]string(nil), store.actions...)
	store.mu.Unlock()
	want := []string{
		"CreateWorkflow",
		"UpdateWorkflowDefinition",
		"UpdateTaskStatus",
		"CreateProjectTask",
		"UpdateProjectTaskDefinition",
		"DeleteProjectTask",
		"ReorderProjectTasks",
		"CreateProjectContent",
		"UpdateProjectContent",
		"DeleteProjectContent",
	}
	if strings.Join(actions, ",") != strings.Join(want, ",") {
		t.Fatalf("store actions = %v, want %v", actions, want)
	}
}

func TestTemplateWriteHandlersCoverAdminSurface(t *testing.T) {
	store := newFakeWorkflowStore()
	projectsReader := newFakeProjects()
	blobs := &fakeBlobStore{}
	router := chi.NewRouter()
	NewRegistrarWithOptions(
		store,
		projectsReader,
		WithBlobStore(blobs),
	).RegisterRoutes(router, passthrough)

	operations := []struct {
		method string
		path   string
		body   string
		status int
	}{
		{http.MethodGet, "/api/v1/project-workflows/admin/templates", "", http.StatusOK},
		{http.MethodPost, "/api/v1/project-workflows/admin/templates", `{"kind":"product_development","title":"模板","key":"template-a"}`, http.StatusOK},
		{http.MethodGet, "/api/v1/project-workflows/admin/templates/9", "", http.StatusOK},
		{http.MethodPatch, "/api/v1/project-workflows/admin/templates/9", `{"title":"模板改"}`, http.StatusOK},
		{http.MethodPost, "/api/v1/project-workflows/admin/templates/9/copy", `{"key":"copy-a"}`, http.StatusOK},
		{http.MethodPost, "/api/v1/project-workflows/admin/templates/9/tasks", `{"title":"节点","sort_order":0}`, http.StatusOK},
		{http.MethodPut, "/api/v1/project-workflows/admin/templates/9/tasks/order", `{"task_ids":[10]}`, http.StatusOK},
		{http.MethodPatch, "/api/v1/project-workflows/admin/template-tasks/10", `{"title":"节点改"}`, http.StatusOK},
		{http.MethodDelete, "/api/v1/project-workflows/admin/template-tasks/10", "", http.StatusOK},
		{http.MethodPost, "/api/v1/project-workflows/admin/template-tasks/10/contents", `{"body":"内容"}`, http.StatusOK},
		{http.MethodPatch, "/api/v1/project-workflows/admin/template-task-contents/11", `{"body":"内容改"}`, http.StatusOK},
		{http.MethodDelete, "/api/v1/project-workflows/admin/template-task-contents/11", "", http.StatusOK},
		{http.MethodDelete, "/api/v1/project-workflows/admin/template-task-attachments/12", "", http.StatusOK},
	}
	for _, operation := range operations {
		request := workflowRequest(operation.method, operation.path, operation.body, "管理员", true)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != operation.status {
			t.Fatalf("%s %s status = %d, body = %s", operation.method, operation.path, recorder.Code, recorder.Body.String())
		}
	}

	upload := multipartRequest(
		t,
		http.MethodPost,
		"/api/v1/project-workflows/admin/template-tasks/10/attachments",
		"管理员",
		true,
		"file",
		"template.pdf",
		"application/pdf",
		[]byte("pdf"),
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, upload)
	if recorder.Code != http.StatusOK {
		t.Fatalf("upload template attachment status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	request := workflowRequest(
		http.MethodDelete,
		"/api/v1/project-workflows/admin/templates/9",
		"",
		"管理员",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("delete template status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	store.mu.Lock()
	actions := append([]string(nil), store.actions...)
	store.mu.Unlock()
	if len(actions) != 15 {
		t.Fatalf("template store actions = %v, want 15", actions)
	}
}

func TestAttachmentUploadDownloadAndDocumentSafety(t *testing.T) {
	store := newFakeWorkflowStore()
	projectsReader := newFakeProjects()
	blobs := &fakeBlobStore{objects: map[string][]byte{
		"project-launch-7/task-4/0123456789abcdef_file.pdf": []byte("attachment"),
	}}
	store.download = &AttachmentDownload{
		ID:          12,
		ProjectID:   7,
		TaskID:      4,
		R2Key:       "project-launch-7/task-4/0123456789abcdef_file.pdf",
		Filename:    "附件.pdf",
		ContentType: "application/pdf",
		FileSize:    10,
	}
	files := &fakeFileStore{key: DocumentKeyAmazonRegistrationForm, data: []byte("xlsx")}
	router := chi.NewRouter()
	NewRegistrarWithOptions(
		store,
		projectsReader,
		WithBlobStore(blobs),
		WithFileStore(files),
		WithAttachmentConfig(AttachmentConfig{MaxBytes: 32}),
	).RegisterRoutes(router, passthrough)

	upload := multipartRequest(
		t,
		http.MethodPost,
		"/api/v1/projects/7/workflow-tasks/4/attachments",
		"运营甲",
		false,
		"file",
		"../../附件.pdf",
		"application/pdf",
		[]byte("pdf"),
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, upload)
	assertWorkflowResponse(t, recorder, http.StatusOK)
	if strings.Contains(recorder.Body.String(), "https://") {
		t.Fatalf("upload leaked object-store URL: %s", recorder.Body.String())
	}
	blobs.mu.Lock()
	putKey := blobs.lastKey
	blobs.mu.Unlock()
	if !strings.HasPrefix(putKey, "project-launch-7/task-4/") || strings.Contains(putKey, "..") {
		t.Fatalf("uploaded key = %q, want controlled project/task prefix", putKey)
	}

	request := workflowRequest(
		http.MethodGet,
		"/api/v1/projects/7/workflow-task-attachments/12/download",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "attachment") {
		t.Fatalf("download = %d %s", recorder.Code, recorder.Body.String())
	}
	disposition := recorder.Header().Get("Content-Disposition")
	if !strings.Contains(disposition, "filename*=utf-8''") {
		t.Fatalf("Content-Disposition = %q", disposition)
	}

	store.attachmentDeleteKeys = []string{"project-launch-7/task-4/0123456789abcdef_file.pdf"}
	request = workflowRequest(
		http.MethodDelete,
		"/api/v1/projects/7/workflow-task-attachments/12",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete attachment = %d %s", recorder.Code, recorder.Body.String())
	}
	blobs.mu.Lock()
	deleteCalls := append([]string(nil), blobs.deleteCalls...)
	blobs.mu.Unlock()
	if len(deleteCalls) != 1 ||
		deleteCalls[0] != "project-launch-7/task-4/0123456789abcdef_file.pdf" {
		t.Fatalf("blob delete calls = %v", deleteCalls)
	}

	request = workflowRequest(
		http.MethodGet,
		"/api/v1/projects/7/workflow-task-attachments/12/download",
		"",
		"运营甲",
		false,
	)
	store.download.R2Key = "../etc/passwd"
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unsafe key status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	store.download.R2Key = "project-launch-7/task-4/0123456789abcdef_file.pdf"
	request = workflowRequest(
		http.MethodGet,
		"/api/v1/projects/8/workflow-task-attachments/12/download",
		"",
		"运营甲",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("cross-project attachment status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	request = workflowRequest(
		http.MethodGet,
		"/api/v1/projects/7/workflows/documents/amazon_registration_form",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "xlsx") {
		t.Fatalf("document download = %d %s", recorder.Code, recorder.Body.String())
	}

	request = workflowRequest(
		http.MethodGet,
		"/api/v1/projects/7/workflows/documents/../../etc/passwd",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound && recorder.Code != http.StatusForbidden {
		t.Fatalf("unsafe document status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAttachmentAndDocumentMissingDependencyIs503(t *testing.T) {
	store := newFakeWorkflowStore()
	projectsReader := newFakeProjects()
	router := chi.NewRouter()
	NewRegistrar(store, projectsReader).RegisterRoutes(router, passthrough)

	request := multipartRequest(
		t,
		http.MethodPost,
		"/api/v1/projects/7/workflow-tasks/4/attachments",
		"运营甲",
		false,
		"file",
		"safe.pdf",
		"application/pdf",
		[]byte("pdf"),
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing blob upload = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	request = workflowRequest(
		http.MethodGet,
		"/api/v1/projects/7/workflows/documents/amazon_registration_form",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing document store = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestPermissionValidationConflictAndNotFoundStatuses(t *testing.T) {
	store := newFakeWorkflowStore()
	projectsReader := newFakeProjects()
	router := chi.NewRouter()
	NewRegistrar(store, projectsReader).RegisterRoutes(router, passthrough)

	request := workflowRequest(http.MethodGet, "/api/v1/project-workflows/templates", "", "", false)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", recorder.Code)
	}

	request = workflowRequest(
		http.MethodGet,
		"/api/v1/project-workflows/admin/templates",
		"",
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-admin template list status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	request = workflowRequest(
		http.MethodPatch,
		"/api/v1/project-workflow-tasks/4",
		`{"status":"done"}`,
		"运营甲",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	store.writeErr = projects.NewAPIError(http.StatusConflict, "模板键已存在")
	request = workflowRequest(
		http.MethodPost,
		"/api/v1/project-workflows/admin/templates",
		`{"kind":"product_development","title":"重复","key":"duplicate"}`,
		"管理员",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	store.writeErr = nil
	store.template = nil
	request = workflowRequest(
		http.MethodGet,
		"/api/v1/project-workflows/admin/templates/99",
		"",
		"管理员",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing template status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestValidationRejectsOrderDurationDatesAndMultipart(t *testing.T) {
	store := newFakeWorkflowStore()
	projectsReader := newFakeProjects()
	blobs := &fakeBlobStore{}
	router := chi.NewRouter()
	NewRegistrarWithOptions(
		store,
		projectsReader,
		WithBlobStore(blobs),
		WithAttachmentConfig(AttachmentConfig{MaxBytes: 4}),
	).RegisterRoutes(router, passthrough)

	cases := []struct {
		method string
		path   string
		body   string
		admin  bool
	}{
		{http.MethodPost, "/api/v1/projects/7/workflows/3/tasks", `{"title":"x","duration_days":3651}`, true},
		{http.MethodPatch, "/api/v1/project-workflow-tasks/4/definition", `{"start_date":"2026-02-01","end_date":"2026-01-01"}`, true},
		{http.MethodPut, "/api/v1/projects/7/workflows/3/tasks/order", `{"task_ids":[4,4]}`, true},
		{http.MethodPost, "/api/v1/project-workflows/admin/templates/9/tasks", `{"title":"x","attachment_key":"../../etc/passwd"}`, true},
		{http.MethodPost, "/api/v1/projects/7/workflow-tasks/4/contents", `{"body":""}`, true},
	}
	for _, testCase := range cases {
		request := workflowRequest(testCase.method, testCase.path, testCase.body, "运营甲", testCase.admin)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s %s = %d %s", testCase.method, testCase.path, recorder.Code, recorder.Body.String())
		}
	}

	request := multipartRequest(
		t,
		http.MethodPost,
		"/api/v1/projects/7/workflow-tasks/4/attachments",
		"运营甲",
		false,
		"file",
		"blocked.exe",
		"application/octet-stream",
		[]byte("1234"),
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("bad extension = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	request = multipartRequest(
		t,
		http.MethodPost,
		"/api/v1/projects/7/workflow-tasks/4/attachments",
		"运营甲",
		false,
		"file",
		"safe.pdf",
		"application/x-msdownload",
		[]byte("1234"),
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("bad MIME = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	request = multipartRequest(
		t,
		http.MethodPost,
		"/api/v1/projects/7/workflow-tasks/4/attachments",
		"运营甲",
		false,
		"file",
		"large.pdf",
		"application/pdf",
		[]byte("12345"),
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("large file = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestWorkflowStoreErrorsUseDetailResponse(t *testing.T) {
	store := newFakeWorkflowStore()
	store.listTemplatesErr = errors.New("database down")
	handler := NewHandler(store, newFakeProjects())
	recorder := httptest.NewRecorder()
	request := workflowRequest(
		http.MethodGet,
		"/api/v1/project-workflows/templates",
		"",
		"运营甲",
		false,
	)
	handler.ListTemplates(recorder, request)
	if recorder.Code != http.StatusInternalServerError ||
		recorder.Body.String() != `{"detail":"Internal Server Error"}` {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

type fakeWorkflowStore struct {
	Store
	mu                   sync.Mutex
	actions              []string
	templates            []TemplateOption
	workflows            []Workflow
	summaries            map[int64][]WorkflowSummary
	schedules            map[int64]ProjectSchedule
	template             *TemplateDetail
	download             *AttachmentDownload
	writeErr             error
	listTemplatesErr     error
	attachmentDeleteKeys []string
}

func newFakeWorkflowStore() *fakeWorkflowStore {
	workflow := workflowFixture()
	template := templateFixture()
	return &fakeWorkflowStore{
		templates: []TemplateOption{{Key: "launch", Kind: KindStoreLaunch, Title: "店铺启动"}},
		workflows: []Workflow{workflow},
		summaries: map[int64][]WorkflowSummary{
			7: {{ID: 3, Kind: KindStoreLaunch, Title: "店铺启动", TemplateKey: "launch", Status: StatusInProgress, TaskCount: 2}},
		},
		schedules: map[int64]ProjectSchedule{7: {}},
		template:  &template,
	}
}

func (s *fakeWorkflowStore) record(action string) {
	s.mu.Lock()
	s.actions = append(s.actions, action)
	s.mu.Unlock()
}

func (s *fakeWorkflowStore) ListWorkflowTemplates(context.Context) ([]TemplateOption, error) {
	return s.templates, s.listTemplatesErr
}

func (s *fakeWorkflowStore) ListProjectWorkflows(context.Context, int64) ([]Workflow, error) {
	s.record("ListProjectWorkflows")
	return s.workflows, nil
}

func (s *fakeWorkflowStore) ListWorkflowSummaries(_ context.Context, _ []int64) (map[int64][]WorkflowSummary, error) {
	return s.summaries, nil
}

func (s *fakeWorkflowStore) ListProjectSchedules(_ context.Context, _ []int64) (map[int64]ProjectSchedule, error) {
	return s.schedules, nil
}

func (s *fakeWorkflowStore) GetWorkflow(context.Context, int64) (*Workflow, error) {
	item := workflowFixture()
	return &item, nil
}

func (s *fakeWorkflowStore) GetTaskProject(context.Context, int64) (int64, error) {
	return 7, nil
}

func (s *fakeWorkflowStore) GetContentProject(context.Context, int64) (int64, error) {
	return 7, nil
}

func (s *fakeWorkflowStore) GetAttachmentForDownload(context.Context, int64, int64) (*AttachmentDownload, error) {
	return s.download, nil
}

func (s *fakeWorkflowStore) CreateWorkflow(context.Context, int64, WorkflowCreateRequest) (*Workflow, error) {
	s.record("CreateWorkflow")
	if s.writeErr != nil {
		return nil, s.writeErr
	}
	item := workflowFixture()
	return &item, nil
}

func (s *fakeWorkflowStore) UpdateWorkflowDefinition(context.Context, int64, WorkflowDefinitionUpdateRequest) (*Workflow, error) {
	s.record("UpdateWorkflowDefinition")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) UpdateTaskStatus(context.Context, int64, string) (*Workflow, error) {
	s.record("UpdateTaskStatus")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) CreateProjectTask(context.Context, int64, int64, TaskCreateRequest) (*Workflow, error) {
	s.record("CreateProjectTask")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) UpdateProjectTaskDefinition(context.Context, int64, TaskDefinitionUpdateRequest) (*Workflow, error) {
	s.record("UpdateProjectTaskDefinition")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) DeleteProjectTask(context.Context, int64) (WorkflowMutation, error) {
	s.record("DeleteProjectTask")
	item := workflowFixture()
	return WorkflowMutation{Workflow: &item}, s.writeErr
}

func (s *fakeWorkflowStore) ReorderProjectTasks(context.Context, int64, int64, []int64) (*Workflow, error) {
	s.record("ReorderProjectTasks")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) CreateProjectContent(context.Context, int64, int64, ContentCreateRequest) (*Workflow, error) {
	s.record("CreateProjectContent")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) UpdateProjectContent(context.Context, int64, ContentUpdateRequest) (*Workflow, error) {
	s.record("UpdateProjectContent")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) DeleteProjectContent(context.Context, int64) (*Workflow, error) {
	s.record("DeleteProjectContent")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) InsertProjectAttachment(context.Context, int64, int64, AttachmentUpload) (*Workflow, error) {
	s.record("InsertProjectAttachment")
	item := workflowFixture()
	return &item, s.writeErr
}

func (s *fakeWorkflowStore) DeleteProjectAttachment(context.Context, int64, int64) (WorkflowMutation, error) {
	s.record("DeleteProjectAttachment")
	item := workflowFixture()
	return WorkflowMutation{Workflow: &item, DeleteKeys: s.attachmentDeleteKeys}, s.writeErr
}

func (s *fakeWorkflowStore) ListWorkflowTemplateRows(context.Context) ([]TemplateListItem, error) {
	s.record("ListWorkflowTemplateRows")
	return []TemplateListItem{templateFixture().TemplateListItem}, s.writeErr
}

func (s *fakeWorkflowStore) GetWorkflowTemplate(context.Context, int64) (*TemplateDetail, error) {
	s.record("GetWorkflowTemplate")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) CreateWorkflowTemplate(context.Context, TemplateCreateRequest) (*TemplateDetail, error) {
	s.record("CreateWorkflowTemplate")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) UpdateWorkflowTemplate(context.Context, int64, TemplateUpdateRequest) (*TemplateDetail, error) {
	s.record("UpdateWorkflowTemplate")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) DeleteWorkflowTemplate(context.Context, int64) (TemplateMutation, error) {
	s.record("DeleteWorkflowTemplate")
	return TemplateMutation{Template: s.template}, s.writeErr
}

func (s *fakeWorkflowStore) CopyWorkflowTemplate(context.Context, int64, TemplateCopyRequest) (*TemplateDetail, error) {
	s.record("CopyWorkflowTemplate")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) CreateTemplateTask(context.Context, int64, TemplateTaskCreateRequest) (*TemplateDetail, error) {
	s.record("CreateTemplateTask")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) UpdateTemplateTask(context.Context, int64, TemplateTaskUpdateRequest) (*TemplateDetail, error) {
	s.record("UpdateTemplateTask")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) DeleteTemplateTask(context.Context, int64) (TemplateMutation, error) {
	s.record("DeleteTemplateTask")
	return TemplateMutation{Template: s.template}, s.writeErr
}

func (s *fakeWorkflowStore) ReorderTemplateTasks(context.Context, int64, []int64) (*TemplateDetail, error) {
	s.record("ReorderTemplateTasks")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) CreateTemplateContent(context.Context, int64, TemplateContentCreateRequest) (*TemplateDetail, error) {
	s.record("CreateTemplateContent")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) UpdateTemplateContent(context.Context, int64, TemplateContentUpdateRequest) (*TemplateDetail, error) {
	s.record("UpdateTemplateContent")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) DeleteTemplateContent(context.Context, int64) (*TemplateDetail, error) {
	s.record("DeleteTemplateContent")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) InsertTemplateAttachment(context.Context, int64, AttachmentUpload) (*TemplateDetail, error) {
	s.record("InsertTemplateAttachment")
	return s.template, s.writeErr
}

func (s *fakeWorkflowStore) DeleteTemplateAttachment(context.Context, int64) (TemplateMutation, error) {
	s.record("DeleteTemplateAttachment")
	return TemplateMutation{Template: s.template}, s.writeErr
}

type fakeProjects struct {
	projects map[int64]projects.ProjectItem
}

func newFakeProjects() *fakeProjects {
	operator := "运营甲"
	return &fakeProjects{projects: map[int64]projects.ProjectItem{
		7: {ID: 7, Name: "美国", ProjectOperator: &operator},
		8: {ID: 8, Name: "德国", ProjectOperator: stringValue("其他人")},
	}}
}

func (p *fakeProjects) GetProject(_ context.Context, projectID int64) (*projects.ProjectItem, error) {
	item, ok := p.projects[projectID]
	if !ok {
		return nil, nil
	}
	return &item, nil
}

func (p *fakeProjects) ListManage(context.Context, string, bool, bool) ([]projects.ProjectItem, error) {
	return []projects.ProjectItem{p.projects[7]}, nil
}

type fakeBlobStore struct {
	mu          sync.Mutex
	objects     map[string][]byte
	lastKey     string
	putErr      error
	openErr     error
	deleteCalls []string
}

func (b *fakeBlobStore) Put(_ context.Context, key string, data []byte, _ string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.lastKey = key
	if b.objects == nil {
		b.objects = map[string][]byte{}
	}
	b.objects[key] = append([]byte(nil), data...)
	return "https://fake.example/" + key, b.putErr
}

func (b *fakeBlobStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.openErr != nil {
		return nil, b.openErr
	}
	data, ok := b.objects[key]
	if !ok {
		return nil, ErrBlobNotFound
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (b *fakeBlobStore) Delete(_ context.Context, key string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.deleteCalls = append(b.deleteCalls, key)
	return nil
}

type fakeFileStore struct {
	key  string
	data []byte
	err  error
}

func (f *fakeFileStore) OpenDocument(_ context.Context, key string) (io.ReadCloser, error) {
	if f.err != nil {
		return nil, f.err
	}
	if key != f.key {
		return nil, ErrDocumentNotFound
	}
	return io.NopCloser(bytes.NewReader(f.data)), nil
}

func workflowFixture() Workflow {
	start := "2026-01-01"
	end := "2026-01-02"
	return Workflow{
		ID: 3, ProjectID: 7, Kind: KindStoreLaunch, Title: "店铺启动",
		TemplateKey: "launch", Status: StatusInProgress, TaskCount: 2,
		CompletedTaskCount: 0, StartDate: &start,
		ScheduleStart: &start, ScheduleEnd: &end, ScheduleDays: intValue(2),
		Tasks: []Task{
			{ID: 4, WorkflowID: 3, Title: "注册", SortOrder: 0, Status: StatusInProgress, StartDate: &start, EndDate: &start, Contents: []Content{}, Attachments: []Attachment{}},
			{ID: 5, WorkflowID: 3, Title: "审核", SortOrder: 1, Status: StatusNotStarted, StartDate: &end, EndDate: &end, Contents: []Content{}, Attachments: []Attachment{}},
		},
	}
}

func templateFixture() TemplateDetail {
	return TemplateDetail{
		TemplateListItem: TemplateListItem{
			ID: 9, Key: "template-a", Kind: KindProductDevelopment,
			Title: "模板", SortOrder: 1, TaskCount: 1,
		},
		Tasks: []TemplateTask{{
			ID: 10, TemplateID: 9, Title: "节点", SortOrder: 0,
			Contents:    []Content{{ID: 11, Body: "内容", SortOrder: 0}},
			Attachments: []Attachment{{ID: 12, Filename: "附件.pdf", ContentType: "application/pdf", FileSize: 1}},
		}},
	}
}

func workflowRequest(method, target, body, operator string, isAdmin bool) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: operator,
		IsAdmin:  isAdmin,
	}))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func multipartRequest(
	t *testing.T,
	method string,
	target string,
	operator string,
	isAdmin bool,
	field string,
	filename string,
	contentType string,
	data []byte,
) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(
		`form-data; name="%s"; filename="%s"`,
		field,
		strings.ReplaceAll(filename, `"`, `\"`),
	))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, target, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: operator,
		IsAdmin:  isAdmin,
	}))
	return request
}

func assertWorkflowResponse(t *testing.T, recorder *httptest.ResponseRecorder, status int) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d, body = %s", recorder.Code, status, recorder.Body.String())
	}
	var payload any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("response is not JSON: %v %s", err, recorder.Body.String())
		}
	}
}

func passthrough(next http.Handler) http.Handler { return next }

func stringValue(value string) *string { return &value }
func intValue(value int) *int          { return &value }
