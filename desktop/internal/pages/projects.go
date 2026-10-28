package pages

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/components"
	"github.com/passwii/believeboyDashboard/desktop/internal/design"
)

type ProjectsOptions struct {
	Load   ProjectLoader
	Update func(func())
}

type ProjectsPage struct {
	load   ProjectLoader
	update func(func())

	projects []api.Project
	loading  bool
	err      error
	query    string

	selectedID int
	selected   int
	sort       ui.SortOrder
	list       ui.ListState

	generation uint64
	loadCancel context.CancelFunc
	closed     bool
}

func NewProjectsPage(options ProjectsOptions) *ProjectsPage {
	page := &ProjectsPage{load: options.Load, update: options.Update}
	page.Refresh()
	return page
}

func (p *ProjectsPage) Close() {
	p.closed = true
	p.generation++
	if p.loadCancel != nil {
		p.loadCancel()
		p.loadCancel = nil
	}
}

func (p *ProjectsPage) Refresh() {
	if p.closed {
		return
	}
	if p.load == nil || p.update == nil {
		p.loading = false
		p.err = errors.New("project loader unavailable")
		return
	}
	p.loading = true
	p.err = nil
	p.generation++
	generation := p.generation
	if p.loadCancel != nil {
		p.loadCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.loadCancel = cancel
	load, update := p.load, p.update
	go func() {
		projects, err := load(ctx, 0)
		update(func() {
			if p.closed || generation != p.generation {
				return
			}
			p.projects = projects
			p.err = err
			p.loading = false
			p.selectFirstVisible()
		})
	}()
}

func (p *ProjectsPage) View(c *ui.Context, options components.WorkbenchOptions) {
	options.Title = "项目"
	options.Breadcrumb = "工作台 / 项目"
	options.ActiveID = "projects"
	options.Project = ""
	options.Projects = nil
	options.OnProjectChange = nil
	options.OnRefresh = p.Refresh
	options.Main = func(c *ui.Context) { p.mainContent(c) }
	options.Inspector = func(c *ui.Context) { p.inspector(c) }
	components.Workbench(c, options)
}

func (p *ProjectsPage) Content(c *ui.Context) { p.mainContent(c) }

func (p *ProjectsPage) InspectorContent(c *ui.Context) { p.inspector(c) }

func (p *ProjectsPage) mainContent(c *ui.Context) {
	palette := design.PaletteFromTheme(c.Theme())
	ui.Column(c).Fill().Padding(design.PagePaddingY, design.PagePaddingX).Gap(16).Children(func() {
		ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(16).Children(func() {
			ui.Column(c).Grow(1).Gap(4).Children(func() {
				ui.Text(c, "项目列表").FontSize(24).FontWeight(600).TextColor(palette.Ink).Role(ui.RoleHeading).Level(1)
				ui.Text(c, "查看当前账号可访问的项目与站点。").FontSize(13).TextColor(palette.InkMuted)
			})
			ui.Text(c, formatProjectCount(len(p.visibleProjects()))).FontSize(11).TextColor(palette.InkMuted)
		})

		if ui.SearchField(c, &p.query).Label("搜索项目").Width(360).Changed() {
			p.selectFirstVisible()
		}

		switch {
		case p.loading:
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Spinner(c).Label("正在加载项目")
				ui.Text(c, "正在加载项目列表…").FontSize(13).TextColor(palette.InkMuted).Role(ui.RoleStatus)
			})
		case p.err != nil:
			ui.Column(c).FillWidth().Padding(20).Gap(8).Background(palette.Panel).Border(1, palette.Line).Radius(12).Role(ui.RoleStatus).Children(func() {
				ui.Text(c, "项目列表加载失败").FontSize(14).FontWeight(600).TextColor(palette.Danger)
				ui.Text(c, "检查服务连接后，选择工具栏中的刷新按钮重试。").FontSize(13).TextColor(palette.InkMuted)
			})
		case len(p.visibleProjects()) == 0:
			message := "当前账号没有可见项目"
			if strings.TrimSpace(p.query) != "" {
				message = "没有匹配的项目"
			}
			ui.Column(c).FillWidth().Padding(24, 0).AlignItems(ui.Start).Gap(8).Children(func() {
				ui.Text(c, message).FontSize(14).FontWeight(600).TextColor(palette.Ink)
				ui.Text(c, "调整搜索条件，或刷新项目列表。").FontSize(13).TextColor(palette.InkMuted)
			})
		default:
			p.projectTable(c)
		}
	})
}

func (p *ProjectsPage) projectTable(c *ui.Context) {
	rows := p.visibleProjects()
	p.selectFirstVisible()
	p.list.Selected = &p.selected
	p.list.Key = func(row int) any { return rows[row].ID }
	p.list.Sort = &p.sort
	columns := []ui.TableColumn{
		{Title: "项目", ID: "name", MinWidth: 180, Sortable: true},
		{Title: "站点", ID: "country", Width: 150, MinWidth: 100, Sortable: true},
		{Title: "状态", ID: "status", Width: 100, MinWidth: 90, Sortable: true},
	}
	table := ui.Table(c, &p.list, columns, len(rows), func(row, column int) {
		project := rows[row]
		switch column {
		case 0:
			ui.Text(c, project.Name).SingleLine()
		case 1:
			ui.Text(c, projectCountry(project)).SingleLine()
		case 2:
			label := "已停用"
			if project.IsActive {
				label = "正常"
			}
			ui.Text(c, label).SingleLine()
		}
	}).Grow(1).Label("项目表格")
	if table.Changed() && p.selected >= 0 && p.selected < len(rows) {
		p.selectedID = rows[p.selected].ID
	}
}

func (p *ProjectsPage) inspector(c *ui.Context) {
	palette := design.PaletteFromTheme(c.Theme())
	project, ok := p.selectedProject()
	ui.Column(c).Fill().Gap(12).Children(func() {
		ui.Text(c, "项目详情").FontSize(14).FontWeight(600).TextColor(palette.Ink).Role(ui.RoleHeading).Level(2)
		if p.loading {
			ui.Text(c, "正在读取项目…").FontSize(12).TextColor(palette.InkMuted)
			return
		}
		if p.err != nil {
			ui.Text(c, "项目详情暂不可用").FontSize(12).TextColor(palette.Danger)
			return
		}
		if !ok {
			ui.Text(c, "选择一个项目查看详情。").FontSize(12).TextColor(palette.InkMuted)
			return
		}
		ui.Text(c, project.Name).FontSize(20).FontWeight(600).TextColor(palette.Ink)
		projectDetail(c, "站点", projectCountry(project))
		status := "已停用"
		if project.IsActive {
			status = "正常"
		}
		projectDetail(c, "状态", status)
		projectDetail(c, "项目编号", formatProjectID(project.ID))
	})
}

func (p *ProjectsPage) selectedProject() (api.Project, bool) {
	for _, project := range p.visibleProjects() {
		if project.ID == p.selectedID {
			return project, true
		}
	}
	rows := p.visibleProjects()
	if p.selected >= 0 && p.selected < len(rows) {
		return rows[p.selected], true
	}
	return api.Project{}, false
}

func (p *ProjectsPage) visibleProjects() []api.Project {
	query := strings.ToLower(strings.TrimSpace(p.query))
	rows := make([]api.Project, 0, len(p.projects))
	for _, project := range p.projects {
		if query != "" && !strings.Contains(strings.ToLower(project.Name+" "+project.Country+" "+projectCountry(project)), query) {
			continue
		}
		rows = append(rows, project)
	}
	if p.sort.Column != "" {
		sort.SliceStable(rows, func(i, j int) bool {
			comparison := 0
			switch p.sort.Column {
			case "country":
				left, right := projectCountry(rows[i]), projectCountry(rows[j])
				if left < right {
					comparison = -1
				} else if left > right {
					comparison = 1
				}
			case "status":
				if rows[i].IsActive != rows[j].IsActive {
					if rows[i].IsActive {
						comparison = 1
					} else {
						comparison = -1
					}
				}
			default:
				left, right := strings.ToLower(rows[i].Name), strings.ToLower(rows[j].Name)
				if left < right {
					comparison = -1
				} else if left > right {
					comparison = 1
				}
			}
			if comparison == 0 {
				if rows[i].ID < rows[j].ID {
					comparison = -1
				} else if rows[i].ID > rows[j].ID {
					comparison = 1
				}
			}
			if p.sort.Descending {
				return comparison > 0
			}
			return comparison < 0
		})
	}
	return rows
}

func (p *ProjectsPage) selectFirstVisible() {
	rows := p.visibleProjects()
	if len(rows) == 0 {
		p.selectedID = 0
		p.selected = -1
		return
	}
	for i, project := range rows {
		if project.ID == p.selectedID {
			p.selected = i
			return
		}
	}
	p.selected = 0
	p.selectedID = rows[0].ID
}

func projectDetail(c *ui.Context, label, value string) {
	p := design.PaletteFromTheme(c.Theme())
	ui.Column(c).Gap(3).Children(func() {
		ui.Text(c, label).FontSize(10).TextColor(p.InkMuted)
		ui.Text(c, value).FontSize(12).TextColor(p.Ink)
	})
}

func projectCountry(project api.Project) string {
	if project.CountryName != nil && strings.TrimSpace(*project.CountryName) != "" {
		return *project.CountryName
	}
	if strings.TrimSpace(project.Country) != "" {
		return project.Country
	}
	return "未设置"
}

func formatProjectCount(count int) string {
	return "共 " + formatProjectID(count) + " 个项目"
}

func formatProjectID(id int) string {
	if id == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	for id > 0 {
		i--
		digits[i] = byte('0' + id%10)
		id /= 10
	}
	return string(digits[i:])
}
