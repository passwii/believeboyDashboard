package pages

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
)

type homeHarness struct {
	page     *HomePage
	tt       *ui.Tester
	mainWork chan func()
	loader   *fakeHomeLoader
}

type fakeHomeLoader struct {
	mu              sync.Mutex
	loads           int
	loadIDs         []int
	projects        int
	projectsBlock   chan struct{}
	projectsStarted chan struct{}
	block           chan struct{}
	blocks          map[int]chan struct{}
	started         map[int]chan struct{}
	dataByProject   map[int]HomeData
	health          api.HealthResponse
	healthErr       error
	unread          api.UnreadCountResponse
	unreadErr       error
	alerts          api.AlertStats
	alertsErr       error
	profile         api.Profile
	profileErr      error
	projectsVal     []api.Project
	projectsErr     error
}

func (f *fakeHomeLoader) Load(ctx context.Context, projectID int) HomeData {
	f.mu.Lock()
	f.loads++
	f.loadIDs = append(f.loadIDs, projectID)
	block := f.block
	specificBlock := false
	if f.blocks != nil {
		if specific := f.blocks[projectID]; specific != nil {
			block = specific
			specificBlock = true
		}
	}
	var started chan struct{}
	if f.started != nil {
		started = f.started[projectID]
	}
	projectData, hasProjectData := f.dataByProject[projectID]
	values := struct {
		health      api.HealthResponse
		unread      api.UnreadCountResponse
		alerts      api.AlertStats
		profile     api.Profile
		projectsVal []api.Project
	}{
		health: f.health, unread: f.unread, alerts: f.alerts, profile: f.profile, projectsVal: f.projectsVal,
	}
	f.mu.Unlock()
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if block != nil {
		if specificBlock {
			<-block
		} else {
			select {
			case <-block:
			case <-ctx.Done():
				return HomeData{}
			}
		}
	}
	if hasProjectData {
		return projectData
	}
	results := HomeData{
		Health:   LoadHealth(values.health, f.healthErr),
		Unread:   LoadUnread(values.unread, f.unreadErr),
		Alerts:   LoadAlerts(values.alerts, f.alertsErr),
		Profile:  LoadProfile(values.profile, f.profileErr),
		LoadedAt: time.Date(2026, 10, 27, 9, 0, 0, 0, time.Local),
	}
	results.Projects = LoadProjects(values.projectsVal, f.projectsErr)
	return results
}

func (f *fakeHomeLoader) LoadProjects(context.Context, int) ([]api.Project, error) {
	f.mu.Lock()
	f.projects++
	block := f.projectsBlock
	started := f.projectsStarted
	f.mu.Unlock()
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if block != nil {
		<-block
	}
	return f.projectsVal, f.projectsErr
}

func newHomeHarness(t *testing.T, loader *fakeHomeLoader, session auth.Session) *homeHarness {
	t.Helper()
	h := &homeHarness{mainWork: make(chan func(), 16), loader: loader}
	h.page = NewHomePage(HomeOptions{
		Session:      session,
		Load:         loader.Load,
		LoadProjects: loader.LoadProjects,
		Update: func(fn func()) {
			h.mainWork <- fn
		},
	})
	h.tt = ui.NewTester(h.page.View, DefaultWidth, DefaultHeight)
	return h
}

func (h *homeHarness) wait(t *testing.T) {
	t.Helper()
	select {
	case fn := <-h.mainWork:
		fn()
		h.tt.Frame()
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for home update")
	}
}

func (h *homeHarness) waitLoaded(t *testing.T) {
	t.Helper()
	deadline := time.After(time.Second)
	for h.page.loading || h.page.projectsLoading {
		select {
		case fn := <-h.mainWork:
			fn()
			h.tt.Frame()
		case <-deadline:
			t.Fatalf("timed out; loading=%v projects=%v texts=%q", h.page.loading, h.page.projectsLoading, h.tt.Texts())
		}
	}
	h.tt.Frame()
}

func fixtureLoader() *fakeHomeLoader {
	return &fakeHomeLoader{
		health:  api.HealthResponse{Status: "ok", Database: "ok", DatabaseReplica: "ok (lag=0.2s)", Redis: "ok (2.1ms)"},
		unread:  api.UnreadCountResponse{Count: 12},
		alerts:  api.AlertStats{TotalActive: 7, CriticalCount: 2, WarningCount: 3},
		profile: api.Profile{ID: "42", Name: "linxiao", FullName: stringPtr("林晓"), RoleType: api.RoleAdmin, IsAdmin: true},
		projectsVal: []api.Project{
			{ID: 1, Name: "北美站"},
			{ID: 2, Name: "欧洲站"},
		},
	}
}

func stringPtr(value string) *string { return &value }

func testSession() auth.Session {
	return auth.Session{UserID: "42", Email: "li@example.com", Name: "linxiao", FullName: stringPtr("林晓"), RoleType: "admin"}
}

func TestHomeStartsLoading(t *testing.T) {
	loader := fixtureLoader()
	loader.block = make(chan struct{})
	h := newHomeHarness(t, loader, testSession())
	h.wait(t)
	if !h.tt.HasText("正在加载工作台") {
		t.Fatalf("loading state missing: %q", h.tt.Texts())
	}
	close(loader.block)
	h.waitLoaded(t)
	if h.tt.HasText("正在加载工作台") {
		t.Fatalf("loading text remained: %q", h.tt.Texts())
	}
	if !h.tt.HasText("正常") || !h.tt.HasText("12") {
		t.Fatalf("home data did not render: %q", h.tt.Texts())
	}
}

func TestHomeSuccessShowsRealCards(t *testing.T) {
	h := newHomeHarness(t, fixtureLoader(), testSession())
	h.waitLoaded(t)
	for _, text := range []string{
		"API / 数据服务", "正常", "12", "7", "林晓", "管理员", "北美站",
	} {
		if !h.tt.HasText(text) {
			t.Errorf("missing %q in %q", text, h.tt.Texts())
		}
	}
	if h.page.ProjectID() != 1 {
		t.Errorf("selected project = %d, want 1", h.page.ProjectID())
	}
}

func TestHomePartialFailureIsIsolated(t *testing.T) {
	loader := fixtureLoader()
	loader.alertsErr = errors.New("alerts unavailable")
	h := newHomeHarness(t, loader, testSession())
	h.waitLoaded(t)
	if !h.tt.HasText("告警加载失败") {
		t.Fatalf("alert error missing: %q", h.tt.Texts())
	}
	for _, text := range []string{"12", "林晓", "正常"} {
		if !h.tt.HasText(text) {
			t.Errorf("successful card %q disappeared: %q", text, h.tt.Texts())
		}
	}
}

func TestHomeAllFailureStillRendersErrors(t *testing.T) {
	loader := fixtureLoader()
	loader.healthErr = errors.New("down")
	loader.unreadErr = errors.New("down")
	loader.alertsErr = errors.New("down")
	loader.profileErr = errors.New("down")
	h := newHomeHarness(t, loader, testSession())
	h.waitLoaded(t)
	if count := strings.Count(strings.Join(h.tt.Texts(), "\n"), "加载失败"); count < 4 {
		t.Fatalf("failure count = %d, texts = %q", count, h.tt.Texts())
	}
}

func TestHomeRefreshStartsNewLoad(t *testing.T) {
	loader := fixtureLoader()
	h := newHomeHarness(t, loader, testSession())
	h.waitLoaded(t)
	h.page.Refresh()
	h.wait(t)
	if loader.loads < 2 {
		t.Errorf("load count = %d, want at least 2", loader.loads)
	}
}

func TestHomeRefreshPassesSelectedProjectToLoader(t *testing.T) {
	loader := fixtureLoader()
	loader.projectsVal = nil
	h := newHomeHarness(t, loader, testSession())
	h.waitLoaded(t)
	h.page.SelectProject(7)
	h.waitLoaded(t)

	loader.mu.Lock()
	ids := append([]int(nil), loader.loadIDs...)
	loader.mu.Unlock()
	if len(ids) != 2 || ids[0] != 0 || ids[1] != 7 {
		t.Fatalf("loader project IDs = %v, want [0 7]", ids)
	}
}

func TestHomeLoadsUnscopedCardsWhileProjectsLoad(t *testing.T) {
	releaseProjects := make(chan struct{})
	started := make(chan struct{}, 1)
	loader := fixtureLoader()
	loader.projectsBlock = releaseProjects
	loader.projectsStarted = started
	h := newHomeHarness(t, loader, testSession())
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("project load did not start")
	}
	close(releaseProjects)
	h.waitLoaded(t)
	loader.mu.Lock()
	ids := append([]int(nil), loader.loadIDs...)
	loader.mu.Unlock()
	if len(ids) != 2 || ids[0] != 0 || ids[1] != 1 {
		t.Fatalf("loader project IDs = %v, want [0 1]", ids)
	}
}

func TestHomeProjectFailureKeepsNonProjectCards(t *testing.T) {
	for _, test := range []struct {
		name      string
		projects  []api.Project
		loadError error
	}{
		{name: "error", loadError: errors.New("projects down")},
		{name: "empty"},
	} {
		t.Run(test.name, func(t *testing.T) {
			loader := fixtureLoader()
			loader.projectsVal = test.projects
			loader.projectsErr = test.loadError
			h := newHomeHarness(t, loader, testSession())
			h.waitLoaded(t)
			if loader.loads != 1 || loader.loadIDs[0] != 0 {
				t.Fatalf("home loader calls = %v, want one unscoped load", loader.loadIDs)
			}
			if h.page.ProjectID() != 0 {
				t.Fatalf("selected project = %d, want none", h.page.ProjectID())
			}
			if !h.tt.HasText("告警未加载") {
				t.Fatalf("alert state should be absent: %q", h.tt.Texts())
			}
			for _, text := range []string{"正常", "12", "林晓"} {
				if !h.tt.HasText(text) {
					t.Fatalf("non-project card %q missing: %q", text, h.tt.Texts())
				}
			}
			if test.loadError != nil && !h.tt.HasText("项目列表加载失败") {
				t.Fatalf("project error missing: %q", h.tt.Texts())
			}
		})
	}
}

func TestHomeRefreshRetriesProjectListAfterFailure(t *testing.T) {
	loader := fixtureLoader()
	loader.projectsVal = nil
	loader.projectsErr = errors.New("projects down")
	h := newHomeHarness(t, loader, testSession())
	h.waitLoaded(t)
	if h.page.ProjectID() != 0 {
		t.Fatalf("selected project = %d, want none", h.page.ProjectID())
	}

	loader.mu.Lock()
	loader.projectsVal = []api.Project{{ID: 9, Name: "恢复项目"}}
	loader.projectsErr = nil
	loader.mu.Unlock()
	h.page.Refresh()
	h.waitLoaded(t)

	if h.page.ProjectID() != 9 {
		t.Fatalf("selected project = %d, want 9", h.page.ProjectID())
	}
	loader.mu.Lock()
	ids := append([]int(nil), loader.loadIDs...)
	loader.mu.Unlock()
	if len(ids) < 2 || ids[len(ids)-1] != 9 {
		t.Fatalf("scoped alert reload project IDs = %v, want final 9", ids)
	}
	if !h.tt.HasText("恢复项目") {
		t.Fatalf("recovered project missing: %q", h.tt.Texts())
	}
}

func TestHomeProjectChangeDiscardsStaleProjectResult(t *testing.T) {
	block7 := make(chan struct{})
	started7 := make(chan struct{}, 1)
	loader := fixtureLoader()
	loader.projectsVal = nil
	loader.blocks = map[int]chan struct{}{7: block7}
	loader.started = map[int]chan struct{}{7: started7}
	loader.dataByProject = map[int]HomeData{
		7: {Health: LoadHealth(api.HealthResponse{Status: "project-7"}, nil), LoadedAt: time.Now()},
		8: {Health: LoadHealth(api.HealthResponse{Status: "project-8"}, nil), LoadedAt: time.Now()},
	}
	h := newHomeHarness(t, loader, testSession())
	h.waitLoaded(t)

	h.page.SelectProject(7)
	select {
	case <-started7:
	case <-time.After(time.Second):
		t.Fatal("project 7 load did not start")
	}
	h.page.SelectProject(8)
	h.waitLoaded(t)
	close(block7)
	h.wait(t)

	if h.page.ProjectID() != 8 {
		t.Fatalf("selected project = %d, want 8", h.page.ProjectID())
	}
	if !h.tt.HasText("project-8") || h.tt.HasText("project-7") {
		t.Fatalf("stale project result won: %q", h.tt.Texts())
	}
}

func TestHomeProjectRowsSelectProject(t *testing.T) {
	loader := fixtureLoader()
	h := newHomeHarness(t, loader, testSession())
	h.waitLoaded(t)
	if err := h.tt.Click("欧洲站"); err != nil {
		t.Fatal(err)
	}
	h.waitLoaded(t)
	if h.page.ProjectID() != 2 {
		t.Fatalf("selected project = %d, want 2", h.page.ProjectID())
	}
	loader.mu.Lock()
	last := loader.loadIDs[len(loader.loadIDs)-1]
	loader.mu.Unlock()
	if last != 2 {
		t.Fatalf("last loader project = %d, want 2", last)
	}
}

func TestHomeCloseRejectsLateResult(t *testing.T) {
	release := make(chan struct{})
	loader := fixtureLoader()
	loader.block = release
	mainWork := make(chan func(), 4)
	page := NewHomePage(HomeOptions{
		Session: testSession(),
		Load:    loader.Load,
		Update:  func(fn func()) { mainWork <- fn },
	})
	tt := ui.NewTester(page.View, DefaultWidth, DefaultHeight)
	_ = tt
	page.SelectProject(7)
	page.Close()
	close(release)
	select {
	case fn := <-mainWork:
		fn()
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for late home result")
	}
	if len(page.results) != 0 {
		t.Fatalf("closed page queued %d results", len(page.results))
	}
}
