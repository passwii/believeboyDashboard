package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/desktop/internal/api"
)

type stubReadClient struct {
	health        api.HealthResponse
	healthErr     error
	unread        api.UnreadCountResponse
	unreadErr     error
	alerts        api.AlertStats
	alertsErr     error
	profile       api.Profile
	profileErr    error
	projects      []api.Project
	projectsErr   error
	delay         time.Duration
	alertProjects []int
}

func (s *stubReadClient) Health(context.Context) (api.HealthResponse, error) {
	if s.delay > 0 {
		time.Sleep(s.delay)
	}
	return s.health, s.healthErr
}

func (s *stubReadClient) UnreadCount(context.Context) (api.UnreadCountResponse, error) {
	return s.unread, s.unreadErr
}

func (s *stubReadClient) AlertStats(_ context.Context, projectID int) (api.AlertStats, error) {
	s.alertProjects = append(s.alertProjects, projectID)
	return s.alerts, s.alertsErr
}

func (s *stubReadClient) CurrentProfile(context.Context) (api.Profile, error) {
	return s.profile, s.profileErr
}

func (s *stubReadClient) ManagedProjects(context.Context) ([]api.Project, error) {
	return s.projects, s.projectsErr
}

func TestGatewayLoaderIsolatesFailures(t *testing.T) {
	client := stubReadClient{
		health:    api.HealthResponse{Status: "ok", Database: "ok", Redis: "ok"},
		unread:    api.UnreadCountResponse{Count: 4},
		alertsErr: errors.New("alerts down"),
		profile:   api.Profile{ID: "42", Name: "linxiao", RoleType: api.RoleAdmin},
	}
	loader := GatewayLoader{Client: &client}
	data := loader.Load(context.Background(), 7)
	if data.Health.Err != nil || data.Health.Value.Status != "ok" {
		t.Errorf("health = %+v", data.Health)
	}
	if data.Unread.Err != nil || data.Unread.Value.Count != 4 {
		t.Errorf("unread = %+v", data.Unread)
	}
	if data.Alerts.Err == nil {
		t.Error("alerts failure was swallowed")
	}
	if data.Profile.Err != nil || data.Profile.Value.Name != "linxiao" {
		t.Errorf("profile = %+v", data.Profile)
	}
	if data.LoadedAt.IsZero() {
		t.Error("LoadedAt not set")
	}
	if len(client.alertProjects) != 1 || client.alertProjects[0] != 7 {
		t.Errorf("alert project IDs = %v, want [7]", client.alertProjects)
	}
}

func TestGatewayLoaderProjects(t *testing.T) {
	client := &stubReadClient{
		projects: []api.Project{{ID: 1, Name: "北美站"}},
	}
	loader := GatewayLoader{Client: client}
	projects, err := loader.LoadProjects(context.Background(), 0)
	if err != nil || len(projects) != 1 {
		t.Fatalf("projects = %+v, err = %v", projects, err)
	}
}

func TestGatewayLoaderSkipsAlertStatsWithoutProject(t *testing.T) {
	client := &stubReadClient{
		health:  api.HealthResponse{Status: "ok"},
		unread:  api.UnreadCountResponse{Count: 1},
		profile: api.Profile{ID: "42", Name: "linxiao"},
	}
	data := (GatewayLoader{Client: client}).Load(context.Background(), 0)
	if len(client.alertProjects) != 0 {
		t.Fatalf("AlertStats called without project: %v", client.alertProjects)
	}
	if data.Alerts.Err == nil {
		t.Fatal("alerts should report missing project scope")
	}
	if data.Health.Err != nil || data.Health.Value.Status != "ok" {
		t.Fatalf("unscoped health should still load: %+v", data.Health)
	}
}
