package ai_chat

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, cfg config.Config) *Registrar {
	return NewRegistrarWithProvider(store, cfg, ProviderFromConfig(cfg))
}

func NewRegistrarWithProvider(store Store, cfg config.Config, provider ai.Provider) *Registrar {
	return &Registrar{handler: NewHandler(store, cfg, provider)}
}

func ProviderFromConfig(cfg config.Config) ai.Provider {
	return ai.NewOpenAIProvider(ai.ProviderConfig{
		BaseURL:      cfg.AIChatProviderBaseURL,
		APIKey:       cfg.AIChatProviderAPIKey,
		DefaultModel: cfg.AIChatDefaultModel,
		Timeout:      time.Duration(cfg.AIChatTimeoutSeconds) * time.Second,
	})
}

func (*Registrar) ModuleName() string { return "ai_chat" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/ai/config", handler.GetConfig)
	router.With(requireAPIKey).Get("/api/v1/ai/conversations", handler.ListConversations)
	router.With(requireAPIKey).Post("/api/v1/ai/conversations", handler.CreateConversation)
	router.With(requireAPIKey).Delete("/api/v1/ai/conversations/{conversation_id}", handler.DeleteConversation)
	router.With(requireAPIKey).Patch("/api/v1/ai/conversations/{conversation_id}", handler.UpdateConversation)
	router.With(requireAPIKey).Post("/api/v1/ai/conversations/{conversation_id}/regenerate-title", handler.RegenerateTitle)
	router.With(requireAPIKey).Get("/api/v1/ai/conversations/{conversation_id}/messages", handler.ListMessages)
	router.With(requireAPIKey).Delete("/api/v1/ai/conversations/{conversation_id}/messages/{message_id}", handler.DeleteMessage)
	router.With(requireAPIKey).Patch("/api/v1/ai/conversations/{conversation_id}/messages/{message_id}", handler.UpdateMessage)
}
