package digital_office

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, options ...Option) *Registrar {
	return &Registrar{handler: NewHandler(store, options...)}
}

func (*Registrar) ModuleName() string { return "digital_office" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	if requireAPIKey == nil {
		requireAPIKey = func(next http.Handler) http.Handler { return next }
	}
	router.With(requireAPIKey).Get("/api/v1/digital-employees/office/stream", registrar.handler.OfficeStream)
}
