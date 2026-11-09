package jobs

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(
	store Store,
	enqueuer JobEnqueuer,
	resultRoot string,
	auditor audit.Service,
) *Registrar {
	return &Registrar{handler: NewHandler(store, enqueuer, resultRoot, auditor)}
}

func (*Registrar) ModuleName() string { return "jobs" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Post("/api/v1/jobs", registrar.handler.Create)
	router.With(requireAPIKey).Get("/api/v1/jobs/{job_id}", registrar.handler.Get)
	router.With(requireAPIKey).Get("/api/v1/jobs/{job_id}/result", registrar.handler.DownloadResult)
}
