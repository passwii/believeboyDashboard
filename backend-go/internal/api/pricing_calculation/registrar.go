package pricing_calculation

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditor audit.Service) *Registrar {
	return &Registrar{handler: NewHandler(store, auditor)}
}

func (*Registrar) ModuleName() string { return "pricing_calculation" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	if requireAPIKey == nil {
		requireAPIKey = func(next http.Handler) http.Handler { return next }
	}
	handler := registrar.handler
	router.With(requireAPIKey).Post("/api/v1/pricing-calculation/quote", handler.QuoteFBA)
	router.With(requireAPIKey).Post("/api/v1/pricing-calculation/reverse-quote", handler.QuoteReverse)
	router.With(requireAPIKey).Post("/api/v1/pricing-calculation/reverse-cost", handler.QuoteCostReverse)
	router.With(requireAPIKey).Post("/api/v1/pricing-calculation/fbm-quote", handler.QuoteFBM)
	router.With(requireAPIKey).Post("/api/v1/pricing-calculation/eu-quote", handler.QuoteEU)
	router.With(requireAPIKey).Get("/api/v1/pricing-calculation/runs", handler.ListRuns)
	router.With(requireAPIKey).Delete("/api/v1/pricing-calculation/runs/{run_id}", handler.DeleteRun)
	router.With(requireAPIKey).Post("/api/v1/pricing-calculation/runs/{run_id}/recalculate", handler.RecalculateRun)
}
