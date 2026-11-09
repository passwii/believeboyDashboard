package sku_info

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

func (*Registrar) ModuleName() string { return "sku_info" }

func (registrar *Registrar) WithBlobStore(blobs BlobStore) *Registrar {
	if registrar != nil && registrar.handler != nil {
		registrar.handler.WithBlobStore(blobs)
	}
	return registrar
}

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler

	// /sku-info and /product-costs alias routes
	for _, prefix := range []string{"/api/v1/sku-info", "/api/v1/product-costs"} {
		router.With(requireAPIKey).Get(prefix, handler.ListSkuRecords)
		router.With(requireAPIKey).Post(prefix, handler.CreateSkuRecord)
		router.With(requireAPIKey).Post(prefix+"/bulk", handler.BulkCreateSkuRecords)
		router.With(requireAPIKey).Patch(prefix+"/{sku_record_id}", handler.UpdateSkuRecord)
		router.With(requireAPIKey).Delete(prefix+"/{sku_record_id}", handler.DeleteSkuRecord)
		router.With(requireAPIKey).Post(prefix+"/{sku_record_id}/move", handler.MoveSkuRecord)
		router.With(requireAPIKey).Post(prefix+"/import-csv", handler.ImportCSV)
		router.With(requireAPIKey).Post(prefix+"/import-blf-basic-info", handler.ImportCSV)
	}

	router.With(requireAPIKey).Get("/api/v1/sku-info/export", handler.ExportCSV)
	router.With(requireAPIKey).Post("/api/v1/sku-info/recalculate-first-leg-costs", handler.RecalculateFirstLegCosts)
	router.With(requireAPIKey).Get("/api/v1/sku-info/sync-first-leg-from-shipment", handler.SyncFirstLegFromShipment)
	router.With(requireAPIKey).Post("/api/v1/sku-info/batch-parse-factory-info", handler.BatchParseFactoryInfo)
	router.With(requireAPIKey).Post("/api/v1/sku-info/batch-update-factory-info", handler.BatchUpdateFactoryInfo)
	router.With(requireAPIKey).Post("/api/v1/sku-info/batch-update-listing-copy", handler.BatchUpdateListingCopy)
	router.With(requireAPIKey).Post("/api/v1/sku-info/fnsku-labels/by-skus", handler.GetFnskuLabelsBySkus)
	router.With(requireAPIKey).Post("/api/v1/sku-info/fnsku-labels/batch-download", handler.BatchDownloadFnskuLabels)
	router.With(requireAPIKey).Post("/api/v1/sku-info/{sku_record_id}/fnsku-label", handler.UploadFnskuLabel)
	router.With(requireAPIKey).Get("/api/v1/sku-info/{sku_record_id}/fnsku-label/download", handler.DownloadFnskuLabel)
	router.With(requireAPIKey).Post("/api/v1/sku-info/{sku_record_id}/product-image", handler.UploadProductImage)
	router.With(requireAPIKey).Delete("/api/v1/sku-info/{sku_record_id}/product-image", handler.DeleteProductImage)
}
