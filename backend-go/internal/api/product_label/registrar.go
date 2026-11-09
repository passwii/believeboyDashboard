package product_label

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(generator Generator) *Registrar {
	return &Registrar{handler: NewHandler(generator)}
}

func (*Registrar) ModuleName() string { return "product_label" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Post("/api/v1/product-label/generate", handler.Generate)
}
