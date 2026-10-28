package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type WindowTitleBarOptions struct {
	LeftWidth       float32
	LeftBackground  ui.Color
	RightBackground ui.Color
	Left            func(*ui.Context)
	Right           func(*ui.Context)
}

// WindowTitleBar places the app's top controls in the native title bar area.
func WindowTitleBar(c *ui.Context, options WindowTitleBarOptions) ui.Element {
	room := c.TitleBar()
	bar := ui.Row(c).
		FillWidth().
		Height(max(room.Height, design.HeaderHeight)).
		AlignItems(ui.Stretch).
		Role(ui.RoleGroup).
		Label("窗口标题栏").
		DragWindow()
	bar.Children(func() {
		left := ui.Row(c).
			Width(options.LeftWidth).
			FillHeight().
			Padding(0, 12, 0, room.Left+12).
			AlignItems(ui.Center)
		if options.LeftBackground != (ui.Color{}) {
			left.Background(options.LeftBackground)
		}
		left.Children(func() {
			if options.Left != nil {
				options.Left(c)
			}
		})

		right := ui.Row(c).
			Grow(1).
			FillHeight().
			Padding(0, room.Right+12, 0, 12).
			AlignItems(ui.Center)
		if options.RightBackground != (ui.Color{}) {
			right.Background(options.RightBackground)
		}
		right.Children(func() {
			if options.Right != nil {
				options.Right(c)
			}
		})
	})
	return bar
}
