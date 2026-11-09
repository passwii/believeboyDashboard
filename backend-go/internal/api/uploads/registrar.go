package uploads

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, blobs BlobStore, config Config, auditor audit.Service) *Registrar {
	return &Registrar{handler: NewHandler(store, blobs, config, auditor)}
}

func (*Registrar) ModuleName() string { return "uploads" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Post("/api/v1/uploads", registrar.handler.Upload)
	router.With(requireAPIKey).Post("/api/v1/report-upload/recognize", registrar.handler.Recognize)
	router.With(requireAPIKey).Post("/api/v1/report-upload/commit", registrar.handler.Commit)
	router.With(requireAPIKey).Get("/api/v1/report-upload/status", registrar.handler.Status)
}
