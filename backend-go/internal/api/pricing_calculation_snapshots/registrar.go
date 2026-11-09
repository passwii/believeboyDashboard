package pricing_calculation_snapshots

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

func (*Registrar) ModuleName() string { return "pricing_calculation_snapshots" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	prefix := "/api/v1/pricing-calculation-snapshots"
	router.With(requireAPIKey).Get(prefix, handler.List)
	router.With(requireAPIKey).Post(prefix, handler.Create)
	router.With(requireAPIKey).Get(prefix+"/{snapshot_id}", handler.Get)
	router.With(requireAPIKey).Get(prefix+"/{snapshot_id}/items", handler.GetItems)
	router.With(requireAPIKey).Patch(prefix+"/{snapshot_id}", handler.Update)
	router.With(requireAPIKey).Delete(prefix+"/{snapshot_id}", handler.Delete)
}
