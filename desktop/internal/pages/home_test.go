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
	mu          sync.Mutex
	loads       int
	projects    int
	block       chan struct{}
	health      api.HealthResponse
	healthErr   error
	unread      api.UnreadCountResponse
	unreadErr   error
	alerts      api.AlertStats
	alertsErr   error
	profile     api.Profile
	profileErr  error
	projectsVal []api.Project
	projectsErr error
}

func (f *fakeHomeLoader) Load(ctx context.Context) HomeData {
	f.mu.Lock()
	f.loads++
	block := f.block
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
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return HomeData{}
		}
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
	f.mu.Unlock()
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
	if !h.tt.HasText("正在加载工作台") {
		t.Fatalf("loading state missing: %q", h.tt.Texts())
	}
	close(loader.block)
	h.wait(t)
	if !h.tt.HasText("工作台") {
		t.Fatalf("home did not load: %q", h.tt.Texts())
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
	loader.projectsErr = errors.New("down")
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
