package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type RailItem struct {
	ID      string
	Label   string
	Icon    *ui.SVG
	Enabled bool
}

type RailOptions struct {
	Items    []RailItem
	ActiveID string
	OnSelect func(string)
}

// Rail is the fixed 64 DIP business-domain column.
func Rail(c *ui.Context, options RailOptions) {
	p := design.Light
	column := ui.Column(c).
		Width(design.RailWidth).
		FillHeight().
		Shrink(0).
		Background(p.Ink).
		BorderStartWidth(0).
		Role(ui.RoleGroup).
		Label("业务导航")

	column.Children(func() {
		logo := ui.ButtonBase(c).
			Key("rail-logo").
			Width(design.RailWidth).
			Height(design.HeaderHeight).
			Background(p.Accent).
			Radius(0).
			Role(ui.RoleButton).
			Label("BelieveBoy 首页").
			Cursor(ui.CursorPointer)
		logo.Children(func() {
			ui.Text(c, "B").FontSize(18).Bold().TextColor(p.OnInk).Role(ui.RoleNone)
		})
		if logo.Clicked() && options.OnSelect != nil {
			options.OnSelect("home")
		}

		ui.Column(c).
			Grow(1).
			FillWidth().
			PaddingY(12).
			Gap(4).
			AlignItems(ui.Center).
			Clip().
			Children(func() {
				for i := range options.Items {
					railButton(c, options, options.Items[i])
				}
			})

		ui.Box(c).
			Width(40).
			Height(1).
			Background(p.InkMuted.Alpha(0.45))
		ui.Column(c).
			PaddingY(12).
			Gap(4).
			AlignItems(ui.Center).
			Children(func() {
				railButton(c, options, RailItem{
					ID:      "settings",
					Label:   "系统设置",
					Icon:    design.IconSystem,
					Enabled: true,
				})
			})
	})
}

func railButton(c *ui.Context, options RailOptions, item RailItem) {
	p := design.Light
	active := item.ID == options.ActiveID
	background := ui.Color{}
	text := p.InkMuted
	if active {
		background = p.OnInk.Alpha(0.12)
		text = p.OnInk
	}
	button := ui.ButtonBase(c).
		Key("rail-" + item.ID).
		Width(44).
		Height(42).
		Radius(4).
		Background(background).
		AlignItems(ui.Center).
		Justify(ui.Center).
		Role(ui.RoleButton).
		Label(item.Label).
		Tooltip(item.Label).
		Disabled(!item.Enabled).
		Cursor(ui.CursorPointer)
	button.Children(func() {
		ui.Icon(c, item.Icon).Size(21, 21).TextColor(text)
	})
	if active {
		ui.Box(c).
			Key("rail-indicator-" + item.ID).
			Absolute().
			Left(-10).
			Top(10).
			Width(2).
			Height(22).
			Background(p.Accent)
	}
	if button.Clicked() && item.Enabled && options.OnSelect != nil {
		options.OnSelect(item.ID)
	}
}
