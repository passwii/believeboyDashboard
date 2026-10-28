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
	Planned  bool
	Selected bool
}

type SidebarGroup struct {
	Label string
	Items []SidebarItem
}

type SidebarOptions struct {
	ActiveID string
	Groups   []SidebarGroup
	OnSelect func(string)
}

// Sidebar wraps MyGo's source-list navigation.
func Sidebar(c *ui.Context, options SidebarOptions) {
	p := design.PaletteFromTheme(c.Theme())
	selected := options.ActiveID
	if selected == "" {
		for _, group := range options.Groups {
			for _, item := range group.Items {
				if item.Selected {
					selected = item.ID
					break
				}
			}
			if selected != "" {
				break
			}
		}
	}
	column := ui.Column(c).
		Width(design.SidebarWidth).
		FillHeight().
		Shrink(0).
		Background(p.PanelAlt).
		BorderEndWidth(1).
		BorderColor(p.Line)
	column.Children(func() {
		navigation := ui.Sidebar(c, &selected, func() {
			for _, group := range options.Groups {
				ui.SidebarSection(c, group.Label, nil, func() {
					for _, item := range group.Items {
						row := ui.SidebarItem(c, item.ID, item.Icon, item.Label).
							Disabled(!item.Enabled)
						if item.Planned {
							row.Children(func() { ui.Badge(c, "稍后") })
						}
					}
				})
			}
		}).Width(design.SidebarWidth).Grow(1).Label("主导航")
		if navigation.Changed() && options.OnSelect != nil {
			options.OnSelect(selected)
		}
	})
}
