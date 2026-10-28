package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type WorkbenchOptions struct {
	Title             string
	Breadcrumb        string
	ActiveID          string
	UserName          string
	UserRole          string
	Project           string
	Projects          []ProjectChoice
	SelectedProject   int
	OnNavigate        func(string)
	OnProjectChange   func(int)
	OnRefresh         func()
	OnSettings        func()
	OnLogout          func()
	Status            string
	InspectorOpen     bool
	MainPaneWidth     *float32
	OnToggleInspector func()
	Main              func(*ui.Context)
	Inspector         func(*ui.Context)
}

// Workbench composes the shared rail, sidebar, header, content and inspector.
func Workbench(c *ui.Context, options WorkbenchOptions) {
	state := &ShellState{InspectorOpen: options.InspectorOpen}
	Shell(c, ShellOptions{
		State:      state,
		Title:      options.Title,
		Breadcrumb: options.Breadcrumb,
		Sidebar: func(c *ui.Context) {
			Sidebar(c, SidebarOptions{
				ActiveID: options.ActiveID,
				OnSelect: options.OnNavigate,
				Groups: []SidebarGroup{
					{Label: "工作台", Items: []SidebarItem{
						{ID: "home", Label: "首页", Icon: design.IconHome, Enabled: true, Selected: options.ActiveID == "home"},
					}},
					{Label: "业务", Items: []SidebarItem{
						{ID: "projects", Label: "项目管理", Icon: design.IconProjects, Enabled: true, Planned: true, Selected: options.ActiveID == "projects"},
						{ID: "operations", Label: "运营分析", Icon: design.IconOps, Enabled: true, Planned: true, Selected: options.ActiveID == "operations"},
						{ID: "reports", Label: "报表中心", Icon: design.IconReports, Enabled: true, Planned: true, Selected: options.ActiveID == "reports"},
						{ID: "ai", Label: "AI 助手", Icon: design.IconAI, Enabled: true, Planned: true, Selected: options.ActiveID == "ai"},
					}},
					{Label: "系统", Items: []SidebarItem{
						{ID: "settings", Label: "系统设置", Icon: design.IconSystem, Enabled: true, Selected: options.ActiveID == "settings"},
					}},
				},
			})
		},
		Header: func(c *ui.Context) {
			Header(c, HeaderOptions{
				Title:             options.Title,
				Breadcrumb:        options.Breadcrumb,
				UserName:          options.UserName,
				UserRole:          options.UserRole,
				Project:           options.Project,
				Projects:          options.Projects,
				SelectedProject:   options.SelectedProject,
				OnProjectChange:   options.OnProjectChange,
				OnRefresh:         options.OnRefresh,
				OnSettings:        options.OnSettings,
				OnLogout:          options.OnLogout,
				Status:            options.Status,
				InspectorOpen:     options.InspectorOpen,
				OnToggleInspector: options.OnToggleInspector,
			})
		},
		Main:              options.Main,
		Inspector:         options.Inspector,
		MainPaneWidth:     options.MainPaneWidth,
		OnToggleInspector: options.OnToggleInspector,
	})
}
