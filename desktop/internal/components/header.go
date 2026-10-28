package components

import (
	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type ProjectChoice struct {
	ID   int
	Name string
}

type HeaderOptions struct {
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
	Status            string
	InspectorOpen     bool
	OnToggleInspector func()
}

// Header composes the window toolbar from MyGo's native controls.
func Header(c *ui.Context, options HeaderOptions) {
	ui.Toolbar(c, func() {
		ui.Column(c).Gap(1).Children(func() {
			ui.Text(c, options.Title).
				FontSize(14).
				FontWeight(600).
				SingleLine().
				MaxWidth(160).
				Role(ui.RoleHeading).
				Level(1)
			if options.Breadcrumb != "" {
				ui.Text(c, options.Breadcrumb).
					FontSize(10).
					TextColor(c.Theme().TextMuted).
					SingleLine().
					MaxWidth(190)
			}
		})
		ui.Spacer(c)

		if options.Status != "" {
			ui.Text(c, options.Status).
				FontSize(11).
				TextColor(c.Theme().Warning).
				MaxWidth(220).
				SingleLine().
				Role(ui.RoleStatus)
		}

		if len(options.Projects) > 0 {
			projectLabel := options.Project
			if projectLabel == "" {
				projectLabel = "选择项目"
			}
			ui.MenuButton(c, projectLabel, func(menu *ui.Menu) {
				for _, choice := range options.Projects {
					item := menu.Item(choice.Name).Checked(choice.ID == options.SelectedProject)
					if item.Chosen() && options.OnProjectChange != nil {
						options.OnProjectChange(choice.ID)
					}
				}
			}).MaxWidth(170)
		} else if options.Project != "" {
			ui.Text(c, options.Project).FontSize(12).SingleLine().MaxWidth(170)
		}

		if options.OnRefresh != nil {
			if nativeIconButton(c, "刷新数据", design.IconRefresh).Clicked() {
				options.OnRefresh()
			}
		}
		if options.OnSettings != nil {
			if ui.Button(c, "设置").Clicked() {
				options.OnSettings()
			}
		}
		if options.OnToggleInspector != nil {
			inspectorOpen := options.InspectorOpen
			if ui.Toggle(c, &inspectorOpen, "检查器").Changed() {
				options.OnToggleInspector()
			}
		}

		if options.OnLogout != nil {
			name := options.UserName
			if name == "" {
				name = "当前用户"
			}
			if options.UserRole != "" {
				ui.Text(c, options.UserRole).
					FontSize(10).
					TextColor(c.Theme().TextMuted).
					SingleLine().
					MaxWidth(70)
			}
			ui.MenuButton(c, name, func(menu *ui.Menu) {
				if menu.Item("退出登录").Chosen() {
					options.OnLogout()
				}
			}).MaxWidth(150)
		}
	}).Label("工作台工具栏").Height(design.HeaderHeight).FillWidth()
}

func nativeIconButton(c *ui.Context, label string, icon *ui.SVG) ui.Element {
	button := ui.Button(c, "").Label(label).Tooltip(label)
	return button.Children(func() {
		ui.Icon(c, icon).Size(15, 15)
	})
}
