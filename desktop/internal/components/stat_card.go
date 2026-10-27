package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type StatState uint8

const (
	StatLoading StatState = iota
	StatReady
	StatError
	StatIdle
)

type StatCardOptions struct {
	Title   string
	Eyebrow string
	Value   string
	Detail  string
	State   StatState
	Error   string
	Accent  ui.Color
}

// StatCard renders one independently loaded home metric.
func StatCard(c *ui.Context, options StatCardOptions) ui.Element {
	p := design.Light
	accent := options.Accent
	if accent == (ui.Color{}) {
		accent = p.Accent
	}
	card := ui.Column(c).
		FillWidth().
		MinHeight(142).
		Padding(18).
		Gap(10).
		Background(p.Panel).
		Border(1, p.Line).
		Radius(0).
		Role(ui.RoleGroup).
		Label(options.Title)

	card.Children(func() {
		ui.Row(c).
			FillWidth().
			AlignItems(ui.Center).
			Gap(8).
			Children(func() {
				ui.Box(c).Size(7, 7).Radius(4).Background(accent)
				ui.Text(c, options.Title).FontSize(12).FontWeight(600).TextColor(p.Ink)
				if options.Eyebrow != "" {
					ui.Text(c, options.Eyebrow).
						FontSize(9).
						TextColor(p.InkMuted).
						MarginStart(4)
				}
			})
		switch options.State {
		case StatLoading:
			ui.Row(c).Grow(1).AlignItems(ui.Center).Gap(10).Children(func() {
				ui.Spinner(c).Label("加载中")
				ui.Text(c, "加载中").FontSize(12).TextColor(p.InkMuted)
			})
		case StatError:
			message := options.Error
			if message == "" {
				message = "请稍后重试"
			}
			ui.Column(c).Grow(1).Gap(4).Children(func() {
				ui.Text(c, "加载失败").FontSize(16).FontWeight(600).TextColor(p.Danger)
				ui.Text(c, message).FontSize(11).TextColor(p.InkMuted)
			})
		case StatIdle:
			ui.Text(c, "—").FontSize(34).FontWeight(650).TextColor(p.InkMuted)
			if options.Detail != "" {
				ui.Text(c, options.Detail).FontSize(11).TextColor(p.InkMuted)
			}
		default:
			ui.Text(c, options.Value).
				FontSize(34).
				FontWeight(650).
				TextColor(p.Ink).
				FontFeatures("tnum")
			if options.Detail != "" {
				ui.Text(c, options.Detail).FontSize(11).TextColor(p.InkMuted)
			}
		}
	})
	return card
}
