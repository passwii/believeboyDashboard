package components

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestStatCardStates(t *testing.T) {
	t.Run("loading", func(t *testing.T) {
		tt := ui.NewTester(func(c *ui.Context) {
			StatCard(c, StatCardOptions{Title: "未读通知", State: StatLoading})
		}, 320, 180)
		if !tt.HasText("未读通知") || !tt.HasText("加载中") {
			t.Fatalf("texts = %q", tt.Texts())
		}
	})
	t.Run("error", func(t *testing.T) {
		tt := ui.NewTester(func(c *ui.Context) {
			StatCard(c, StatCardOptions{Title: "未读通知", State: StatError, Error: "稍后重试"})
		}, 320, 180)
		if !tt.HasText("加载失败") || !tt.HasText("稍后重试") {
			t.Fatalf("texts = %q", tt.Texts())
		}
	})
	t.Run("value", func(t *testing.T) {
		tt := ui.NewTester(func(c *ui.Context) {
			StatCard(c, StatCardOptions{Title: "未读通知", Value: "12", Detail: "待处理", State: StatReady})
		}, 320, 180)
		if !tt.HasText("12") || !tt.HasText("待处理") {
			t.Fatalf("texts = %q", tt.Texts())
		}
	})
}
