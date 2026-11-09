package platform_revenues

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

func (*Registrar) ModuleName() string { return "platform_revenues" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/platform-revenues", handler.ListRevenues)
	router.With(requireAPIKey).Post("/api/v1/platform-revenues", handler.CreateRevenue)
	router.With(requireAPIKey).Post("/api/v1/platform-revenues/upload-image", handler.UploadImage)
	router.With(requireAPIKey).Get("/api/v1/platform-revenues/project-countries/{project_id}", handler.GetProjectCountries)
	router.With(requireAPIKey).Get("/api/v1/platform-revenues/{revenue_id}", handler.GetRevenue)
	router.With(requireAPIKey).Patch("/api/v1/platform-revenues/{revenue_id}", handler.UpdateRevenue)
	router.With(requireAPIKey).Delete("/api/v1/platform-revenues/{revenue_id}", handler.DeleteRevenue)
}
