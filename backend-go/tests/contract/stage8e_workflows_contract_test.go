package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/workflows"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage8EStore struct {
	workflows.Store
	workflow *workflows.Workflow
}

func (store *stage8EStore) ListWorkflowTemplates(context.Context) ([]workflows.TemplateOption, error) {
	return []workflows.TemplateOption{{Key: "launch", Kind: workflows.KindStoreLaunch, Title: "店铺启动"}}, nil
}

func (store *stage8EStore) ListProjectWorkflows(context.Context, int64) ([]workflows.Workflow, error) {
	if store.workflow == nil {
		item := stage8EWorkflow()
		store.workflow = &item
	}
	return []workflows.Workflow{*store.workflow}, nil
}

func (store *stage8EStore) GetTaskProject(_ context.Context, taskID int64) (int64, error) {
	if taskID == 999 {
		return 0, nil
	}
	return 7, nil
}

func (store *stage8EStore) CreateWorkflow(context.Context, int64, workflows.WorkflowCreateRequest) (*workflows.Workflow, error) {
	item := stage8EWorkflow()
	return &item, nil
}

func (store *stage8EStore) UpdateTaskStatus(context.Context, int64, string) (*workflows.Workflow, error) {
	item := stage8EWorkflow()
	return &item, nil
}

type stage8EProjects struct {
	items map[int64]projects.ProjectItem
}

func (reader *stage8EProjects) GetProject(_ context.Context, projectID int64) (*projects.ProjectItem, error) {
	item, ok := reader.items[projectID]
	if !ok {
		return nil, nil
	}
	return &item, nil
}

func (reader *stage8EProjects) ListManage(context.Context, string, bool, bool) ([]projects.ProjectItem, error) {
	return []projects.ProjectItem{reader.items[7]}, nil
}

func TestStage8EWorkflowsRouteInventory(t *testing.T) {
	router := chi.NewRouter()
	workflows.NewRegistrar(
		&stage8EStore{},
		stage8EProjectReader(),
	).RegisterRoutes(router, stage8EPassthrough)

	want := []string{
		"DELETE /api/v1/project-workflows/admin/template-task-attachments/{attachment_id}",
		"DELETE /api/v1/project-workflows/admin/template-task-contents/{content_id}",
		"PATCH /api/v1/project-workflows/admin/template-task-contents/{content_id}",
		"DELETE /api/v1/project-workflows/admin/template-tasks/{task_id}",
		"PATCH /api/v1/project-workflows/admin/template-tasks/{task_id}",
		"POST /api/v1/project-workflows/admin/template-tasks/{task_id}/attachments",
		"POST /api/v1/project-workflows/admin/template-tasks/{task_id}/contents",
		"GET /api/v1/project-workflows/admin/templates",
		"POST /api/v1/project-workflows/admin/templates",
		"DELETE /api/v1/project-workflows/admin/templates/{template_id}",
		"GET /api/v1/project-workflows/admin/templates/{template_id}",
		"PATCH /api/v1/project-workflows/admin/templates/{template_id}",
		"POST /api/v1/project-workflows/admin/templates/{template_id}/copy",
		"POST /api/v1/project-workflows/admin/templates/{template_id}/tasks",
		"PUT /api/v1/project-workflows/admin/templates/{template_id}/tasks/order",
		"DELETE /api/v1/project-workflow-task-contents/{content_id}",
		"PATCH /api/v1/project-workflow-task-contents/{content_id}",
		"DELETE /api/v1/project-workflow-tasks/{task_id}",
		"PATCH /api/v1/project-workflow-tasks/{task_id}",
		"PATCH /api/v1/project-workflow-tasks/{task_id}/definition",
		"GET /api/v1/project-workflows/summary",
		"GET /api/v1/project-workflows/templates",
		"PATCH /api/v1/project-workflows/{workflow_id}",
		"DELETE /api/v1/projects/{project_id}/workflow-task-attachments/{attachment_id}",
		"GET /api/v1/projects/{project_id}/workflow-task-attachments/{attachment_id}/download",
		"POST /api/v1/projects/{project_id}/workflow-tasks/{task_id}/attachments",
		"POST /api/v1/projects/{project_id}/workflow-tasks/{task_id}/contents",
		"GET /api/v1/projects/{project_id}/workflows/documents/{document_key}",
		"GET /api/v1/projects/{project_id}/workflows",
		"POST /api/v1/projects/{project_id}/workflows",
		"POST /api/v1/projects/{project_id}/workflows/{workflow_id}/tasks",
		"PUT /api/v1/projects/{project_id}/workflows/{workflow_id}/tasks/order",
	}

	var got []string
	if err := chi.Walk(router, func(
		method string,
		route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		got = append(got, method+" "+route)
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("route count = %d, want %d\ngot:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("route[%d] = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestStage8EWorkflowsAuthProjectScopeAndValidation(t *testing.T) {
	store := &stage8EStore{}
	router := chi.NewRouter()
	workflows.NewRegistrar(store, stage8EProjectReader()).RegisterRoutes(router, stage8EPassthrough)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/project-workflows/templates", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", recorder.Code)
	}

	request = stage8ERequest(http.MethodGet, "/api/v1/project-workflows/templates", "op", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("templates status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var templates workflows.TemplatesResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &templates); err != nil {
		t.Fatalf("decode templates: %v", err)
	}
	if len(templates.Templates) != 1 || templates.Templates[0].Key != "launch" {
		t.Fatalf("templates = %#v", templates)
	}

	request = stage8ERequest(
		http.MethodGet,
		"/api/v1/project-workflows/admin/templates",
		"op",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-admin admin templates status = %d, want 403", recorder.Code)
	}

	request = stage8ERequest(
		http.MethodGet,
		"/api/v1/projects/8/workflows",
		"op",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("invisible project status = %d, want 403", recorder.Code)
	}

	request = stage8EJSONRequest(
		http.MethodPatch,
		"/api/v1/project-workflow-tasks/4",
		`{"status":"done"}`,
		"op",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid status = %d, want 422", recorder.Code)
	}

	request = stage8EJSONRequest(
		http.MethodPatch,
		"/api/v1/project-workflow-tasks/999",
		`{"status":"completed"}`,
		"op",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing task status = %d, want 404", recorder.Code)
	}
}

func TestStage8EWorkflowsCreateAndUnsafeAttachmentFailClosed(t *testing.T) {
	store := &stage8EStore{}
	router := chi.NewRouter()
	workflows.NewRegistrar(store, stage8EProjectReader()).RegisterRoutes(router, stage8EPassthrough)

	request := stage8EJSONRequest(
		http.MethodPost,
		"/api/v1/projects/7/workflows",
		`{"kind":"store_launch","template_key":"launch"}`,
		"op",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("create workflow status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/projects/7/workflow-tasks/4/attachments",
		bytes.NewReader(nil),
	)
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "op",
	}))
	request.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing blob store status = %d, want 503", recorder.Code)
	}
}

func stage8EProjectReader() *stage8EProjects {
	operator := "op"
	other := "other"
	return &stage8EProjects{items: map[int64]projects.ProjectItem{
		7: {ID: 7, Name: "美国", ProjectOperator: &operator},
		8: {ID: 8, Name: "德国", ProjectOperator: &other},
	}}
}

func stage8EWorkflow() workflows.Workflow {
	start := "2026-11-08"
	end := "2026-11-09"
	return workflows.Workflow{
		ID: 3, ProjectID: 7, Kind: workflows.KindStoreLaunch, Title: "店铺启动",
		TemplateKey: "launch", Status: workflows.StatusInProgress, TaskCount: 1,
		StartDate: &start, ScheduleStart: &start, ScheduleEnd: &end,
		ScheduleDays: stage8EInt(2),
		Tasks: []workflows.Task{{
			ID: 4, WorkflowID: 3, Title: "注册", SortOrder: 0,
			Status: workflows.StatusInProgress, StartDate: &start, EndDate: &end,
			Contents: []workflows.Content{}, Attachments: []workflows.Attachment{},
		}},
	}
}

func stage8ERequest(method, target, operator string, isAdmin bool) *http.Request {
	request := httptest.NewRequest(method, target, nil)
	return request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: operator,
		IsAdmin:  isAdmin,
	}))
}

func stage8EJSONRequest(method, target, body, operator string, isAdmin bool) *http.Request {
	request := stage8ERequest(method, target, operator, isAdmin)
	request.Body = io.NopCloser(bytes.NewBufferString(body))
	request.ContentLength = int64(len(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func stage8EPassthrough(next http.Handler) http.Handler { return next }

func stage8EInt(value int) *int { return &value }
