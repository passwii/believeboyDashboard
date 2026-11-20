package auth

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

type Registrar struct {
	handler *Handler
}

// NewRegistrar accepts WithSessionManager for production wiring. The gateway
// must always pass it; the unconfigured form is retained only for isolated
// contract fixtures and must not be used by a production router.
func NewRegistrar(store Store, options ...Option) httpserver.ModuleRegistrar {
	return Registrar{handler: NewHandler(store, options...)}
}

func (Registrar) ModuleName() string {
	return "auth"
}

func (registrar Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	if requireAPIKey == nil {
		requireAPIKey = func(next http.Handler) http.Handler { return next }
	}
	router.Post("/api/v1/auth/login", registrar.handler.Login)
	router.With(requireAPIKey).Get("/api/v1/auth/me", registrar.handler.Me)
	router.With(requireAPIKey).Patch("/api/v1/auth/change-password", registrar.handler.ChangePassword)
	router.With(requireAPIKey).Post("/api/v1/auth/logout", registrar.handler.Logout)
}
