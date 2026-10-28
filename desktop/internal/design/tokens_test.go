package design

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestShellTokens(t *testing.T) {
	if SidebarWidth != 240 || HeaderHeight != 48 || DefaultMainPaneWidth != 560 {
		t.Fatalf("tokens = sidebar %.0f/header %.0f/main %.0f", SidebarWidth, HeaderHeight, DefaultMainPaneWidth)
	}
}

func TestIconsParse(t *testing.T) {
	for name, icon := range map[string]interface{ Size() (float32, float32) }{
		"home": IconHome, "projects": IconProjects, "operations": IconOps,
		"reports": IconReports, "ai": IconAI, "system": IconSystem,
	} {
		w, h := icon.Size()
		if w <= 0 || h <= 0 {
			t.Errorf("%s icon size = %.0fx%.0f", name, w, h)
		}
	}
}

func TestPaletteFromThemeFollowsSystemColors(t *testing.T) {
	theme := ui.DarkTheme()
	theme.Background = ui.Hex("#101820")
	theme.Surface = ui.Hex("#1A2631")
	theme.Border = ui.Hex("#334455")
	theme.Text = ui.Hex("#E6EDF3")
	theme.TextMuted = ui.Hex("#9AA8B5")
	theme.Accent = ui.Hex("#5B9BD5")

	palette := PaletteFromTheme(theme)
	if palette.Paper != theme.Background {
		t.Errorf("paper = %#v, want theme background %#v", palette.Paper, theme.Background)
	}
	if palette.Panel != theme.Surface {
		t.Errorf("panel = %#v, want theme surface %#v", palette.Panel, theme.Surface)
	}
	if palette.Line != theme.Border {
		t.Errorf("line = %#v, want theme border %#v", palette.Line, theme.Border)
	}
	if palette.Ink != theme.Text || palette.InkMuted != theme.TextMuted {
		t.Errorf("text colors = %#v/%#v, want %#v/%#v", palette.Ink, palette.InkMuted, theme.Text, theme.TextMuted)
	}
	if palette.Accent != theme.Accent {
		t.Errorf("accent = %#v, want theme accent %#v", palette.Accent, theme.Accent)
	}
	if palette.BrandPanel != BrandPanelColor || palette.BrandInk != BrandInkColor || palette.BrandMuted != BrandMutedColor {
		t.Errorf("brand palette = %#v/%#v/%#v", palette.BrandPanel, palette.BrandInk, palette.BrandMuted)
	}
}
