package pages

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
	"github.com/passwii/believeboyDashboard/desktop/internal/components"
)

type testLogin struct {
	Email    string
	Password string
}

type loginHarness struct {
	page     *LoginPage
	tt       *ui.Tester
	mu       sync.Mutex
	calls    []testLogin
	mainWork chan func()
	context  *ui.Context
}

func newTestLogin(t *testing.T, login LoginFunc) *loginHarness {
	return newTestLoginWithRouter(t, login, ui.NewRouter("/"))
}

func newTestLoginWithoutRouter(t *testing.T, login LoginFunc) *loginHarness {
	return newTestLoginWithRouter(t, login, nil)
}

func newTestLoginWithRouter(t *testing.T, login LoginFunc, router *ui.Router) *loginHarness {
	t.Helper()
	if login == nil {
		login = func(context.Context, string, string) (*api.LoginResponse, error) {
			return &api.LoginResponse{}, nil
		}
	}
	h := &loginHarness{
		mainWork: make(chan func(), 8),
	}
	h.page = NewLoginPage(LoginOptions{
		Router: router,
		Update: func(fn func()) {
			h.mainWork <- fn
		},
		Login: func(ctx context.Context, email, password string) (*api.LoginResponse, error) {
			h.mu.Lock()
			h.calls = append(h.calls, testLogin{Email: email, Password: password})
			h.mu.Unlock()
			return login(ctx, email, password)
		},
	})
	h.tt = ui.NewTester(func(c *ui.Context) {
		h.context = c
		h.page.View(c)
	}, DefaultWidth, DefaultHeight)
	return h
}

func (h *loginHarness) drainMainWork(t *testing.T) {
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

func (h *loginHarness) waitForResult(t *testing.T) {
	t.Helper()
	select {
	case fn := <-h.mainWork:
		fn()
		h.tt.Frame()
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for login result")
	}
}

func (h *loginHarness) callCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.calls)
}

func (h *loginHarness) enterCredentials(t *testing.T, email, password string) {
	t.Helper()
	h.tt.Click("邮箱")
	h.tt.Type(email)
	h.tt.Click("密码")
	h.tt.Type(password)
}

func TestLoginWindowSizes(t *testing.T) {
	if DefaultWidth != 1120 || DefaultHeight != 760 {
		t.Fatalf("default size = %dx%d, want 1120x760", DefaultWidth, DefaultHeight)
	}
	if MinWidth != 1000 || MinHeight != 700 {
		t.Fatalf("minimum size = %dx%d, want 1000x700", MinWidth, MinHeight)
	}
}

func TestLoginStartsEmpty(t *testing.T) {
	h := newTestLogin(t, nil)
	if h.page.Email() != "" || h.page.Password() != "" {
		t.Fatalf("initial credentials = %q/%q, want empty", h.page.Email(), h.page.Password())
	}
}

func TestLoginRequiresMainThreadUpdate(t *testing.T) {
	page := NewLoginPage(LoginOptions{
		Login: func(context.Context, string, string) (*api.LoginResponse, error) {
			return &api.LoginResponse{}, nil
		},
	})
	tt := ui.NewTester(page.View, DefaultWidth, DefaultHeight)
	tt.Click("邮箱")
	tt.Type("user@example.com")
	tt.Click("密码")
	tt.Type("secret")
	tt.Click("登录")
	if !tt.HasText(UpdateUnavailableMessage) {
		t.Errorf("missing configuration error %q in %q", UpdateUnavailableMessage, tt.Texts())
	}
}

func TestLoginRendersBrandAndForm(t *testing.T) {
	h := newTestLogin(t, nil)
	for _, text := range []string{
		"BelieveBoy",
		"统一管理项目、运营与财务数据",
		"本地原生客户端",
		"登录工作台",
		"邮箱",
		"密码",
		"登录",
	} {
		if !h.tt.HasText(text) {
			t.Errorf("missing %q in rendered texts %q", text, h.tt.Texts())
		}
	}
	if !h.tt.Focused("邮箱") {
		t.Error("email field should have initial focus")
	}

	brand, ok := h.tt.Find("BelieveBoy")
	if !ok {
		t.Fatal("brand panel not found")
	}
	form, ok := h.tt.Find("使用 BelieveBoy 账号继续。")
	if !ok {
		t.Fatal("login form not found")
	}
	wantSplit := float32(DefaultWidth) * components.BrandPanelRatio
	if brand.X >= wantSplit {
		t.Errorf("brand starts at %.0f, outside the left panel ending at %.0f", brand.X, wantSplit)
	}
	if form.X <= wantSplit || form.X > wantSplit+120 {
		t.Errorf("form content starts at %.0f, want it inside the right panel after %.0f", form.X, wantSplit)
	}
}

func TestLoginFitsMinimumWindow(t *testing.T) {
	h := newTestLogin(t, nil)
	h.tt.SetSize(DefaultWidth, DefaultHeight)
	h.tt.SetSize(MinWidth, MinHeight)
	h.tt.Frame()
	for _, text := range []string{
		"BelieveBoy",
		"登录工作台",
		"邮箱",
		"密码",
		"登录",
	} {
		r, ok := h.tt.Find(text)
		if !ok {
			t.Fatalf("missing %q at the minimum window size: %q", text, h.tt.Texts())
		}
		if r.X < 0 || r.Y < 0 || r.X+r.W > MinWidth || r.Y+r.H > MinHeight {
			t.Errorf("%q at %+v, outside the %dx%d window", text, r, MinWidth, MinHeight)
		}
	}
	form, ok := h.tt.Find("使用 BelieveBoy 账号继续。")
	if !ok {
		t.Fatal("login form not found at the minimum window size")
	}
	wantSplit := float32(MinWidth) * components.BrandPanelRatio
	if form.X <= wantSplit || form.X > wantSplit+120 {
		t.Errorf("form starts at %.0f, want it after the 56/44 split at %.0f", form.X, wantSplit)
	}
	input := h.page.emailBounds
	if input.X < wantSplit || input.X+input.W > MinWidth-64 {
		t.Errorf("email input bounds = %+v, want it inside the right panel", input)
	}
}

func TestLoginValidation(t *testing.T) {
	t.Run("empty email", func(t *testing.T) {
		h := newTestLogin(t, nil)
		h.tt.Click("登录")
		if h.callCount() != 0 {
			t.Fatalf("login called %d times", h.callCount())
		}
		if !h.tt.HasText("请输入邮箱") {
			t.Errorf("missing email error: %q", h.tt.Texts())
		}
		if !h.tt.Focused("邮箱") {
			t.Error("email field did not receive focus")
		}
	})

	t.Run("invalid email", func(t *testing.T) {
		h := newTestLogin(t, nil)
		h.tt.Click("邮箱")
		h.tt.Type("not-an-email")
		h.tt.Key(0, ui.KeyTab)
		h.tt.Type("secret")
		h.tt.Click("登录")
		if h.callCount() != 0 {
			t.Fatalf("login called %d times", h.callCount())
		}
		if !h.tt.HasText("请输入有效邮箱") {
			t.Errorf("missing invalid email error: %q", h.tt.Texts())
		}
	})

	t.Run("empty password", func(t *testing.T) {
		h := newTestLogin(t, nil)
		h.tt.Click("邮箱")
		h.tt.Type("user@example.com")
		h.tt.Click("登录")
		if h.callCount() != 0 {
			t.Fatalf("login called %d times", h.callCount())
		}
		if !h.tt.HasText("请输入密码") {
			t.Errorf("missing password error: %q", h.tt.Texts())
		}
		h.tt.Frame()
		if !h.tt.Focused("密码") {
			t.Error("password field did not receive focus")
		}
	})

	t.Run("both empty prefers email focus", func(t *testing.T) {
		h := newTestLogin(t, nil)
		h.tt.Click("登录")
		if !h.tt.HasText(EmailRequiredMessage) || !h.tt.HasText(PasswordRequiredMessage) {
			t.Fatalf("both field errors should show: %q", h.tt.Texts())
		}
		h.tt.Frame()
		if !h.tt.Focused("邮箱") {
			t.Error("email should take focus when both fields are empty")
		}
	})
}

func TestLoginSubmitAndLoading(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		close(started)
		<-release
		return &api.LoginResponse{}, nil
	})
	h.tt.Click("邮箱")
	h.tt.Type("user@example.com")
	h.tt.Click("密码")
	h.tt.Type("secret")
	h.tt.Click("登录")

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("login did not start")
	}
	if !h.tt.HasText("正在登录…") {
		t.Errorf("loading state missing: %q", h.tt.Texts())
	}
	if !h.tt.HasText("登录中") {
		t.Errorf("busy button label missing: %q", h.tt.Texts())
	}
	if h.tt.Focused("密码") {
		t.Error("password input should be disabled during login")
	}
	if h.tt.Focused("邮箱") {
		t.Error("email input should be disabled during login")
	}
	h.tt.Type("blocked")
	if h.page.Email() != "user@example.com" || h.page.Password() != "secret" {
		t.Errorf("typing changed disabled credentials: %q/%q", h.page.Email(), h.page.Password())
	}
	if err := h.tt.Click("登录中"); err == nil {
		if h.callCount() != 1 {
			t.Errorf("busy click started %d logins, want 1", h.callCount())
		}
	}
	close(release)
	h.waitForResult(t)
	h.tt.Frame()
}

func TestLoginStaleResultCannotOverwriteNewestState(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return &api.LoginResponse{}, nil
	})
	h.enterCredentials(t, "user@example.com", "secret")
	h.page.requestGeneration = 7
	h.page.inFlight = true
	h.page.results = []loginResult{
		{generation: 6, err: &api.HTTPError{StatusCode: http.StatusForbidden}},
		{generation: 7, err: &api.NetworkError{Cause: errors.New("newest")}},
	}
	h.tt.Frame()
	if h.page.RouterPath() == HomeRoute {
		t.Fatal("stale result navigated home")
	}
	if h.page.inFlight {
		t.Error("newest result did not clear the in-flight state")
	}
	if !h.tt.HasText(NetworkMessage) {
		t.Errorf("newest error did not win: %q", h.tt.Texts())
	}
	if h.tt.HasText(ForbiddenMessage) {
		t.Errorf("stale error was applied: %q", h.tt.Texts())
	}
}

func TestLoginOnlyStaleResultKeepsInflight(t *testing.T) {
	h := newTestLogin(t, nil)
	h.page.requestGeneration = 3
	h.page.inFlight = true
	h.page.results = []loginResult{{generation: 2, err: errors.New("old")}}
	h.tt.Frame()
	if !h.page.inFlight {
		t.Error("stale result cleared the active in-flight state")
	}
	if h.tt.HasText(DefaultLoginErrorMessage) {
		t.Error("stale error was rendered")
	}
}

func TestLoginNewerSubmitWinsOverOlderCompletion(t *testing.T) {
	started := make(chan struct{}, 2)
	replies := make(chan chan error, 2)
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		reply := make(chan error, 1)
		replies <- reply
		started <- struct{}{}
		if err := <-reply; err != nil {
			return nil, err
		}
		return &api.LoginResponse{}, nil
	})
	h.enterCredentials(t, "user@example.com", "secret")
	h.page.submit(h.context)
	first := <-replies
	<-started

	// Simulate a newer submit that races the first completion. The UI
	// normally disables inputs and the button while in flight; this bypasses
	// that guard to exercise the generation defense itself.
	h.page.inFlight = false
	h.page.submit(h.context)
	second := <-replies
	<-started

	first <- &api.HTTPError{StatusCode: http.StatusForbidden}
	h.waitForResult(t)
	if h.tt.HasText(ForbiddenMessage) {
		t.Errorf("older completion overwrote the newer request: %q", h.tt.Texts())
	}
	if !h.page.inFlight {
		t.Error("older completion cleared the newer in-flight state")
	}

	second <- &api.NetworkError{Cause: errors.New("newest")}
	h.waitForResult(t)
	if !h.tt.HasText(NetworkMessage) {
		t.Errorf("newer completion did not render: %q", h.tt.Texts())
	}
}

func TestLoginCloseIgnoresLateResult(t *testing.T) {
	reply := make(chan error, 1)
	started := make(chan struct{})
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		close(started)
		if err := <-reply; err != nil {
			return nil, err
		}
		return &api.LoginResponse{}, nil
	})
	h.enterCredentials(t, "user@example.com", "secret")
	h.tt.Click("登录")
	<-started
	h.page.Close()
	reply <- nil
	select {
	case result := <-h.mainWork:
		result()
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for late result")
	}
	h.tt.Frame()
	if h.tt.HasText(NavigationUnavailableMessage) || h.tt.HasText(DefaultLoginErrorMessage) {
		t.Errorf("late result changed a closed page: %q", h.tt.Texts())
	}
	if h.page.RouterPath() == HomeRoute {
		t.Error("late result navigated home after Close")
	}
	if h.page.inFlight {
		t.Error("closed page remained in flight")
	}
}

func TestLoginClosePreventsNewSubmit(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return &api.LoginResponse{}, nil
	})
	h.enterCredentials(t, "user@example.com", "secret")
	h.page.Close()
	h.tt.Frame()
	h.tt.Click("登录")
	if h.callCount() != 0 {
		t.Errorf("closed page started %d login requests", h.callCount())
	}
}

func TestLoginViewAfterCloseDoesNotPanic(t *testing.T) {
	h := newTestLogin(t, nil)
	h.page.Close()
	h.tt.Frame()
	if !h.tt.HasText("登录工作台") {
		t.Errorf("closed page frame is not renderable: %q", h.tt.Texts())
	}
}

func TestLoginEnterSubmits(t *testing.T) {
	started := make(chan struct{})
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		close(started)
		return &api.LoginResponse{}, nil
	})
	h.tt.Click("邮箱")
	h.tt.Type("user@example.com")
	h.tt.Key(0, ui.KeyTab)
	h.tt.Type("secret")
	h.tt.Frame()
	if !h.tt.Focused("密码") {
		t.Fatal("password field was not settled before Enter")
	}
	h.tt.Key(0, ui.KeyEnter)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("Enter did not start login")
	}
	if h.callCount() != 1 {
		t.Fatalf("login called %d times, want 1", h.callCount())
	}
}

func TestLoginSuccessNavigatesHome(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return &api.LoginResponse{}, nil
	})
	h.tt.Click("邮箱")
	h.tt.Type("user@example.com")
	h.tt.Click("密码")
	h.tt.Type("secret")
	h.tt.Click("登录")
	h.waitForResult(t)
	h.tt.Frame()
	if h.page.RouterPath() != HomeRoute {
		t.Errorf("router path = %q, want %q", h.page.RouterPath(), HomeRoute)
	}
}

func TestLoginSuccessWithoutRouterShowsFailure(t *testing.T) {
	h := newTestLoginWithoutRouter(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return &api.LoginResponse{}, nil
	})
	h.enterCredentials(t, "user@example.com", "secret")
	h.tt.Click("登录")
	h.waitForResult(t)
	h.tt.Frame()
	if h.page.inFlight {
		t.Error("page remained in flight without a router")
	}
	if !errors.Is(h.page.LastError(), ErrNavigationUnavailable) {
		t.Errorf("last error = %v, want ErrNavigationUnavailable", h.page.LastError())
	}
	if !h.tt.HasText(NavigationUnavailableMessage) {
		t.Errorf("missing navigation failure %q in %q", NavigationUnavailableMessage, h.tt.Texts())
	}
}

func TestLoginSuccessUsesContextRouterFallback(t *testing.T) {
	router := ui.NewRouter("/")
	login := func(context.Context, string, string) (*api.LoginResponse, error) {
		return &api.LoginResponse{}, nil
	}
	mainWork := make(chan func(), 8)
	page := NewLoginPage(LoginOptions{
		Login:  login,
		Update: func(fn func()) { mainWork <- fn },
		// Deliberately nil: the page must use Context.Router().
		Router: nil,
	})
	tt := ui.NewTester(func(c *ui.Context) {
		router.View(c, func(*ui.Route) {
			page.View(c)
		})
	}, DefaultWidth, DefaultHeight)
	tt.Click("邮箱")
	tt.Type("user@example.com")
	tt.Click("密码")
	tt.Type("secret")
	tt.Click("登录")
	select {
	case fn := <-mainWork:
		fn()
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for context-router login result")
	}
	tt.Frame()
	if got := router.Path(); got != HomeRoute {
		t.Errorf("context router path = %q, want %q", got, HomeRoute)
	}
	if page.LastError() != nil {
		t.Errorf("context router fallback left error %v", page.LastError())
	}
}

func TestLoginSessionPersistFailureMapsToStableMessage(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return nil, fmt.Errorf("persist: %w", api.ErrSessionPersist)
	})
	h.enterCredentials(t, "user@example.com", "secret")
	h.tt.Click("登录")
	h.waitForResult(t)
	if !h.tt.HasText(SessionErrorMessage) {
		t.Errorf("missing session persistence message %q in %q", SessionErrorMessage, h.tt.Texts())
	}
	if !errors.Is(h.page.LastError(), api.ErrSessionPersist) {
		t.Errorf("last error = %v, want ErrSessionPersist", h.page.LastError())
	}
}

func TestLoginRealClientPersistFailureMapsToStableMessage(t *testing.T) {
	client, err := api.NewClient(api.ClientConfig{
		BaseURL:  "http://gateway.test",
		ClientID: "client-uuid",
		HTTPClient: pageStubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(`{
					"id":"42",
					"name":"yawei",
					"email":"yawei@example.com",
					"is_admin":false,
					"is_active":true,
					"role_type":"operator",
					"session_id":"session-1",
					"api_key":"api-key-value"
				}`)),
			}, nil
		}},
		Sessions: pageFailingSessionStore{err: errors.New("keychain unavailable")},
	})
	if err != nil {
		t.Fatal(err)
	}
	h := newTestLogin(t, ClientLogin(client))
	h.enterCredentials(t, "user@example.com", "secret")
	h.tt.Click("登录")
	h.waitForResult(t)
	if !h.tt.HasText(SessionErrorMessage) {
		t.Errorf("missing session persistence message %q in %q", SessionErrorMessage, h.tt.Texts())
	}
}

type pageStubHTTPClient struct {
	fn func(*http.Request) (*http.Response, error)
}

func (s pageStubHTTPClient) Do(req *http.Request) (*http.Response, error) {
	return s.fn(req)
}

type pageFailingSessionStore struct {
	err error
}

func (s pageFailingSessionStore) Load(context.Context) (auth.Session, string, error) {
	return auth.Session{}, "", auth.ErrNoSession
}

func (s pageFailingSessionStore) Save(context.Context, auth.Session, string) error {
	return s.err
}

func (s pageFailingSessionStore) Clear(context.Context) error {
	return nil
}

func TestLoginMalformedResponseUsesGenericMessage(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return nil, fmt.Errorf("decode: %w", api.ErrInvalidLogin)
	})
	h.enterCredentials(t, "user@example.com", "secret")
	h.tt.Click("登录")
	h.waitForResult(t)
	if !h.tt.HasText(DefaultLoginErrorMessage) {
		t.Errorf("malformed response should use the generic login message: %q", h.tt.Texts())
	}
}

func TestLoginErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "unauthorized",
			err:  &api.HTTPError{StatusCode: http.StatusUnauthorized},
			want: "邮箱或密码不正确",
		},
		{
			name: "forbidden",
			err:  &api.HTTPError{StatusCode: http.StatusForbidden},
			want: "当前账号无权登录，请联系管理员",
		},
		{
			name: "rate limited with retry after",
			err:  &api.HTTPError{StatusCode: http.StatusTooManyRequests, RetryAfter: 15 * time.Second},
			want: "登录尝试过于频繁，请在 15 秒后重试",
		},
		{
			name: "network",
			err:  &api.NetworkError{Cause: errors.New("connection refused")},
			want: "无法连接服务器，请检查网络后重试",
		},
		{
			name: "unknown",
			err:  errors.New("boom"),
			want: "登录失败，请稍后重试",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
				return nil, test.err
			})
			h.tt.Click("邮箱")
			h.tt.Type("user@example.com")
			h.tt.Click("密码")
			h.tt.Type("secret")
			h.tt.Click("登录")
			h.waitForResult(t)
			if !h.tt.HasText(test.want) {
				t.Errorf("missing %q in %q", test.want, h.tt.Texts())
			}
			if test.name == "unauthorized" {
				if h.page.passwordErr == "" {
					t.Error("credential error not shown below the password field")
				}
			}
			if strings.Contains(strings.Join(h.tt.Texts(), "\n"), "secret") {
				t.Error("renderer exposed the password")
			}
		})
	}
}

func TestLoginErrorBannerHasVisibleBackground(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return nil, &api.NetworkError{Cause: errors.New("offline")}
	})
	h.tt.Click("邮箱")
	h.tt.Type("user@example.com")
	h.tt.Click("密码")
	h.tt.Type("secret")
	h.tt.Click("登录")
	h.waitForResult(t)
	rect, ok := h.tt.Find(NetworkMessage)
	if !ok {
		t.Fatalf("missing banner text %q", NetworkMessage)
	}
	img := h.tt.Image()
	if img == nil {
		t.Fatal("no rendered frame")
	}
	x, y := int(rect.X)+2, int(rect.Y+rect.H/2)
	if x < 0 || y < 0 || x >= img.Bounds().Dx() || y >= img.Bounds().Dy() {
		t.Fatalf("banner point (%d,%d) outside image %v", x, y, img.Bounds())
	}
	got := img.RGBAAt(x, y)
	if got.R == img.RGBAAt(x, 0).R && got.G == img.RGBAAt(x, 0).G && got.B == img.RGBAAt(x, 0).B {
		t.Errorf("banner background equals page background: %v", got)
	}
}

func TestLoginRateLimitWithoutRetryAfter(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return nil, &api.HTTPError{StatusCode: http.StatusTooManyRequests}
	})
	h.tt.Click("邮箱")
	h.tt.Type("user@example.com")
	h.tt.Click("密码")
	h.tt.Type("secret")
	h.tt.Click("登录")
	h.waitForResult(t)
	if !h.tt.HasText(RateLimitedMessage) {
		t.Errorf("missing rate limit error %q in %q", RateLimitedMessage, h.tt.Texts())
	}
}

func TestLoginEditsClearStaleCredentialError(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return nil, &api.HTTPError{StatusCode: http.StatusUnauthorized}
	})
	h.tt.Click("邮箱")
	h.tt.Type("user@example.com")
	h.tt.Click("密码")
	h.tt.Type("wrong")
	h.tt.Click("登录")
	h.waitForResult(t)
	if h.page.passwordErr == "" {
		t.Fatal("credential error was not set")
	}
	h.tt.Click("密码")
	h.tt.Type("!")
	if h.page.passwordErr != "" {
		t.Errorf("stale password error = %q after typing", h.page.passwordErr)
	}
	if h.tt.HasText(UnauthorizedMessage) {
		t.Errorf("stale banner remains: %q", h.tt.Texts())
	}
}

func TestLoginEmailEditClearsCredential401(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return nil, &api.HTTPError{StatusCode: http.StatusUnauthorized}
	})
	h.enterCredentials(t, "user@example.com", "wrong")
	h.tt.Click("登录")
	h.waitForResult(t)
	if h.page.passwordErr != UnauthorizedMessage {
		t.Fatalf("password error = %q, want credential error", h.page.passwordErr)
	}

	h.tt.Click("邮箱")
	h.tt.Type("!")
	if h.page.passwordErr != "" {
		t.Errorf("email edit left credential error %q", h.page.passwordErr)
	}
	if h.page.LastError() != nil {
		t.Errorf("email edit left last error %v", h.page.LastError())
	}
	if h.tt.HasText(UnauthorizedMessage) {
		t.Errorf("email edit left credential banner: %q", h.tt.Texts())
	}
}

func TestLoginPasswordEditClearsCredential401(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return nil, &api.HTTPError{StatusCode: http.StatusUnauthorized}
	})
	h.enterCredentials(t, "user@example.com", "wrong")
	h.tt.Click("登录")
	h.waitForResult(t)
	if h.page.passwordErr != UnauthorizedMessage {
		t.Fatalf("password error = %q, want credential error", h.page.passwordErr)
	}

	h.tt.Click("密码")
	h.tt.Type("!")
	if h.page.passwordErr != "" {
		t.Errorf("password edit left credential error %q", h.page.passwordErr)
	}
	if h.page.LastError() != nil {
		t.Errorf("password edit left last error %v", h.page.LastError())
	}
	if h.tt.HasText(UnauthorizedMessage) {
		t.Errorf("password edit left credential banner: %q", h.tt.Texts())
	}
}

func TestLoginEditsClearBanners(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "forbidden", err: &api.HTTPError{StatusCode: http.StatusForbidden}, want: ForbiddenMessage},
		{name: "network", err: &api.NetworkError{Cause: errors.New("offline")}, want: NetworkMessage},
		{name: "rate limited", err: &api.HTTPError{StatusCode: http.StatusTooManyRequests}, want: RateLimitedMessage},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
				return nil, test.err
			})
			h.enterCredentials(t, "user@example.com", "wrong")
			h.tt.Click("登录")
			h.waitForResult(t)
			if !h.tt.HasText(test.want) {
				t.Fatalf("missing %q before edit", test.want)
			}
			h.tt.Click("邮箱")
			h.tt.Type("!")
			if h.tt.HasText(test.want) {
				t.Errorf("banner %q remained after email edit: %q", test.want, h.tt.Texts())
			}
		})
	}
}

func TestLoginEditsClearValidationErrors(t *testing.T) {
	h := newTestLogin(t, nil)
	h.tt.Click("登录")
	if !h.tt.HasText(EmailRequiredMessage) || !h.tt.HasText(PasswordRequiredMessage) {
		t.Fatalf("missing validation errors: %q", h.tt.Texts())
	}
	h.tt.Click("邮箱")
	h.tt.Type("user@example.com")
	if h.tt.HasText(EmailRequiredMessage) {
		t.Errorf("email error remained after edit: %q", h.tt.Texts())
	}
	h.tt.Click("密码")
	h.tt.Type("secret")
	if h.tt.HasText(PasswordRequiredMessage) || h.tt.HasText(EmailRequiredMessage) {
		t.Errorf("validation errors remained after edits: %q", h.tt.Texts())
	}
}

func TestLoginRejectsInvalidEmailBeforeCallingLogin(t *testing.T) {
	called := false
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		called = true
		return &api.LoginResponse{}, nil
	})
	h.tt.Click("邮箱")
	h.tt.Type("user@localhost")
	h.tt.Click("密码")
	h.tt.Type("secret")
	h.tt.Click("登录")
	if called {
		t.Error("login called for a syntactically invalid email")
	}
	if !h.tt.HasText(EmailInvalidMessage) {
		t.Errorf("missing invalid email error %q in %q", EmailInvalidMessage, h.tt.Texts())
	}
}

func TestLoginDoesNotExposePassword(t *testing.T) {
	h := newTestLogin(t, nil)
	secret := "correct-horse-" + "battery-staple-9f8e7d6c"
	h.tt.Click("密码")
	h.tt.Type(secret)
	for _, text := range h.tt.Texts() {
		if strings.Contains(text, secret) {
			t.Fatalf("rendered password text %q", text)
		}
	}
	if h.page.Password() != secret {
		t.Error("password input did not keep its value for submission")
	}
	if err := h.tt.Click("邮箱"); err != nil {
		t.Fatalf("password field is not operable: %v", err)
	}
	h.tt.Key(0, ui.KeyTab)
	if !h.tt.Focused("密码") {
		t.Error("password field is not reachable by Tab")
	}
}

func TestLoginAccessibleNamesAvailableToTester(t *testing.T) {
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		return &api.LoginResponse{}, nil
	})
	for _, label := range []string{"登录工作台", "邮箱", "密码", "登录"} {
		if _, ok := h.tt.Find(label); !ok {
			t.Errorf("missing accessible-visible name %q", label)
		}
	}
	// Tester v0.6.4 has no exported accessibility-tree API. These strongest
	// available checks cover discoverable labels and focusable controls; the
	// Password role and hidden value require a manual VoiceOver check.
}

func TestLoginSpinnerAccessibleName(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	h := newTestLogin(t, func(context.Context, string, string) (*api.LoginResponse, error) {
		close(started)
		<-release
		return &api.LoginResponse{}, nil
	})
	h.enterCredentials(t, "user@example.com", "secret")
	h.tt.Click("登录")
	<-started
	if _, ok := h.tt.Find("正在登录…"); !ok {
		t.Errorf("spinner accessible name missing: %q", h.tt.Texts())
	}
	close(release)
	h.waitForResult(t)
}

func TestClientLoginAdapter(t *testing.T) {
	if ClientLogin(nil) != nil {
		t.Fatal("nil client should produce a nil login function")
	}
}

func TestLoginTabOrder(t *testing.T) {
	h := newTestLogin(t, nil)
	if !h.tt.Focused("邮箱") {
		t.Fatal("email should start focused")
	}
	h.tt.Key(0, ui.KeyTab)
	if !h.tt.Focused("密码") {
		t.Fatalf("first Tab should focus password, texts=%q", h.tt.Texts())
	}
	h.tt.Key(0, ui.KeyTab)
	if !h.tt.Focused("登录") {
		t.Errorf("second Tab should focus login button, texts=%q", h.tt.Texts())
	}
}
