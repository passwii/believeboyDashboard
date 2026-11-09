package shop_calculation

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

func (*Registrar) ModuleName() string { return "shop_calculation" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	prefix := "/api/v1/shop-calculation"
	router.With(requireAPIKey).Get(prefix, handler.List)
	router.With(requireAPIKey).Get(prefix+"/history", handler.History)
	router.With(requireAPIKey).Get(prefix+"/aggregate", handler.Aggregate)
	router.With(requireAPIKey).Post(prefix, handler.Create)
	router.With(requireAPIKey).Delete(prefix+"/{item_id}", handler.Delete)
}
