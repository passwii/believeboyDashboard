package ai_chat_v2

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store ai_chat.Store, cfg config.Config) *Registrar {
	return &Registrar{handler: NewHandler(store, cfg)}
}

func NewRegistrarWithOptions(
	store ai_chat.Store,
	cfg config.Config,
	options Options,
) *Registrar {
	return &Registrar{handler: NewHandlerWithOptions(store, cfg, options)}
}

func (*Registrar) ModuleName() string { return "ai_chat_v2" }

func (registrar *Registrar) Close() error {
	return registrar.handler.Close()
}

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Post(
		"/api/v1/ai/conversations/{conversation_id}/messages/stream",
		registrar.handler.Stream,
	)
	router.With(requireAPIKey).Post(
		"/api/v1/ai/conversations/{conversation_id}/cancel",
		registrar.handler.Cancel,
	)
}
