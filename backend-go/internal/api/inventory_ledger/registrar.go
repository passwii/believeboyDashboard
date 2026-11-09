package inventory_ledger

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store) *Registrar {
	return &Registrar{handler: NewHandler(store)}
}

func (*Registrar) ModuleName() string { return "inventory_ledger" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/months", handler.ListMonths)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/snapshot", handler.GetSnapshot)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/events", handler.GetEvents)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/receipt-clusters", handler.GetClusters)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/location-detail", handler.GetLocationDetail)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/trend", handler.GetTrend)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/detail", handler.GetDetail)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/summary", handler.GetSummary)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/batches", handler.ListBatches)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/consistency", handler.GetConsistency)
	router.With(requireAPIKey).Get("/api/v1/inventory-ledger/month-analysis", handler.GetMonthAnalysis)
}
