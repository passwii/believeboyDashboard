package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type ProjectChoice struct {
	ID   int
	Name string
}

type HeaderState struct {
	UserMenuOpen bool
}

type HeaderOptions struct {
	State             *HeaderState
	Title             string
	Breadcrumb        string
	UserName          string
	UserRole          string
	Project           string
	Projects          []ProjectChoice
	SelectedProject   int
	OnProjectChange   func(int)
	OnLogout          func()
	OnRefresh         func()
	OnSettings        func()
	InspectorOpen     bool
	OnToggleInspector func()
}

// Header is the fixed 56 DIP top bar and owns the user/project menus.
func Header(c *ui.Context, options HeaderOptions) {
	p := design.Light
	row := ui.Row(c).
		FillWidth().
		Height(design.HeaderHeight).
		PaddingX(20).
		Gap(14).
		AlignItems(ui.Center).
		Background(p.Panel).
		BorderWidth(0, 0, 1, 0).
		BorderColor(p.Line)

	row.Children(func() {
		ui.Column(c).Gap(3).MinWidth(0).Grow(1).Children(func() {
			ui.Text(c, options.Title).
				FontSize(16).
				FontWeight(650).
				TextColor(p.Ink).
				Role(ui.RoleHeading).
				Level(1)
			if options.Breadcrumb != "" {
				ui.Text(c, options.Breadcrumb).FontSize(11).TextColor(p.InkMuted)
			}
		})

		if len(options.Projects) > 0 || options.Project != "" {
			projectLabel := options.Project
			if projectLabel == "" {
				projectLabel = "选择项目"
			}
			project := ui.ButtonBase(c).
				Key("header-project").
				Gap(8).
				Height(32).
				PaddingX(10).
				Background(p.Paper).
				Border(1, p.Line).
				Radius(3).
				Label(projectLabel).
				Cursor(ui.CursorPointer)
			project.Children(func() {
				ui.Text(c, projectLabel).FontSize(12).TextColor(p.Ink)
				ui.Icon(c, design.IconChevron).Size(13, 13).TextColor(p.InkMuted)
			})
			if len(options.Projects) > 0 {
				project.Menu(func(menu *ui.Menu) {
					for _, choice := range options.Projects {
						item := menu.Item(choice.Name)
						item.Checked(choice.ID == options.SelectedProject)
						if item.Chosen() && options.OnProjectChange != nil {
							options.OnProjectChange(choice.ID)
						}
					}
				})
			}
		}

		if options.OnRefresh != nil {
			refresh := iconButton(c, "刷新数据", design.IconRefresh)
			if refresh.Clicked() {
				options.OnRefresh()
			}
		}
		if options.OnSettings != nil {
			settings := iconButton(c, "打开设置", design.IconSystem)
			if settings.Clicked() {
				options.OnSettings()
			}
		}
		if options.OnToggleInspector != nil {
			label := "显示检查器"
			if options.InspectorOpen {
				label = "隐藏检查器"
			}
			toggle := iconButton(c, label, design.IconChevron)
			if toggle.Clicked() {
				options.OnToggleInspector()
			}
		}

		name := options.UserName
		if name == "" {
			name = "当前用户"
		}
		user := ui.ButtonBase(c).
			Key("header-user").
			Height(34).
			Padding(3, 8).
			Gap(8).
			AlignItems(ui.Center).
			Radius(3).
			Background(p.Paper).
			Border(1, p.Line).
			Label(name).
			Cursor(ui.CursorPointer)
		user.Children(func() {
			avatar := ui.Box(c).
				Size(24, 24).
				Radius(12).
				Background(p.AccentSoft).
				AlignItems(ui.Center).
				Justify(ui.Center)
			avatar.Children(func() {
				ui.Icon(c, design.IconUser).Size(13, 13).TextColor(p.Accent)
			})
			ui.Column(c).Gap(1).Children(func() {
				ui.Text(c, name).FontSize(12).FontWeight(600).TextColor(p.Ink)
				if options.UserRole != "" {
					ui.Text(c, options.UserRole).FontSize(10).TextColor(p.InkMuted)
				}
			})
			ui.Icon(c, design.IconChevron).Size(12, 12).TextColor(p.InkMuted)
		})
		user.Menu(func(menu *ui.Menu) {
			if menu.Item("退出登录").Chosen() && options.OnLogout != nil {
				options.OnLogout()
			}
		})
	})
}

func iconButton(c *ui.Context, label string, icon *ui.SVG) ui.Element {
	p := design.Light
	button := ui.ButtonBase(c).
		Key("header-"+label).
		Size(32, 32).
		Radius(3).
		Background(p.Paper).
		Border(1, p.Line).
		Role(ui.RoleButton).
		Label(label).
		Tooltip(label).
		Cursor(ui.CursorPointer)
	button.Children(func() {
		ui.Icon(c, icon).Size(15, 15).TextColor(p.InkMuted)
	})
	return button
}
