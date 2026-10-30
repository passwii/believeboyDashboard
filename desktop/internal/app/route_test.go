package app

import (
	"context"
	"testing"
	"time"
)

func TestInitialRouteRestoresOnlyKnownWorkspaceRoutesForAuthenticatedSessions(t *testing.T) {
	tests := []struct {
		name          string
		lastRoute     string
		authenticated bool
		want          string
	}{
		{name: "home", lastRoute: "/home", authenticated: true, want: "/home"},
		{name: "projects", lastRoute: "/projects", authenticated: true, want: "/projects"},
		{name: "operations", lastRoute: "/operations", authenticated: true, want: "/operations"},
		{name: "reports", lastRoute: "/reports", authenticated: true, want: "/reports"},
		{name: "ai", lastRoute: "/ai", authenticated: true, want: "/ai"},
		{name: "settings", lastRoute: "/settings", authenticated: true, want: "/settings"},
		{name: "unknown", lastRoute: "/missing", authenticated: true, want: "/home"},
		{name: "login", lastRoute: "/login", authenticated: true, want: "/home"},
		{name: "empty", lastRoute: "", authenticated: true, want: "/home"},
		{name: "logged out", lastRoute: "/projects", authenticated: false, want: "/login"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := InitialRoute(test.lastRoute, test.authenticated); got != test.want {
				t.Errorf("InitialRoute(%q, %v) = %q, want %q", test.lastRoute, test.authenticated, got, test.want)
			}
		})
	}
}

func TestRouteTrackerDebouncesAndPersistsLatestRoute(t *testing.T) {
	saved := make(chan string, 4)
	tracker := newRouteTracker(func(_ context.Context, route string) error {
		saved <- route
		return nil
	}, 20*time.Millisecond)
	defer tracker.Close()
	tracker.Seed("/home")

	tracker.Observe("/settings")
	tracker.Observe("/projects")

	select {
	case route := <-saved:
		if route != "/projects" {
			t.Fatalf("saved route = %q, want /projects", route)
		}
	case <-time.After(time.Second):
		t.Fatal("route was not persisted")
	}
	select {
	case route := <-saved:
		t.Fatalf("stale route was persisted: %q", route)
	case <-time.After(60 * time.Millisecond):
	}
}
