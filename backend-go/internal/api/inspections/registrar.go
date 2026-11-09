package inspections

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, blobs BlobStore, auditor audit.Service) *Registrar {
	return &Registrar{handler: NewHandler(store, blobs, auditor)}
}

func NewRegistrarWithDependencies(dependencies RegistrarDependencies) *Registrar {
	return NewRegistrar(dependencies.Store, dependencies.Blobs, dependencies.Auditor)
}

func (*Registrar) ModuleName() string {
	return "inspections"
}

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	if requireAPIKey == nil {
		requireAPIKey = func(next http.Handler) http.Handler { return next }
	}
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/inspections/template", handler.GetTemplate)
	router.With(requireAPIKey).Get("/api/v1/inspections/periods", handler.ListPeriods)
	router.With(requireAPIKey).Get("/api/v1/inspections/periods/current", handler.GetCurrentPeriod)
	router.With(requireAPIKey).Get(
		"/api/v1/inspections/periods/{period_id}/overview",
		handler.GetPeriodOverview,
	)
	router.With(requireAPIKey).Get(
		"/api/v1/inspections/periods/{period_id}/projects/{project_id}",
		handler.GetReport,
	)
	router.With(requireAPIKey).Post(
		"/api/v1/inspections/periods/{period_id}/projects/{project_id}",
		handler.CreateOrUpdateReport,
	)
	router.With(requireAPIKey).Patch(
		"/api/v1/inspections/periods/{period_id}/projects/{project_id}",
		handler.UpdateReport,
	)
	router.With(requireAPIKey).Post(
		"/api/v1/inspections/periods/{period_id}/projects/{project_id}/submit",
		handler.SubmitReport,
	)
	router.With(requireAPIKey).Post(
		"/api/v1/inspections/screenshots/upload",
		handler.UploadScreenshot,
	)
	router.With(requireAPIKey).Delete(
		"/api/v1/inspections/screenshots/{screenshot_id}",
		handler.DeleteScreenshot,
	)
	router.With(requireAPIKey).Get("/api/v1/inspections/history", handler.GetHistory)
}
