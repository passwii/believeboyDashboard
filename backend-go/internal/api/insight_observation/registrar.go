package insight_observation

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, cfg Config) *Registrar {
	return &Registrar{handler: NewHandler(store, cfg)}
}

func (*Registrar) ModuleName() string { return ModuleName }

func (registrar *Registrar) RegisterRoutes(router chi.Router, requireAPIKey func(http.Handler) http.Handler) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/insight/observation/gate", handler.Gate)
	router.With(requireAPIKey).Get("/api/v1/insight/observation/retirement-readiness", handler.RetirementReadiness)
}
