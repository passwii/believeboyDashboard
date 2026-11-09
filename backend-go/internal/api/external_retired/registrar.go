package external_retired

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Registrar mounts the public 410 Gone fallback without changing its response.
type Registrar struct {
	handler *Handler
}

func NewRegistrar() *Registrar {
	return &Registrar{handler: NewHandler()}
}

func (*Registrar) ModuleName() string { return "external_retired" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	_ func(http.Handler) http.Handler,
) {
	for _, method := range []string{
		http.MethodGet,
		http.MethodPost,
		http.MethodPut,
		http.MethodPatch,
		http.MethodDelete,
	} {
		router.Method(method, "/api/v1/external/*", http.HandlerFunc(registrar.handler.Gone))
	}
}
