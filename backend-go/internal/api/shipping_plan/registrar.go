package shipping_plan

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditor audit.Service, projectReaders ...ProjectReader) *Registrar {
	return &Registrar{handler: NewHandler(store, auditor, projectReaders...)}
}

func (*Registrar) ModuleName() string { return "shipping_plan" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/shipping-plan/skus", handler.GetShippingPlanSkus)
	router.With(requireAPIKey).Get("/api/v1/shipping-plan/forecast", handler.GetShippingPlanForecast)
	router.With(requireAPIKey).Get("/api/v1/shipping-plan/shipment-history", handler.GetShippingPlanShipmentHistory)
	router.With(requireAPIKey).Get("/api/v1/shipping-plan/batches", handler.GetShippingPlanBatches)
	router.With(requireAPIKey).Post("/api/v1/shipping-plan/batches", handler.PostShippingPlanBatch)
	router.With(requireAPIKey).Patch("/api/v1/shipping-plan/batches/{batch_id}", handler.PatchShippingPlanBatch)
	router.With(requireAPIKey).Post("/api/v1/shipping-plan/batches/{batch_id}/cancel", handler.CancelShippingPlanBatch)
	router.With(requireAPIKey).Post("/api/v1/shipping-plan/batches/{batch_id}/allocations", handler.PostShippingPlanAllocation)
	router.With(requireAPIKey).Delete("/api/v1/shipping-plan/allocations/{allocation_id}", handler.RemoveShippingPlanAllocation)
	// FastAPI uses {sku:path}. Keep the catch-all last and validate the exact suffix in-handler.
	router.With(requireAPIKey).Put("/api/v1/shipping-plan/skus/*", handler.PutShippingPlanGrowthFactor)
}
