package pages

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
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
		Router: ui.NewRouter("/"),
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
	if !tt.HasText(SessionErrorMessage) {
		t.Errorf("missing configuration error %q in %q", SessionErrorMessage, tt.Texts())
	}
}

func TestLoginRendersBrandAndForm(t *testing.T) {
	h := newTestLogin(t, nil)
	for _, text := range []string{
		"BelieveBoy",
		"品牌",
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
	input := h.page.emailInput.Bounds(h.context)
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
	if err := h.tt.Click("登录中"); err == nil {
		if h.callCount() != 1 {
			t.Errorf("busy click started %d logins, want 1", h.callCount())
		}
	}
	close(release)
	h.waitForResult(t)
	h.tt.Frame()
}

func TestLoginEnterSubmits(t *testing.T) {
	h := newTestLogin(t, nil)
	h.tt.Click("邮箱")
	h.tt.Type("user@example.com")
	h.tt.Key(0, ui.KeyTab)
	h.tt.Type("secret")
	h.tt.Key(0, ui.KeyEnter)
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
	h.tt.Click("密码")
	h.tt.Type("super-secret")
	for _, text := range h.tt.Texts() {
		if strings.Contains(text, "super-secret") {
			t.Fatalf("rendered password text %q", text)
		}
	}
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
