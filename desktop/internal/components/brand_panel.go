package components

import "github.com/egoist/mygo/ui"

const BrandPanelRatio float32 = 0.56

// BrandPanel draws the login page's left panel for a window width.
func BrandPanel(c *ui.Context, windowWidth float32) ui.Element {
	panel := ui.Column(c).
		Width(windowWidth*BrandPanelRatio).
		FillHeight().
		Padding(72, 64).
		Gap(20).
		Justify(ui.End).
		AlignItems(ui.Start).
		Role(ui.RoleGroup).
		Label("BelieveBoy 品牌与客户端状态")
	panel.Background(ui.Hex("#10251F"))

	panel.Children(func() {
		ui.Text(c, "BelieveBoy").
			FontSize(54).
			Bold().
			TextColor(ui.Hex("#F4EAD7")).
			Label("BelieveBoy")
		ui.Text(c, "品牌").
			FontSize(15).
			FontWeight(600).
			TextColor(ui.Hex("#E8B86D")).
			Label("品牌")
		ui.Text(c, "统一管理项目、运营与财务数据").
			FontSize(24).
			TextColor(ui.Hex("#F4EAD7")).
			MaxWidth(440).
			Label("统一管理项目、运营与财务数据")
		ui.Text(c, "品牌、运营与财务数据在同一个原生工作台汇合；不打开网页，也不依赖浏览器会话。").
			FontSize(15).
			TextColor(ui.Hex("#B8C8BF")).
			MaxWidth(430)
		ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
			ui.Box(c).
				Size(9, 9).
				Radius(5).
				Background(ui.Hex("#72C79A")).
				Role(ui.RoleNone)
			ui.Text(c, "本地原生客户端").
				FontSize(13).
				TextColor(ui.Hex("#B8C8BF"))
		})
	})
	return panel
}
