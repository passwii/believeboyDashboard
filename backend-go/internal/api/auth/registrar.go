package auth

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store) httpserver.ModuleRegistrar {
	return Registrar{handler: NewHandler(store)}
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
}
