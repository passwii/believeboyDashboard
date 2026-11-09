package internal_jobs

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, runner Runner, auditor audit.Service) *Registrar {
	return &Registrar{handler: NewHandler(store, runner, auditor)}
}

func (*Registrar) ModuleName() string { return "internal_jobs" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Post("/api/v1/internal/jobs/return-analysis-refresh", handler.RefreshReturnAnalysis)
	router.With(requireAPIKey).Post("/api/v1/internal/jobs/return-analysis-rebuild", handler.RebuildReturnAnalysis)
}
