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
	MainPaneWidth     *float32
	OnToggleInspector func()
}

// PlaceholderPage is a native empty state. It never navigates to a web URL.
func PlaceholderPage(c *ui.Context, options PlaceholderOptions) {
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
		MainPaneWidth:     options.MainPaneWidth,
		OnToggleInspector: options.OnToggleInspector,
		Main: func(c *ui.Context) {
			PlaceholderContent(c, options)
		},
		Inspector: func(c *ui.Context) {
			PlaceholderInspectorContent(c, options)
		},
	})
}

func PlaceholderContent(c *ui.Context, options PlaceholderOptions) {
	p := design.PaletteFromTheme(c.Theme())
	description := options.Description
	if description == "" {
		description = "该模块将在后续阶段提供原生界面。"
	}
	ui.Column(c).
		Fill().
		Padding(48).
		Justify(ui.Center).
		AlignItems(ui.Start).
		Children(func() {
			ui.Column(c).
				Width(480).
				MaxWidth(520).
				Gap(14).
				Children(func() {
					ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
						ui.Text(c, options.Title).
							FontSize(26).
							FontWeight(650).
							TextColor(p.Ink).
							Role(ui.RoleHeading).
							Level(1)
						ui.Badge(c, "暂未开放")
					})
					ui.Text(c, description).
						FontSize(14).
						TextColor(p.InkMuted)
				})
		})
}

func PlaceholderInspectorContent(c *ui.Context, options PlaceholderOptions) {
	p := design.PaletteFromTheme(c.Theme())
	description := options.Description
	if description == "" {
		description = "该模块将在后续阶段提供原生界面。"
	}
	ui.Column(c).Fill().Padding(18).Gap(10).Children(func() {
		ui.Text(c, "模块说明").FontSize(13).FontWeight(600).TextColor(p.Ink)
		ui.Text(c, description).
			FontSize(12).
			TextColor(p.InkMuted)
	})
}
