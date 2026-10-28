package pages

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestPlaceholderStaysNativeAndNavigates(t *testing.T) {
	var selected string
	tt := ui.NewTester(func(c *ui.Context) {
		PlaceholderPage(c, PlaceholderOptions{
			ActiveID:   "operations",
			Title:      "运营",
			Breadcrumb: "工作台 / 运营",
			UserName:   "林晓",
			UserRole:   "管理员",
			OnNavigate: func(id string) {
				selected = id
			},
		})
	}, DefaultWidth, DefaultHeight)
	if !tt.HasText("暂未开放") || !tt.HasText("该模块将在后续阶段提供原生界面") {
		t.Fatalf("placeholder texts = %q", tt.Texts())
	}
	if err := tt.Click("系统设置"); err != nil {
		t.Fatal(err)
	}
	if selected != "settings" {
		t.Fatalf("selected = %q, want settings", selected)
	}
	if opened := tt.OpenedURLs(); len(opened) != 0 {
		t.Fatalf("opened URLs = %q", opened)
	}
}
