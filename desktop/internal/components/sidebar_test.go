package components

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestSidebarArrowKeysSelectNextItem(t *testing.T) {
	selected := "home"
	groups := []SidebarGroup{{
		Label: "工作台",
		Items: []SidebarItem{
			{ID: "home", Label: "首页", Enabled: true, Selected: true},
			{ID: "projects", Label: "项目", Enabled: true},
		},
	}}
	tt := ui.NewTester(func(c *ui.Context) {
		Sidebar(c, SidebarOptions{
			ActiveID: selected,
			Groups:   groups,
			OnSelect: func(id string) { selected = id },
		})
	}, 320, 480)

	if err := tt.Click("首页"); err != nil {
		t.Fatal(err)
	}
	if _, ok := tt.Find("主导航"); !ok {
		t.Fatal("native navigation has no accessibility name")
	}
	tt.Key(0, ui.KeyDown)
	if selected != "projects" {
		t.Fatalf("arrow down selected %q, want projects", selected)
	}
}
