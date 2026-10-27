package app

import (
	"context"
	"time"

	"github.com/passwii/believeboyDashboard/desktop/internal/api"
	"github.com/passwii/believeboyDashboard/desktop/internal/pages"
)

type ReadClient interface {
	Health(context.Context) (api.HealthResponse, error)
	UnreadCount(context.Context) (api.UnreadCountResponse, error)
	AlertStats(context.Context, int) (api.AlertStats, error)
	CurrentProfile(context.Context) (api.Profile, error)
	ManagedProjects(context.Context) ([]api.Project, error)
}

// GatewayLoader fans out independent read-only gateway calls. One failed
// card never prevents the others from rendering.
type GatewayLoader struct {
	Client ReadClient
}

func (l GatewayLoader) Load(ctx context.Context) pages.HomeData {
	type result struct {
		index int
		data  any
		err   error
	}
	results := make(chan result, 4)
	go func() {
		value, err := l.Client.Health(ctx)
		results <- result{index: 0, data: value, err: err}
	}()
	go func() {
		value, err := l.Client.UnreadCount(ctx)
		results <- result{index: 1, data: value, err: err}
	}()
	go func() {
		value, err := l.Client.AlertStats(ctx, 0)
		results <- result{index: 2, data: value, err: err}
	}()
	go func() {
		value, err := l.Client.CurrentProfile(ctx)
		results <- result{index: 3, data: value, err: err}
	}()

	data := pages.HomeData{LoadedAt: time.Now()}
	for range 4 {
		result := <-results
		switch result.index {
		case 0:
			data.Health = pages.LoadHealth(result.data.(api.HealthResponse), result.err)
		case 1:
			data.Unread = pages.LoadUnread(result.data.(api.UnreadCountResponse), result.err)
		case 2:
			data.Alerts = pages.LoadAlerts(result.data.(api.AlertStats), result.err)
		case 3:
			data.Profile = pages.LoadProfile(result.data.(api.Profile), result.err)
		}
	}
	return data
}

func (l GatewayLoader) LoadProjects(ctx context.Context, _ int) ([]api.Project, error) {
	return l.Client.ManagedProjects(ctx)
}
