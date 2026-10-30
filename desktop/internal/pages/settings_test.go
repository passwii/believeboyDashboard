package pages

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
)

func TestSettingsPageShowsRuntimeAndSavedGateway(t *testing.T) {
	page := NewSettingsPage(SettingsOptions{
		RuntimeURL: "http://127.0.0.1:8200",
		CurrentURL: "https://gateway.example.test",
	})
	tt := ui.NewTester(page.Content, DefaultWidth, DefaultHeight)

	if !tt.HasText("Gateway 设置") || !tt.HasText("当前运行 Gateway") ||
		!tt.HasText("http://127.0.0.1:8200") || !tt.HasText("https://gateway.example.test") {
		t.Fatalf("settings texts = %q", tt.Texts())
	}
	if !tt.HasText("保存后需重启应用") {
		t.Fatalf("restart notice missing: %q", tt.Texts())
	}
	if !tt.HasText("连接状态：未测试") {
		t.Fatalf("initial connection status missing: %q", tt.Texts())
	}
}

func TestSettingsPageRejectsNonHTTPGatewayURLWithNativeError(t *testing.T) {
	saved := false
	page := NewSettingsPage(SettingsOptions{
		CurrentURL: "https://gateway.example.test",
		SaveGateway: func(context.Context, string) (string, error) {
			saved = true
			return "", nil
		},
	})
	page.inputURL = "ftp://gateway.example.test"
	tt := ui.NewTester(page.Content, DefaultWidth, DefaultHeight)
	tt.Frame()
	if err := tt.Click("保存设置"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()

	if saved {
		t.Error("invalid URL was saved")
	}
	if !tt.HasText("必须使用 http:// 或 https://") {
		t.Fatalf("validation error missing: %q", tt.Texts())
	}
}

func TestSettingsPageNormalizesAndSavesGateway(t *testing.T) {
	work := make(chan func(), 4)
	received := make(chan string, 1)
	page := NewSettingsPage(SettingsOptions{
		CurrentURL: "https://old.example.test",
		Update:     func(fn func()) { work <- fn },
		SaveGateway: func(_ context.Context, raw string) (string, error) {
			received <- raw
			return raw, nil
		},
	})
	page.inputURL = "  https://new.example.test/  "
	tt := ui.NewTester(page.Content, DefaultWidth, DefaultHeight)
	tt.Frame()
	if err := tt.Click("保存设置"); err != nil {
		t.Fatal(err)
	}

	select {
	case raw := <-received:
		if raw != "https://new.example.test" {
			t.Fatalf("saved URL = %q", raw)
		}
	case <-time.After(time.Second):
		t.Fatal("save callback was not called")
	}
	applyNextUpdate(t, work)
	tt.Frame()

	if !tt.HasText("已保存，重启应用后生效") {
		t.Fatalf("save confirmation missing: %q", tt.Texts())
	}
	if page.InputURL() != "https://new.example.test" {
		t.Errorf("input URL = %q", page.InputURL())
	}
	if page.CurrentURL() != "https://new.example.test" {
		t.Errorf("current URL = %q", page.CurrentURL())
	}
}

func TestSettingsPageTestsConnection(t *testing.T) {
	work := make(chan func(), 4)
	page := NewSettingsPage(SettingsOptions{
		CurrentURL: "https://gateway.example.test",
		Update:     func(fn func()) { work <- fn },
		TestGateway: func(context.Context, string) (api.ConnectionInfo, error) {
			return api.ConnectionInfo{Status: "ok", Version: "1.2.3"}, nil
		},
	})
	tt := ui.NewTester(page.Content, DefaultWidth, DefaultHeight)
	tt.Frame()
	if err := tt.Click("测试连接"); err != nil {
		t.Fatal(err)
	}
	if !tt.HasText("正在测试连接") {
		t.Fatalf("loading status missing: %q", tt.Texts())
	}
	applyNextUpdate(t, work)
	tt.Frame()

	if !tt.HasText("连接成功") || !tt.HasText("服务状态：ok") || !tt.HasText("版本：1.2.3") {
		t.Fatalf("connection result missing: %q", tt.Texts())
	}
}

func TestSettingsPageShowsNativeConnectionError(t *testing.T) {
	work := make(chan func(), 4)
	page := NewSettingsPage(SettingsOptions{
		CurrentURL: "https://gateway.example.test",
		Update:     func(fn func()) { work <- fn },
		TestGateway: func(context.Context, string) (api.ConnectionInfo, error) {
			return api.ConnectionInfo{}, &api.NetworkError{Cause: errors.New("offline")}
		},
	})
	tt := ui.NewTester(page.Content, DefaultWidth, DefaultHeight)
	tt.Frame()
	if err := tt.Click("测试连接"); err != nil {
		t.Fatal(err)
	}
	applyNextUpdate(t, work)
	tt.Frame()

	if !tt.HasText("无法连接 Gateway，请检查地址与网络后重试") {
		t.Fatalf("network error missing: %q", tt.Texts())
	}
}

func applyNextUpdate(t *testing.T, work <-chan func()) {
	t.Helper()
	select {
	case fn := <-work:
		fn()
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for UI update")
	}
}
