package page_render

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler     *Handler
	publicLimit func(http.Handler) http.Handler
}

func NewRegistrar(
	store Store,
	blobs BlobStore,
	config Config,
	auditor audit.Service,
) *Registrar {
	config = normalizeConfig(config)
	return &Registrar{
		handler:     NewHandler(store, blobs, config, auditor),
		publicLimit: newPublicRateLimiter(config.PublicRequestsPerMinute, nil).middleware,
	}
}

func (*Registrar) ModuleName() string { return "page_render" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Post("/api/v1/page-render/upload", registrar.handler.Upload)
	router.With(requireAPIKey).Get("/api/v1/page-render/history", registrar.handler.History)
	router.With(requireAPIKey).Delete("/api/v1/page-render/{page_id}", registrar.handler.Delete)
	router.With(requireAPIKey, registrar.publicLimit).
		Get("/api/v1/page-render/public/{page_id}", registrar.handler.Public)
}
