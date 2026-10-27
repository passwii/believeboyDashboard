package design

import "testing"

func TestShellTokens(t *testing.T) {
	if RailWidth != 64 || SidebarWidth != 224 || HeaderHeight != 56 || InspectorWidth != 320 {
		t.Fatalf("tokens = %.0f/%.0f/%.0f/%.0f", RailWidth, SidebarWidth, HeaderHeight, InspectorWidth)
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
