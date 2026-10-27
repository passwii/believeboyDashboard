package design

import "github.com/egoist/mygo/ui"

const (
	RailWidth      float32 = 64
	SidebarWidth   float32 = 224
	HeaderHeight   float32 = 56
	InspectorWidth float32 = 320

	PagePaddingX float32 = 28
	PagePaddingY float32 = 24
)

// Palette mirrors the V3 Terminal workstation language: graphite chrome,
// warm paper content, and a single operational green accent.
type Palette struct {
	Ink        ui.Color
	InkMuted   ui.Color
	Paper      ui.Color
	PaperDeep  ui.Color
	Panel      ui.Color
	PanelAlt   ui.Color
	Line       ui.Color
	LineSoft   ui.Color
	Accent     ui.Color
	AccentSoft ui.Color
	Success    ui.Color
	Warning    ui.Color
	Danger     ui.Color
	OnInk      ui.Color
}

var Light = Palette{
	Ink:        ui.Hex("#18211D"),
	InkMuted:   ui.Hex("#66716B"),
	Paper:      ui.Hex("#F5F3ED"),
	PaperDeep:  ui.Hex("#EEEAE1"),
	Panel:      ui.Hex("#FFFDF8"),
	PanelAlt:   ui.Hex("#F8F5EE"),
	Line:       ui.Hex("#D8D3C7"),
	LineSoft:   ui.Hex("#E9E4D9"),
	Accent:     ui.Hex("#1F7A57"),
	AccentSoft: ui.Hex("#DCEFE5"),
	Success:    ui.Hex("#2E7D5B"),
	Warning:    ui.Hex("#A86613"),
	Danger:     ui.Hex("#B44335"),
	OnInk:      ui.Hex("#F7F3E9"),
}

func ApplyTheme(theme *ui.Theme) {
	p := Light
	theme.Background = p.Paper
	theme.Surface = p.Panel
	theme.SurfaceHover = p.PanelAlt
	theme.SurfacePressed = p.PaperDeep
	theme.Border = p.Line
	theme.Text = p.Ink
	theme.TextMuted = p.InkMuted
	theme.Accent = p.Accent
	theme.AccentHover = ui.Hex("#176746")
	theme.AccentPressed = ui.Hex("#125438")
	theme.AccentText = p.OnInk
	theme.Danger = p.Danger
	theme.Warning = p.Warning
	theme.Success = p.Success
	theme.Selection = p.Accent.Alpha(0.2)
	theme.Focus = p.Accent.Alpha(0.55)
	theme.Radius = 0
	theme.Spacing = 4
}

func Theme(dark bool) *ui.Theme {
	theme := ui.LightTheme()
	if dark {
		theme = ui.DarkTheme()
	}
	ApplyTheme(theme)
	return theme
}
