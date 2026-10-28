package pages

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/components"
)

func TestProjectsPageSearchAndSelectionUpdateInspector(t *testing.T) {
	projects := []api.Project{
		{ID: 1, Name: "北美站", Country: "US", CountryName: projectCountryName("美国站"), IsActive: true},
		{ID: 2, Name: "欧洲站", Country: "DE", CountryName: projectCountryName("德国站"), IsActive: true},
	}
	page, tt, work := newProjectsPageHarness(t, projects, nil)
	defer page.Close()
	waitProjectsLoaded(t, page, tt, work)

	for _, text := range []string{"项目列表", "北美站", "欧洲站"} {
		if !tt.HasText(text) {
			t.Fatalf("missing %q in %q", text, tt.Texts())
		}
	}
	if err := tt.Click("北美站"); err != nil {
		t.Fatal(err)
	}
	tt.Key(0, ui.KeyDown)
	tt.Frame()
	if !tt.HasText("德国站") {
		t.Fatalf("keyboard row selection did not update the inspector: %q", tt.Texts())
	}
	if err := tt.Click("欧洲站"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("德国站") {
		t.Fatalf("selected project's country missing from inspector: %q", tt.Texts())
	}

	if err := tt.Click("搜索项目"); err != nil {
		t.Fatal(err)
	}
	tt.Type("北美")
	tt.Frame()
	if !tt.HasText("北美站") || tt.HasText("欧洲站") {
		t.Fatalf("search did not filter the table: %q", tt.Texts())
	}
}

func TestProjectsPageShowsLoadFailure(t *testing.T) {
	page, tt, work := newProjectsPageHarness(t, nil, errors.New("gateway unavailable"))
	defer page.Close()
	waitProjectsLoaded(t, page, tt, work)
	if !tt.HasText("项目列表加载失败") {
		t.Fatalf("load failure state missing: %q", tt.Texts())
	}
}

func TestProjectsPageShowsLoadingAndEmptyStates(t *testing.T) {
	page, tt, work := newProjectsPageHarness(t, []api.Project{}, nil)
	defer page.Close()
	if !tt.HasText("正在加载项目列表…") {
		t.Fatalf("loading state missing: %q", tt.Texts())
	}
	waitProjectsLoaded(t, page, tt, work)
	if !tt.HasText("当前账号没有可见项目") {
		t.Fatalf("empty state missing: %q", tt.Texts())
	}
}

func TestProjectsPageDiscardsAStaleRefreshResult(t *testing.T) {
	mainWork := make(chan func(), 8)
	oldStarted := make(chan struct{})
	releaseOld := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	load := func(context.Context, int) ([]api.Project, error) {
		mu.Lock()
		calls++
		call := calls
		mu.Unlock()
		if call == 1 {
			close(oldStarted)
			<-releaseOld
			return []api.Project{{ID: 1, Name: "过期项目"}}, nil
		}
		return []api.Project{{ID: 2, Name: "最新项目"}}, nil
	}
	page := NewProjectsPage(ProjectsOptions{Load: load, Update: func(fn func()) { mainWork <- fn }})
	defer page.Close()
	width := float32(560)
	tt := ui.NewTester(func(c *ui.Context) {
		page.View(c, components.WorkbenchOptions{InspectorOpen: true, MainPaneWidth: &width})
	}, 1120, 760)
	select {
	case <-oldStarted:
	case <-time.After(time.Second):
		t.Fatal("first project request did not start")
	}
	page.Refresh()
	waitProjectsLoaded(t, page, tt, mainWork)
	if !tt.HasText("最新项目") {
		t.Fatalf("fresh result missing: %q", tt.Texts())
	}
	close(releaseOld)
	select {
	case fn := <-mainWork:
		fn()
		tt.Frame()
	case <-time.After(time.Second):
		t.Fatal("stale request did not finish")
	}
	if len(page.projects) != 1 || page.projects[0].Name != "最新项目" {
		t.Fatalf("stale result replaced current projects: %+v", page.projects)
	}
}

func TestProjectsPageSortsByNameInBothDirections(t *testing.T) {
	page := &ProjectsPage{
		projects: []api.Project{{ID: 2, Name: "北美站"}, {ID: 1, Name: "欧洲站"}},
		sort:     ui.SortOrder{Column: "name"},
	}
	if got := page.visibleProjects(); got[0].Name != "北美站" || got[1].Name != "欧洲站" {
		t.Fatalf("ascending name order = %+v", got)
	}
	page.sort.Descending = true
	if got := page.visibleProjects(); got[0].Name != "欧洲站" || got[1].Name != "北美站" {
		t.Fatalf("descending name order = %+v", got)
	}
}

func newProjectsPageHarness(t *testing.T, projects []api.Project, loadErr error) (*ProjectsPage, *ui.Tester, chan func()) {
	t.Helper()
	mainWork := make(chan func(), 8)
	page := NewProjectsPage(ProjectsOptions{
		Load: func(context.Context, int) ([]api.Project, error) {
			return projects, loadErr
		},
		Update: func(fn func()) { mainWork <- fn },
	})
	width := float32(560)
	tt := ui.NewTester(func(c *ui.Context) {
		page.View(c, components.WorkbenchOptions{
			Title: "项目", Breadcrumb: "工作台 / 项目", ActiveID: "projects",
			InspectorOpen: true, MainPaneWidth: &width,
		})
	}, 1120, 760)
	return page, tt, mainWork
}

func waitProjectsLoaded(t *testing.T, page *ProjectsPage, tt *ui.Tester, work <-chan func()) {
	t.Helper()
	deadline := time.After(time.Second)
	for page.loading {
		select {
		case fn := <-work:
			fn()
			tt.Frame()
		case <-deadline:
			t.Fatalf("timed out waiting for projects: texts=%q", tt.Texts())
		}
	}
	tt.Frame()
}

func projectCountryName(value string) *string { return &value }
