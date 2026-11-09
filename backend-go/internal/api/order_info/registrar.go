package order_info

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

func (*Registrar) ModuleName() string { return "order_info" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/order-info/page", handler.GetPage)
	router.With(requireAPIKey).Get("/api/v1/order-info/list", handler.ListOrders)
	router.With(requireAPIKey).Get("/api/v1/order-info/stats", handler.GetStats)
	router.With(requireAPIKey).Get("/api/v1/order-info/overview", handler.GetOverview)
	router.With(requireAPIKey).Get("/api/v1/order-info/filter-options", handler.GetFilterOptions)
	router.With(requireAPIKey).Get("/api/v1/order-info/live-stream", handler.GetLiveStream)
	router.With(requireAPIKey).Post("/api/v1/order-info/export", handler.ExportOrders)
	router.With(requireAPIKey).Patch("/api/v1/order-info/{order_id}", handler.UpdateOrder)
}
