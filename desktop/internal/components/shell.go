package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type ShellMetrics struct {
	Rail      float32
	Sidebar   float32
	Header    float32
	Inspector float32
}

var ShellMetricsDefault = ShellMetrics{
	Rail:      design.RailWidth,
	Sidebar:   design.SidebarWidth,
	Header:    design.HeaderHeight,
	Inspector: design.InspectorWidth,
}

const ShellHeaderHeight = design.HeaderHeight

type ShellState struct {
	InspectorOpen bool
	Metrics       ShellMetrics
}

type ShellOptions struct {
	State      *ShellState
	Title      string
	Breadcrumb string
	Rail       func(*ui.Context)
	Sidebar    func(*ui.Context)
	Header     func(*ui.Context)
	Main       func(*ui.Context)
	Inspector  func(*ui.Context)
}

// Shell composes the fixed rail/sidebar/content/inspector workbench.
func Shell(c *ui.Context, options ShellOptions) ui.Element {
	state := options.State
	if state == nil {
		state = &ShellState{}
	}
	state.Metrics = ShellMetricsDefault
	p := design.Light
	root := ui.Row(c).
		Fill().
		Background(p.Paper).
		Role(ui.RoleGroup).
		Label("应用外壳")

	root.Children(func() {
		if options.Rail != nil {
			ui.Column(c).
				Width(design.RailWidth).
				FillHeight().
				Shrink(0).
				Children(func() {
					options.Rail(c)
				})
		}

		if options.Sidebar != nil {
			ui.Column(c).
				Width(design.SidebarWidth).
				FillHeight().
				Shrink(0).
				Children(func() {
					options.Sidebar(c)
				})
		}

		ui.Column(c).
			Grow(1).
			FillHeight().
			MinWidth(0).
			Children(func() {
				ui.Column(c).Shrink(0).FillWidth().Children(func() {
					if options.Header != nil {
						options.Header(c)
					} else {
						Header(c, HeaderOptions{
							Title:         options.Title,
							Breadcrumb:    options.Breadcrumb,
							InspectorOpen: state.InspectorOpen,
							OnToggleInspector: func() {
								state.InspectorOpen = !state.InspectorOpen
							},
						})
					}
				})
				ui.Row(c).Grow(1).FillWidth().MinHeight(0).Children(func() {
					ui.Column(c).
						Grow(1).
						FillHeight().
						MinWidth(0).
						MinHeight(0).
						Clip().
						Role(ui.RoleGroup).
						Label("主内容区").
						Children(func() {
							if options.Main != nil {
								options.Main(c)
							}
						})
					if state.InspectorOpen && options.Inspector != nil {
						ui.Column(c).
							Width(design.InspectorWidth).
							FillHeight().
							Shrink(0).
							Background(p.Panel).
							BorderStartWidth(1).
							BorderColor(p.Line).
							Role(ui.RoleGroup).
							Label("检查器区域").
							Children(func() {
								options.Inspector(c)
							})
					}
				})
			})
	})
	return root
}
