package contract

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/workflows"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestStage1BProjectsAndWorkflowWireContracts(t *testing.T) {
	projectStore := &stage1BProjectStore{
		options: []projects.ProjectOption{{
			ID: contractInt64(7), Name: "北美", Country: "US", CountryName: contractString("美国站"),
		}},
		items: []projects.ProjectItem{{
			ID: 7, Name: "北美", ProjectOperator: contractString("运营甲"),
			Country: "US", CountryName: contractString("美国站"), IsActive: true,
		}},
	}
	workflowStore := &stage1BWorkflowStore{
		templates: []workflows.TemplateOption{{
			Key: "launch", Kind: "store_launch", Title: "店铺启动",
		}},
		workflows: []workflows.Workflow{{
			ID: 3, ProjectID: 7, Kind: "store_launch", Title: "店铺启动",
			TemplateKey: "launch", Status: "completed", TaskCount: 1,
			CompletedTaskCount: 1, Tasks: []workflows.Task{},
		}},
		summaries: map[int64][]workflows.WorkflowSummary{7: {{
			ID: 3, Kind: "store_launch", Title: "店铺启动", TemplateKey: "launch",
			Status: "completed", TaskCount: 1, CompletedTaskCount: 1,
		}}},
		schedules: map[int64]workflows.ProjectSchedule{7: {}},
	}

	router := chi.NewRouter()
	projects.NewRegistrar(projectStore, nil).RegisterRoutes(router, contractPassthrough)
	workflows.NewRegistrar(workflowStore, projectStore).RegisterRoutes(router, contractPassthrough)

	requests := []struct {
		method string
		path   string
		user   auth.UserContext
		want   string
	}{
		{
			method: http.MethodGet,
			path:   "/api/v1/projects",
			want:   `[{"id":7,"name":"北美","country":"US","country_name":"美国站"}]`,
		},
		{
			method: http.MethodGet,
			path:   "/api/v1/projects/manage",
			user:   auth.UserContext{Operator: "运营甲"},
			want:   `[{"id":7,"name":"北美","brand_name":null,"store_address":null,"project_operator":"运营甲","assistant_operator":null,"commission_basis":null,"commission_rate":null,"sort_order":0,"is_active":true,"source_file":null,"has_context":false,"project_tier":null,"country":"US","country_name":"美国站","vat_enabled":false}]`,
		},
		{
			method: http.MethodGet,
			path:   "/api/v1/project-workflows/templates",
			user:   auth.UserContext{UserID: "user", Operator: "运营甲"},
			want:   `{"templates":[{"key":"launch","kind":"store_launch","title":"店铺启动"}]}`,
		},
		{
			method: http.MethodGet,
			path:   "/api/v1/project-workflows/summary",
			user:   auth.UserContext{Operator: "运营甲"},
			want:   `{"projects":[{"project_id":7,"workflows":[{"id":3,"kind":"store_launch","title":"店铺启动","template_key":"launch","status":"completed","completed_task_count":1,"task_count":1,"start_date":null,"schedule_start":null,"schedule_end":null,"schedule_days":null}],"schedule_start":null,"schedule_end":null,"schedule_days":null}]}`,
		},
		{
			method: http.MethodGet,
			path:   "/api/v1/projects/7/workflows",
			user:   auth.UserContext{Operator: "运营甲"},
			want:   `{"project_id":7,"workflows":[{"id":3,"project_id":7,"kind":"store_launch","title":"店铺启动","template_key":"launch","status":"completed","task_count":1,"completed_task_count":1,"start_date":null,"schedule_start":null,"schedule_end":null,"schedule_days":null,"tasks":[]}]}`,
		},
	}
	for _, test := range requests {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, nil)
			request = request.WithContext(auth.WithUserContext(request.Context(), test.user))
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK || recorder.Body.String() != test.want {
				t.Fatalf("response = %d %s, want 200 %s", recorder.Code, recorder.Body.String(), test.want)
			}
		})
	}
}

func contractPassthrough(next http.Handler) http.Handler { return next }

func contractString(value string) *string { return &value }
func contractInt64(value int64) *int64    { return &value }

type stage1BProjectStore struct {
	projects.Store
	options []projects.ProjectOption
	items   []projects.ProjectItem
}

func (s *stage1BProjectStore) ListOptions(context.Context) ([]projects.ProjectOption, error) {
	return s.options, nil
}
func (s *stage1BProjectStore) ListManage(context.Context, string, bool, bool) ([]projects.ProjectItem, error) {
	return s.items, nil
}
func (s *stage1BProjectStore) GetProject(context.Context, int64) (*projects.ProjectItem, error) {
	return &s.items[0], nil
}

type stage1BWorkflowStore struct {
	workflows.Store
	templates []workflows.TemplateOption
	workflows []workflows.Workflow
	summaries map[int64][]workflows.WorkflowSummary
	schedules map[int64]workflows.ProjectSchedule
}

func (s *stage1BWorkflowStore) ListWorkflowTemplates(context.Context) ([]workflows.TemplateOption, error) {
	return s.templates, nil
}
func (s *stage1BWorkflowStore) ListProjectWorkflows(context.Context, int64) ([]workflows.Workflow, error) {
	return s.workflows, nil
}
func (s *stage1BWorkflowStore) ListWorkflowSummaries(context.Context, []int64) (map[int64][]workflows.WorkflowSummary, error) {
	return s.summaries, nil
}
func (s *stage1BWorkflowStore) ListProjectSchedules(context.Context, []int64) (map[int64]workflows.ProjectSchedule, error) {
	return s.schedules, nil
}
