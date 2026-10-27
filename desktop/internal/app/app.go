package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
	"github.com/passwii/believeboyDashboard/desktop/internal/components"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
	"github.com/passwii/believeboyDashboard/desktop/internal/pages"
)

const (
	LoginRoute      = "/login"
	HomeRoute       = pages.HomeRoute
	SettingsRoute   = "/settings"
	ProjectsRoute   = "/projects"
	OperationsRoute = "/operations"
	ReportsRoute    = "/reports"
	AIRoute         = "/ai"
)

type Options struct {
	Router         *ui.Router
	Sessions       api.SessionStore
	InitialSession *auth.Session
	InitialAPIKey  string
	Login          pages.LoginFunc
	HomeLoader     pages.HomeLoader
	ProjectLoader  pages.ProjectLoader
	Logout         func(context.Context) error
	Quit           func()
	VerifySession  func(context.Context) (api.MeResponse, error)
}

// App owns router-level state and keeps all model updates on the UI thread.
type App struct {
	mu             sync.RWMutex
	router         *ui.Router
	sessions       api.SessionStore
	session        auth.Session
	hasSession     bool
	apiKey         string
	login          pages.LoginFunc
	homeLoader     pages.HomeLoader
	projectLoader  pages.ProjectLoader
	logout         func(context.Context) error
	quit           func()
	update         func(func())
	verifySession  func(context.Context) (api.MeResponse, error)
	refreshStarted bool
	refreshCancel  context.CancelFunc
	authGeneration uint64
	authStoreMu    sync.Mutex
	loginMu        sync.Mutex
	loginPage      *pages.LoginPage
	homePage       *pages.HomePage
	logoutError    string
	inspectorOpen  bool
	sessionStatus  string
	closed         bool
}

func New(options Options) *App {
	router := options.Router
	if router == nil {
		route := LoginRoute
		if options.InitialSession != nil {
			route = HomeRoute
		}
		router = ui.NewRouter(route)
	}
	a := &App{
		router:        router,
		sessions:      options.Sessions,
		login:         options.Login,
		homeLoader:    options.HomeLoader,
		projectLoader: options.ProjectLoader,
		logout:        options.Logout,
		quit:          options.Quit,
		verifySession: options.VerifySession,
		apiKey:        options.InitialAPIKey,
	}
	if options.InitialSession != nil {
		a.setSession(*options.InitialSession)
	}
	return a
}

func (a *App) SetUpdate(update func(func())) {
	a.mu.Lock()
	a.update = update
	start := !a.refreshStarted && a.hasSession && a.verifySession != nil && a.sessions != nil
	var (
		ctx       context.Context
		cancel    context.CancelFunc
		epoch     uint64
		userID    string
		sessionID string
		apiKey    string
	)
	if start {
		a.refreshStarted = true
		ctx, cancel = context.WithCancel(context.Background())
		a.refreshCancel = cancel
		epoch = a.authGeneration
		userID = a.session.UserID
		sessionID = a.session.SessionID
		apiKey = a.apiKey
	}
	a.mu.Unlock()
	if start {
		go a.refreshSavedSession(ctx, epoch, userID, sessionID, apiKey)
	}
}

func (a *App) SetQuit(quit func()) {
	a.mu.Lock()
	a.quit = quit
	a.mu.Unlock()
}

func (a *App) SetLogout(logout func(context.Context) error) {
	a.mu.Lock()
	a.logout = logout
	a.mu.Unlock()
}

func (a *App) Router() *ui.Router {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.router
}

func (a *App) sessionActive() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.hasSession
}

func (a *App) refreshSavedSession(ctx context.Context, epoch uint64, userID, sessionID, apiKey string) {
	a.mu.RLock()
	sessions := a.sessions
	verify := a.verifySession
	a.mu.RUnlock()
	if sessions == nil || verify == nil {
		return
	}
	response, err := verify(ctx)
	if !a.authRefreshValid(ctx, epoch) {
		return
	}
	if invalidSessionError(err) || (err == nil && !response.IsActive) {
		a.authStoreMu.Lock()
		if !a.authRefreshValid(ctx, epoch) {
			a.authStoreMu.Unlock()
			return
		}
		clearErr := sessions.Clear(ctx)
		a.authStoreMu.Unlock()
		a.updateSession(func() {
			a.mu.Lock()
			valid := !a.closed && a.authGeneration == epoch
			a.mu.Unlock()
			if valid {
				a.applySessionRevoked(clearErr)
			}
		})
		return
	}
	if err != nil {
		a.updateSession(func() {
			a.mu.Lock()
			if a.closed || a.authGeneration != epoch {
				a.mu.Unlock()
				return
			}
			a.sessionStatus = "会话校验失败，继续使用本地会话"
			a.mu.Unlock()
		})
		return
	}
	refreshed := auth.Session{
		UserID: response.ID, Email: response.Email, Name: response.Name,
		FullName: response.FullName, RoleType: string(response.RoleType),
		SessionID: sessionID, IsAdmin: response.IsAdmin, IsActive: response.IsActive,
	}
	if refreshed.UserID == "" {
		refreshed.UserID = userID
	}
	a.authStoreMu.Lock()
	if !a.authRefreshValid(ctx, epoch) {
		a.authStoreMu.Unlock()
		return
	}
	saveErr := sessions.Save(ctx, refreshed, apiKey)
	a.authStoreMu.Unlock()
	if !a.authRefreshValid(ctx, epoch) {
		return
	}
	a.updateSession(func() {
		a.mu.Lock()
		if a.closed || a.authGeneration != epoch {
			a.mu.Unlock()
			return
		}
		a.session = refreshed
		a.hasSession = true
		a.apiKey = apiKey
		if saveErr != nil {
			a.sessionStatus = "会话已刷新，但本地凭据保存失败"
		} else {
			a.sessionStatus = ""
		}
		a.mu.Unlock()
	})
}

func (a *App) updateSession(fn func()) {
	a.mu.RLock()
	update := a.update
	closed := a.closed
	a.mu.RUnlock()
	if update != nil && !closed {
		update(fn)
	}
}

func (a *App) applySessionRevoked(clearErr error) {
	if a.closed {
		return
	}
	a.mu.Lock()
	a.logoutError = ""
	a.sessionStatus = ""
	if clearErr != nil {
		a.sessionStatus = "本地会话清理失败，请重试"
	}
	a.session = auth.Session{}
	a.hasSession = false
	a.apiKey = ""
	a.mu.Unlock()
	a.resetHistory(LoginRoute)
}

func (a *App) authRefreshValid(ctx context.Context, epoch uint64) bool {
	if ctx.Err() != nil {
		return false
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return !a.closed && a.authGeneration == epoch
}

func invalidSessionError(err error) bool {
	var httpErr *api.HTTPError
	return errors.As(err, &httpErr) &&
		(httpErr.StatusCode == 401 || httpErr.StatusCode == 404)
}

// resetHistory starts a fresh router and page state for a new auth boundary.
func (a *App) resetHistory(route string) {
	a.mu.Lock()
	a.authGeneration++
	if a.refreshCancel != nil {
		a.refreshCancel()
		a.refreshCancel = nil
	}
	login := a.loginPage
	home := a.homePage
	a.loginPage = nil
	a.homePage = nil
	a.router = ui.NewRouter(route)
	a.mu.Unlock()
	if login != nil {
		login.Close()
	}
	if home != nil {
		home.Close()
	}
}

func (a *App) Close() {
	a.authStoreMu.Lock()
	a.mu.Lock()
	a.closed = true
	if a.refreshCancel != nil {
		a.refreshCancel()
		a.refreshCancel = nil
	}
	login := a.loginPage
	home := a.homePage
	a.mu.Unlock()
	a.authStoreMu.Unlock()
	if login != nil {
		login.Close()
	}
	if home != nil {
		home.Close()
	}
}

func (a *App) View(c *ui.Context) {
	router := a.Router()
	if router.Path() != LoginRoute && !a.sessionActive() {
		a.resetHistory(LoginRoute)
		router = a.Router()
	}
	design.ApplyTheme(c.Theme())
	router.View(c, func(route *ui.Route) {
		switch {
		case route.Match(LoginRoute):
			route.Title("登录")
			a.loginView(c)
		case route.Match(HomeRoute):
			route.Title("首页")
			a.homeView(c)
		case route.Match(SettingsRoute):
			route.Title("系统设置")
			a.placeholderView(c, "settings", "系统设置", "工作台 / 系统设置", "系统设置")
		case route.Match(ProjectsRoute):
			route.Title("项目")
			a.placeholderView(c, "projects", "项目", "工作台 / 项目", "项目工作区")
		case route.Match(OperationsRoute):
			route.Title("运营")
			a.placeholderView(c, "operations", "运营", "工作台 / 运营", "运营分析")
		case route.Match(ReportsRoute):
			route.Title("报表")
			a.placeholderView(c, "reports", "报表", "工作台 / 报表", "报表中心")
		case route.Match(AIRoute):
			route.Title("AI")
			a.placeholderView(c, "ai", "AI", "工作台 / AI", "AI 助手")
		default:
			route.Title("未找到")
			p := design.Light
			ui.Column(c).Fill().Padding(48).Gap(12).Children(func() {
				ui.Text(c, "页面不存在").FontSize(24).FontWeight(650).TextColor(p.Ink)
				ui.Text(c, "当前地址无法打开；请返回首页。").
					FontSize(12).
					TextColor(p.InkMuted)
				if ui.Button(c, "返回首页").Clicked() {
					a.navigate("home")
				}
			})
		}
	})
	a.shortcuts(c)
}

func (a *App) loginView(c *ui.Context) {
	if a.loginMu.TryLock() {
		defer a.loginMu.Unlock()
	}
	a.mu.Lock()
	page := a.loginPage
	notice := a.sessionStatus
	a.mu.Unlock()
	if page == nil {
		page = pages.NewLoginPage(pages.LoginOptions{
			Login: a.loginAttempt,
			Update: func(fn func()) {
				a.mu.RLock()
				update := a.update
				a.mu.RUnlock()
				if update == nil {
					return
				}
				update(func() {
					fn()
				})
			},
			Router: a.router,
			Notice: notice,
		})
		a.mu.Lock()
		a.loginPage = page
		a.mu.Unlock()
	}
	page.View(c)
}

func (a *App) loginAttempt(ctx context.Context, email, password string) (*api.LoginResponse, error) {
	a.mu.RLock()
	login := a.login
	update := a.update
	a.mu.RUnlock()
	if login == nil {
		return nil, errors.New("login unavailable")
	}
	response, err := login(ctx, email, password)
	if err != nil || response == nil {
		return response, err
	}
	session := auth.Session{
		UserID: response.ID, Email: response.Email, Name: response.Name,
		FullName: response.FullName, RoleType: string(response.RoleType),
		SessionID: response.SessionID, IsAdmin: response.IsAdmin, IsActive: response.IsActive,
	}
	if update == nil {
		return nil, errors.New("window update unavailable")
	}
	update(func() { a.completeLogin(session, response.APIKey) })
	return response, nil
}

func (a *App) completeLogin(session auth.Session, apiKey string) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.logoutError = ""
	a.sessionStatus = ""
	a.session = session
	a.hasSession = true
	a.apiKey = apiKey
	a.mu.Unlock()
	a.resetHistory(HomeRoute)
}

func (a *App) homeView(c *ui.Context) {
	if !a.hasSession {
		a.router.Replace(LoginRoute)
		return
	}
	a.mu.Lock()
	page := a.homePage
	a.mu.Unlock()
	if page == nil {
		a.mu.RLock()
		session := a.session
		loader := a.homeLoader
		projectLoader := a.projectLoader
		update := a.update
		a.mu.RUnlock()
		page = pages.NewHomePage(pages.HomeOptions{
			Session: session, Load: loader, LoadProjects: projectLoader, Update: update,
		})
		a.mu.Lock()
		a.homePage = page
		a.mu.Unlock()
	}
	page.ViewHome(c, components.WorkbenchOptions{
		Title:             "首页",
		Breadcrumb:        "工作台 / 首页",
		ActiveID:          "home",
		UserName:          displayName(a.session),
		UserRole:          RoleLabel(a.session.RoleType),
		Project:           page.SelectedProjectName(),
		Projects:          page.ProjectChoices(),
		OnNavigate:        a.navigate,
		OnSettings:        func() { a.navigate("settings") },
		OnLogout:          a.triggerLogout,
		InspectorOpen:     a.inspectorOpen,
		OnToggleInspector: a.toggleInspector,
		Status:            a.sessionStatus,
		OnRefresh:         page.Refresh,
		OnProjectChange:   page.SelectProject,
	})
	if a.logoutError != "" {
		p := design.Light
		ui.Text(c, a.logoutError).FontSize(11).TextColor(p.Danger).Role(ui.RoleStatus)
	}
}

func (a *App) placeholderView(c *ui.Context, id, title, breadcrumb, description string) {
	pages.PlaceholderPage(c, pages.PlaceholderOptions{
		ActiveID: id, Title: title, Breadcrumb: breadcrumb, Description: description,
		UserName: displayName(a.session), UserRole: RoleLabel(a.session.RoleType),
		OnNavigate: a.navigate, OnSettings: func() { a.navigate("settings") },
		OnLogout:          a.triggerLogout,
		InspectorOpen:     a.inspectorOpen,
		OnToggleInspector: a.toggleInspector,
		Status:            a.sessionStatus,
	})
	if a.logoutError != "" {
		p := design.Light
		ui.Text(c, a.logoutError).FontSize(11).TextColor(p.Danger).Role(ui.RoleStatus)
	}
}

func (a *App) toggleInspector() {
	a.inspectorOpen = !a.inspectorOpen
}

func (a *App) shortcuts(c *ui.Context) {
	c.OnShortcut(ui.Cmd, ui.KeyR, func() {
		a.mu.RLock()
		home := a.homePage
		a.mu.RUnlock()
		if home != nil && a.router.Path() == HomeRoute {
			home.Refresh()
		}
	})
	c.OnShortcut(ui.Cmd, ui.KeyComma, func() { a.navigate("settings") })
	c.OnShortcut(ui.Cmd, ui.KeyQ, func() {
		a.mu.RLock()
		quit := a.quit
		a.mu.RUnlock()
		if quit != nil {
			quit()
		}
	})
}

func (a *App) navigate(id string) {
	route := id
	switch id {
	case "home":
		route = HomeRoute
	case "settings":
		route = SettingsRoute
	case "projects":
		route = ProjectsRoute
	case "operations":
		route = OperationsRoute
	case "reports":
		route = ReportsRoute
	case "ai":
		route = AIRoute
	}
	if !strings.HasPrefix(route, "/") {
		route = "/" + route
	}
	if !a.sessionActive() {
		return
	}
	a.Router().Push(route)
}

func (a *App) triggerLogout() {
	a.invalidateAuthRefresh()
	a.mu.RLock()
	logout := a.logout
	update := a.update
	a.mu.RUnlock()
	if logout == nil {
		a.applyLogout(nil)
		return
	}
	go func() {
		a.authStoreMu.Lock()
		err := logout(context.Background())
		a.authStoreMu.Unlock()
		if update == nil {
			return
		}
		update(func() { a.applyLogout(err) })
	}()
}

func (a *App) applyLogout(err error) {
	if a.closed {
		return
	}
	if err != nil && !errors.Is(err, auth.ErrNoSession) {
		a.mu.Lock()
		a.logoutError = "退出登录失败：" + err.Error()
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	a.logoutError = ""
	a.sessionStatus = ""
	a.session = auth.Session{}
	a.hasSession = false
	a.apiKey = ""
	a.mu.Unlock()
	a.resetHistory(LoginRoute)
}

func (a *App) invalidateAuthRefresh() {
	a.mu.Lock()
	a.authGeneration++
	if a.refreshCancel != nil {
		a.refreshCancel()
		a.refreshCancel = nil
	}
	a.mu.Unlock()
}

func (a *App) updateFunc() func(func()) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.update
}

func (a *App) setSession(session auth.Session) {
	a.mu.Lock()
	a.session = session
	a.hasSession = true
	a.mu.Unlock()
}

func displayName(session auth.Session) string {
	if value := session.DisplayName(); value != "" {
		return value
	}
	return session.Name
}

func RoleLabel(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin":
		return "管理员"
	case "operator":
		return "运营"
	case "businessdev":
		return "商务"
	default:
		return "成员"
	}
}

func (a *App) Debug() string {
	return fmt.Sprintf("route=%s session=%v", a.router.Path(), a.hasSession)
}
