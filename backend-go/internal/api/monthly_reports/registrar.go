package monthly_reports

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditor audit.Service) *Registrar {
	return NewRegistrarWithEnqueuer(store, auditor, nil)
}

func NewRegistrarWithEnqueuer(
	store Store,
	auditor audit.Service,
	enqueuer JobEnqueuer,
) *Registrar {
	return &Registrar{handler: NewHandlerWithEnqueuer(store, auditor, enqueuer)}
}

func (*Registrar) ModuleName() string { return "monthly_reports" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/monthly-reports", handler.List)
	router.With(requireAPIKey).Post("/api/v1/monthly-reports", handler.Create)
	router.With(requireAPIKey).Post("/api/v1/monthly-reports/generate", handler.Generate)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/financial-series", handler.FinancialSeries)
	router.With(requireAPIKey).Post("/api/v1/monthly-reports/financial-series/recalculate", handler.RecalculateFinancialSeries)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/financial-series/accounting-detail", handler.AccountingDetail)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/financial-series/accounting-detail/export", handler.ExportAccountingDetail)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/tasks/{task_id}", handler.Task)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/tasks/{task_id}/result", handler.TaskResult)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/{report_id}", handler.Get)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/{report_id}/status", handler.Status)
	router.With(requireAPIKey).Post("/api/v1/monthly-reports/{report_id}/confirm", handler.Confirm)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/{report_id}/export", handler.ExportReport)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/{report_id}/export/excel", handler.ExportExcel)
	router.With(requireAPIKey).Get("/api/v1/monthly-reports/{report_id}/export/pdf", handler.ExportPDF)
	router.With(requireAPIKey).Delete("/api/v1/monthly-reports/{report_id}", handler.Delete)
}
