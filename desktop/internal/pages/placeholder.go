package pages

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/components"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type PlaceholderOptions struct {
	ActiveID          string
	Title             string
	Breadcrumb        string
	Description       string
	UserName          string
	UserRole          string
	OnNavigate        func(string)
	OnSettings        func()
	OnLogout          func()
	Status            string
	InspectorOpen     bool
	OnToggleInspector func()
}

// PlaceholderPage is a native empty state. It never navigates to a web URL.
func PlaceholderPage(c *ui.Context, options PlaceholderOptions) {
	design.ApplyTheme(c.Theme())
	components.Workbench(c, components.WorkbenchOptions{
		Title:             options.Title,
		Breadcrumb:        options.Breadcrumb,
		ActiveID:          options.ActiveID,
		UserName:          options.UserName,
		UserRole:          options.UserRole,
		Project:           "全部项目",
		OnNavigate:        options.OnNavigate,
		OnSettings:        options.OnSettings,
		OnLogout:          options.OnLogout,
		Status:            options.Status,
		InspectorOpen:     options.InspectorOpen,
		OnToggleInspector: options.OnToggleInspector,
		Main: func(c *ui.Context) {
			p := design.Light
			ui.Column(c).Fill().Padding(48).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
				ui.Column(c).
					Width(460).
					Padding(32).
					Gap(14).
					AlignItems(ui.Center).
					Background(p.Panel).
					Border(1, p.Line).
					Children(func() {
						ui.Box(c).
							Size(48, 48).
							Radius(24).
							Background(p.PaperDeep).
							AlignItems(ui.Center).
							Justify(ui.Center).
							Children(func() {
								ui.Text(c, "7").FontSize(13).FontWeight(650).TextColor(p.Accent)
							})
						ui.Text(c, options.Title).
							FontSize(22).
							FontWeight(650).
							TextColor(p.Ink).
							Role(ui.RoleHeading).
							Level(1)
						ui.Text(c, "功能建设中").
							FontSize(12).
							FontWeight(600).
							TextColor(p.Warning)
						description := options.Description
						if description == "" {
							description = "该模块将在后续迁移阶段提供原生界面，当前不会打开网页。"
						}
						ui.Text(c, description).
							FontSize(12).
							TextColor(p.InkMuted).
							AlignSelf(ui.Center)
					})
			})
		},
		Inspector: func(c *ui.Context) {
			p := design.Light
			ui.Column(c).Fill().Padding(18).Gap(10).Children(func() {
				ui.Text(c, "原生占位").FontSize(13).FontWeight(600).TextColor(p.Ink)
				ui.Text(c, "页面未加载任何 http(s) 内容。").
					FontSize(11).
					TextColor(p.InkMuted)
			})
		},
	})
}
