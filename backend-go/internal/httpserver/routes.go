package httpserver

import (
	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notifications"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

type OwnedStores struct {
	APIKeys        auth.UserKeyResolver
	HealthDatabase health.Pinger
	HealthReplica  health.Probe
	HealthRedis    health.RedisHealthProbe
	ExchangeRates  exchange_rates.Store
	Notifications  notifications.Store
	Alerts         alerts.Store
	Profile        profile.Store
}

func registerOwnedRoutes(
	router chi.Router,
	cfg config.Config,
	stores OwnedStores,
) {
	requireAPIKey := auth.RequireAPIKey(cfg.APIKey, stores.APIKeys)

	if cfg.OwnedModules["health"] {
		healthHandler := health.NewHandler(health.HandlerConfig{
			Database:   stores.HealthDatabase,
			Replica:    stores.HealthReplica,
			Redis:      stores.HealthRedis,
			Version:    cfg.AppEnv,
			ReplicaURL: cfg.DatabaseReadURL,
		})
		router.With(requireAPIKey).Get("/api/v1/health", healthHandler.Health)
		router.Get("/api/v1/health/live", healthHandler.HealthLive)
		router.Get("/api/v1/health/ready", healthHandler.HealthReady)
	}

	if cfg.OwnedModules["exchange_rates"] {
		exchangeHandler := exchange_rates.NewHandler(stores.ExchangeRates)
		router.With(requireAPIKey).Get("/api/v1/exchange-rates", exchangeHandler.ListExchangeRates)
		router.With(requireAPIKey).Get("/api/v1/exchange-rates/resolve", exchangeHandler.ResolveExchangeRate)
		router.With(requireAPIKey).Get("/api/v1/exchange-rates/options", exchangeHandler.ExchangeRateOptions)
		router.With(requireAPIKey).Get("/api/v1/exchange-rates/{exchange_rate_id}", exchangeHandler.GetExchangeRate)
	}

	if cfg.OwnedModules["notifications"] {
		notificationsHandler := notifications.NewHandler(stores.Notifications)
		router.With(requireAPIKey).Get("/api/v1/notifications", notificationsHandler.List)
		router.With(requireAPIKey).Get("/api/v1/notifications/unread-count", notificationsHandler.UnreadCount)
	}

	if cfg.OwnedModules["alerts"] {
		alertsHandler := alerts.NewHandler(stores.Alerts)
		router.With(requireAPIKey).Get("/api/v1/alerts/metrics", alertsHandler.Metrics)
		router.With(requireAPIKey).Get("/api/v1/alerts/rules", alertsHandler.Rules)
		router.With(requireAPIKey).Get("/api/v1/alerts/events", alertsHandler.Events)
		router.With(requireAPIKey).Get("/api/v1/alerts/stats", alertsHandler.Stats)
	}

	if cfg.OwnedModules["profile"] {
		profileHandler := profile.NewHandler(stores.Profile)
		router.With(requireAPIKey).Get("/api/v1/system-management/profile", profileHandler.GetProfile)
	}
}
