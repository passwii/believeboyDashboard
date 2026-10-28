package design

import "github.com/egoist/mygo/ui"

const (
	SidebarWidth         float32 = 240
	HeaderHeight         float32 = 48
	DefaultMainPaneWidth float32 = 560

	PagePaddingX float32 = 28
	PagePaddingY float32 = 24
)

var (
	BrandPanelColor  = ui.Hex("#10251F")
	BrandInkColor    = ui.Hex("#F4EAD7")
	BrandMutedColor  = ui.Hex("#B8C8BF")
	BrandAccentColor = ui.Hex("#E8B86D")
)

type Palette struct {
	Ink         ui.Color
	InkMuted    ui.Color
	Paper       ui.Color
	PaperDeep   ui.Color
	Panel       ui.Color
	PanelAlt    ui.Color
	Line        ui.Color
	LineSoft    ui.Color
	Accent      ui.Color
	AccentSoft  ui.Color
	Success     ui.Color
	Warning     ui.Color
	Danger      ui.Color
	OnInk       ui.Color
	BrandPanel  ui.Color
	BrandInk    ui.Color
	BrandMuted  ui.Color
	BrandAccent ui.Color
}

func PaletteFromTheme(theme *ui.Theme) Palette {
	if theme == nil {
		theme = ui.LightTheme()
	}
	return Palette{
		Ink:         theme.Text,
		InkMuted:    theme.TextMuted,
		Paper:       theme.Background,
		PaperDeep:   theme.SurfacePressed,
		Panel:       theme.Surface,
		PanelAlt:    theme.SurfaceHover,
		Line:        theme.Border,
		LineSoft:    theme.Border,
		Accent:      theme.Accent,
		AccentSoft:  theme.Selection,
		Success:     theme.Success,
		Warning:     theme.Warning,
		Danger:      theme.Danger,
		OnInk:       theme.AccentText,
		BrandPanel:  BrandPanelColor,
		BrandInk:    BrandInkColor,
		BrandMuted:  BrandMutedColor,
		BrandAccent: BrandAccentColor,
	}
}
