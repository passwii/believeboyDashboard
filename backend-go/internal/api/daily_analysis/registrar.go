package daily_analysis

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store) *Registrar {
	return &Registrar{handler: NewHandler(store)}
}

func (*Registrar) ModuleName() string { return "daily_analysis" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/daily-analysis", handler.GetDailyAnalysis)
	router.With(requireAPIKey).Get("/api/v1/daily-analysis/all", handler.GetDailyAnalysisAll)
	router.With(requireAPIKey).Get("/api/v1/daily-analysis/all-countries", handler.GetDailyAnalysisAllCountries)
	router.With(requireAPIKey).Get("/api/v1/daily-analysis/all-projects-countries", handler.GetDailyAnalysisAllProjectsCountries)
}
