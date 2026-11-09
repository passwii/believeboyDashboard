package return_analysis

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

func (*Registrar) ModuleName() string { return "return_analysis" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler

	router.With(requireAPIKey).Get("/api/v1/return-analysis/raw-rows", handler.GetRawRows)
	router.With(requireAPIKey).Get("/api/v1/return-analysis", handler.GetReturnAnalysis)
}
