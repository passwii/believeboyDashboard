package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type SidebarItem struct {
	ID       string
	Label    string
	Icon     *ui.SVG
	Enabled  bool
	Selected bool
}

type SidebarGroup struct {
	Label string
	Items []SidebarItem
}

type SidebarOptions struct {
	Groups        []SidebarGroup
	FocusSelected bool
	OnSelect      func(string)
}

// Sidebar is the fixed 224 DIP sub-navigation column.
func Sidebar(c *ui.Context, options SidebarOptions) {
	p := design.Light
	column := ui.Column(c).
		Width(design.SidebarWidth).
		FillHeight().
		Shrink(0).
		Background(p.PanelAlt).
		BorderEndWidth(1).
		BorderColor(p.Line)
	column.Children(func() {
		ui.Row(c).
			Height(design.HeaderHeight).
			FillWidth().
			PaddingX(18).
			AlignItems(ui.Center).
			BorderWidth(0, 0, 1, 0).
			BorderColor(p.Line).
			Children(func() {
				ui.Text(c, "BELIEVEBOY / 工作台").
					FontSize(11).
					FontWeight(600).
					TextColor(p.InkMuted)
			})
		ui.Column(c).
			Grow(1).
			FillWidth().
			Padding(18, 12).
			Gap(18).
			Clip().
			Children(func() {
				for _, group := range options.Groups {
					sidebarGroup(c, options, group)
				}
			})
	})
}

func sidebarGroup(c *ui.Context, options SidebarOptions, group SidebarGroup) {
	p := design.Light
	ui.Column(c).FillWidth().Gap(3).Role(ui.RoleGroup).Label(group.Label).Children(func() {
		ui.Text(c, group.Label).
			FontSize(10).
			FontWeight(600).
			TextColor(p.InkMuted).
			Margin(0, 0, 5, 7)
		for _, item := range group.Items {
			row := ui.Row(c).
				Key("sidebar-" + item.ID).
				FillWidth().
				Height(34).
				PaddingX(9).
				Gap(9).
				AlignItems(ui.Center).
				Radius(3).
				Role(ui.RoleButton).
				Label(item.Label).
				Disabled(!item.Enabled).
				Cursor(ui.CursorPointer)
			textColor := p.Ink
			if !item.Enabled {
				textColor = p.InkMuted.Alpha(0.55)
			}
			if item.Selected {
				row.Background(p.AccentSoft)
				textColor = p.Accent
				if options.FocusSelected {
					row.Focus()
				}
			}
			row.Children(func() {
				ui.Icon(c, item.Icon).Size(16, 16).TextColor(textColor)
				ui.Text(c, item.Label).
					FontSize(13).
					FontWeight(map[bool]int{true: 600, false: 450}[item.Selected]).
					TextColor(textColor).
					Grow(1)
				if !item.Enabled {
					ui.Text(c, "稍后").
						FontSize(9).
						TextColor(p.InkMuted.Alpha(0.8)).
						Background(p.PaperDeep).
						Padding(2, 5).
						Radius(2)
				}
			})
			if row.Clicked() && item.Enabled && options.OnSelect != nil {
				options.OnSelect(item.ID)
			}
		}
	})
}
