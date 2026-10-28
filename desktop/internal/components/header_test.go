package components

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestHeaderShowsContextAndLogsOut(t *testing.T) {
	loggedOut := false
	tt := ui.NewTester(func(c *ui.Context) {
		Header(c, HeaderOptions{
			Title:      "首页",
			Breadcrumb: "工作台 / 首页",
			UserName:   "林晓",
			UserRole:   "管理员",
			Project:    "北美站",
			OnLogout: func() {
				loggedOut = true
			},
		})
	}, 1120, 760)

	for _, text := range []string{"首页", "工作台 / 首页", "北美站", "林晓", "管理员"} {
		if !tt.HasText(text) {
			t.Errorf("missing %q in %q", text, tt.Texts())
		}
	}
	if err := tt.Click("林晓"); err != nil {
		t.Fatal(err)
	}
	if menu := tt.Menu(); len(menu) != 1 || menu[0] != "退出登录" {
		t.Fatalf("user menu = %q", menu)
	}
	if err := tt.ChooseMenuItem("退出登录"); err != nil {
		t.Fatal(err)
	}
	if !loggedOut {
		t.Error("logout was not called")
	}
}

func TestHeaderProjectSelection(t *testing.T) {
	var selectedProject int
	projects := []ProjectChoice{
		{ID: 1, Name: "北美站"},
		{ID: 2, Name: "欧洲站"},
	}
	tt := ui.NewTester(func(c *ui.Context) {
		Header(c, HeaderOptions{
			Title:           "首页",
			Project:         "北美站",
			Projects:        projects,
			SelectedProject: 1,
			OnProjectChange: func(id int) {
				selectedProject = id
			},
		})
	}, 1120, 760)
	if err := tt.Click("北美站"); err != nil {
		t.Fatal(err)
	}
	if menu := tt.Menu(); len(menu) != 2 || menu[0] != "北美站" || menu[1] != "欧洲站" {
		t.Fatalf("project menu = %q", menu)
	}
	if err := tt.ChooseMenuItem("欧洲站"); err != nil {
		t.Fatal(err)
	}
	if selectedProject != 2 {
		t.Errorf("selected project = %d, want 2", selectedProject)
	}
}
