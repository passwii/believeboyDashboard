package projects

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestRegistrarProjectRoutesUseSnakeCaseAndContextIdentity(t *testing.T) {
	store := &handlerStore{
		options: []ProjectOption{{ID: int64Pointer(7), Name: "北美", Country: "US", CountryName: stringPointer("美国站")}},
		manage:  []ProjectItem{{ID: 7, Name: "北美", ProjectOperator: stringPointer("运营甲"), Country: "US"}},
	}
	router := chi.NewRouter()
	NewRegistrar(store, &handlerAudit{}).RegisterRoutes(router, passthrough)

	list := httptest.NewRecorder()
	router.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil))
	if list.Code != http.StatusOK || list.Body.String() != `[{"id":7,"name":"北美","country":"US","country_name":"美国站"}]` {
		t.Fatalf("GET /projects = %d %s", list.Code, list.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/manage?show_inactive=true", nil)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "运营甲",
	}))
	managed := httptest.NewRecorder()
	router.ServeHTTP(managed, request)
	if managed.Code != http.StatusOK {
		t.Fatalf("GET /projects/manage = %d %s", managed.Code, managed.Body.String())
	}
	if store.listOperator != "运营甲" || store.listAdmin || !store.listInactive {
		t.Errorf("ListManage args = (%q, %v, %v), want (运营甲, false, true)", store.listOperator, store.listAdmin, store.listInactive)
	}
	if !strings.Contains(managed.Body.String(), `"project_operator":"运营甲"`) {
		t.Errorf("manage body = %s, want snake_case project_operator", managed.Body.String())
	}
}

func TestCreateProjectAuditsSuccessfulMutation(t *testing.T) {
	created := ProjectItem{ID: 9, Name: "新品", Country: "DE"}
	store := &handlerStore{created: created}
	auditor := &handlerAudit{}
	handler := NewHandler(store, auditor)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects", strings.NewReader(`{"name":"新品","country":"DE"}`))
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "运营甲",
		IsAdmin:  true,
	}))
	recorder := httptest.NewRecorder()

	handler.CreateProject(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(auditor.entries) != 1 || auditor.entries[0].Action != "projects.create" ||
		auditor.entries[0].TargetType != "project" || auditor.entries[0].Operator == nil ||
		*auditor.entries[0].Operator != "运营甲" {
		t.Fatalf("audit entries = %#v, want projects.create for 运营甲", auditor.entries)
	}
	if !strings.Contains(recorder.Body.String(), `"country":"DE"`) {
		t.Errorf("body = %s, want country DE", recorder.Body.String())
	}
}

func TestPatchProjectContextPassesMergeObjectsAndAudits(t *testing.T) {
	store := &handlerStore{context: ProjectContext{
		ProjectID: 7, ProjectName: "北美",
		ProjectContext: map[string]any{"brand": "A"},
		SKUContext:     map[string]any{"size": "L"},
	}}
	auditor := &handlerAudit{}
	handler := NewHandler(store, auditor)
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/projects/7/context", strings.NewReader(
		`{"project_context":{"market":"US"},"sku_context":{"color":"blue"}}`,
	))
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "运营甲",
	}))
	request = withChiParam(request, "project_id", "7")
	recorder := httptest.NewRecorder()

	handler.PatchProjectContext(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.projectPatch["market"] != "US" || store.skuPatch["color"] != "blue" {
		t.Fatalf("context patch = %#v / %#v", store.projectPatch, store.skuPatch)
	}
	if len(auditor.entries) != 1 || auditor.entries[0].Action != "projects.context.update" {
		t.Errorf("audit entries = %#v, want projects.context.update", auditor.entries)
	}
}

func TestProjectShopConflictMapsTo409(t *testing.T) {
	store := &handlerStore{shopErr: NewAPIError(http.StatusConflict, "shop_id/shop_name is already mapped to another project")}
	handler := NewHandler(store, &handlerAudit{})
	request := httptest.NewRequest(http.MethodPut, "/api/v1/projects/7/shops/us", strings.NewReader(`{"shop_id":"other"}`))
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{IsAdmin: true}))
	request = withChiParams(request, map[string]string{"project_id": "7", "country": "us"})
	recorder := httptest.NewRecorder()

	handler.UpsertProjectShop(recorder, request)

	assertDetail(t, recorder, http.StatusConflict, "shop_id/shop_name is already mapped to another project")
}

func TestProjectHandlerConvertsStoreFailuresToDetail(t *testing.T) {
	handler := NewHandler(&handlerStore{listErr: errors.New("db down")}, &handlerAudit{})
	recorder := httptest.NewRecorder()
	handler.ListProjects(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil))
	assertDetail(t, recorder, http.StatusInternalServerError, "Internal Server Error")
}

func TestProjectMoveRouteIsDynamicAndRejectsUnknownDirection(t *testing.T) {
	store := &handlerStore{}
	router := chi.NewRouter()
	NewRegistrar(store, &handlerAudit{}).RegisterRoutes(router, passthrough)

	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/7/move-up", nil)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{IsAdmin: true}))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("move-up status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.moveDirection != "up" {
		t.Fatalf("move direction = %q, want up", store.moveDirection)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/projects/7/move-sideways", nil)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{IsAdmin: true}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	assertDetail(t, recorder, http.StatusBadRequest, "direction must be 'up' or 'down'")
}

func TestProjectContextParseUsesInjectedParserAndChecksProjectAccess(t *testing.T) {
	store := &handlerStore{}
	parser := &handlerContextParser{result: map[string]any{"季节性": "旺季 11-12 月"}}
	router := chi.NewRouter()
	NewRegistrar(store, &handlerAudit{}, WithContextParser(parser)).RegisterRoutes(router, passthrough)

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/projects/7/context/parse",
		strings.NewReader(`{"description":"11-12 月是旺季"}`),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{IsAdmin: true}))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("parse status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"季节性":"旺季 11-12 月"`) {
		t.Fatalf("parse body = %s", recorder.Body.String())
	}
	if parser.description != "11-12 月是旺季" {
		t.Fatalf("parser description = %q", parser.description)
	}

	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/projects/7/context/parse",
		strings.NewReader(`{"description":"11-12 月是旺季"}`),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{Operator: "bob"}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	assertDetail(t, recorder, http.StatusForbidden, "无权限访问该项目")

	noParserRouter := chi.NewRouter()
	NewRegistrar(store, &handlerAudit{}).RegisterRoutes(noParserRouter, passthrough)
	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/projects/7/context/parse",
		strings.NewReader(`{"description":"项目背景"}`),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{IsAdmin: true}))
	recorder = httptest.NewRecorder()
	noParserRouter.ServeHTTP(recorder, request)
	assertDetail(t, recorder, http.StatusServiceUnavailable, "AI 项目背景解析未配置")

	emptyResultRouter := chi.NewRouter()
	NewRegistrar(
		store,
		&handlerAudit{},
		WithContextParser(&handlerContextParser{}),
	).RegisterRoutes(emptyResultRouter, passthrough)
	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/projects/7/context/parse",
		strings.NewReader(`{"description":"项目背景"}`),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{IsAdmin: true}))
	recorder = httptest.NewRecorder()
	emptyResultRouter.ServeHTTP(recorder, request)
	assertDetail(t, recorder, http.StatusServiceUnavailable, "AI 项目背景解析未返回有效结果")
}

func TestProjectItemJSONUsesSnakeCaseAndNullOptionals(t *testing.T) {
	payload, err := json.Marshal(ProjectItem{ID: 1, Name: "A", Country: "US"})
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != `{"id":1,"name":"A","brand_name":null,"store_address":null,"project_operator":null,"assistant_operator":null,"commission_basis":null,"commission_rate":null,"sort_order":0,"is_active":false,"source_file":null,"has_context":false,"project_tier":null,"country":"US","country_name":null,"vat_enabled":false}` {
		t.Fatalf("ProjectItem JSON = %s", payload)
	}
}

func passthrough(next http.Handler) http.Handler { return next }

func withChiParam(request *http.Request, key, value string) *http.Request {
	return withChiParams(request, map[string]string{key: value})
}

func withChiParams(request *http.Request, values map[string]string) *http.Request {
	routeContext := chi.NewRouteContext()
	for key, value := range values {
		routeContext.URLParams.Add(key, value)
	}
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}

func assertDetail(t *testing.T, recorder *httptest.ResponseRecorder, status int, detail string) {
	t.Helper()
	if recorder.Code != status || recorder.Body.String() != `{"detail":"`+detail+`"}` {
		t.Fatalf("response = %d %s, want %d detail %q", recorder.Code, recorder.Body.String(), status, detail)
	}
}

type handlerStore struct {
	options       []ProjectOption
	manage        []ProjectItem
	created       ProjectItem
	context       ProjectContext
	listOperator  string
	listAdmin     bool
	listInactive  bool
	projectPatch  map[string]any
	skuPatch      map[string]any
	listErr       error
	shopErr       error
	moveDirection string
}

func (s *handlerStore) ListOptions(context.Context) ([]ProjectOption, error) {
	return s.options, s.listErr
}
func (s *handlerStore) ListManage(_ context.Context, operator string, isAdmin, showInactive bool) ([]ProjectItem, error) {
	s.listOperator, s.listAdmin, s.listInactive = operator, isAdmin, showInactive
	return s.manage, s.listErr
}
func (*handlerStore) ListOperatorOptions(context.Context) ([]string, error) {
	return []string{}, nil
}
func (*handlerStore) GetProject(context.Context, int64) (*ProjectItem, error) {
	item := ProjectItem{ID: 7, Name: "北美", ProjectOperator: stringPointer("运营甲")}
	return &item, nil
}
func (s *handlerStore) CreateProject(context.Context, CreateProjectInput) (ProjectItem, error) {
	return s.created, nil
}
func (*handlerStore) UpdateProject(context.Context, int64, UpdateProjectInput) (ProjectItem, error) {
	return ProjectItem{}, nil
}
func (s *handlerStore) MoveProject(_ context.Context, projectID int64, direction string) (ProjectItem, error) {
	s.moveDirection = direction
	return ProjectItem{ID: projectID, Name: "北美", Country: "US", SortOrder: 1}, nil
}
func (*handlerStore) ListProjectShops(context.Context, int64) ([]ProjectShopItem, error) {
	return []ProjectShopItem{}, nil
}
func (s *handlerStore) UpsertProjectShop(context.Context, int64, string, ShopUpsert) (*ProjectShopItem, ProjectShopItem, error) {
	return nil, ProjectShopItem{}, s.shopErr
}
func (*handlerStore) DeleteProjectShop(context.Context, int64, string) (bool, error) {
	return true, nil
}
func (s *handlerStore) GetProjectContext(context.Context, int64) (ProjectContext, error) {
	return s.context, nil
}
func (s *handlerStore) PatchProjectContext(_ context.Context, _ int64, projectPatch, skuPatch map[string]any, _ string) (ProjectContext, error) {
	s.projectPatch, s.skuPatch = projectPatch, skuPatch
	return s.context, nil
}

type handlerAudit struct {
	entries []audit.Entry
}

func (a *handlerAudit) LogAction(_ context.Context, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}
func (*handlerAudit) LogActionTx(context.Context, pgx.Tx, audit.Entry) error { return nil }
func (*handlerAudit) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

type handlerContextParser struct {
	result      map[string]any
	err         error
	description string
}

func (p *handlerContextParser) Parse(_ context.Context, description string) (map[string]any, error) {
	p.description = description
	return p.result, p.err
}
