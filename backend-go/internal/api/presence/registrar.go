package presence

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, now func() time.Time) *Registrar {
	return &Registrar{handler: NewHandler(store, now)}
}

func (*Registrar) ModuleName() string { return "presence" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Post("/api/v1/system-management/presence/heartbeat", registrar.handler.Heartbeat)
	router.With(requireAPIKey).Get("/api/v1/system-management/presence", registrar.handler.Get)
}
