package digital_employees

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestDigitalEmployeesRegistrarAuthAndList(t *testing.T) {
	store := &fakeDigitalEmployeeStore{
		employees: []DigitalEmployee{{
			ID:                            7,
			Name:                          "数据库守护者",
			EmployeeType:                  EmployeeTypeDatabase,
			Status:                        EmployeeStatusIdle,
			IsSilentAlertThresholdMinutes: 30,
			CreatedAt:                     "2026-11-01T01:02:03Z",
			UpdatedAt:                     "2026-11-01T01:02:03Z",
		}},
	}
	router := chi.NewRouter()
	NewRegistrar(store).RegisterRoutes(
		router,
		auth.RequireAPIKey("master-key", "proxy-secret", nil),
	)

	for name, test := range map[string]struct {
		headers map[string]string
		want    int
	}{
		"missing": {want: http.StatusUnauthorized},
		"invalid": {
			headers: map[string]string{"X-API-Key": "bad-key"},
			want:    http.StatusForbidden,
		},
		"valid": {
			headers: map[string]string{
				"X-API-Key":              "master-key",
				"X-Trusted-Proxy-Secret": "proxy-secret",
			},
			want: http.StatusOK,
		},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/digital-employees", nil)
			for key, value := range test.headers {
				request.Header.Set(key, value)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d; body = %s", response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestDigitalEmployeesRegistrarModuleAndAllRoutes(t *testing.T) {
	router := chi.NewRouter()
	registrar := NewRegistrar(&fakeDigitalEmployeeStore{})
	registrar.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	if got := registrar.ModuleName(); got != "digital_employees" {
		t.Fatalf("module name = %q", got)
	}
	routes := make(map[string]struct{})
	if err := chi.Walk(router, func(
		method, route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		routes[method+" "+route] = struct{}{}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(routes) != 11 {
		t.Fatalf("routes = %#v, want 11", routes)
	}
}

func TestDigitalEmployeeHandlersCoverStatusCodes(t *testing.T) {
	t.Run("get missing employee returns 404", func(t *testing.T) {
		handler := NewHandler(&fakeDigitalEmployeeStore{})
		request := withDigitalEmployeeURLParams(
			httptest.NewRequest(http.MethodGet, "/api/v1/digital-employees/99", nil),
			map[string]string{"employee_id": "99"},
		)
		response := httptest.NewRecorder()
		handler.GetEmployee(response, request)
		assertDigitalResponse(t, response, http.StatusNotFound, `{"detail":"Employee not found"}`)
	})

	t.Run("invalid status transition returns 400", func(t *testing.T) {
		handler := NewHandler(&fakeDigitalEmployeeStore{
			updateStatusErr: ErrInvalidStatus,
		})
		request := withDigitalEmployeeURLParams(
			httptest.NewRequest(
				http.MethodPatch,
				"/api/v1/digital-employees/7/status",
				strings.NewReader(`{"status":"running"}`),
			),
			map[string]string{"employee_id": "7"},
		)
		response := httptest.NewRecorder()
		handler.UpdateStatus(response, request)
		assertDigitalResponse(t, response, http.StatusBadRequest, `{"detail":"Only SUSPENDED or IDLE allowed"}`)
	})

	t.Run("invalid heartbeat secret returns 401", func(t *testing.T) {
		handler := NewHandler(&fakeDigitalEmployeeStore{heartbeatErr: ErrInvalidAPISecret})
		request := withDigitalEmployeeURLParams(
			httptest.NewRequest(
				http.MethodPost,
				"/api/v1/digital-employees/7/heartbeat?api_secret=wrong",
				strings.NewReader(`{"task_id":"t-1","status":"running"}`),
			),
			map[string]string{"employee_id": "7"},
		)
		response := httptest.NewRecorder()
		handler.Heartbeat(response, request)
		assertDigitalResponse(t, response, http.StatusUnauthorized, `{"detail":"Invalid api_secret"}`)
	})
}

func TestDigitalEmployeePaginationAndCursor(t *testing.T) {
	store := &fakeDigitalEmployeeStore{
		tasks: []DigitalEmployeeTask{{
			ID:              12,
			TaskID:          "task-12",
			TaskName:        "payment",
			TaskType:        "report",
			Status:          TaskStatusSucceeded,
			ProgressPercent: 100,
			MetadataJSON:    map[string]any{"project_name": "润茗"},
			CreatedAt:       "2026-11-08T00:00:00Z",
		}},
		taskTotal: 7,
		logs: []DigitalEmployeeLog{
			{ID: 8, Level: LogLevelInfo, Message: "first", CreatedAt: "2026-11-08T00:00:01Z"},
			{ID: 9, Level: LogLevelInfo, Message: "second", CreatedAt: "2026-11-08T00:00:02Z"},
		},
		logsHasMore: true,
		nextCursor:  int64Pointer(9),
	}
	handler := NewHandler(store)

	taskRequest := withDigitalEmployeeURLParams(
		httptest.NewRequest(
			http.MethodGet,
			"/api/v1/digital-employees/7/tasks?page=2&page_size=3",
			nil,
		),
		map[string]string{"employee_id": "7"},
	)
	taskResponse := httptest.NewRecorder()
	handler.ListTasks(taskResponse, taskRequest)
	if taskResponse.Code != http.StatusOK {
		t.Fatalf("list tasks status = %d; body = %s", taskResponse.Code, taskResponse.Body.String())
	}
	if store.listTasksPage != 2 || store.listTasksPageSize != 3 {
		t.Fatalf("pagination = (%d, %d), want (2, 3)", store.listTasksPage, store.listTasksPageSize)
	}
	if !strings.Contains(taskResponse.Body.String(), `"metadata_json":{"project_name":"润茗"}`) {
		t.Errorf("task response metadata = %s", taskResponse.Body.String())
	}
	if !strings.Contains(taskResponse.Body.String(), `"total":7`) {
		t.Errorf("task response total = %s", taskResponse.Body.String())
	}

	logRequest := withDigitalEmployeeURLParams(
		httptest.NewRequest(
			http.MethodGet,
			"/api/v1/digital-employees/7/tasks/11/logs?cursor=7&limit=2",
			nil,
		),
		map[string]string{"employee_id": "7", "task_id": "11"},
	)
	logResponse := httptest.NewRecorder()
	handler.ListLogs(logResponse, logRequest)
	if logResponse.Code != http.StatusOK {
		t.Fatalf("list logs status = %d; body = %s", logResponse.Code, logResponse.Body.String())
	}
	if store.listLogsCursor == nil || *store.listLogsCursor != 7 || store.listLogsLimit != 2 {
		t.Fatalf("cursor/limit = (%v, %d), want (7, 2)", store.listLogsCursor, store.listLogsLimit)
	}
	var payload DigitalEmployeeLogListResponse
	if err := json.Unmarshal(logResponse.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.HasMore || payload.Cursor == nil || *payload.Cursor != "9" || len(payload.Items) != 2 {
		t.Fatalf("log payload = %#v", payload)
	}
}

func TestDigitalEmployeeRegisterAndHeartbeatResponses(t *testing.T) {
	now := time.Date(2026, 11, 8, 9, 10, 11, 123456000, time.UTC)
	store := &fakeDigitalEmployeeStore{
		registerID:     22,
		registerSecret: "existing-or-new-secret",
		acknowledgedAt: now,
	}
	handler := NewHandler(
		store,
		WithNow(func() time.Time { return now }),
		WithSecretGenerator(func() (string, error) { return "candidate-secret", nil }),
	)

	registerRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/digital-employees/register",
		strings.NewReader(`{"name":"报表快递员","employee_type":"auto_report_upload"}`),
	)
	registerResponse := httptest.NewRecorder()
	handler.Register(registerResponse, registerRequest)
	if registerResponse.Code != http.StatusOK {
		t.Fatalf("register status = %d; body = %s", registerResponse.Code, registerResponse.Body.String())
	}
	if store.registerInput.IsSilentAlertThresholdMinutes != 30 ||
		store.registerCandidateSecret != "candidate-secret" {
		t.Fatalf("register input = %#v", store.registerInput)
	}
	assertDigitalResponse(
		t,
		registerResponse,
		http.StatusOK,
		`{"id":22,"api_secret":"existing-or-new-secret"}`,
	)

	heartbeatRequest := withDigitalEmployeeURLParams(
		httptest.NewRequest(
			http.MethodPost,
			"/api/v1/digital-employees/22/heartbeat",
			strings.NewReader(`{"task_id":"t-1","task_name":"payment","status":"running","progress_percent":12}`),
		),
		map[string]string{"employee_id": "22"},
	)
	heartbeatResponse := httptest.NewRecorder()
	handler.Heartbeat(heartbeatResponse, heartbeatRequest)
	assertDigitalResponse(
		t,
		heartbeatResponse,
		http.StatusOK,
		`{"ok":true,"acknowledged_at":"2026-11-08T09:10:11.123456Z"}`,
	)
}

func TestNewAPISecretIsURLSafeAndRandom(t *testing.T) {
	first, err := NewAPISecret()
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewAPISecret()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 43 || len(second) != 43 {
		t.Fatalf("secret lengths = %d / %d, want 43", len(first), len(second))
	}
	if first == second {
		t.Fatal("two generated secrets are identical")
	}
	if strings.ContainsAny(first, "+/=") {
		t.Fatalf("secret is not raw URL-safe base64: %q", first)
	}
}

type fakeDigitalEmployeeStore struct {
	employees               []DigitalEmployee
	employee                *DigitalEmployee
	createdEmployee         *DigitalEmployee
	updatedEmployee         *DigitalEmployee
	tasks                   []DigitalEmployeeTask
	taskTotal               int
	task                    *DigitalEmployeeTask
	logs                    []DigitalEmployeeLog
	logsHasMore             bool
	logsTotal               int
	nextCursor              *int64
	recentLogs              []DigitalEmployeeLog
	registerID              int64
	registerSecret          string
	acknowledgedAt          time.Time
	statusFilter            *string
	employeeTypeFilter      *string
	listTasksPage           int
	listTasksPageSize       int
	listLogsCursor          *int64
	listLogsLimit           int
	registerInput           RegisterInput
	registerCandidateSecret string
	createInput             DigitalEmployeeCreate
	createSecret            string
	updateStatus            string
	heartbeatInput          HeartbeatInput
	err                     error
	updateStatusErr         error
	getEmployeeErr          error
	heartbeatErr            error
}

func (s *fakeDigitalEmployeeStore) ListEmployees(
	_ context.Context,
	status, employeeType *string,
) ([]DigitalEmployee, error) {
	s.statusFilter = status
	s.employeeTypeFilter = employeeType
	return s.employees, s.err
}

func (s *fakeDigitalEmployeeStore) GetEmployee(context.Context, int64) (*DigitalEmployee, error) {
	if s.getEmployeeErr != nil {
		return nil, s.getEmployeeErr
	}
	if s.employee == nil {
		return nil, ErrEmployeeNotFound
	}
	return s.employee, s.err
}

func (s *fakeDigitalEmployeeStore) CreateEmployee(
	_ context.Context,
	input DigitalEmployeeCreate,
	apiSecret string,
) (*DigitalEmployee, error) {
	s.createInput = input
	s.createSecret = apiSecret
	return s.createdEmployee, s.err
}

func (s *fakeDigitalEmployeeStore) UpdateEmployeeStatus(
	_ context.Context,
	_ int64,
	status string,
) (*DigitalEmployee, error) {
	s.updateStatus = status
	if s.updateStatusErr != nil {
		return nil, s.updateStatusErr
	}
	return s.updatedEmployee, s.err
}

func (s *fakeDigitalEmployeeStore) DeleteEmployee(context.Context, int64) error {
	return s.err
}

func (s *fakeDigitalEmployeeStore) ListTasks(
	_ context.Context,
	_ int64,
	page, pageSize int,
) ([]DigitalEmployeeTask, int, error) {
	s.listTasksPage = page
	s.listTasksPageSize = pageSize
	return s.tasks, s.taskTotal, s.err
}

func (s *fakeDigitalEmployeeStore) GetTask(context.Context, int64, int64) (*DigitalEmployeeTask, error) {
	if s.task == nil {
		return nil, ErrTaskNotFound
	}
	return s.task, s.err
}

func (s *fakeDigitalEmployeeStore) ListLogs(
	_ context.Context,
	_, _ int64,
	cursor *int64,
	limit int,
) ([]DigitalEmployeeLog, bool, *int64, error) {
	s.listLogsCursor = cursor
	s.listLogsLimit = limit
	return s.logs, s.logsHasMore, s.nextCursor, s.err
}

func (s *fakeDigitalEmployeeStore) ListEmployeeLogs(
	context.Context,
	int64,
	int,
) ([]DigitalEmployeeLog, error) {
	return s.recentLogs, s.err
}

func (s *fakeDigitalEmployeeStore) RegisterEmployee(
	_ context.Context,
	input RegisterInput,
	candidateSecret string,
) (int64, string, error) {
	s.registerInput = input
	s.registerCandidateSecret = candidateSecret
	return s.registerID, s.registerSecret, s.err
}

func (s *fakeDigitalEmployeeStore) Heartbeat(
	_ context.Context,
	input HeartbeatInput,
	_ time.Time,
) (time.Time, error) {
	s.heartbeatInput = input
	if s.heartbeatErr != nil {
		return time.Time{}, s.heartbeatErr
	}
	return s.acknowledgedAt, s.err
}

func withDigitalEmployeeURLParams(request *http.Request, params map[string]string) *http.Request {
	routeContext := chi.NewRouteContext()
	for key, value := range params {
		routeContext.URLParams.Add(key, value)
	}
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}

func assertDigitalResponse(
	t *testing.T,
	response *httptest.ResponseRecorder,
	status int,
	body string,
) {
	t.Helper()
	if response.Code != status || response.Body.String() != body {
		t.Fatalf(
			"response = (%d, %s), want (%d, %s)",
			response.Code,
			response.Body.String(),
			status,
			body,
		)
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}
