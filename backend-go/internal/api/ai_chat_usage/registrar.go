package ai_chat_usage

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store) *Registrar {
	return &Registrar{handler: NewHandler(store)}
}

func (*Registrar) ModuleName() string { return "ai_chat_usage" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Get("/api/v1/ai/usage/stats", registrar.handler.GetStats)
}
