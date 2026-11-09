package internal_keys

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

func (Registrar) ModuleName() string {
	return "internal_keys"
}

func (registrar Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	if requireAPIKey == nil {
		requireAPIKey = func(next http.Handler) http.Handler { return next }
	}
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/internal/api-keys", handler.ListAPIKeys)
	router.With(requireAPIKey).Post("/api/v1/internal/api-keys", handler.CreateAPIKey)
	router.With(requireAPIKey).Patch("/api/v1/internal/api-keys/{key_id}", handler.UpdateAPIKey)
	router.With(requireAPIKey).Post("/api/v1/internal/api-keys/{key_id}/revoke", handler.RevokeAPIKey)
	router.With(requireAPIKey).Post("/api/v1/internal/api-keys/{key_id}/deactivate", handler.DeactivateAPIKey)
	router.With(requireAPIKey).Post("/api/v1/internal/api-keys/{key_id}/activate", handler.ActivateAPIKey)
	router.With(requireAPIKey).Delete("/api/v1/internal/api-keys/{key_id}", handler.DeleteAPIKey)

	router.With(requireAPIKey).Get("/api/v1/internal/user-api-keys", handler.ListUserAPIKeys)
	router.With(requireAPIKey).Post("/api/v1/internal/user-api-keys", handler.CreateUserAPIKey)
	router.With(requireAPIKey).Delete("/api/v1/internal/user-api-keys/{key_id}", handler.DeleteUserAPIKey)
	router.With(requireAPIKey).Post("/api/v1/internal/user-api-keys/{user_id}/revoke", handler.RevokeUserAPIKeys)
	router.With(requireAPIKey).Post("/api/v1/internal/user-api-keys/{user_id}/rotate", handler.RotateUserAPIKey)
}
