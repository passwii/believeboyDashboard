package pages

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/config"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

const (
	GatewayURLRequiredMessage     = "请输入 Gateway 地址"
	GatewayURLSchemeMessage       = "Gateway 地址必须使用 http:// 或 https://"
	GatewayURLInvalidMessage      = "请输入有效的 Gateway 地址"
	GatewaySaveUnavailableMessage = "保存功能暂不可用"
	GatewayTestUnavailableMessage = "连接测试暂不可用"
	GatewaySaveErrorMessage       = "保存 Gateway 失败，请重试"
	GatewayNetworkErrorMessage    = "无法连接 Gateway，请检查地址与网络后重试"
	GatewaySavedMessage           = "已保存，重启应用后生效"
	GatewayRestartNotice          = "保存后需重启应用，新 Gateway 才会用于登录与数据请求。"
)

type SaveGatewayFunc func(ctx context.Context, rawURL string) (string, error)
type TestGatewayFunc func(ctx context.Context, rawURL string) (api.ConnectionInfo, error)

type SettingsOptions struct {
	RuntimeURL  string
	CurrentURL  string
	SaveGateway SaveGatewayFunc
	TestGateway TestGatewayFunc
	Update      func(func())
}

type settingsResultKind uint8

const (
	settingsSaved settingsResultKind = iota + 1
	settingsTested
)

type settingsResult struct {
	kind       settingsResultKind
	url        string
	connection api.ConnectionInfo
	err        error
	generation uint64
}

// SettingsPage owns the native gateway configuration form. Persistence and
// health checks run outside the UI thread and return through Update.
type SettingsPage struct {
	runtimeURL  string
	currentURL  string
	inputURL    string
	saveGateway SaveGatewayFunc
	testGateway TestGatewayFunc
	update      func(func())

	saving       bool
	testing      bool
	errorMessage string
	notice       string
	connection   api.ConnectionInfo
	lastErr      error
	results      []settingsResult
	generation   uint64
	cancel       context.CancelFunc
	closed       bool
}

func NewSettingsPage(options SettingsOptions) *SettingsPage {
	runtimeURL := strings.TrimSpace(options.RuntimeURL)
	currentURL := strings.TrimSpace(options.CurrentURL)
	if runtimeURL == "" {
		runtimeURL = currentURL
	}
	if currentURL == "" {
		currentURL = runtimeURL
	}
	return &SettingsPage{
		runtimeURL:  runtimeURL,
		currentURL:  currentURL,
		inputURL:    currentURL,
		saveGateway: options.SaveGateway,
		testGateway: options.TestGateway,
		update:      options.Update,
	}
}

func (p *SettingsPage) InputURL() string   { return p.inputURL }
func (p *SettingsPage) CurrentURL() string { return p.currentURL }
func (p *SettingsPage) LastError() error   { return p.lastErr }

func (p *SettingsPage) Close() {
	p.closed = true
	p.generation++
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
	}
	p.results = nil
}

func (p *SettingsPage) Prepare(c *ui.Context) { p.applyResults(c) }

func (p *SettingsPage) Content(c *ui.Context) {
	p.Prepare(c)
	palette := design.PaletteFromTheme(c.Theme())
	ui.Column(c).Fill().Padding(design.PagePaddingY, design.PagePaddingX).Gap(16).Children(func() {
		ui.Column(c).Gap(4).Children(func() {
			ui.Text(c, "Gateway 设置").FontSize(24).FontWeight(600).TextColor(palette.Ink).Role(ui.RoleHeading).Level(1)
			ui.Text(c, "配置桌面端使用的 API 网关。配置仅保存在本机。").
				FontSize(13).
				TextColor(palette.InkMuted)
		})

		ui.Column(c).
			FillWidth().
			MaxWidth(680).
			Padding(20).
			Gap(16).
			Background(palette.Panel).
			Border(1, palette.Line).
			Radius(12).
			Children(func() {
				gatewayValue(c, "当前运行 Gateway", p.runtimeURL)
				gatewayValue(c, "已保存 Gateway", p.currentURL)
				ui.Form(c, func() {
					ui.Field(c, "API Base URL", func() {
						input := ui.TextInput(c, &p.inputURL).
							Placeholder("https://gateway.example.com").
							Disabled(p.saving || p.testing)
						if input.Changed() {
							p.errorMessage = ""
							p.notice = ""
							p.connection = api.ConnectionInfo{}
							p.lastErr = nil
						}
					}).Description("只允许 http:// 或 https://；保存时会去掉末尾斜杠。")
				})
				ui.Text(c, GatewayRestartNotice).FontSize(12).TextColor(palette.Warning).Role(ui.RoleStatus)
				ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
					testButton := ui.Button(c, "测试连接").Disabled(p.saving || p.testing)
					if testButton.Clicked() {
						p.submitTest(c)
					}
					saveLabel := "保存设置"
					if p.saving {
						saveLabel = "保存中"
					}
					saveButton := ui.PrimaryButton(c, saveLabel).Disabled(p.saving || p.testing)
					if saveButton.Clicked() {
						p.submitSave(c)
					}
					if p.saving || p.testing {
						ui.Spinner(c).Label("正在处理 Gateway 配置")
					}
				})
				p.statusView(c)
			})
	})
}

func (p *SettingsPage) Inspector(c *ui.Context) {
	palette := design.PaletteFromTheme(c.Theme())
	ui.Column(c).Fill().Gap(12).Children(func() {
		ui.Text(c, "连接说明").FontSize(14).FontWeight(600).TextColor(palette.Ink).Role(ui.RoleHeading).Level(2)
		ui.Text(c, "测试连接会请求 Gateway 的公开健康检查，不会发送当前账号凭据。").FontSize(12).TextColor(palette.InkMuted)
		ui.Text(c, "保存只更新本机配置；当前窗口仍使用启动时的 Gateway，重启后切换。").FontSize(12).TextColor(palette.InkMuted)
	})
}

func gatewayValue(c *ui.Context, label, value string) {
	palette := design.PaletteFromTheme(c.Theme())
	ui.Column(c).Gap(3).Children(func() {
		ui.Text(c, label).FontSize(10).TextColor(palette.InkMuted)
		ui.Text(c, value).FontSize(13).TextColor(palette.Ink).SingleLine()
	})
}

func (p *SettingsPage) statusView(c *ui.Context) {
	palette := design.PaletteFromTheme(c.Theme())
	switch {
	case p.testing:
		ui.Column(c).Gap(4).Children(func() {
			ui.Text(c, "连接状态：测试中").FontSize(12).TextColor(palette.InkMuted)
			ui.Text(c, "正在测试连接…").FontSize(12).TextColor(palette.InkMuted).Role(ui.RoleStatus)
		})
	case p.saving:
		ui.Column(c).Gap(4).Children(func() {
			ui.Text(c, "连接状态：未测试").FontSize(12).TextColor(palette.InkMuted)
			ui.Text(c, "正在保存 Gateway…").FontSize(12).TextColor(palette.InkMuted).Role(ui.RoleStatus)
		})
	case p.errorMessage != "":
		ui.Column(c).FillWidth().Gap(6).Children(func() {
			ui.Text(c, "连接状态：未通过").FontSize(12).TextColor(palette.Danger)
			errorBanner(c, p.errorMessage)
		})
	case p.connection.Status != "":
		ui.Column(c).FillWidth().Padding(12).Gap(4).Background(palette.Success.Alpha(0.08)).Border(1, palette.Success.Alpha(0.30)).Radius(8).Role(ui.RoleStatus).Children(func() {
			ui.Text(c, "连接状态：正常").FontSize(13).FontWeight(600).TextColor(palette.Success)
			detail := "连接成功 · 服务状态：" + p.connection.Status
			if p.connection.Version != "" {
				detail += " · 版本：" + p.connection.Version
			}
			ui.Text(c, detail).FontSize(12).TextColor(palette.InkMuted)
		})
	case p.notice != "":
		ui.Column(c).Gap(4).Children(func() {
			ui.Text(c, "连接状态：未测试").FontSize(12).TextColor(palette.InkMuted)
			ui.Text(c, p.notice).FontSize(12).TextColor(palette.Success).Role(ui.RoleStatus)
		})
	default:
		ui.Text(c, "连接状态：未测试").FontSize(12).TextColor(palette.InkMuted).Role(ui.RoleStatus)
	}
}

func (p *SettingsPage) submitSave(c *ui.Context) {
	if p.closed || p.saving || p.testing {
		return
	}
	normalized, ok := p.validateInput(c)
	if !ok {
		return
	}
	if p.saveGateway == nil {
		p.fail(nil, GatewaySaveUnavailableMessage)
		c.Services().Invalidate()
		return
	}
	if p.update == nil {
		p.fail(nil, GatewaySaveUnavailableMessage)
		c.Services().Invalidate()
		return
	}

	p.inputURL = normalized
	p.saving = true
	p.errorMessage = ""
	p.notice = ""
	p.connection = api.ConnectionInfo{}
	p.lastErr = nil
	p.generation++
	generation := p.generation
	saveGateway := p.saveGateway
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	go func() {
		savedURL, err := saveGateway(ctx, normalized)
		p.update(func() {
			p.results = append(p.results, settingsResult{
				kind:       settingsSaved,
				url:        savedURL,
				err:        err,
				generation: generation,
			})
		})
	}()
}

func (p *SettingsPage) submitTest(c *ui.Context) {
	if p.closed || p.saving || p.testing {
		return
	}
	normalized, ok := p.validateInput(c)
	if !ok {
		return
	}
	if p.testGateway == nil {
		p.fail(nil, GatewayTestUnavailableMessage)
		c.Services().Invalidate()
		return
	}
	if p.update == nil {
		p.fail(nil, GatewayTestUnavailableMessage)
		c.Services().Invalidate()
		return
	}

	p.inputURL = normalized
	p.testing = true
	p.errorMessage = ""
	p.notice = ""
	p.connection = api.ConnectionInfo{}
	p.lastErr = nil
	p.generation++
	generation := p.generation
	testGateway := p.testGateway
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	go func() {
		info, err := testGateway(ctx, normalized)
		p.update(func() {
			p.results = append(p.results, settingsResult{
				kind:       settingsTested,
				connection: info,
				err:        err,
				generation: generation,
			})
		})
	}()
}

func (p *SettingsPage) validateInput(c *ui.Context) (string, bool) {
	normalized, err := config.NormalizeAPIBaseURL(p.inputURL)
	if err != nil {
		p.lastErr = err
		switch {
		case errors.Is(err, config.ErrUnsupportedAPIBaseURLScheme):
			p.errorMessage = GatewayURLSchemeMessage
		case strings.TrimSpace(p.inputURL) == "":
			p.errorMessage = GatewayURLRequiredMessage
		default:
			p.errorMessage = GatewayURLInvalidMessage
		}
		p.notice = ""
		p.connection = api.ConnectionInfo{}
		c.Services().Invalidate()
		return "", false
	}
	p.inputURL = normalized
	return normalized, true
}

func (p *SettingsPage) fail(err error, message string) {
	p.lastErr = err
	p.errorMessage = message
	p.notice = ""
}

func (p *SettingsPage) applyResults(c *ui.Context) {
	if len(p.results) == 0 {
		return
	}
	results := p.results
	p.results = nil
	for _, result := range results {
		if p.closed || result.generation != p.generation {
			continue
		}
		p.cancel = nil
		switch result.kind {
		case settingsSaved:
			p.saving = false
			if result.err != nil {
				p.fail(result.err, settingsSaveError(result.err))
				continue
			}
			p.currentURL = result.url
			p.inputURL = result.url
			p.notice = GatewaySavedMessage
			p.lastErr = nil
		case settingsTested:
			p.testing = false
			if result.err != nil {
				p.fail(result.err, settingsTestError(result.err))
				continue
			}
			p.connection = result.connection
			p.lastErr = nil
		}
	}
	c.Services().Invalidate()
}

func settingsSaveError(err error) string {
	switch {
	case errors.Is(err, config.ErrUnsupportedAPIBaseURLScheme):
		return GatewayURLSchemeMessage
	case errors.Is(err, config.ErrInvalidAPIBaseURL):
		return GatewayURLInvalidMessage
	default:
		return GatewaySaveErrorMessage
	}
}

func settingsTestError(err error) string {
	var httpErr *api.HTTPError
	switch {
	case errors.Is(err, config.ErrUnsupportedAPIBaseURLScheme):
		return GatewayURLSchemeMessage
	case errors.Is(err, config.ErrInvalidAPIBaseURL):
		return GatewayURLInvalidMessage
	case errors.Is(err, api.ErrNetwork):
		return GatewayNetworkErrorMessage
	case errors.As(err, &httpErr):
		return fmt.Sprintf("Gateway 返回错误（HTTP %d）", httpErr.StatusCode)
	default:
		return "连接测试失败，请检查 Gateway 地址"
	}
}
