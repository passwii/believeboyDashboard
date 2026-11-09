package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notifications"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

// ModuleRegistrar defines the contract for a self-registering domain module.
type ModuleRegistrar interface {
	ModuleName() string
	RegisterRoutes(router chi.Router, requireAPIKey func(http.Handler) http.Handler)
}

// FuncModuleRegistrar adapts a name and function into a ModuleRegistrar.
type FuncModuleRegistrar struct {
	Name     string
	Register func(router chi.Router, requireAPIKey func(http.Handler) http.Handler)
}

func (f FuncModuleRegistrar) ModuleName() string {
	return f.Name
}

func (f FuncModuleRegistrar) RegisterRoutes(router chi.Router, requireAPIKey func(http.Handler) http.Handler) {
	if f.Register != nil {
		f.Register(router, requireAPIKey)
	}
}

type OwnedStores struct {
	APIKeys            auth.UserKeyResolver
	HealthDatabase     health.Pinger
	HealthReplica      health.Probe
	HealthRedis        health.RedisHealthProbe
	ExchangeRates      exchange_rates.Store
	ExchangeRatesBlobs exchange_rates.BlobStore
	Notifications      notifications.Store
	Alerts             alerts.Store
	Profile            profile.Store
	ProfileBlobs       profile.BlobStore
	ProfileAuditor     profile.Auditor
	CustomRegistrars   []ModuleRegistrar
}

func registerOwnedRoutes(
	router chi.Router,
	cfg config.Config,
	stores OwnedStores,
) {
	requireAPIKey := auth.RequireAPIKey(cfg.APIKey, cfg.TrustedProxySecret, stores.APIKeys)

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
		exchangeHandler := exchange_rates.NewHandler(
			stores.ExchangeRates,
			exchange_rates.WithBlobStore(stores.ExchangeRatesBlobs),
		)
		router.With(requireAPIKey).Get("/api/v1/exchange-rates", exchangeHandler.ListExchangeRates)
		router.With(requireAPIKey).Get("/api/v1/exchange-rates/resolve", exchangeHandler.ResolveExchangeRate)
		router.With(requireAPIKey).Get("/api/v1/exchange-rates/options", exchangeHandler.ExchangeRateOptions)
		router.With(requireAPIKey).Get("/api/v1/exchange-rates/{exchange_rate_id}", exchangeHandler.GetExchangeRate)
		if cfg.OwnedModules["exchange_rates_write"] {
			exchangeHandler.RegisterWriteRoutes(router, requireAPIKey)
		}
	}

	if cfg.OwnedModules["notifications"] {
		notificationsHandler := notifications.NewHandler(stores.Notifications)
		router.With(requireAPIKey).Get("/api/v1/notifications", notificationsHandler.List)
		router.With(requireAPIKey).Get("/api/v1/notifications/unread-count", notificationsHandler.UnreadCount)
		if cfg.OwnedModules["notifications_write"] {
			notificationsHandler.RegisterWriteRoutes(router, requireAPIKey)
		}
	}

	if cfg.OwnedModules["alerts"] {
		alertsHandler := alerts.NewHandler(stores.Alerts)
		router.With(requireAPIKey).Get("/api/v1/alerts/metrics", alertsHandler.Metrics)
		router.With(requireAPIKey).Get("/api/v1/alerts/rules", alertsHandler.Rules)
		router.With(requireAPIKey).Get("/api/v1/alerts/events", alertsHandler.Events)
		router.With(requireAPIKey).Get("/api/v1/alerts/stats", alertsHandler.Stats)
		if cfg.OwnedModules["alerts_write"] {
			alertsHandler.RegisterWriteRoutes(router, requireAPIKey)
		}
	}

	if cfg.OwnedModules["profile"] {
		profileHandler := profile.NewHandler(
			stores.Profile,
			profile.WithBlobStore(stores.ProfileBlobs),
			profile.WithAuditor(stores.ProfileAuditor),
		)
		router.With(requireAPIKey).Get("/api/v1/system-management/profile", profileHandler.GetProfile)
		router.With(requireAPIKey).Patch("/api/v1/system-management/profile", profileHandler.UpdateProfile)
		router.With(requireAPIKey).Post("/api/v1/system-management/profile/avatar", profileHandler.UploadAvatar)
		router.With(requireAPIKey).Delete("/api/v1/system-management/profile/avatar", profileHandler.DeleteAvatar)
	}

	for _, registrar := range stores.CustomRegistrars {
		if registrar != nil && cfg.OwnedModules[registrar.ModuleName()] {
			registrar.RegisterRoutes(router, requireAPIKey)
		}
	}
}
