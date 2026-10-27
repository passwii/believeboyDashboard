package pages

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/components"
)

const (
	DefaultWidth  = 1120
	DefaultHeight = 760
	MinWidth      = 1000
	MinHeight     = 700

	HomeRoute = "/home"

	EmailRequiredMessage         = "请输入邮箱"
	EmailInvalidMessage          = "请输入有效邮箱"
	PasswordRequiredMessage      = "请输入密码"
	DefaultLoginErrorMessage     = "登录失败，请稍后重试"
	UnauthorizedMessage          = "邮箱或密码不正确"
	ForbiddenMessage             = "当前账号无权登录，请联系管理员"
	NetworkMessage               = "无法连接服务器，请检查网络后重试"
	RateLimitedMessage           = "登录尝试过于频繁，请稍后重试"
	RateLimitedWithWaitMessage   = "登录尝试过于频繁，请在 %s后重试"
	BackendUnavailableMessage    = "登录服务暂不可用，请稍后重试"
	SessionErrorMessage          = "登录会话保存失败，请重试"
	UpdateUnavailableMessage     = "登录暂时不可用，请稍后重试"
	NavigationUnavailableMessage = "登录成功但无法进入工作台，请重启客户端"
)

var ErrNavigationUnavailable = errors.New("pages: navigation unavailable")

// LoginFunc performs one login attempt. It runs outside the main thread.
type LoginFunc func(ctx context.Context, email, password string) (*api.LoginResponse, error)

// LoginOptions configures the login page.
type LoginOptions struct {
	Login  LoginFunc
	Update func(func())
	Router *ui.Router
}

// ClientLogin adapts an API client to the page's login function. The caller
// is responsible for publishing the page's result through Window.Update.
func ClientLogin(client *api.Client) LoginFunc {
	if client == nil {
		return nil
	}
	return client.Login
}

type loginResult struct {
	response   *api.LoginResponse
	err        error
	generation uint64
}

// LoginPage owns the state of the native login screen. Keep it on the main
// thread: the login goroutine only queues data for the next view build.
type LoginPage struct {
	email         string
	password      string
	emailErr      string
	passwordErr   string
	banner        string
	inFlight      bool
	login         LoginFunc
	update        func(func())
	router        *ui.Router
	pendingRoute  string
	pendingRouter *ui.Router

	focusEmail        bool
	focusPassword     bool
	credentialError   bool
	emailBounds       ui.Rect
	results           []loginResult
	requestGeneration uint64
	closed            bool
	lastErr           error
}

// NewLoginPage returns a page backed by login.
func NewLoginPage(options LoginOptions) *LoginPage {
	return &LoginPage{login: options.Login, update: options.Update, router: options.Router}
}

// Email returns the current email field value.
func (p *LoginPage) Email() string { return p.email }

// Password returns the current password field value.
func (p *LoginPage) Password() string { return p.password }

// RouterPath returns the login page's router path, if it has one.
func (p *LoginPage) RouterPath() string {
	if p.router == nil {
		return ""
	}
	return p.router.Path()
}

// LastError returns the last stable error applied by the page, if any. Read
// it on the main thread.
func (p *LoginPage) LastError() error { return p.lastErr }

// View builds the login screen.
func (p *LoginPage) View(c *ui.Context) {
	p.applyResults(c)
	focusEmail, focusPassword := p.focusEmail, p.focusPassword
	p.focusEmail, p.focusPassword = false, false

	t := c.Theme()
	width, _ := c.Size()
	ui.Row(c).Fill().Children(func() {
		p.buildPendingNavigation(c)
		components.BrandPanel(c, width)
		ui.Column(c).
			Grow(1).
			FillHeight().
			Justify(ui.Center).
			AlignItems(ui.Stretch).
			Padding(72, 64).
			Children(func() {
				ui.Column(c).
					WidthPercent(100).
					MaxWidth(380).
					MinWidth(0).
					AlignSelf(ui.Center).
					Gap(22).
					Children(func() {
						ui.Text(c, "登录工作台").
							FontSize(30).
							Bold().
							Role(ui.RoleHeading).
							Label("登录工作台")
						ui.Text(c, "使用 BelieveBoy 账号继续。").
							FontSize(14).
							TextColor(t.TextMuted)
						if p.banner != "" {
							errorBanner(c, p.banner)
						}
						ui.Form(c, func() {
							ui.Field(c, "邮箱", func() {
								input := ui.TextInput(c, &p.email).
									Placeholder("name@example.com").
									InputMethod(false).
									Disabled(p.inFlight)
								p.emailBounds = input.Bounds()
								if input.Changed() {
									p.emailErr, p.banner, p.lastErr = "", "", nil
									if p.credentialError {
										p.passwordErr, p.credentialError = "", false
									}
								}
								if focusEmail {
									input.Focus()
								} else if !focusPassword {
									input.AutoFocus()
								}
							}).Error(p.emailErr)
							ui.Field(c, "密码", func() {
								input := ui.TextInput(c, &p.password).
									Password().
									Disabled(p.inFlight).
									OnChange(func() {
										p.passwordErr, p.banner, p.lastErr = "", "", nil
										p.credentialError = false
									}).
									OnTextKey(func(key ui.TextKey) bool {
										if key.Key != ui.KeyEnter || key.Mods != 0 {
											return false
										}
										p.submit(c)
										return true
									})
								if focusPassword {
									input.Focus()
								}
							}).Error(p.passwordErr)
						})
						ui.Row(c).Key("submit-row").Gap(10).AlignItems(ui.Center).Children(func() {
							loginButton(c, p)
						})
					})
			})
	})
}

func loginButton(c *ui.Context, p *LoginPage) {
	label := "登录"
	if p.inFlight {
		label = "登录中"
	}
	button := ui.PrimaryButton(c, label).
		Width(110).
		Disabled(p.inFlight)
	if button.Clicked() {
		p.submit(c)
	}
	if p.inFlight {
		ui.Spinner(c).Label("正在登录…")
	}
}

func errorBanner(c *ui.Context, message string) ui.Element {
	t := c.Theme()
	banner := ui.Row(c).
		FillWidth().
		Padding(12).
		Gap(8).
		AlignItems(ui.Center).
		Background(t.Danger.Alpha(0.08)).
		Border(1, t.Danger.Alpha(0.35)).
		Radius(8).
		Role(ui.RoleStatus).
		Label(message)
	banner.Children(func() {
		ui.Text(c, message).FontSize(13).TextColor(t.Danger)
	})
	return banner
}

func (p *LoginPage) submit(c *ui.Context) {
	if p.inFlight || p.closed {
		return
	}
	p.banner = ""
	p.emailErr = ""
	p.passwordErr = ""
	p.credentialError = false

	email := strings.TrimSpace(p.email)
	p.email = email
	if email == "" {
		p.emailErr = EmailRequiredMessage
	}
	if p.password == "" {
		p.passwordErr = PasswordRequiredMessage
	}
	if p.emailErr != "" {
		p.banner = p.emailErr
	}
	if p.passwordErr != "" && p.banner == "" {
		p.banner = p.passwordErr
	}
	if p.emailErr != "" || p.passwordErr != "" {
		p.focusInvalidField(c, p.emailErr != "", p.passwordErr != "")
		return
	}
	if !validEmail(email) {
		p.emailErr = EmailInvalidMessage
		p.banner = p.emailErr
		p.focusInvalidField(c, true, false)
		return
	}
	if p.login == nil {
		p.banner = DefaultLoginErrorMessage
		return
	}
	if p.update == nil {
		p.banner = UpdateUnavailableMessage
		return
	}

	p.inFlight = true
	p.requestGeneration++
	p.lastErr = nil
	generation := p.requestGeneration
	login := p.login
	password := p.password
	go func() {
		response, err := login(context.Background(), email, password)
		p.update(func() {
			p.results = append(p.results, loginResult{
				response: response, err: err, generation: generation,
			})
		})
	}()
}

// Close marks the page closed. Late login results are ignored.
func (p *LoginPage) Close() {
	p.closed = true
	p.inFlight = false
	p.requestGeneration++
	p.results = nil
	p.pendingRoute, p.pendingRouter = "", nil
}

func (p *LoginPage) focusInvalidField(c *ui.Context, emailInvalid, passwordInvalid bool) {
	switch {
	case emailInvalid:
		p.focusEmail = true
	case passwordInvalid:
		p.focusPassword = true
	}
	c.Services().Invalidate()
}

func (p *LoginPage) applyResults(c *ui.Context) {
	if len(p.results) == 0 {
		return
	}
	results := p.results
	p.results = nil
	for _, result := range results {
		if p.closed || result.generation != p.requestGeneration {
			continue
		}
		p.applyResult(c, result)
		return
	}
}

func (p *LoginPage) applyResult(c *ui.Context, result loginResult) {
	p.inFlight = false
	if result.err != nil {
		p.lastErr = result.err
		message := loginErrorMessage(result.err)
		p.banner = message
		if errors.Is(result.err, api.ErrUnauthorized) {
			p.passwordErr = message
			p.credentialError = true
			p.focusPassword = true
		}
		return
	}
	if result.response == nil {
		return
	}
	router := p.router
	if router == nil {
		router = c.Router()
	}
	if router != nil {
		p.lastErr = nil
		p.pendingRoute = HomeRoute
		p.pendingRouter = router
		return
	}
	p.banner = NavigationUnavailableMessage
	p.lastErr = ErrNavigationUnavailable
}

func (p *LoginPage) buildPendingNavigation(c *ui.Context) {
	if p.pendingRoute == "" {
		return
	}
	route, router := p.pendingRoute, p.pendingRouter
	p.pendingRoute, p.pendingRouter = "", nil
	ui.Box(c).
		Key("login-navigation").
		Size(0, 0).
		Role(ui.RoleNone).
		SetChanged().
		OnChange(func() {
			if router != nil && !p.closed {
				router.Replace(route)
			}
		})
}

func loginErrorMessage(err error) string {
	var httpErr *api.HTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusUnauthorized:
			return UnauthorizedMessage
		case http.StatusForbidden:
			return ForbiddenMessage
		case http.StatusTooManyRequests:
			if httpErr.RetryAfter > 0 {
				return fmt.Sprintf(RateLimitedWithWaitMessage, retryAfterText(httpErr.RetryAfter))
			}
			return RateLimitedMessage
		}
	}
	if errors.Is(err, api.ErrNetwork) {
		return NetworkMessage
	}
	if errors.Is(err, api.ErrUnexpectedStatus) {
		return BackendUnavailableMessage
	}
	if errors.Is(err, api.ErrSessionPersist) {
		return SessionErrorMessage
	}
	if errors.Is(err, api.ErrInvalidLogin) {
		return DefaultLoginErrorMessage
	}
	return DefaultLoginErrorMessage
}

func retryAfterText(delay time.Duration) string {
	seconds := int(delay.Seconds())
	if seconds < 1 {
		seconds = 1
	}
	return fmt.Sprintf("%d 秒", seconds)
}

func validEmail(email string) bool {
	if email == "" || !utf8.ValidString(email) {
		return false
	}
	at := strings.LastIndexByte(email, '@')
	if at <= 0 || at == len(email)-1 || strings.Count(email, "@") != 1 {
		return false
	}
	local, domain := email[:at], email[at+1:]
	if local == "" || domain == "" {
		return false
	}
	if strings.HasPrefix(local, ".") || strings.HasSuffix(local, ".") || strings.Contains(local, "..") {
		return false
	}
	if strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") || strings.Contains(domain, "..") {
		return false
	}
	if !strings.Contains(domain, ".") {
		return false
	}
	for _, r := range email {
		if r <= ' ' || r == 0x7f {
			return false
		}
	}
	return true
}
