package pages

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
	"github.com/passwii/believeboyDashboard/desktop/internal/components"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type cardResult[T any] struct {
	Value T
	Err   error
}

type HomeData struct {
	Health   cardResult[api.HealthResponse]
	Unread   cardResult[api.UnreadCountResponse]
	Alerts   cardResult[api.AlertStats]
	Profile  cardResult[api.Profile]
	Projects cardResult[[]api.Project]
	LoadedAt time.Time
}

func LoadHealth(value api.HealthResponse, err error) cardResult[api.HealthResponse] {
	return cardResult[api.HealthResponse]{Value: value, Err: err}
}

func LoadUnread(value api.UnreadCountResponse, err error) cardResult[api.UnreadCountResponse] {
	return cardResult[api.UnreadCountResponse]{Value: value, Err: err}
}

func LoadAlerts(value api.AlertStats, err error) cardResult[api.AlertStats] {
	return cardResult[api.AlertStats]{Value: value, Err: err}
}

func LoadProfile(value api.Profile, err error) cardResult[api.Profile] {
	return cardResult[api.Profile]{Value: value, Err: err}
}

func LoadProjects(value []api.Project, err error) cardResult[[]api.Project] {
	return cardResult[[]api.Project]{Value: value, Err: err}
}

type HomeLoader func(context.Context) HomeData
type ProjectLoader func(context.Context, int) ([]api.Project, error)

type HomeOptions struct {
	Session      auth.Session
	Load         HomeLoader
	LoadProjects ProjectLoader
	Update       func(func())
}

type homeResult struct {
	data       HomeData
	generation uint64
}

// HomePage owns the native workbench state. Network results only enter
// through Update, and stale generations are discarded.
type HomePage struct {
	session      auth.Session
	load         HomeLoader
	loadProjects ProjectLoader
	update       func(func())

	data       HomeData
	loading    bool
	err        error
	results    []homeResult
	generation uint64
	closed     bool

	projects          []api.Project
	selectedProject   int
	projectsLoading   bool
	projectsErr       error
	projectGeneration uint64
	loadCancel        context.CancelFunc
	projectCancel     context.CancelFunc
}

func NewHomePage(options HomeOptions) *HomePage {
	page := &HomePage{
		session:      options.Session,
		load:         options.Load,
		loadProjects: options.LoadProjects,
		update:       options.Update,
	}
	if page.loadProjects != nil {
		page.projectsLoading = true
	}
	page.Refresh()
	if page.loadProjects != nil {
		page.LoadProjects()
	}
	return page
}

func (p *HomePage) Close() {
	p.closed = true
	p.generation++
	p.projectGeneration++
	if p.loadCancel != nil {
		p.loadCancel()
		p.loadCancel = nil
	}
	if p.projectCancel != nil {
		p.projectCancel()
		p.projectCancel = nil
	}
	p.results = nil
}

func (p *HomePage) ProjectID() int {
	return p.selectedProject
}

func (p *HomePage) Refresh() {
	if p.closed {
		return
	}
	if p.load == nil || p.update == nil {
		p.loading = false
		p.err = errors.New("home loader unavailable")
		return
	}
	p.loading = true
	p.err = nil
	p.generation++
	generation := p.generation
	load := p.load
	if p.loadCancel != nil {
		p.loadCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.loadCancel = cancel
	go func() {
		data := load(ctx)
		p.update(func() {
			p.results = append(p.results, homeResult{data: data, generation: generation})
		})
	}()
}

func (p *HomePage) LoadProjects() {
	if p.closed || p.loadProjects == nil || p.update == nil {
		return
	}
	p.projectsLoading = true
	p.projectsErr = nil
	p.projectGeneration++
	generation := p.projectGeneration
	load := p.loadProjects
	projectID := p.selectedProject
	if p.projectCancel != nil {
		p.projectCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.projectCancel = cancel
	go func() {
		projects, err := load(ctx, projectID)
		p.update(func() {
			if p.closed || generation != p.projectGeneration {
				return
			}
			p.projectsLoading = false
			p.projectsErr = err
			if err == nil {
				p.projects = projects
				if p.selectedProject == 0 && len(projects) > 0 {
					p.selectedProject = projects[0].ID
					p.Refresh()
				}
			}
		})
	}()
}

func (p *HomePage) SelectProject(id int) {
	if p.selectedProject == id {
		return
	}
	p.selectedProject = id
	p.Refresh()
}

func (p *HomePage) View(c *ui.Context) {
	p.applyResults(c)
	design.ApplyTheme(c.Theme())
	components.Shell(c, components.ShellOptions{
		Title:      "首页",
		Breadcrumb: "工作台 / 首页",
		Rail: func(c *ui.Context) {
			components.Rail(c, components.RailOptions{
				Items: []components.RailItem{
					{ID: "home", Label: "首页", Icon: design.IconHome, Enabled: true},
					{ID: "projects", Label: "项目", Icon: design.IconProjects, Enabled: false},
					{ID: "operations", Label: "运营", Icon: design.IconOps, Enabled: false},
					{ID: "reports", Label: "报表", Icon: design.IconReports, Enabled: false},
					{ID: "ai", Label: "AI", Icon: design.IconAI, Enabled: false},
				},
				ActiveID: "home",
			})
		},
		Sidebar: func(c *ui.Context) {
			components.Sidebar(c, components.SidebarOptions{
				Groups: []components.SidebarGroup{
					{Label: "工作台", Items: []components.SidebarItem{
						{ID: "home", Label: "首页", Icon: design.IconHome, Enabled: true, Selected: true},
					}},
					{Label: "业务", Items: []components.SidebarItem{
						{ID: "projects", Label: "项目管理", Icon: design.IconProjects},
						{ID: "operations", Label: "运营分析", Icon: design.IconOps},
						{ID: "reports", Label: "报表中心", Icon: design.IconReports},
						{ID: "ai", Label: "AI 助手", Icon: design.IconAI},
					}},
					{Label: "系统", Items: []components.SidebarItem{
						{ID: "settings", Label: "系统设置", Icon: design.IconSystem},
					}},
				},
			})
		},
		Header: func(c *ui.Context) {
			profile := p.session
			name := profile.DisplayName()
			if name == "" {
				name = profile.Name
			}
			projectName := "全部项目"
			choices := make([]components.ProjectChoice, 0, len(p.projects))
			for _, project := range p.projects {
				choices = append(choices, components.ProjectChoice{ID: project.ID, Name: project.Name})
				if project.ID == p.selectedProject {
					projectName = project.Name
				}
			}
			components.Header(c, components.HeaderOptions{
				Title:           "首页",
				Breadcrumb:      "工作台 / 首页",
				UserName:        name,
				UserRole:        roleLabel(profile.RoleType),
				Project:         projectName,
				Projects:        choices,
				SelectedProject: p.selectedProject,
				OnProjectChange: p.SelectProject,
				OnRefresh:       p.Refresh,
				OnLogout:        nil,
			})
		},
		Main: func(c *ui.Context) {
			p.homeContent(c)
		},
		Inspector: func(c *ui.Context) {
			p.inspector(c)
		},
	})
}

func (p *HomePage) ViewHome(c *ui.Context, options components.WorkbenchOptions) {
	p.applyResults(c)
	if options.OnProjectChange == nil {
		options.OnProjectChange = p.SelectProject
	}
	if options.OnRefresh == nil {
		options.OnRefresh = p.Refresh
	}
	if options.Main == nil {
		options.Main = p.HomeContent
	}
	if options.Inspector == nil {
		options.Inspector = p.Inspector
	}
	components.Workbench(c, options)
}

func (p *HomePage) HomeContent(c *ui.Context) { p.homeContent(c) }

func (p *HomePage) Inspector(c *ui.Context) { p.inspector(c) }

func (p *HomePage) ProjectChoices() []components.ProjectChoice { return p.projectChoices() }

func (p *HomePage) SelectedProjectName() string { return p.selectedProjectName() }

func (p *HomePage) projectChoices() []components.ProjectChoice {
	choices := make([]components.ProjectChoice, 0, len(p.projects))
	for _, project := range p.projects {
		choices = append(choices, components.ProjectChoice{ID: project.ID, Name: project.Name})
	}
	return choices
}

func (p *HomePage) selectedProjectName() string {
	for _, project := range p.projects {
		if project.ID == p.selectedProject {
			return project.Name
		}
	}
	return "全部项目"
}

func (p *HomePage) applyResults(c *ui.Context) {
	if len(p.results) > 0 {
		results := p.results
		p.results = nil
		for _, result := range results {
			if p.closed || result.generation != p.generation {
				continue
			}
			p.data = result.data
			p.loading = false
			break
		}
	}
	if p.err != nil {
		_ = c
	}
}

func (p *HomePage) homeContent(c *ui.Context) {
	palette := design.Light
	ui.Scroll(c).Fill().Children(func() {
		ui.Column(c).
			FillWidth().
			Padding(design.PagePaddingY, design.PagePaddingX).
			Gap(20).
			Children(func() {
				ui.Row(c).FillWidth().AlignItems(ui.End).Gap(16).Children(func() {
					ui.Column(c).Grow(1).Gap(5).Children(func() {
						ui.Text(c, "运营总览").
							FontSize(26).
							FontWeight(650).
							TextColor(palette.Ink).
							Role(ui.RoleHeading).
							Level(1)
						ui.Text(c, "以实时网关数据核对今日工作台状态。").
							FontSize(12).
							TextColor(palette.InkMuted)
					})
					if p.loading {
						ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
							ui.Spinner(c).Label("正在加载工作台")
							ui.Text(c, "正在加载工作台").FontSize(11).TextColor(palette.InkMuted)
						})
					} else if !p.data.LoadedAt.IsZero() {
						ui.Text(c, "更新于 "+p.data.LoadedAt.Format("15:04")).
							FontSize(10).
							TextColor(palette.InkMuted)
					}
				})

				ui.Grid(c).
					FillWidth().
					ColumnTracks(ui.Fr(1), ui.Fr(1)).
					Gap(14).
					Children(func() {
						p.healthCard(c)
						p.unreadCard(c)
						p.alertCard(c)
						p.profileCard(c)
					})
				p.projectSection(c)
				if p.err != nil {
					ui.Text(c, p.err.Error()).FontSize(11).TextColor(palette.Danger)
				}
			})
	})
}

func (p *HomePage) healthCard(c *ui.Context) {
	state := components.StatLoading
	value, detail := "", ""
	errText := ""
	if !p.loading {
		if p.data.Health.Err != nil {
			state = components.StatError
			errText = "服务暂不可用"
		} else {
			state = components.StatReady
			value = healthLabel(p.data.Health.Value)
			detail = "数据库 " + p.data.Health.Value.Database + " · Redis " + p.data.Health.Value.Redis
		}
	}
	components.StatCard(c, components.StatCardOptions{
		Title: "API / 数据服务", Eyebrow: "HEALTH", Value: value, Detail: detail,
		State: state, Error: errText, Accent: design.Light.Success,
	})
}

func (p *HomePage) unreadCard(c *ui.Context) {
	state := components.StatLoading
	value, detail, errText := "", "", ""
	if !p.loading {
		if err := p.data.Unread.Err; err != nil {
			state, errText = components.StatError, "通知服务暂不可用"
		} else {
			state = components.StatReady
			value = fmt.Sprintf("%d", p.data.Unread.Value.Count)
			detail = "未读通知"
		}
	}
	components.StatCard(c, components.StatCardOptions{
		Title: "未读通知", Eyebrow: "INBOX", Value: value, Detail: detail,
		State: state, Error: errText, Accent: design.Light.Accent,
	})
}

func (p *HomePage) alertCard(c *ui.Context) {
	state := components.StatLoading
	value, detail, errText := "", "", ""
	if !p.loading {
		if p.data.Alerts.Err != nil {
			state, errText = components.StatError, "告警加载失败"
		} else {
			state = components.StatReady
			value = fmt.Sprintf("%d", p.data.Alerts.Value.TotalActive)
			detail = fmt.Sprintf("严重 %d · 警告 %d", p.data.Alerts.Value.CriticalCount, p.data.Alerts.Value.WarningCount)
		}
	}
	components.StatCard(c, components.StatCardOptions{
		Title: "活跃告警", Eyebrow: "ALERTS", Value: value, Detail: detail,
		State: state, Error: errText, Accent: design.Light.Danger,
	})
}

func (p *HomePage) profileCard(c *ui.Context) {
	state := components.StatLoading
	name, role, detail, errText := "", "", "", ""
	profile := p.session
	if !p.loading {
		if p.data.Profile.Err != nil {
			state, errText = components.StatError, "用户资料暂不可用"
		} else {
			state = components.StatReady
			profile = auth.Session{
				Name: p.data.Profile.Value.Name, RoleType: string(p.data.Profile.Value.RoleType),
				FullName: p.data.Profile.Value.FullName,
			}
		}
	}
	name = profile.DisplayName()
	if name == "" {
		name = profile.Name
	}
	role = roleLabel(profile.RoleType)
	if name == "" {
		name = "未命名用户"
	}
	detail = role
	components.StatCard(c, components.StatCardOptions{
		Title: "当前用户", Eyebrow: "PROFILE", Value: name, Detail: detail,
		State: state, Error: errText, Accent: design.Light.Warning,
	})
}

func (p *HomePage) projectSection(c *ui.Context) {
	palette := design.Light
	ui.Column(c).
		FillWidth().
		Padding(16).
		Gap(10).
		Background(palette.Panel).
		Border(1, palette.Line).
		Children(func() {
			ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
				ui.Text(c, "项目上下文").FontSize(12).FontWeight(600).TextColor(palette.Ink).Grow(1)
				ui.Text(c, fmt.Sprintf("%d 个可见项目", len(p.projects))).FontSize(10).TextColor(palette.InkMuted)
			})
			switch {
			case p.projectsLoading:
				ui.Text(c, "正在加载项目列表").FontSize(11).TextColor(palette.InkMuted)
			case p.projectsErr != nil:
				ui.Text(c, "项目列表加载失败").FontSize(11).TextColor(palette.Danger)
			case len(p.projects) == 0:
				ui.Text(c, "当前账号没有可见项目").FontSize(11).TextColor(palette.InkMuted)
			default:
				for i, project := range p.projects {
					if i == 6 {
						break
					}
					row := ui.Row(c).
						Key(fmt.Sprintf("project-%d", project.ID)).
						FillWidth().
						Height(28).
						PaddingX(8).
						AlignItems(ui.Center).
						Radius(2)
					if project.ID == p.selectedProject {
						row.Background(palette.AccentSoft)
					}
					row.Children(func() {
						ui.Text(c, project.Name).FontSize(11).TextColor(palette.Ink).Grow(1)
						if project.CountryName != nil {
							ui.Text(c, *project.CountryName).FontSize(10).TextColor(palette.InkMuted)
						}
					})
				}
			}
		})
}

func (p *HomePage) inspector(c *ui.Context) {
	palette := design.Light
	ui.Column(c).Fill().Padding(18).Gap(14).Children(func() {
		ui.Text(c, "系统检查器").FontSize(14).FontWeight(600).TextColor(palette.Ink)
		ui.Text(c, "首页指标来自 Go Gateway；项目列表经 Gateway 代理至 FastAPI。").
			FontSize(11).
			TextColor(palette.InkMuted)
		if !p.loading && !p.data.LoadedAt.IsZero() {
			ui.Text(c, "上次刷新 "+p.data.LoadedAt.Format("2006-01-02 15:04")).
				FontSize(10).
				TextColor(palette.InkMuted)
		}
	})
}

func healthLabel(health api.HealthResponse) string {
	switch {
	case strings.EqualFold(health.Status, "ok"):
		return "正常"
	case health.Status != "":
		return health.Status
	default:
		return "未知"
	}
}

func roleLabel(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin":
		return "管理员"
	case "operator":
		return "运营"
	case "businessdev":
		return "商务"
	default:
		return "成员"
	}
}
