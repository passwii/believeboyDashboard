package httpserver

import (
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func NewRouter(cfg config.Config, logger *slog.Logger, stores OwnedStores) (chi.Router, error) {
	logger = loggerOrDefault(logger)
	proxy, err := NewReverseProxy(cfg.FastAPIOrigin, logger)
	if err != nil {
		return nil, fmt.Errorf("FASTAPI_ORIGIN is invalid: %w", err)
	}

	router := chi.NewRouter()
	router.Use(RequestID)
	router.Use(RequestLogger(logger))
	router.Use(PanicRecovery(logger))

	registerOwnedRoutes(router, cfg, stores)
	trustedProxyOnly := auth.RequireTrustedProxyForMasterKey(cfg.APIKey, cfg.TrustedProxySecret)
	var proxyHandler http.Handler = proxy
	// FastAPI is now only reached for routes the Go gateway does not implement,
	// so every fallback is a migration gap worth logging. A fully-owned router
	// never reaches the catch-all; a partial GO_API_OWNED list still logs each
	// proxy hit.
	proxyHandler = logFallbackToFastAPI(logger, proxyHandler)
	router.Handle("/*", trustedProxyOnly(proxyHandler))

	return router, nil
}
