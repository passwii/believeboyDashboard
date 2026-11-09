package report_reconciliation

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

func (*Registrar) ModuleName() string { return "report_reconciliation" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler

	router.With(requireAPIKey).Get("/api/v1/report-reconciliation/available-reports", handler.ListAvailableReports)
	router.With(requireAPIKey).Post("/api/v1/report-reconciliation/auto-reconcile", handler.AutoReconcile)
	router.With(requireAPIKey).Get("/api/v1/report-reconciliation/history", handler.GetReconciliationHistory)
	router.With(requireAPIKey).Post("/api/v1/report-reconciliation/reconcile", handler.ReconcileReports)
	router.With(requireAPIKey).Post("/api/v1/report-reconciliation/reports/{report_id}/pdf-upload", handler.UploadSummaryPdf)
	router.With(requireAPIKey).Post("/api/v1/report-reconciliation/reports/{report_id}/csv-upload", handler.UploadTransactionCsv)
	router.With(requireAPIKey).Get("/api/v1/report-reconciliation/reports/{report_id}/export-pt3", handler.ExportPt3Data)
	router.With(requireAPIKey).Get("/api/v1/report-reconciliation/reports/{report_id}/download-pdf", handler.DownloadPdf)
	router.With(requireAPIKey).Get("/api/v1/report-reconciliation/reports/{report_id}/download-csv", handler.DownloadCsv)
}
