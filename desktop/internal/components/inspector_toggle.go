package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

// InspectorToggle exposes the shell's inspector state as a small native
// icon button placed in a supplied slot.
func InspectorToggle(c *ui.Context, state *ShellState) {
	if state == nil {
		return
	}
	label := "显示检查器"
	if state.InspectorOpen {
		label = "隐藏检查器"
	}
	p := design.Light
	button := ui.ButtonBase(c).
		Key("inspector-toggle").
		Size(28, 28).
		Radius(3).
		Background(p.Paper).
		Border(1, p.Line).
		Role(ui.RoleButton).
		Label(label).
		Tooltip(label).
		Cursor(ui.CursorPointer)
	button.Children(func() {
		ui.Box(c).Size(13, 10).
			Border(1, p.InkMuted).
			Children(func() {
				ui.Box(c).FillWidth().Height(1).Margin(2, 0, 0, 0).Background(p.InkMuted)
			})
	})
	if button.Clicked() {
		state.InspectorOpen = !state.InspectorOpen
	}
}
