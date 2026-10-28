package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
)

type readStubHTTP struct {
	t      *testing.T
	routes map[string]string
	last   *http.Request
}

func (s *readStubHTTP) Do(req *http.Request) (*http.Response, error) {
	s.t.Helper()
	s.last = req
	if req.Header.Get("X-API-Key") == "" {
		s.t.Error("missing X-API-Key")
	}
	body, ok := s.routes[req.URL.Path]
	if !ok {
		s.t.Fatalf("unexpected path %s", req.URL.Path)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

type readStubSessions struct{}

func (readStubSessions) Load(context.Context) (auth.Session, string, error) {
	return auth.Session{
		UserID: "42", Email: "li@example.com", Name: "linxiao",
		SessionID: "session-1", RoleType: "admin",
	}, "api-key", nil
}

func (readStubSessions) Save(context.Context, auth.Session, string) error { return nil }
func (readStubSessions) Clear(context.Context) error                      { return nil }

func TestReadModelMethodsUseGatewayPaths(t *testing.T) {
	httpStub := readStubHTTP{t: t, routes: map[string]string{
		"/api/v1/health":                     `{"status":"ok","database":"ok","redis":"ok"}`,
		"/api/v1/notifications/unread-count": `{"count":5}`,
		"/api/v1/alerts/stats":               `{"total_active":2}`,
		"/api/v1/system-management/profile":  `{"id":"42","name":"linxiao","role_type":"admin"}`,
		"/api/v1/projects/manage":            `[{"id":1,"name":"北美站","is_active":true}]`,
		"/api/v1/auth/me":                    `{"id":"42","email":"li@example.com","name":"linxiao","full_name":"林晓","is_admin":true,"is_active":true,"role_type":"admin"}`,
	}}
	client, err := NewClient(ClientConfig{
		BaseURL: "http://gateway.test", ClientID: "client-id",
		HTTPClient: &httpStub, Sessions: readStubSessions{},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if value, err := client.Health(ctx); err != nil || value.Status != "ok" {
		t.Errorf("Health = %+v, %v", value, err)
	}
	if value, err := client.UnreadCount(ctx); err != nil || value.Count != 5 {
		t.Errorf("UnreadCount = %+v, %v", value, err)
	}
	if value, err := client.AlertStats(ctx, 0); err != nil || value.TotalActive != 2 {
		t.Errorf("AlertStats = %+v, %v", value, err)
	}
	if value, err := client.CurrentProfile(ctx); err != nil || value.Name != "linxiao" {
		t.Errorf("CurrentProfile = %+v, %v", value, err)
	}
	if value, err := client.ManagedProjects(ctx); err != nil || len(value) != 1 {
		t.Errorf("ManagedProjects = %+v, %v", value, err)
	}
	if value, err := client.AuthMe(ctx); err != nil || value.ID != "42" || value.RoleType != RoleAdmin {
		t.Errorf("AuthMe = %+v, %v", value, err)
	}
	if value, err := client.AlertStats(ctx, 7); err != nil || value.TotalActive != 2 {
		t.Errorf("AlertStats project = %+v, %v", value, err)
	}
	if got := httpStub.last.URL.Query().Get("project_id"); got != "7" {
		t.Errorf("project_id query = %q, want 7", got)
	}
}
