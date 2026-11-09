package ad_upload

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

func (*Registrar) ModuleName() string { return "ad_upload" }

func (r *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Post("/api/v1/ad-upload/recognize", r.handler.Recognize)
	router.With(requireAPIKey).Post("/api/v1/ad-upload/commit", r.handler.Commit)
	router.With(requireAPIKey).Get("/api/v1/ad-upload/status", r.handler.Status)
}
