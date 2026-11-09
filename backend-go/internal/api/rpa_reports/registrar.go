package rpa_reports

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

func (*Registrar) ModuleName() string { return "rpa_reports" }

func (r *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Get("/api/v1/rpa-reports/status", r.handler.GetStatus)
}
