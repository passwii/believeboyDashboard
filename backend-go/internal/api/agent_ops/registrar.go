package agent_ops

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, now func() time.Time) *Registrar {
	return &Registrar{handler: NewHandler(store, now)}
}

func (*Registrar) ModuleName() string { return "agent_ops" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Get("/api/v1/agent-ops/domain-summary", registrar.handler.DomainSummary)
	router.With(requireAPIKey).Get("/api/v1/agent-ops/employee-summary", registrar.handler.EmployeeSummary)
}
