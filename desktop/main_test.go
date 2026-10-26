package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestNativeShellView(t *testing.T) {
	a := &app{}
	tt := ui.NewTester(a.view, 900, 640)

	for _, text := range []string{
		"BelieveBoy",
		"原生工作台",
		"Go Gateway 接入准备中",
	} {
		if !tt.HasText(text) {
			t.Errorf("missing %q in native shell texts %q", text, tt.Texts())
		}
	}
}

func TestMyGoConfiguration(t *testing.T) {
	data, err := os.ReadFile("mygo.json")
	if err != nil {
		t.Fatal(err)
	}

	var config struct {
		Name       string `json:"name"`
		Identifier string `json:"identifier"`
		MacOS      struct {
			MinimumSystemVersion string `json:"minimumSystemVersion"`
		} `json:"macos"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}

	if config.Name != "BelieveBoy" {
		t.Errorf("name = %q", config.Name)
	}
	if config.Identifier != "com.passwii.dashboard.desktop" {
		t.Errorf("identifier = %q", config.Identifier)
	}
	if config.MacOS.MinimumSystemVersion != "13.0" {
		t.Errorf("minimumSystemVersion = %q", config.MacOS.MinimumSystemVersion)
	}
}

func TestDesktopSourceStaysNative(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"ui.WebView", "mygo://", "http://", "https://"} {
		if strings.Contains(string(source), forbidden) {
			t.Errorf("main.go contains web content marker %q", forbidden)
		}
	}
}
