package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type ShellOptions struct {
	State             *ShellState
	Title             string
	Breadcrumb        string
	Sidebar           func(*ui.Context)
	Header            func(*ui.Context)
	Main              func(*ui.Context)
	Inspector         func(*ui.Context)
	MainPaneWidth     *float32
	OnToggleInspector func()
}

type ShellState struct {
	InspectorOpen bool
	MainPaneWidth float32
}

// Shell uses one native source-list sidebar, a native toolbar, and an
// adjustable content/inspector split.
func Shell(c *ui.Context, options ShellOptions) ui.Element {
	p := design.PaletteFromTheme(c.Theme())
	state := options.State
	if state == nil {
		state = &ShellState{}
	}
	mainPaneWidth := design.DefaultMainPaneWidth
	if options.MainPaneWidth != nil && *options.MainPaneWidth > 0 {
		mainPaneWidth = *options.MainPaneWidth
	} else if state.MainPaneWidth > 0 {
		mainPaneWidth = state.MainPaneWidth
	} else {
		state.MainPaneWidth = mainPaneWidth
	}
	root := ui.Column(c).
		Fill().
		Background(p.Paper).
		MinWidth(0).
		MinHeight(0).
		Role(ui.RoleGroup).
		Label("应用外壳")

	root.Children(func() {
		WindowTitleBar(c, WindowTitleBarOptions{
			LeftWidth:       design.SidebarWidth,
			LeftBackground:  p.PanelAlt,
			RightBackground: p.Paper,
			Left: func(c *ui.Context) {
				ui.Column(c).Gap(1).Children(func() {
					ui.Text(c, "BelieveBoy").FontSize(12).FontWeight(650).TextColor(p.Ink)
					ui.Text(c, "运营工作台").FontSize(10).TextColor(p.InkMuted)
				})
			},
			Right: func(c *ui.Context) {
				if options.Header != nil {
					options.Header(c)
				} else {
					Header(c, HeaderOptions{
						Title:             options.Title,
						Breadcrumb:        options.Breadcrumb,
						InspectorOpen:     state.InspectorOpen,
						OnToggleInspector: options.OnToggleInspector,
					})
				}
			},
		})

		ui.Row(c).Grow(1).FillWidth().AlignItems(ui.Stretch).MinHeight(0).Children(func() {
			if options.Sidebar != nil {
				options.Sidebar(c)
			}

			ui.Column(c).
				Grow(1).
				FillHeight().
				MinWidth(0).
				Children(func() {
					if state.InspectorOpen && options.Inspector != nil {
						width := mainPaneWidth
						if options.MainPaneWidth != nil {
							width = *options.MainPaneWidth
						} else {
							width = state.MainPaneWidth
						}
						split := ui.Split(c, &width,
							func() { mainContent(c, options.Main) },
							func() { inspectorContent(c, options.Inspector, p) },
						).Grow(1).FillWidth().MinHeight(0)
						if split.Changed() && options.MainPaneWidth != nil {
							*options.MainPaneWidth = width
						} else if split.Changed() {
							state.MainPaneWidth = width
						}
					} else {
						mainContent(c, options.Main)
					}
				})
		})
	})
	return root
}

func mainContent(c *ui.Context, build func(*ui.Context)) {
	ui.Column(c).
		Grow(1).
		FillHeight().
		MinWidth(0).
		MinHeight(0).
		Clip().
		Role(ui.RoleGroup).
		Label("主内容区").
		Children(func() {
			if build != nil {
				build(c)
			}
		})
}

func inspectorContent(c *ui.Context, build func(*ui.Context), palette design.Palette) {
	ui.Column(c).
		Fill().
		MinWidth(0).
		MinHeight(0).
		Padding(18).
		Background(palette.Panel).
		Role(ui.RoleGroup).
		Label("检查器区域").
		Children(func() {
			build(c)
		})
}
