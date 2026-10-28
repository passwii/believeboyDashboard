package components

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestBrandPanel(t *testing.T) {
	tt := ui.NewTester(func(c *ui.Context) {
		BrandPanel(c, 1120)
	}, 1120, 760)
	for _, text := range []string{
		"BelieveBoy",
		"统一管理项目、运营与财务数据",
		"本地原生客户端",
	} {
		if !tt.HasText(text) {
			t.Errorf("missing %q from %q", text, tt.Texts())
		}
	}
	title, ok := tt.Find("BelieveBoy")
	if !ok {
		t.Fatal("brand title not found")
	}
	if title.X < 48 || title.X > 56 || title.Y < 200 {
		t.Errorf("brand title bounds = %+v, want padded left panel content", title)
	}
}
