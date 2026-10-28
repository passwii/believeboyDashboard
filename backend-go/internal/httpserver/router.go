package httpserver

import (
	"fmt"
	"log/slog"

	"github.com/go-chi/chi/v5"
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
	router.Handle("/*", proxy)

	return router, nil
}
