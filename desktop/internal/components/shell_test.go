package components

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

func TestShellUsesSingleSidebarWithNativeToolbar(t *testing.T) {
	selected := "home"
	var state ShellState
	width := float32(560)
	tt := ui.NewTester(func(c *ui.Context) {
		state.InspectorOpen = false
		Shell(c, ShellOptions{
			State:         &state,
			Title:         "首页",
			Breadcrumb:    "工作台 / 首页",
			MainPaneWidth: &width,
			Sidebar: func(c *ui.Context) {
				Sidebar(c, SidebarOptions{
					ActiveID: selected,
					Groups: []SidebarGroup{{Label: "工作台", Items: []SidebarItem{
						{ID: "home", Label: "首页", Selected: true, Enabled: true},
						{ID: "projects", Label: "项目", Enabled: true},
					}}},
					OnSelect: func(id string) { selected = id },
				})
			},
			Header: func(c *ui.Context) {
				Header(c, HeaderOptions{Title: "首页", Breadcrumb: "工作台 / 首页"})
			},
			Main: func(c *ui.Context) {
				ui.Column(c).Fill().Label("MAIN PANE").Children(func() { ui.Text(c, "MAIN") })
			},
		})
	}, 1120, 760)

	if !tt.HasText("首页") || !tt.HasText("项目") || !tt.HasText("MAIN") {
		t.Fatalf("native workbench missing content: %q", tt.Texts())
	}
	if main := rectFor(t, tt, "MAIN PANE"); main.X < design.SidebarWidth {
		t.Errorf("main pane starts at %.0f, before sidebar ends at %.0f", main.X, design.SidebarWidth)
	}
	if err := tt.Click("项目"); err != nil {
		t.Fatal(err)
	}
	if selected != "projects" {
		t.Errorf("selected route = %q, want projects", selected)
	}
}

func TestShellInspectorUsesResizableSplit(t *testing.T) {
	inspectorOpen := true
	width := float32(560)
	tt := ui.NewTester(func(c *ui.Context) {
		state := &ShellState{InspectorOpen: inspectorOpen}
		Shell(c, ShellOptions{
			State:         state,
			Title:         "项目",
			MainPaneWidth: &width,
			Header: func(c *ui.Context) {
				Header(c, HeaderOptions{
					Title:             "项目",
					InspectorOpen:     inspectorOpen,
					OnToggleInspector: func() { inspectorOpen = !inspectorOpen },
				})
			},
			Main: func(c *ui.Context) {
				ui.Column(c).Fill().Label("MAIN PANE").Children(func() { ui.Text(c, "MAIN") })
			},
			Inspector: func(c *ui.Context) {
				ui.Column(c).Fill().Label("INSPECTOR PANE").Children(func() { ui.Text(c, "INSPECTOR") })
			},
		})
	}, 1000, 700)

	main := rectFor(t, tt, "MAIN PANE")
	inspector := rectFor(t, tt, "INSPECTOR PANE")
	if main.W < 40 || inspector.W < 40 || main.X+main.W > inspector.X || inspector.X+inspector.W > 1000 {
		t.Fatalf("split panes overlap or overflow: main=%+v inspector=%+v", main, inspector)
	}
	if err := tt.Click("检查器"); err != nil {
		t.Fatal(err)
	}
	if inspectorOpen || tt.HasText("INSPECTOR") {
		t.Fatalf("inspector remained open after toolbar toggle: %v %q", inspectorOpen, tt.Texts())
	}
}

func TestShellDividerResizeUpdatesAppWidth(t *testing.T) {
	width := float32(560)
	selected := "home"
	tt := ui.NewTester(func(c *ui.Context) {
		Shell(c, ShellOptions{
			State:         &ShellState{InspectorOpen: true},
			Title:         "项目",
			MainPaneWidth: &width,
			Sidebar: func(c *ui.Context) {
				Sidebar(c, SidebarOptions{
					ActiveID: selected,
					Groups: []SidebarGroup{{Label: "工作台", Items: []SidebarItem{
						{ID: "home", Label: "首页", Enabled: true},
					}}},
				})
			},
			Header: func(c *ui.Context) {
				Header(c, HeaderOptions{Title: "项目"})
			},
			Main: func(c *ui.Context) {
				ui.Column(c).Fill().Label("MAIN PANE").Children(func() { ui.Text(c, "MAIN") })
			},
			Inspector: func(c *ui.Context) {
				ui.Column(c).Fill().Label("INSPECTOR PANE").Children(func() { ui.Text(c, "INSPECTOR") })
			},
		})
	}, 1120, 700)
	if width != 560 {
		t.Fatalf("initial main pane width = %.0f, want 560", width)
	}
	main := rectFor(t, tt, "MAIN PANE")
	inspector := rectFor(t, tt, "INSPECTOR PANE")
	if main.X != design.SidebarWidth {
		t.Fatalf("main starts at %.0f, want sidebar edge %.0f", main.X, design.SidebarWidth)
	}
	if inspector.X <= main.X+main.W {
		t.Fatalf("inspector did not follow main pane: main=%+v inspector=%+v", main, inspector)
	}
	x, y := float32(design.SidebarWidth)+width+3, float32(140)
	tt.Press(x, y)
	tt.Move(x+40, y)
	tt.Release(x+40, y)
	if width != 600 {
		t.Fatalf("dragged split width = %.0f, want 600", width)
	}
}

func TestShellUsesSystemDarkAppearance(t *testing.T) {
	tt := ui.NewTester(func(c *ui.Context) {
		Shell(c, ShellOptions{
			Title: "首页",
			Main: func(c *ui.Context) {
				ui.Text(c, "MAIN")
			},
		})
	}, 480, 320)
	tt.SetDark(true)

	want := ui.DarkTheme().Background
	got := tt.Image().RGBAAt(20, 100)
	if got.R != want.R || got.G != want.G || got.B != want.B {
		t.Fatalf("shell background = %#v, want dark theme background %#v", got, want)
	}
}

func TestShellIntegratesNativeWindowControlsIntoLayout(t *testing.T) {
	var state ShellState
	tt := ui.NewTester(func(c *ui.Context) {
		Shell(c, ShellOptions{
			State: &state,
			Sidebar: func(c *ui.Context) {
				Sidebar(c, SidebarOptions{Groups: []SidebarGroup{{Label: "工作台", Items: []SidebarItem{
					{ID: "home", Label: "首页", Enabled: true, Selected: true},
				}}}})
			},
			Header: func(c *ui.Context) {
				Header(c, HeaderOptions{Title: "首页", OnRefresh: func() {}})
			},
			Main: func(c *ui.Context) {
				ui.Column(c).Fill().Label("MAIN PANE").Children(func() { ui.Text(c, "MAIN") })
			},
		})
	}, 1120, 760)
	tt.SetTitleBar(ui.TitleBar{Height: 32, Left: 80, Right: 20})
	tt.Frame()

	bar := rectFor(t, tt, "窗口标题栏")
	if bar.H < design.HeaderHeight {
		t.Errorf("titlebar height = %.0f, want at least %.0f", bar.H, design.HeaderHeight)
	}
	brand := rectFor(t, tt, "BelieveBoy")
	if brand.X < 92 || brand.X+brand.W > design.SidebarWidth {
		t.Errorf("brand bounds = %+v, want clear of traffic lights within the sidebar title slot", brand)
	}
	main := rectFor(t, tt, "MAIN PANE")
	if main.Y < bar.Y+bar.H {
		t.Errorf("main pane starts at %.0f before titlebar ends at %.0f", main.Y, bar.Y+bar.H)
	}
	if refresh := rectFor(t, tt, "刷新数据"); refresh.X < design.SidebarWidth {
		t.Errorf("toolbar action starts at %.0f before the sidebar edge %.0f", refresh.X, design.SidebarWidth)
	}
}

func rectFor(t *testing.T, tt *ui.Tester, text string) ui.Rect {
	t.Helper()
	r, ok := tt.Find(text)
	if !ok {
		t.Fatalf("missing %q in %q", text, tt.Texts())
	}
	return r
}
