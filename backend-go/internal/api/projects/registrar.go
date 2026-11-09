package projects

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditor audit.Service, options ...Option) *Registrar {
	return &Registrar{handler: NewHandler(store, auditor, options...)}
}

func (*Registrar) ModuleName() string { return "projects" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/projects", handler.ListProjects)
	router.With(requireAPIKey).Get("/api/v1/projects/manage", handler.ListProjectsManage)
	router.With(requireAPIKey).Get("/api/v1/projects/operator-options", handler.ListProjectOperatorOptions)
	router.With(requireAPIKey).Post("/api/v1/projects", handler.CreateProject)
	router.With(requireAPIKey).Patch("/api/v1/projects/{project_id}", handler.UpdateProject)
	router.With(requireAPIKey).Post("/api/v1/projects/{project_id}/move-{direction}", handler.MoveProject)
	router.With(requireAPIKey).Get("/api/v1/projects/{project_id}/shops", handler.ListProjectShops)
	router.With(requireAPIKey).Put("/api/v1/projects/{project_id}/shops/{country}", handler.UpsertProjectShop)
	router.With(requireAPIKey).Delete("/api/v1/projects/{project_id}/shops/{country}", handler.DeleteProjectShop)
	router.With(requireAPIKey).Get("/api/v1/projects/{project_id}/context", handler.GetProjectContext)
	router.With(requireAPIKey).Patch("/api/v1/projects/{project_id}/context", handler.PatchProjectContext)
	router.With(requireAPIKey).Post("/api/v1/projects/{project_id}/context/parse", handler.ParseProjectContext)
}
