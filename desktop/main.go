package main

import (
	"log"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type app struct{}

func (a *app) view(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Fill().Gap(12).Padding(32).Children(func() {
		ui.Text(c, "BelieveBoy").FontSize(32).Bold()
		ui.Text(c, "原生工作台").FontSize(18).Bold()
		ui.Text(c, "Go Gateway 接入准备中").FontSize(14).TextColor(t.TextMuted)
	})
}

func defaultWindowOptions(a *app) mygo.WindowOptions {
	return mygo.WindowOptions{
		Title:     "BelieveBoy",
		Width:     480,
		Height:    360,
		MinWidth:  320,
		MinHeight: 280,
		// Opens where the user left it last time.
		StateKey: "main",
		// The window shows the interface MyGo draws, not a web page.
		Content: ui.View(a.view),
	}
}

func main() {
	a := &app{}
	mygo.App.WhenReady(func() {
		mygo.NewWindow(defaultWindowOptions(a))
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
