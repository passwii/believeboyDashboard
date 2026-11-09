package new_product_calculations

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

func (*Registrar) ModuleName() string { return "new_product_calculations" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	const prefix = "/api/v1/new-product-calculations"
	router.With(requireAPIKey).Get(prefix, handler.List)
	router.With(requireAPIKey).Get(prefix+"/{project_id}/{sku}", handler.Get)
	router.With(requireAPIKey).Post(prefix, handler.Upsert)
	router.With(requireAPIKey).Delete(prefix+"/{snapshot_id}", handler.Delete)
}
