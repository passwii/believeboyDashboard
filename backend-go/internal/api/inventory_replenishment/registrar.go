package inventory_replenishment

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

func (*Registrar) ModuleName() string { return "inventory_replenishment" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/inventory-analysis", handler.GetInventoryAnalysis)
	router.With(requireAPIKey).Get("/api/v1/inventory-snapshot-options", handler.ListInventorySnapshotOptions)
	router.With(requireAPIKey).Get("/api/v1/inventory-replenishment-analysis", handler.ListInventoryReplenishmentAnalysis)
	// FastAPI uses {sku:path}; keep the catch-all scoped to this endpoint only.
	router.With(requireAPIKey).Put("/api/v1/inventory-replenishment-settings/{project_id}/*", handler.UpdateInventoryReplenishmentSetting)
	router.With(requireAPIKey).Get("/api/v1/inventory-replenishment-shipments", handler.ListInventoryReplenishmentShipments)
	router.With(requireAPIKey).Get("/api/v1/inventory-replenishment-calendar", handler.ListInventoryReplenishmentCalendar)
	router.With(requireAPIKey).Get("/api/v1/seasonal-replenishment-analysis", handler.ListSeasonalReplenishmentAnalysis)
	router.With(requireAPIKey).Get("/api/v1/inventory-replenishment-snapshots", handler.ListInventoryReplenishmentSnapshots)
	router.With(requireAPIKey).Post("/api/v1/inventory-replenishment-snapshots", handler.CreateInventoryReplenishmentSnapshot)
	router.With(requireAPIKey).Get("/api/v1/inventory-replenishment-snapshots/{snapshot_id}", handler.GetInventoryReplenishmentSnapshot)
	router.With(requireAPIKey).Get("/api/v1/inventory-replenishment-snapshots/{snapshot_id}/items", handler.ListInventoryReplenishmentSnapshotItems)
	router.With(requireAPIKey).Patch("/api/v1/inventory-replenishment-snapshots/{snapshot_id}", handler.UpdateInventoryReplenishmentSnapshot)
	// PUT remains a compatibility alias; PATCH is the FastAPI/OpenAPI method.
	router.With(requireAPIKey).Put("/api/v1/inventory-replenishment-snapshots/{snapshot_id}", handler.UpdateInventoryReplenishmentSnapshot)
	router.With(requireAPIKey).Delete("/api/v1/inventory-replenishment-snapshots/{snapshot_id}", handler.DeleteInventoryReplenishmentSnapshot)
}
