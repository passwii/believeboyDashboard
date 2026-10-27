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

func TestDefaultWindowOptionsStaysNative(t *testing.T) {
	opts := defaultWindowOptions(&desktopRuntime{})

	if opts.Content == nil {
		t.Error("window Content is nil")
	}
	if opts.URL != "" {
		t.Errorf("window URL = %q, want empty", opts.URL)
	}
	if opts.Width != 1120 || opts.Height != 760 || opts.MinWidth != 1000 || opts.MinHeight != 700 {
		t.Errorf("window size = %dx%d min %dx%d", opts.Width, opts.Height, opts.MinWidth, opts.MinHeight)
	}
	if opts.StateKey != "main" {
		t.Errorf("StateKey = %q, want main", opts.StateKey)
	}
}

func TestNativeShellViewWithoutBootstrap(t *testing.T) {
	runtime := &desktopRuntime{}
	opts := defaultWindowOptions(runtime)
	if opts.Content == nil {
		t.Fatal("window Content is nil")
	}
	tt := ui.NewTester(runtime.View, 1120, 760)
	if !tt.HasText("应用初始化失败") {
		t.Fatalf("texts = %q", tt.Texts())
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

func TestNativeSourceGuardDistinguishesAPIFromPages(t *testing.T) {
	apiClient := `package sample
const gatewayBaseURL = "http://127.0.0.1:8200"
`
	if violations := nativeSourceViolations(apiClient); len(violations) != 0 {
		t.Errorf("API client violations = %q, want none", violations)
	}

	pageLoader := `package sample
func load(page interface{ LoadHTML(string, string) }) {
	page.LoadHTML("<p>hi</p>", "")
}
`
	violations := nativeSourceViolations(pageLoader)
	if len(violations) != 1 || violations[0] != "LoadHTML(" {
		t.Errorf("page loader violations = %q, want [LoadHTML(]", violations)
	}
}

var nativeSourceForbidden = []string{
	"ui.WebView",
	"WebViewOptions{",
	"NewWebView(",
	"LoadURL(",
	"LoadHTML(",
	"SetFrontend(",
	"mygo://",
}

func nativeSourceViolations(source string) []string {
	var violations []string
	for _, marker := range nativeSourceForbidden {
		if strings.Contains(source, marker) {
			violations = append(violations, marker)
		}
	}
	return violations
}

func TestDesktopSourceStaysNative(t *testing.T) {
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
		for _, marker := range nativeSourceViolations(string(source)) {
			t.Errorf("%s contains web content marker %q", path, marker)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
