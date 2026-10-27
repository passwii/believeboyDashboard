package main

import (
	"context"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestNewDependenciesWiresOwnedModules(t *testing.T) {
	cfg := config.Config{
		APIKey:          "test-api-key",
		DatabaseURL:     "postgres://localhost/test",
		DatabaseReadURL: "postgres://localhost/replica",
		RedisURL:        "redis://localhost:6379/0",
		AppEnv:          "test",
		OwnedModules: map[string]bool{
			"health":         true,
			"exchange_rates": true,
			"profile":        true,
		},
	}

	deps, err := newDependencies(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newDependencies() error = %v", err)
	}
	t.Cleanup(deps.Close)

	if deps.Stores.APIKeys == nil || deps.Stores.ExchangeRates == nil ||
		deps.Stores.Profile == nil || deps.Stores.HealthDatabase == nil ||
		deps.Stores.HealthReplica == nil || deps.Stores.HealthRedis == nil {
		t.Fatalf("NewRouter stores were not fully wired: %#v", deps.Stores)
	}
}

func TestNewDependenciesSkipsDisabledOwnedModules(t *testing.T) {
	cfg := config.Config{
		APIKey:       "test-api-key",
		DatabaseURL:  "postgres://localhost/test",
		RedisURL:     "redis://localhost:6379/0",
		OwnedModules: map[string]bool{},
	}

	deps, err := newDependencies(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newDependencies() error = %v", err)
	}
	t.Cleanup(deps.Close)
}
