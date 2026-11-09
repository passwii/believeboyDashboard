package users

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditors ...audit.Service) httpserver.ModuleRegistrar {
	return Registrar{handler: NewHandler(store, auditors...)}
}

func NewRegistrarWithOptions(
	store Store,
	options ...Option,
) httpserver.ModuleRegistrar {
	return Registrar{handler: NewHandlerWithOptions(store, options...)}
}

func (Registrar) ModuleName() string {
	return "users"
}

func (registrar Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	if requireAPIKey == nil {
		requireAPIKey = func(next http.Handler) http.Handler { return next }
	}
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/system-management/users", handler.List)
	router.With(requireAPIKey).Post("/api/v1/system-management/users", handler.Create)
	router.With(requireAPIKey).Patch("/api/v1/system-management/users/{user_id}", handler.Update)
	router.With(requireAPIKey).Delete("/api/v1/system-management/users/{user_id}", handler.Delete)
	router.With(requireAPIKey).Post(
		"/api/v1/system-management/users/{user_id}/revoke-sessions",
		handler.RevokeSessions,
	)
}
