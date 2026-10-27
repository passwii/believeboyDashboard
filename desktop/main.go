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
	"github.com/passwii/believeboyDashboard/desktop/internal/config"
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
		// Opens where the user left it last time.
		StateKey: "main",
		// The window shows the interface MyGo draws, not a web page.
		Content: ui.View(runtime.View),
	}
}

func (r *desktopRuntime) View(c *ui.Context) {
	if r == nil || r.app == nil {
		ui.Text(c, "应用初始化失败，请查看日志。")
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
	cfg, err := config.NewStore().Load(ctx)
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
	route := app.LoginRoute
	if savedErr == nil {
		copy := saved
		initial = &copy
		route = pages.HomeRoute
	} else if !errors.Is(savedErr, auth.ErrNoSession) {
		log.Printf("desktop session: %v", savedErr)
	}

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
	})
	return &desktopRuntime{config: cfg, app: desktopApp}, nil
}
