package insight_runs

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, enqueuer ai_insight.JobEnqueuer, provider ai.Provider, events EventStore, cfg Config) *Registrar {
	return &Registrar{handler: NewHandler(store, enqueuer, provider, events, cfg)}
}

func (*Registrar) ModuleName() string { return ModuleName }

func (registrar *Registrar) RegisterRoutes(router chi.Router, requireAPIKey func(http.Handler) http.Handler) {
	handler := registrar.handler
	router.With(requireAPIKey).Post("/api/v1/insight/runs", handler.Create)
	router.With(requireAPIKey).Get("/api/v1/insight/runs/{run_id}", handler.Get)
	router.With(requireAPIKey).Get("/api/v1/insight/runs/{run_id}/stream", handler.Stream)
	router.With(requireAPIKey).Post("/api/v1/insight/runs/{run_id}/cancel", handler.Cancel)
	router.With(requireAPIKey).Post("/api/v1/insight/runs/{run_id}/retry", handler.Retry)
}
