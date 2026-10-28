package app

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
	"github.com/passwii/believeboyDashboard/desktop/internal/pages"
)

type testSessions struct {
	mu       sync.Mutex
	session  auth.Session
	err      error
	cleared  int
	clearErr error
	saveErr  error
	saved    []auth.Session
	apiKeys  []string
}

func (s *testSessions) Load(context.Context) (auth.Session, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return auth.Session{}, "", s.err
	}
	return s.session, "api-key", nil
}

func (s *testSessions) Save(_ context.Context, session auth.Session, apiKey string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saveErr != nil {
		return s.saveErr
	}
	s.saved = append(s.saved, session)
	s.apiKeys = append(s.apiKeys, apiKey)
	return nil
}

func (s *testSessions) Clear(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleared++
	if s.clearErr != nil {
		return s.clearErr
	}
	s.err = auth.ErrNoSession
	return nil
}

type testHomeLoader struct {
	mu    sync.Mutex
	calls int
}

func (l *testHomeLoader) Load(context.Context, int) pages.HomeData {
	l.mu.Lock()
	l.calls++
	l.mu.Unlock()
	profile := "林晓"
	return pages.HomeData{
		Health:   pages.LoadHealth(api.HealthResponse{Status: "ok", Database: "ok", Redis: "ok"}, nil),
		Unread:   pages.LoadUnread(api.UnreadCountResponse{Count: 3}, nil),
		Alerts:   pages.LoadAlerts(api.AlertStats{TotalActive: 1}, nil),
		Profile:  pages.LoadProfile(api.Profile{Name: "linxiao", FullName: &profile, RoleType: api.RoleAdmin}, nil),
		LoadedAt: time.Now(),
	}
}

func (l *testHomeLoader) Calls() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.calls
}

func testProjects(context.Context, int) ([]api.Project, error) {
	return []api.Project{
		{ID: 1, Name: "北美站", Country: "US", CountryName: projectCountry("美国站"), IsActive: true},
		{ID: 2, Name: "欧洲站", Country: "DE", CountryName: projectCountry("德国站"), IsActive: true},
	}, nil
}

func projectCountry(value string) *string { return &value }

type appHarness struct {
	app      *App
	tt       *ui.Tester
	context  *ui.Context
	mainWork chan func()
	loader   *testHomeLoader
	sessions *testSessions
	loginFn  pages.LoginFunc
}

func newAppHarness(t *testing.T, session *auth.Session) *appHarness {
	return newAppHarnessAuth(t, session, nil, nil)
}

func newAppHarnessConfigured(
	t *testing.T,
	session *auth.Session,
	verify func(context.Context) (api.MeResponse, error),
) *appHarness {
	return newAppHarnessAuth(t, session, verify, nil)
}

func newAppHarnessAuth(
	t *testing.T,
	session *auth.Session,
	verify func(context.Context) (api.MeResponse, error),
	configure func(*testSessions),
) *appHarness {
	t.Helper()
	router := ui.NewRouter("/login")
	if session != nil {
		router.Replace(pages.HomeRoute)
	}
	sessions := &testSessions{}
	if configure != nil {
		configure(sessions)
	}
	if session != nil {
		sessions.session = *session
	} else {
		sessions.err = auth.ErrNoSession
	}
	loader := &testHomeLoader{}
	h := &appHarness{mainWork: make(chan func(), 32), loader: loader, sessions: sessions}
	var initial *auth.Session
	if session != nil {
		copy := *session
		initial = &copy
	}
	loginFn := func(context.Context, string, string) (*api.LoginResponse, error) {
		name := "林晓"
		return &api.LoginResponse{
			ID: "99", Name: "newuser", Email: "new@example.com",
			FullName: &name, RoleType: api.RoleAdmin, IsAdmin: true,
			IsActive: true, SessionID: "session-2", APIKey: "new-api-key",
		}, nil
	}
	h.loginFn = loginFn
	h.app = New(Options{
		Router:         router,
		Sessions:       sessions,
		InitialSession: initial,
		InitialAPIKey:  "api-key",
		Login:          loginFn,
		HomeLoader:     loader.Load,
		ProjectLoader:  testProjects,
		Logout:         sessions.Clear,
		Quit:           func() {},
		VerifySession:  verify,
	})
	h.app.SetUpdate(func(fn func()) { h.mainWork <- fn })
	h.tt = ui.NewTester(func(c *ui.Context) {
		h.context = c
		h.app.View(c)
	}, pages.DefaultWidth, pages.DefaultHeight)
	return h
}

func (h *appHarness) login(email, password string) {
	h.tt.Click("邮箱")
	h.tt.Type(email)
	h.tt.Click("密码")
	h.tt.Type(password)
	h.tt.Key(0, ui.KeyEnter)
}

func (h *appHarness) clickSidebar(label, id string) {
	h.tt.Click(label)
	h.tt.Frame()
}

func (h *appHarness) waitForLogoutError(t *testing.T) {
	t.Helper()
	deadline := time.After(time.Second)
	for !h.tt.HasText("退出登录失败") {
		select {
		case fn := <-h.mainWork:
			fn()
			h.tt.Frame()
		case <-deadline:
			t.Fatalf("timed out; texts=%q", h.tt.Texts())
		}
	}
}

func (h *appHarness) waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.After(time.Second)
	for !predicate() {
		select {
		case fn := <-h.mainWork:
			fn()
			h.tt.Frame()
		case <-deadline:
			t.Fatalf("timed out; route=%s texts=%q", h.currentRouter().Path(), h.tt.Texts())
		}
	}
}

func (h *appHarness) currentRouter() *ui.Router {
	return h.app.Router()
}

func (h *appHarness) sessionSnapshot() auth.Session {
	h.app.mu.RLock()
	defer h.app.mu.RUnlock()
	return h.app.session
}

func (h *appHarness) sessionStatusSnapshot() string {
	h.app.mu.RLock()
	defer h.app.mu.RUnlock()
	return h.app.sessionStatus
}

func (h *appHarness) drainMainWork(t *testing.T) {
	t.Helper()
	for {
		select {
		case fn := <-h.mainWork:
			fn()
			h.tt.Frame()
		default:
			return
		}
	}
}

func testSession() *auth.Session {
	name := "林晓"
	return &auth.Session{
		UserID: "42", Email: "li@example.com", Name: "linxiao",
		FullName: &name, RoleType: "admin", SessionID: "session-1",
	}
}

func TestAppShowsLoginWithoutSession(t *testing.T) {
	h := newAppHarness(t, nil)
	if h.currentRouter().Path() != "/login" || !h.tt.HasText("登录工作台") {
		t.Fatalf("route=%q texts=%q", h.currentRouter().Path(), h.tt.Texts())
	}
}

func TestAppShowsHomeWithSession(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	if !h.tt.HasText("未读通知") || !h.tt.HasText("活跃告警") {
		t.Fatalf("home cards missing: %q", h.tt.Texts())
	}
}

func TestAppUnknownRouteShowsNativeNotFound(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	h.currentRouter().Replace("/missing")
	h.tt.Frame()
	if !h.tt.HasText("页面不存在") {
		t.Fatalf("missing route error: %q", h.tt.Texts())
	}
	if err := h.tt.Click("返回首页"); err != nil {
		t.Fatal(err)
	}
	if h.currentRouter().Path() != pages.HomeRoute {
		t.Fatalf("route = %q, want home", h.currentRouter().Path())
	}
}

func TestAppLoginEstablishesSessionBeforeNavigatingHome(t *testing.T) {
	h := newAppHarness(t, nil)
	h.login("li@example.com", "secret")
	h.waitFor(t, func() bool { return h.currentRouter().Path() == pages.HomeRoute })
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	if !h.tt.HasText("未读通知") {
		t.Fatalf("home cards missing after login: %q", h.tt.Texts())
	}
	if h.currentRouter().CanGoBack() {
		t.Error("login success left a back entry to /login")
	}
}

func TestAppNavigatesToNativeSettingsPlaceholder(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	if err := h.tt.Click("系统设置"); err != nil {
		t.Fatal(err)
	}
	h.tt.Frame()
	if h.currentRouter().Path() != "/settings" {
		t.Fatalf("route = %q, want /settings", h.currentRouter().Path())
	}
	if !h.tt.HasText("暂未开放") || !h.tt.HasText("系统设置") {
		t.Fatalf("placeholder missing: %q", h.tt.Texts())
	}
	if !h.tt.Focused("系统设置") {
		t.Error("navigation did not keep focus on the selected sidebar item")
	}
	if opened := h.tt.OpenedURLs(); len(opened) != 0 {
		t.Errorf("placeholder opened web URLs: %q", opened)
	}
}

func TestAppKeepsWorkspaceChromeStableDuringRouteTransition(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })

	const sidebarProbeX, sidebarProbeY = 10, 50
	before := h.tt.Image().RGBAAt(sidebarProbeX, sidebarProbeY)
	h.tt.Click("系统设置")
	if h.currentRouter().Path() != SettingsRoute {
		t.Fatalf("route = %q, want %q", h.currentRouter().Path(), SettingsRoute)
	}
	if !h.tt.HasText("暂未开放") {
		t.Fatalf("settings content missing during route transition: %q", h.tt.Texts())
	}
	h.tt.Advance(75 * time.Millisecond)
	after := h.tt.Image().RGBAAt(sidebarProbeX, sidebarProbeY)
	if after != before {
		t.Errorf("sidebar chrome pixel changed during content transition: before=%#v after=%#v", before, after)
	}
}

func TestAppShortcuts(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	before := h.loader.Calls()

	h.tt.Key(ui.Cmd, ui.KeyR)
	h.waitFor(t, func() bool { return h.loader.Calls() > before })

	h.tt.Key(ui.Cmd, ui.KeyComma)
	if h.currentRouter().Path() != "/settings" {
		t.Fatalf("Cmd+, route = %q", h.currentRouter().Path())
	}

	quit := 0
	h.app.SetQuit(func() { quit++ })
	h.tt.Key(ui.Cmd, ui.KeyQ)
	if quit != 1 {
		t.Fatalf("Cmd+Q count = %d, want 1", quit)
	}
}

func TestAppLogoutClearsSessionAndReturnsToLogin(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	if err := h.tt.Click("林晓"); err != nil {
		t.Fatal(err)
	}
	if err := h.tt.ChooseMenuItem("退出登录"); err != nil {
		t.Fatal(err)
	}
	h.waitFor(t, func() bool { return h.currentRouter().Path() == "/login" })
	if h.sessions.cleared != 1 {
		t.Errorf("session clear count = %d, want 1", h.sessions.cleared)
	}
	if !h.tt.HasText("登录工作台") {
		t.Errorf("login page missing: %q", h.tt.Texts())
	}
}

func TestAppLogoutFailureKeepsSession(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.app.SetLogout(func(context.Context) error { return errors.New("keychain locked") })
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	if err := h.tt.Click("林晓"); err != nil {
		t.Fatal(err)
	}
	if err := h.tt.ChooseMenuItem("退出登录"); err != nil {
		t.Fatal(err)
	}
	h.waitFor(t, func() bool { return h.tt.HasText("退出登录失败") })
	if h.currentRouter().Path() != "/home" {
		t.Errorf("route after logout failure = %q", h.currentRouter().Path())
	}
}

func TestAppHistoryUsesPushAndSupportsBackForward(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	h.tt.Click("系统设置")
	h.tt.Frame()
	h.tt.Click("报表中心")
	h.tt.Frame()
	if h.currentRouter().Path() != "/reports" {
		t.Fatalf("route = %q, want /reports", h.currentRouter().Path())
	}
	h.currentRouter().Back()
	h.tt.Frame()
	if h.currentRouter().Path() != "/settings" || !h.tt.HasText("系统设置") {
		t.Fatalf("back route = %q texts=%q", h.currentRouter().Path(), h.tt.Texts())
	}
	h.currentRouter().Forward()
	h.tt.Frame()
	if h.currentRouter().Path() != "/reports" || !h.tt.HasText("报表") {
		t.Fatalf("forward route = %q texts=%q", h.currentRouter().Path(), h.tt.Texts())
	}
}

func TestAppProtectedRoutesRequireSession(t *testing.T) {
	for _, route := range []string{"/settings", "/reports", "/projects", "/operations", "/ai"} {
		t.Run(route, func(t *testing.T) {
			h := newAppHarness(t, nil)
			h.currentRouter().Replace(route)
			h.tt.Frame()
			if h.currentRouter().Path() != "/login" {
				t.Fatalf("route = %q, want /login", h.currentRouter().Path())
			}
			if !h.tt.HasText("登录工作台") {
				t.Fatalf("login page missing: %q", h.tt.Texts())
			}
		})
	}
}

func TestAppSettingsShortcutDoesNothingLoggedOut(t *testing.T) {
	h := newAppHarness(t, nil)
	h.tt.Key(ui.Cmd, ui.KeyComma)
	if h.currentRouter().Path() != "/login" {
		t.Fatalf("route = %q, want /login", h.currentRouter().Path())
	}
}

func TestAppNonProjectPlaceholdersAreReachableFromSidebar(t *testing.T) {
	tests := []struct {
		label string
		route string
	}{
		{label: "运营分析", route: "/operations"},
		{label: "报表中心", route: "/reports"},
		{label: "AI 助手", route: "/ai"},
	}
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	for _, test := range tests {
		if err := h.tt.Click(test.label); err != nil {
			t.Fatal(err)
		}
		h.tt.Frame()
		if h.currentRouter().Path() != test.route {
			t.Fatalf("%s route = %q, want %q", test.label, h.currentRouter().Path(), test.route)
		}
		if !h.tt.HasText("暂未开放") {
			t.Fatalf("%s placeholder missing: %q", test.label, h.tt.Texts())
		}
		if opened := h.tt.OpenedURLs(); len(opened) != 0 {
			t.Fatalf("%s opened URLs: %q", test.label, opened)
		}
	}
}

func TestAppProjectsPageShowsSearchableTableAndInspector(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	if err := h.tt.Click("项目管理"); err != nil {
		t.Fatal(err)
	}
	h.tt.Frame()
	if h.currentRouter().Path() != "/projects" {
		t.Fatalf("route = %q, want /projects", h.currentRouter().Path())
	}
	if err := h.tt.Click("检查器"); err != nil {
		t.Fatal(err)
	}
	h.waitFor(t, func() bool { return h.tt.HasText("北美站") && h.tt.HasText("欧洲站") })
	if !h.tt.HasText("项目列表") || !h.tt.HasText("北美站") || !h.tt.HasText("欧洲站") {
		t.Fatalf("projects table missing: %q", h.tt.Texts())
	}
	if err := h.tt.Click("欧洲站"); err != nil {
		t.Fatal(err)
	}
	h.tt.Frame()
	if !h.tt.HasText("项目详情") || !h.tt.HasText("德国站") {
		t.Fatalf("project inspector missing selected details: %q", h.tt.Texts())
	}
	if err := h.tt.Click("搜索项目"); err != nil {
		t.Fatal(err)
	}
	h.tt.Type("北美")
	h.tt.Frame()
	if !h.tt.HasText("北美站") || h.tt.HasText("欧洲站") {
		t.Fatalf("project filter did not narrow the table: %q", h.tt.Texts())
	}
}

func TestAsyncHomeRedrawDoesNotStealHeaderFocus(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	before := h.loader.Calls()
	if err := h.tt.Click("刷新数据"); err != nil {
		t.Fatal(err)
	}
	if !h.tt.Focused("刷新数据") {
		t.Fatal("refresh button did not receive focus")
	}
	h.waitFor(t, func() bool { return h.loader.Calls() > before })
	select {
	case fn := <-h.mainWork:
		fn()
		h.tt.Frame()
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for async home redraw")
	}
	if !h.tt.Focused("刷新数据") {
		t.Fatalf("async redraw moved focus: %q", h.tt.Texts())
	}
}

func TestSavedSessionRefreshUpdatesSessionAndKeychain(t *testing.T) {
	name := "新名字"
	h := newAppHarnessConfigured(t, testSession(), func(context.Context) (api.MeResponse, error) {
		return api.MeResponse{
			ID: "42", Email: "li@example.com", Name: "linxiao",
			FullName: &name, IsAdmin: false, IsActive: true, RoleType: api.RoleOperator,
		}, nil
	})
	h.waitFor(t, func() bool { return h.tt.HasText("新名字") })
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	if len(h.sessions.saved) != 1 {
		t.Fatalf("saved sessions = %d, want 1", len(h.sessions.saved))
	}
	if h.sessions.saved[0].FullName == nil || *h.sessions.saved[0].FullName != "新名字" {
		t.Errorf("saved session = %+v", h.sessions.saved[0])
	}
	if h.sessions.saved[0].SessionID != "session-1" || h.sessions.apiKeys[0] != "api-key" {
		t.Errorf("saved credentials = session %q key %q", h.sessions.saved[0].SessionID, h.sessions.apiKeys[0])
	}
}

func TestSavedSessionRevokedClearsCredentialsAndReturnsToLogin(t *testing.T) {
	h := newAppHarnessConfigured(t, testSession(), func(context.Context) (api.MeResponse, error) {
		return api.MeResponse{}, &api.HTTPError{StatusCode: http.StatusUnauthorized}
	})
	h.waitFor(t, func() bool { return h.currentRouter().Path() == "/login" })
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	if h.sessions.cleared != 1 {
		t.Fatalf("cleared = %d, want 1", h.sessions.cleared)
	}
	if !h.tt.HasText("登录工作台") {
		t.Fatalf("login page missing: %q", h.tt.Texts())
	}
}

func TestSavedSessionNetworkFailureKeepsCachedSession(t *testing.T) {
	h := newAppHarnessConfigured(t, testSession(), func(context.Context) (api.MeResponse, error) {
		return api.MeResponse{}, &api.NetworkError{Cause: errors.New("offline")}
	})
	h.waitFor(t, func() bool { return h.tt.HasText("会话校验失败，继续使用本地会话") })
	if h.currentRouter().Path() != "/home" {
		t.Fatalf("route = %q, want /home", h.currentRouter().Path())
	}
	if !h.tt.HasText("林晓") {
		t.Fatalf("cached session missing: %q", h.tt.Texts())
	}
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	if h.sessions.cleared != 0 || len(h.sessions.saved) != 0 {
		t.Fatalf("network error mutated Keychain: cleared=%d saved=%d", h.sessions.cleared, len(h.sessions.saved))
	}
}

func TestSavedSessionServerFailureKeepsCachedSession(t *testing.T) {
	h := newAppHarnessConfigured(t, testSession(), func(context.Context) (api.MeResponse, error) {
		return api.MeResponse{}, &api.HTTPError{StatusCode: http.StatusInternalServerError}
	})
	h.waitFor(t, func() bool { return h.tt.HasText("会话校验失败，继续使用本地会话") })
	if h.currentRouter().Path() != "/home" {
		t.Fatalf("route = %q, want /home", h.currentRouter().Path())
	}
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	if h.sessions.cleared != 0 || len(h.sessions.saved) != 0 {
		t.Fatalf("5xx mutated Keychain: cleared=%d saved=%d", h.sessions.cleared, len(h.sessions.saved))
	}
}

func TestSavedSessionNotFoundClearsCredentialsAndReturnsToLogin(t *testing.T) {
	h := newAppHarnessConfigured(t, testSession(), func(context.Context) (api.MeResponse, error) {
		return api.MeResponse{}, &api.HTTPError{StatusCode: http.StatusNotFound}
	})
	h.waitFor(t, func() bool { return h.currentRouter().Path() == "/login" })
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	if h.sessions.cleared != 1 {
		t.Fatalf("cleared = %d, want 1", h.sessions.cleared)
	}
	if !h.tt.HasText("登录工作台") {
		t.Fatalf("login page missing: %q", h.tt.Texts())
	}
}

func TestSavedSessionClearFailureShowsRetryAndKeepsLogin(t *testing.T) {
	h := newAppHarnessAuth(t, testSession(), func(context.Context) (api.MeResponse, error) {
		return api.MeResponse{}, &api.HTTPError{StatusCode: http.StatusUnauthorized}
	}, func(sessions *testSessions) {
		sessions.clearErr = errors.New("keychain locked")
	})
	h.waitFor(t, func() bool { return h.tt.HasText("本地会话清理失败，请重试") })
	if h.currentRouter().Path() != "/login" {
		t.Fatalf("route = %q, want /login", h.currentRouter().Path())
	}
	if h.sessionStatusSnapshot() != "本地会话清理失败，请重试" {
		t.Fatalf("status = %q", h.sessionStatusSnapshot())
	}
}

func TestSavedSessionRefreshIsDiscardedAfterLogout(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	h := newAppHarnessConfigured(t, testSession(), func(context.Context) (api.MeResponse, error) {
		close(started)
		<-release
		name := "旧刷新"
		return api.MeResponse{
			ID: "42", Email: "li@example.com", Name: "linxiao",
			FullName: &name, IsAdmin: true, IsActive: true, RoleType: api.RoleAdmin,
		}, nil
	})
	<-started
	h.app.triggerLogout()
	h.waitFor(t, func() bool { return h.currentRouter().Path() == "/login" })
	close(release)
	select {
	case fn := <-h.mainWork:
		fn()
		h.tt.Frame()
	case <-time.After(50 * time.Millisecond):
	}
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	if len(h.sessions.saved) != 0 {
		t.Fatalf("stale refresh wrote Keychain: %+v", h.sessions.saved)
	}
	if h.sessionSnapshot().UserID != "" {
		t.Fatalf("stale refresh resurrected session: %+v", h.sessionSnapshot())
	}
}

func TestSavedSessionRefreshIsDiscardedAfterNewerLogin(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	h := newAppHarnessConfigured(t, testSession(), func(context.Context) (api.MeResponse, error) {
		close(started)
		<-release
		name := "旧刷新"
		return api.MeResponse{
			ID: "42", Email: "li@example.com", Name: "linxiao",
			FullName: &name, IsAdmin: true, IsActive: true, RoleType: api.RoleAdmin,
		}, nil
	})
	<-started
	if _, err := h.app.loginAttempt(context.Background(), "new@example.com", "secret"); err != nil {
		t.Fatal(err)
	}
	h.waitFor(t, func() bool { return h.sessionSnapshot().UserID == "99" })
	close(release)
	time.Sleep(10 * time.Millisecond)
	if got := h.sessionSnapshot().UserID; got != "99" {
		t.Fatalf("stale refresh replaced newer login: %q", got)
	}
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	for _, saved := range h.sessions.saved {
		if saved.UserID == "42" {
			t.Fatalf("stale refresh saved old session: %+v", saved)
		}
	}
}

func TestSavedSessionRefreshAfterCloseDoesNothing(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	h := newAppHarnessConfigured(t, testSession(), func(context.Context) (api.MeResponse, error) {
		close(started)
		<-release
		name := "不应写入"
		return api.MeResponse{
			ID: "42", Email: "li@example.com", Name: "linxiao",
			FullName: &name, IsAdmin: true, IsActive: true, RoleType: api.RoleAdmin,
		}, nil
	})
	<-started
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	h.drainMainWork(t)
	h.app.Close()
	close(release)
	select {
	case fn := <-h.mainWork:
		fn()
		t.Fatal("closed app received a session-refresh update")
	case <-time.After(50 * time.Millisecond):
	}
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	if len(h.sessions.saved) != 0 {
		t.Fatalf("closed app wrote Keychain: %+v", h.sessions.saved)
	}
	if h.sessionStatusSnapshot() != "" {
		t.Fatalf("closed app mutated status: %q", h.sessionStatusSnapshot())
	}
}

func TestCompleteLoginAfterCloseDoesNotRestoreSession(t *testing.T) {
	h := newAppHarness(t, nil)
	h.app.Close()

	h.app.completeLogin(auth.Session{
		UserID: "late", Email: "late@example.com", Name: "late",
		SessionID: "late-session", IsActive: true,
	}, "late-key")

	if h.app.sessionActive() {
		t.Fatal("closed app restored a late login session")
	}
}

func TestLogoutThenLoginCannotBackIntoPriorAccountHistory(t *testing.T) {
	h := newAppHarness(t, testSession())
	h.waitFor(t, func() bool { return h.tt.HasText("工作台概览") })
	h.tt.Click("系统设置")
	h.tt.Frame()
	h.tt.Click("报表中心")
	h.tt.Frame()
	if h.currentRouter().Path() != "/reports" {
		t.Fatalf("route = %q, want /reports", h.currentRouter().Path())
	}
	if err := h.tt.Click("林晓"); err != nil {
		t.Fatal(err)
	}
	if err := h.tt.ChooseMenuItem("退出登录"); err != nil {
		t.Fatal(err)
	}
	h.waitFor(t, func() bool { return h.currentRouter().Path() == "/login" })
	h.login("new@example.com", "secret")
	h.waitFor(t, func() bool { return h.currentRouter().Path() == pages.HomeRoute })
	if h.currentRouter().CanGoBack() {
		t.Fatal("new login retains prior account history")
	}
	h.currentRouter().Back()
	h.tt.Frame()
	if h.currentRouter().Path() != pages.HomeRoute || h.tt.HasText("报表中心") && h.tt.HasText("暂未开放") {
		t.Fatalf("back exposed prior account route: %q %q", h.currentRouter().Path(), h.tt.Texts())
	}
}
