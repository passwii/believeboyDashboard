package category_research

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

func (*Registrar) ModuleName() string { return "category_research" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler

	router.With(requireAPIKey).Post("/api/v1/category-research/datasets/import", handler.ImportDataset)
	router.With(requireAPIKey).Get("/api/v1/category-research/datasets", handler.ListDatasets)
	router.With(requireAPIKey).Post("/api/v1/category-research/datasets/recompute", handler.BatchRecomputeDatasets)

	router.With(requireAPIKey).Get("/api/v1/category-research/datasets/{dataset_id}/exports/{export_key}", handler.DownloadExport)
	router.With(requireAPIKey).Get("/api/v1/category-research/datasets/{dataset_id}/exports", handler.ListExports)
	router.With(requireAPIKey).Get("/api/v1/category-research/datasets/{dataset_id}/market-trend", handler.GetMarketTrend)
	router.With(requireAPIKey).Get("/api/v1/category-research/datasets/{dataset_id}/trend", handler.GetTrend)
	router.With(requireAPIKey).Post("/api/v1/category-research/datasets/{dataset_id}/dimensions/manual-upsert", handler.UpsertManualDimensions)
	router.With(requireAPIKey).Get("/api/v1/category-research/datasets/{dataset_id}/products", handler.ListProducts)
	router.With(requireAPIKey).Post("/api/v1/category-research/datasets/{dataset_id}/recompute", handler.RecomputeDataset)
	router.With(requireAPIKey).Get("/api/v1/category-research/datasets/{dataset_id}", handler.GetDataset)
}
