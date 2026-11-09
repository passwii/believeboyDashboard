package insight_domains

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, enqueuer ai_insight.JobEnqueuer, provider ai.Provider, cfg Config) *Registrar {
	return &Registrar{handler: NewHandler(store, enqueuer, provider, cfg)}
}

func (*Registrar) ModuleName() string { return ModuleName }

func (registrar *Registrar) RegisterRoutes(router chi.Router, requireAPIKey func(http.Handler) http.Handler) {
	handler := registrar.handler
	router.With(requireAPIKey).Post("/api/v1/insight/ad-analysis/runs", handler.CreateAdAnalysisRun)
	router.With(requireAPIKey).Post("/api/v1/insight/inventory-health/runs", handler.CreateInventoryHealthRun)
}
