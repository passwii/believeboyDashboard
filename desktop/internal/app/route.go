package app

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"
)

const defaultRoutePersistDelay = 300 * time.Millisecond

type routeSaver func(context.Context, string) error

// InitialRoute restores only a known workspace route, and only after the
// saved session has been accepted. Every other launch starts at login or home.
func InitialRoute(lastRoute string, authenticated bool) string {
	if !authenticated {
		return LoginRoute
	}
	lastRoute = strings.TrimSpace(lastRoute)
	if isWorkspaceRoute(lastRoute) {
		return lastRoute
	}
	return HomeRoute
}

func isWorkspaceRoute(route string) bool {
	switch route {
	case HomeRoute, ProjectsRoute, OperationsRoute, ReportsRoute, AIRoute, SettingsRoute:
		return true
	default:
		return false
	}
}

// routeTracker debounces navigation writes and detaches them from the UI
// thread. A failed write is logged and never changes the visible route.
type routeTracker struct {
	mu     sync.Mutex
	save   routeSaver
	delay  time.Duration
	cancel context.CancelFunc
	last   string
	closed bool
}

func newRouteTracker(save routeSaver, delay time.Duration) *routeTracker {
	if delay <= 0 {
		delay = defaultRoutePersistDelay
	}
	return &routeTracker{save: save, delay: delay}
}

func (t *routeTracker) Seed(route string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cancelLocked()
	t.last = route
}

func (t *routeTracker) Observe(route string) {
	if t == nil || !isWorkspaceRoute(route) {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed || route == t.last {
		return
	}
	t.last = route
	t.scheduleLocked(route)
}

func (t *routeTracker) Reset(route string, persist bool) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cancelLocked()
	t.last = route
	if persist && isWorkspaceRoute(route) {
		t.scheduleLocked(route)
	}
}

func (t *routeTracker) Close() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
	t.cancelLocked()
}

func (t *routeTracker) cancelLocked() {
	if t.cancel != nil {
		t.cancel()
		t.cancel = nil
	}
}

func (t *routeTracker) scheduleLocked(route string) {
	if t.closed || t.save == nil {
		return
	}
	t.cancelLocked()
	ctx, cancel := context.WithCancel(context.Background())
	t.cancel = cancel
	save := t.save
	delay := t.delay
	go func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if err := save(ctx, route); err != nil && ctx.Err() == nil {
			log.Printf("desktop route persistence: %v", err)
		}
	}()
}
