package alerts

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMetricsReturnsStaticFastAPIOptions(t *testing.T) {
	store := &fakeStore{}
	rec := httptest.NewRecorder()

	NewHandler(store).Metrics(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/v1/alerts/metrics", nil),
	)

	want := `{"metrics":[{"value":"sales_amount","label":"销售额","description":"每日销售总额"},{"value":"order_qty","label":"订单量","description":"每日订单总数"},{"value":"ad_spend","label":"广告花费","description":"每日广告总支出"},{"value":"acos","label":"ACOS","description":"广告销售成本比"},{"value":"return_rate","label":"退货率","description":"退货占总订单比例"},{"value":"inventory_risk","label":"库存风险","description":"库存缺货风险等级"},{"value":"reconciliation_mismatch","label":"报表核对异常","description":"PDF与数据库数据匹配率低于阈值"}]}`
	assertResponse(t, rec, http.StatusOK, want)
	if store.calls != 0 {
		t.Errorf("store calls = %d, want metrics to be static", store.calls)
	}
}

func TestRulesReturnsEmptyArrayAndAppliesFilters(t *testing.T) {
	isActive := false
	store := &fakeStore{project: &Project{ProjectOperator: stringPointer("operator-a")}}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/alerts/rules?project_id=12&metric=acos&is_active=false",
		nil,
	)
	req.Header.Set("X-Operator", "operator-a")
	req.Header.Set("X-Is-Admin", "false")
	rec := httptest.NewRecorder()

	NewHandler(store).Rules(rec, req)

	if store.projectID != "12" {
		t.Errorf("GetProject() id = %q, want 12", store.projectID)
	}
	if store.ruleFilters.ProjectID == nil || *store.ruleFilters.ProjectID != "12" ||
		store.ruleFilters.Metric == nil || *store.ruleFilters.Metric != "acos" ||
		store.ruleFilters.IsActive == nil || *store.ruleFilters.IsActive != isActive {
		t.Errorf("ListRules() filters = %#v, want project/metric/is_active", store.ruleFilters)
	}
	assertResponse(t, rec, http.StatusOK, `[]`)
}

func TestRulesAllowsAdminAndSerializesTimestampAndNullables(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	store := &fakeStore{
		project: &Project{ProjectOperator: stringPointer("someone-else")},
		ruleRows: []Rule{{
			ID:                   2,
			Name:                 "acos high",
			ProjectID:            2,
			Country:              "US",
			Metric:               "acos",
			TriggerType:          "threshold",
			Condition:            "above",
			Threshold:            0.25,
			WindowDays:           7,
			Severity:             "warning",
			NotificationChannels: "in_app",
			IsActive:             true,
			CreatedBy:            "operator-a",
			CreatedAt:            createdAt,
			UpdatedAt:            createdAt,
		}},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules?project_id=2", nil)
	req.Header.Set("X-Is-Admin", "yes")
	rec := httptest.NewRecorder()

	NewHandler(store).Rules(rec, req)

	want := `[{"name":"acos high","project_id":2,"country":"US","metric":"acos","trigger_type":"threshold","condition":"above","threshold":0.25,"window_days":7,"severity":"warning","notification_channels":"in_app","id":2,"is_active":true,"created_by":"operator-a","created_at":"2026-10-01T02:03:04.123000Z","updated_at":"2026-10-01T02:03:04.123000Z"}]`
	assertResponse(t, rec, http.StatusOK, want)
}

func TestRulesChecksProjectVisibilityLikeEnsureProjectAccess(t *testing.T) {
	tests := []struct {
		name       string
		project    *Project
		operator   string
		userName   string
		isAdmin    string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "missing project",
			project:    nil,
			operator:   "operator-a",
			wantStatus: http.StatusNotFound,
			wantBody:   `{"detail":"项目不存在"}`,
		},
		{
			name:       "denied",
			project:    &Project{ProjectOperator: stringPointer("operator-b"), AssistantOperator: stringPointer("operator-c")},
			operator:   "operator-a",
			wantStatus: http.StatusForbidden,
			wantBody:   `{"detail":"无权限访问该项目"}`,
		},
		{
			name:       "missing operator",
			project:    &Project{ProjectOperator: stringPointer("operator-a")},
			wantStatus: http.StatusForbidden,
			wantBody:   `{"detail":"无权限访问该项目"}`,
		},
		{
			name:       "assistant operator",
			project:    &Project{AssistantOperator: stringPointer("operator-a, operator-b")},
			operator:   "operator-b",
			wantStatus: http.StatusOK,
			wantBody:   `[]`,
		},
		{
			name:       "X-User-Name fallback",
			project:    &Project{ProjectOperator: stringPointer("operator-a、operator-b")},
			userName:   "operator-b",
			wantStatus: http.StatusOK,
			wantBody:   `[]`,
		},
		{
			name:       "admin bypass",
			project:    &Project{ProjectOperator: stringPointer("operator-b")},
			operator:   "operator-a",
			isAdmin:    "true",
			wantStatus: http.StatusOK,
			wantBody:   `[]`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{project: tt.project}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules?project_id=9", nil)
			if tt.operator != "" {
				req.Header.Set("X-Operator", tt.operator)
			}
			if tt.userName != "" {
				req.Header.Set("X-User-Name", tt.userName)
			}
			if tt.isAdmin != "" {
				req.Header.Set("X-Is-Admin", tt.isAdmin)
			}
			rec := httptest.NewRecorder()

			NewHandler(store).Rules(rec, req)

			assertResponse(t, rec, tt.wantStatus, tt.wantBody)
		})
	}
}

func TestRulesRejectsInvalidBooleanHeaderBeforeProjectLookup(t *testing.T) {
	store := &fakeStore{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules?project_id=1", nil)
	req.Header.Set("X-Is-Admin", "maybe")
	rec := httptest.NewRecorder()

	NewHandler(store).Rules(rec, req)

	assertResponse(
		t,
		rec,
		http.StatusUnprocessableEntity,
		`{"detail":[{"type":"bool_parsing","loc":["header","X-Is-Admin"],"msg":"Input should be a valid boolean, unable to interpret input","input":"maybe"}]}`,
	)
	if store.calls != 0 {
		t.Errorf("store calls = %d, want 0", store.calls)
	}
}

func TestRulesAggregatesValidationErrorsInPydanticOrder(t *testing.T) {
	store := &fakeStore{}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/alerts/rules?project_id=bad&is_active=maybe",
		nil,
	)
	req.Header.Set("X-Is-Admin", "invalid")
	rec := httptest.NewRecorder()

	NewHandler(store).Rules(rec, req)

	assertResponse(
		t,
		rec,
		http.StatusUnprocessableEntity,
		`{"detail":[{"type":"int_parsing","loc":["query","project_id"],"msg":"Input should be a valid integer, unable to parse string as an integer","input":"bad"},{"type":"bool_parsing","loc":["query","is_active"],"msg":"Input should be a valid boolean, unable to interpret input","input":"maybe"},{"type":"bool_parsing","loc":["header","X-Is-Admin"],"msg":"Input should be a valid boolean, unable to interpret input","input":"invalid"}]}`,
	)
	if store.calls != 0 {
		t.Errorf("store calls = %d, want 0", store.calls)
	}
}

func TestRulesUsesFirstRepeatedAdminHeaderLikeFastAPI(t *testing.T) {
	store := &fakeStore{
		project: &Project{ProjectOperator: stringPointer("operator-b")},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules?project_id=1", nil)
	req.Header.Add("X-Operator", "operator-a")
	req.Header.Add("X-Is-Admin", "True")
	req.Header.Add("X-Is-Admin", "false")
	rec := httptest.NewRecorder()

	NewHandler(store).Rules(rec, req)

	assertResponse(t, rec, http.StatusOK, `[]`)
}

func TestEventsUsesDefaultsAndReturnsFastAPIShape(t *testing.T) {
	triggeredAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	acknowledgedAt := triggeredAt.Add(time.Minute)
	store := &fakeStore{
		project: &Project{ProjectOperator: stringPointer("operator-a")},
		eventRows: []Event{{
			ID:              1,
			RuleID:          2,
			ProjectID:       3,
			Metric:          "acos",
			CurrentValue:    1.2,
			BaselineValue:   1,
			DeviationPct:    20,
			Severity:        "warning",
			Message:         "message",
			Status:          "acknowledged",
			TriggeredAt:     triggeredAt,
			AcknowledgedAt:  &acknowledgedAt,
			AcknowledgedBy:  stringPointer("operator-a"),
			MatchRate:       floatPointer(0.9),
			MismatchedItems: intPointer(2),
			TotalDiff:       floatPointer(3.5),
			ReportMonth:     stringPointer("2026-10"),
			ReportID:        intPointer(4),
		}},
		eventTotal: 1,
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/events?project_id=3", nil)
	req.Header.Set("X-Operator", "operator-a")
	rec := httptest.NewRecorder()

	NewHandler(store).Events(rec, req)

	if store.eventFilters.Page != 1 || store.eventFilters.PageSize != 20 ||
		store.eventFilters.Severity != nil || store.eventFilters.Status != nil {
		t.Errorf("ListEvents() filters = %#v, want defaults and no severity/status", store.eventFilters)
	}
	want := `{"items":[{"id":1,"rule_id":2,"project_id":3,"metric":"acos","current_value":1.2,"baseline_value":1,"deviation_pct":20,"severity":"warning","message":"message","status":"acknowledged","triggered_at":"2026-10-01T02:03:04.123000Z","acknowledged_at":"2026-10-01T02:04:04.123000Z","acknowledged_by":"operator-a","match_rate":0.9,"mismatched_items":2,"total_diff":3.5,"report_month":"2026-10","report_id":4}],"total":1,"page":1,"page_size":20}`
	assertResponse(t, rec, http.StatusOK, want)
}

func TestEventsAppliesFiltersAndPreservesEmptyArray(t *testing.T) {
	store := &fakeStore{
		project: &Project{ProjectOperator: stringPointer("operator-a")},
	}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/alerts/events?project_id=3&severity=critical&status=active&page=2&page_size=5",
		nil,
	)
	req.Header.Set("X-Operator", "operator-a")
	rec := httptest.NewRecorder()

	NewHandler(store).Events(rec, req)

	if store.eventFilters.Severity == nil || *store.eventFilters.Severity != "critical" ||
		store.eventFilters.Status == nil || *store.eventFilters.Status != "active" ||
		store.eventFilters.Page != 2 || store.eventFilters.PageSize != 5 {
		t.Errorf("ListEvents() filters = %#v, want severity/status/page/size", store.eventFilters)
	}
	assertResponse(t, rec, http.StatusOK, `{"items":[],"total":0,"page":2,"page_size":5}`)
}

func TestEventsRejectsPaginationBounds(t *testing.T) {
	tests := []struct {
		query string
		body  string
	}{
		{
			query: "page=0",
			body:  `{"detail":[{"type":"greater_than_equal","loc":["query","page"],"msg":"Input should be greater than or equal to 1","input":"0","ctx":{"ge":1}}]}`,
		},
		{
			query: "page_size=101",
			body:  `{"detail":[{"type":"less_than_equal","loc":["query","page_size"],"msg":"Input should be less than or equal to 100","input":"101","ctx":{"le":100}}]}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			store := &fakeStore{}
			rec := httptest.NewRecorder()
			NewHandler(store).Events(
				rec,
				httptest.NewRequest(http.MethodGet, "/api/v1/alerts/events?"+tt.query, nil),
			)
			assertResponse(t, rec, http.StatusUnprocessableEntity, tt.body)
			if store.calls != 0 {
				t.Errorf("store calls = %d, want 0", store.calls)
			}
		})
	}
}

func TestEventsAggregatesPageAndHeaderValidationErrors(t *testing.T) {
	store := &fakeStore{}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/alerts/events?page=0&page_size=101",
		nil,
	)
	req.Header.Set("X-Is-Admin", "invalid")
	rec := httptest.NewRecorder()

	NewHandler(store).Events(rec, req)

	assertResponse(
		t,
		rec,
		http.StatusUnprocessableEntity,
		`{"detail":[{"type":"greater_than_equal","loc":["query","page"],"msg":"Input should be greater than or equal to 1","input":"0","ctx":{"ge":1}},{"type":"less_than_equal","loc":["query","page_size"],"msg":"Input should be less than or equal to 100","input":"101","ctx":{"le":100}},{"type":"bool_parsing","loc":["header","X-Is-Admin"],"msg":"Input should be a valid boolean, unable to interpret input","input":"invalid"}]}`,
	)
	if store.calls != 0 {
		t.Errorf("store calls = %d, want 0", store.calls)
	}
}

func TestEventsChecksProjectAccess(t *testing.T) {
	store := &fakeStore{
		project: &Project{ProjectOperator: stringPointer("operator-b")},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/events?project_id=3", nil)
	req.Header.Set("X-Operator", "operator-a")
	rec := httptest.NewRecorder()

	NewHandler(store).Events(rec, req)

	assertResponse(t, rec, http.StatusForbidden, `{"detail":"无权限访问该项目"}`)
	if store.eventListCalls != 0 {
		t.Errorf("ListEvents() calls = %d, want 0", store.eventListCalls)
	}
}

func TestStatsReturnsEmptyCountsAndProjectFilter(t *testing.T) {
	store := &fakeStore{
		project: &Project{ProjectOperator: stringPointer("operator-a")},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/stats?project_id=8", nil)
	req.Header.Set("X-Operator", "operator-a")
	rec := httptest.NewRecorder()

	NewHandler(store).Stats(rec, req)

	if store.statsProjectID == nil || *store.statsProjectID != "8" {
		t.Errorf("Stats() project = %#v, want 8", store.statsProjectID)
	}
	if store.statsToday == "" {
		t.Error("Stats() today is empty, want current local date")
	}
	assertResponse(
		t,
		rec,
		http.StatusOK,
		`{"total_active":0,"critical_count":0,"warning_count":0,"info_count":0,"acknowledged_today":0,"resolved_today":0}`,
	)
}

func TestAlertStoreErrorsReturn500(t *testing.T) {
	store := &fakeStore{project: &Project{ProjectOperator: stringPointer("operator-a")}, err: errors.New("database down")}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules?project_id=1", nil)
	req.Header.Set("X-Operator", "operator-a")
	rec := httptest.NewRecorder()
	NewHandler(store).Rules(rec, req)
	assertInternalError(t, rec)

	store = &fakeStore{err: errors.New("database down")}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/alerts/events", nil)
	rec = httptest.NewRecorder()
	NewHandler(store).Events(rec, req)
	assertInternalError(t, rec)

	store = &fakeStore{err: errors.New("database down")}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/alerts/stats", nil)
	req.Header.Set("X-Is-Admin", "true")
	rec = httptest.NewRecorder()
	NewHandler(store).Stats(rec, req)
	assertInternalError(t, rec)

	store = &fakeStore{err: errors.New("database down")}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules?project_id=1", nil)
	rec = httptest.NewRecorder()
	NewHandler(store).Rules(rec, req)
	assertInternalError(t, rec)
}

func TestStatsWithoutProjectRequiresAdmin(t *testing.T) {
	store := &fakeStore{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/stats", nil)
	req.Header.Set("X-Operator", "operator-a")
	rec := httptest.NewRecorder()

	NewHandler(store).Stats(rec, req)

	assertResponse(t, rec, http.StatusForbidden, `{"detail":"需要管理员权限"}`)
	if store.statsProjectID != nil {
		t.Error("global Stats() ran for a non-admin")
	}

	store = &fakeStore{}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/alerts/stats", nil)
	req.Header.Set("X-Is-Admin", "true")
	rec = httptest.NewRecorder()
	NewHandler(store).Stats(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin global stats status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

type fakeStore struct {
	project        *Project
	ruleRows       []Rule
	eventRows      []Event
	eventTotal     int
	stats          Stats
	err            error
	calls          int
	projectID      string
	ruleFilters    RuleFilters
	eventFilters   EventFilters
	eventListCalls int
	statsProjectID *string
	statsToday     string
}

func (s *fakeStore) GetProject(_ context.Context, projectID string) (*Project, error) {
	s.calls++
	s.projectID = projectID
	return s.project, s.err
}

func (s *fakeStore) ListRules(_ context.Context, filters RuleFilters) ([]Rule, error) {
	s.calls++
	s.ruleFilters = filters
	return s.ruleRows, s.err
}

func (s *fakeStore) ListEvents(_ context.Context, filters EventFilters) ([]Event, int, error) {
	s.calls++
	s.eventListCalls++
	s.eventFilters = filters
	return s.eventRows, s.eventTotal, s.err
}

func (s *fakeStore) Stats(_ context.Context, projectID *string, today string) (Stats, error) {
	s.calls++
	s.statsProjectID = projectID
	s.statsToday = today
	return s.stats, s.err
}

func assertResponse(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, status, rec.Body.String())
	}
	if got := rec.Body.String(); got != body {
		t.Errorf("body = %s, want %s", got, body)
	}
}

func TestStatsChecksProjectAccessBeforeAggregating(t *testing.T) {
	tests := []struct {
		name       string
		operator   string
		isAdmin    string
		project    *Project
		wantStatus int
		wantBody   string
	}{
		{
			name:       "owner",
			operator:   "operator-a",
			project:    &Project{ProjectOperator: stringPointer("operator-a")},
			wantStatus: http.StatusOK,
		},
		{
			name:       "assistant owner",
			operator:   "operator-b",
			project:    &Project{AssistantOperator: stringPointer("operator-b")},
			wantStatus: http.StatusOK,
		},
		{
			name:       "admin",
			isAdmin:    "true",
			project:    &Project{ProjectOperator: stringPointer("someone-else")},
			wantStatus: http.StatusOK,
		},
		{
			name:       "unauthorized",
			operator:   "operator-a",
			project:    &Project{ProjectOperator: stringPointer("operator-b")},
			wantStatus: http.StatusForbidden,
			wantBody:   `{"detail":"无权限访问该项目"}`,
		},
		{
			name:       "missing",
			operator:   "operator-a",
			project:    nil,
			wantStatus: http.StatusNotFound,
			wantBody:   `{"detail":"项目不存在"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{project: tt.project}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/stats?project_id=8", nil)
			if tt.operator != "" {
				req.Header.Set("X-Operator", tt.operator)
			}
			if tt.isAdmin != "" {
				req.Header.Set("X-Is-Admin", tt.isAdmin)
			}
			rec := httptest.NewRecorder()

			NewHandler(store).Stats(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantBody != "" && rec.Body.String() != tt.wantBody {
				t.Errorf("body = %s, want %s", rec.Body.String(), tt.wantBody)
			}
			if tt.wantStatus != http.StatusOK && store.statsProjectID != nil {
				t.Error("Stats() ran despite denied project access")
			}
		})
	}
}

func assertInternalError(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body = %s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Header().Get("Content-Type"), "text/plain; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	if got, want := rec.Body.String(), "Internal Server Error"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func stringPointer(value string) *string {
	return &value
}

func floatPointer(value float64) *float64 {
	return &value
}

func intPointer(value int) *int {
	return &value
}
