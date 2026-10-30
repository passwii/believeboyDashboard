package main

import (
	"context"
	"errors"
	"log"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/app"
	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
	"github.com/passwii/believeboyDashboard/desktop/internal/components"
	"github.com/passwii/believeboyDashboard/desktop/internal/config"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
	"github.com/passwii/believeboyDashboard/desktop/internal/pages"
)

type desktopRuntime struct {
	config  config.Config
	app     *app.App
	window  *mygo.Window
	initErr error
}

func defaultWindowOptions(runtime *desktopRuntime) mygo.WindowOptions {
	return mygo.WindowOptions{
		Title:     "BelieveBoy",
		Width:     pages.DefaultWidth,
		Height:    pages.DefaultHeight,
		MinWidth:  pages.MinWidth,
		MinHeight: pages.MinHeight,
		// Draw the app toolbar into the title bar while the OS keeps its traffic lights.
		TitleBarStyle:  mygo.TitleBarHidden,
		TitleBarHeight: int(design.HeaderHeight),
		// Opens where the user left it last time.
		StateKey: "main",
		// The window shows the interface MyGo draws, not a web page.
		Content: ui.View(runtime.View),
	}
}

func (r *desktopRuntime) View(c *ui.Context) {
	if r == nil || r.app == nil {
		palette := design.PaletteFromTheme(c.Theme())
		ui.Column(c).Fill().Background(palette.Paper).Children(func() {
			components.WindowTitleBar(c, components.WindowTitleBarOptions{
				LeftWidth:       design.SidebarWidth,
				LeftBackground:  palette.PanelAlt,
				RightBackground: palette.Paper,
				Left: func(c *ui.Context) {
					ui.Text(c, "BelieveBoy").FontSize(12).FontWeight(650).TextColor(palette.Ink)
				},
			})
			ui.Column(c).Grow(1).FillWidth().Padding(48).Children(func() {
				ui.Text(c, "应用初始化失败，请查看日志。")
			})
		})
		return
	}
	r.app.View(c)
}

func main() {
	mygo.App.SetName("BelieveBoy")
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Role: mygo.RoleAppMenu},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleWindowMenu},
	}))
	mygo.App.WhenReady(func() {
		runtime, err := bootstrap(context.Background())
		if err != nil {
			runtime = &desktopRuntime{initErr: err}
			log.Printf("desktop bootstrap: %v", err)
		}
		window := mygo.NewWindow(defaultWindowOptions(runtime))
		if runtime != nil {
			runtime.window = window
			if runtime.app != nil {
				runtime.app.SetUpdate(window.Update)
				runtime.app.SetQuit(mygo.App.Quit)
			}
			window.OnClosed(func() {
				if runtime.app != nil {
					runtime.app.Close()
				}
			})
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// bootstrap loads non-secret config, creates the real gateway client, and
// decides the initial route. A missing saved Keychain session stays on login.
func bootstrap(ctx context.Context) (*desktopRuntime, error) {
	store := config.NewStore()
	cfg, err := store.Load(ctx)
	if err != nil {
		return nil, err
	}
	sessions := auth.NewStore(auth.NewMyGoKeychain(), auth.SystemClock{})
	client, err := api.NewClient(api.ClientConfig{
		BaseURL: cfg.APIBaseURL, ClientID: cfg.ClientID, Sessions: sessions,
	})
	if err != nil {
		return nil, err
	}
	saved, savedAPIKey, savedErr := sessions.Load(ctx)
	var initial *auth.Session
	if savedErr == nil {
		copy := saved
		initial = &copy
	} else if !errors.Is(savedErr, auth.ErrNoSession) {
		log.Printf("desktop session: %v", savedErr)
	}
	route := app.InitialRoute(cfg.LastRoute, savedErr == nil)

	loader := app.GatewayLoader{Client: client}
	desktopApp := app.New(app.Options{
		Router:         ui.NewRouter(route),
		Sessions:       sessions,
		InitialSession: initial,
		InitialAPIKey:  savedAPIKey,
		Login:          pages.ClientLogin(client),
		HomeLoader:     loader.Load,
		ProjectLoader:  loader.LoadProjects,
		Logout:         client.Logout,
		Quit:           mygo.App.Quit,
		VerifySession:  client.AuthMe,
		InitialConfig:  cfg,
		SaveAPIBaseURL: store.UpdateAPIBaseURL,
		TestGateway:    api.TestGatewayConnection,
		SaveLastRoute: func(ctx context.Context, route string) error {
			_, err := store.UpdateLastRoute(ctx, route)
			return err
		},
	})
	return &desktopRuntime{config: cfg, app: desktopApp}, nil
}
