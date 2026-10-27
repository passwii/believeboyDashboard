package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

type dependencies struct {
	Stores httpserver.OwnedStores
	Close  func()
}

func newDependencies(ctx context.Context, cfg config.Config) (*dependencies, error) {
	deps := &dependencies{Close: func() {}}
	var pools []*pgxpool.Pool
	closeAll := func() {
		for _, pool := range pools {
			pool.Close()
		}
	}

	needsDatabase := cfg.OwnedModules["health"] ||
		cfg.OwnedModules["exchange_rates"] ||
		cfg.OwnedModules["profile"]
	if needsDatabase {
		primary, err := store.OpenPool(ctx, cfg.DatabaseURL)
		if err != nil {
			return nil, fmt.Errorf("open primary database: %w", err)
		}
		pools = append(pools, primary)
		primaryDB := store.NewPGXDB(primary)
		deps.Stores.APIKeys = store.NewUserKeyStore(primaryDB)
		deps.Stores.HealthDatabase = primaryDB
		if cfg.OwnedModules["exchange_rates"] || cfg.OwnedModules["profile"] {
			deps.Stores.ExchangeRates = store.NewExchangeRateStore(primaryDB)
		}
		if cfg.OwnedModules["profile"] {
			deps.Stores.Profile = store.NewProfileStore(primaryDB)
		}

		if cfg.OwnedModules["health"] && cfg.DatabaseReadURL != "" {
			replica, err := store.OpenPool(ctx, cfg.DatabaseReadURL)
			if err != nil {
				closeAll()
				return nil, fmt.Errorf("open read database: %w", err)
			}
			pools = append(pools, replica)
			deps.Stores.HealthReplica = health.NewPostgresProbe(store.NewPGXDB(replica))
		}
	}

	if cfg.OwnedModules["health"] {
		redisClient := health.NewRedisClient(cfg.RedisURL)
		if redisClient == nil {
			closeAll()
			return nil, fmt.Errorf("parse REDIS_URL")
		}
		deps.Stores.HealthRedis = health.NewRedisProbe(redisClient, nil)
	}

	deps.Close = func() {
		if probe, ok := deps.Stores.HealthRedis.(*health.RedisProbe); ok {
			_ = probe.Close()
		}
		closeAll()
	}
	return deps, nil
}
