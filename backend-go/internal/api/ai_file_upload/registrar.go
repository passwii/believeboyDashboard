package ai_file_upload

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar() *Registrar {
	return &Registrar{handler: NewHandler()}
}

func (*Registrar) ModuleName() string { return "ai_file_upload" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	router.With(requireAPIKey).Post("/api/v1/ai/upload", registrar.handler.Upload)
}
