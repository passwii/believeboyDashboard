package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

const BrandPanelRatio float32 = 0.46

// BrandPanel draws the login page's left panel for a window width.
func BrandPanel(c *ui.Context, windowWidth float32) ui.Element {
	p := design.PaletteFromTheme(c.Theme())
	panel := ui.Column(c).
		Width(windowWidth*BrandPanelRatio).
		FillHeight().
		Padding(56, 52).
		Gap(20).
		Justify(ui.End).
		AlignItems(ui.Start).
		Role(ui.RoleGroup).
		Label("BelieveBoy 桌面工作台")
	panel.Background(p.BrandPanel)

	panel.Children(func() {
		ui.Text(c, "BelieveBoy").
			FontSize(52).
			Bold().
			TextColor(p.BrandInk).
			Label("BelieveBoy")
		ui.Text(c, "统一管理项目、运营与财务数据").
			FontSize(24).
			TextColor(p.BrandInk).
			MaxWidth(440).
			Label("统一管理项目、运营与财务数据")
		ui.Text(c, "品牌、运营与财务数据在同一个原生工作台汇合；不打开网页，也不依赖浏览器会话。").
			FontSize(15).
			TextColor(p.BrandMuted).
			MaxWidth(430)
		ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
			ui.Box(c).
				Size(9, 9).
				Radius(5).
				Background(p.Success).
				Role(ui.RoleNone)
			ui.Text(c, "本地原生客户端").
				FontSize(13).
				TextColor(p.BrandAccent)
		})
	})
	return panel
}
