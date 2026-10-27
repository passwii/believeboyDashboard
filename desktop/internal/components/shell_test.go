package components

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestShellFixedColumnsAndCollapsedInspector(t *testing.T) {
	var state ShellState
	tt := ui.NewTester(func(c *ui.Context) {
		Shell(c, ShellOptions{
			State:      &state,
			Title:      "首页",
			Breadcrumb: "工作台 / 首页",
			Rail: func(c *ui.Context) {
				ui.Text(c, "RAIL")
			},
			Sidebar: func(c *ui.Context) {
				ui.Text(c, "SIDEBAR")
			},
			Main: func(c *ui.Context) {
				ui.Text(c, "MAIN")
			},
			Inspector: func(c *ui.Context) {
				ui.Text(c, "INSPECTOR")
			},
		})
	}, 1120, 760)

	if got := state.Metrics; got != (ShellMetrics{Rail: 64, Sidebar: 224, Header: 56, Inspector: 320}) {
		t.Fatalf("metrics = %+v", got)
	}
	rail := rectFor(t, tt, "RAIL")
	sidebar := rectFor(t, tt, "SIDEBAR")
	main := rectFor(t, tt, "MAIN")
	if rail.X != 0 {
		t.Errorf("rail = %+v, want x=0", rail)
	}
	if sidebar.X < 64 || sidebar.X >= 288 {
		t.Errorf("sidebar = %+v, want it between x=64 and x=288", sidebar)
	}
	if main.X < 288 || main.X >= 300 {
		t.Errorf("main x = %.0f, want about 288", main.X)
	}
	if _, ok := tt.Find("INSPECTOR"); ok {
		t.Error("collapsed inspector rendered content")
	}
	if title := rectFor(t, tt, "首页"); title.Y+title.H > ShellHeaderHeight {
		t.Errorf("title = %+v, want it inside the 56 DIP header", title)
	}
}

func TestShellExpandedInspector(t *testing.T) {
	state := ShellState{InspectorOpen: true}
	tt := ui.NewTester(func(c *ui.Context) {
		Shell(c, ShellOptions{
			State: &state,
			Title: "首页",
			Rail: func(c *ui.Context) {
				ui.Text(c, "RAIL")
			},
			Sidebar: func(c *ui.Context) {
				ui.Text(c, "SIDEBAR")
			},
			Main: func(c *ui.Context) {
				ui.Text(c, "MAIN")
			},
			Inspector: func(c *ui.Context) {
				ui.Text(c, "INSPECTOR")
			},
		})
	}, 1120, 760)

	inspector := rectFor(t, tt, "INSPECTOR")
	if inspector.X < 800 || inspector.X >= 812 {
		t.Errorf("inspector = %+v, want it starting at x=800", inspector)
	}
	if inspector.X+inspector.W > 1120 {
		t.Errorf("inspector %+v overflows the window", inspector)
	}
}

func TestShellToggleInspector(t *testing.T) {
	var state ShellState
	tt := ui.NewTester(func(c *ui.Context) {
		Shell(c, ShellOptions{
			State: &state,
			Title: "首页",
			Main: func(c *ui.Context) {
				ui.Text(c, "MAIN")
			},
			Inspector: func(c *ui.Context) {
				ui.Text(c, "INSPECTOR")
			},
		})
	}, 1120, 760)
	if err := tt.Click("显示检查器"); err != nil {
		t.Fatal(err)
	}
	if !state.InspectorOpen || !tt.HasText("INSPECTOR") {
		t.Fatalf("inspector open = %v, texts = %q", state.InspectorOpen, tt.Texts())
	}
	if err := tt.Click("隐藏检查器"); err != nil {
		t.Fatal(err)
	}
	if state.InspectorOpen || tt.HasText("INSPECTOR") {
		t.Fatalf("inspector did not collapse: %v %q", state.InspectorOpen, tt.Texts())
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
