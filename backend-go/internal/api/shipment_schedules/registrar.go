package shipment_schedules

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

func (*Registrar) ModuleName() string { return "shipment_schedules" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/shipment-schedules", handler.ListShipmentSchedules)
	router.With(requireAPIKey).Get("/api/v1/shipment-schedules/cost-summary", handler.SummarizeShipmentScheduleCosts)
	router.With(requireAPIKey).Get("/api/v1/shipment-schedules/sku-summary", handler.ListShipmentSkuSummary)
	router.With(requireAPIKey).Get("/api/v1/shipment-schedules/fba-box-details", handler.ListShipmentFbaBoxDetails)
	router.With(requireAPIKey).Get("/api/v1/shipment-schedules/batches", handler.ListShipmentBatches)
	router.With(requireAPIKey).Delete("/api/v1/shipment-schedules/batches/hidden", handler.HideShipmentBatch)
	router.With(requireAPIKey).Get("/api/v1/shipment-schedules/{schedule_id}", handler.GetShipmentScheduleDetail)
	router.With(requireAPIKey).Post("/api/v1/shipment-schedules", handler.CreateShipmentSchedule)
	router.With(requireAPIKey).Post("/api/v1/shipment-schedules/import-csv", handler.ImportShipmentSchedulesCSV)
	router.With(requireAPIKey).Patch("/api/v1/shipment-schedules/{schedule_id}", handler.UpdateShipmentSchedule)
	router.With(requireAPIKey).Delete("/api/v1/shipment-schedules/{schedule_id}", handler.DeleteShipmentSchedule)
	router.With(requireAPIKey).Post("/api/v1/shipment-schedules/{schedule_id}/items/import-csv", handler.ImportShipmentScheduleItemsCSV)
	router.With(requireAPIKey).Post("/api/v1/shipment-schedules/{schedule_id}/costs/calculate", handler.CalculateShipmentScheduleCosts)
}
