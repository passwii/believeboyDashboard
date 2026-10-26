package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
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

func TestDefaultWindowOptionsStaysNative(t *testing.T) {
	opts := defaultWindowOptions(&app{})

	if opts.Content == nil {
		t.Error("window Content is nil")
	}
	if opts.URL != "" {
		t.Errorf("window URL = %q, want empty", opts.URL)
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

	var rawConfig map[string]json.RawMessage
	if err := json.Unmarshal(data, &rawConfig); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"devUrl",
		"devCommand",
		"buildCommand",
		"frontendDist",
		"bindings",
	} {
		if _, ok := rawConfig[key]; ok {
			t.Errorf("mygo.json contains frontend key %q", key)
		}
	}
}

func TestDesktopSourceStaysNative(t *testing.T) {
	forbidden := []string{
		"ui.WebView",
		"WebViewOptions{",
		"NewWebView(",
		"LoadURL(",
		"LoadHTML(",
		"SetFrontend(",
		"mygo://",
		"http://",
		"https://",
	}
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if path != "." && (entry.Name() == "build" || strings.HasPrefix(entry.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, marker := range forbidden {
			if strings.Contains(string(source), marker) {
				t.Errorf("%s contains web content marker %q", path, marker)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
