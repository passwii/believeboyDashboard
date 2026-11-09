package product_analysis

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditor audit.Service, options ...Option) *Registrar {
	return &Registrar{handler: NewHandler(store, auditor, options...)}
}

func (*Registrar) ModuleName() string { return "product_analysis" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	const prefix = "/api/v1/product-analysis"

	router.With(requireAPIKey).Get(prefix+"/sources", handler.ListSources)
	router.With(requireAPIKey).Post(prefix+"/sources/upload-file", handler.UploadSources)
	router.With(requireAPIKey).Get(prefix+"/sources/{source_id}/rows", handler.GetSourceRows)
	router.With(requireAPIKey).Get(prefix+"/inventory/current", handler.GetCurrentInventory)
	router.With(requireAPIKey).Get(prefix+"/pt1", handler.ListPT1)
	router.With(requireAPIKey).Get(prefix+"/pt1/{pt1_id}/details", handler.GetPT1Details)
	router.With(requireAPIKey).Get(prefix+"/weekly", handler.ListWeekly)
	router.With(requireAPIKey).Post(prefix+"/weekly/recompute", handler.RecomputeWeekly)
	router.With(requireAPIKey).Post(prefix+"/calculation/check", handler.CheckAvailability)
	router.With(requireAPIKey).Post(prefix+"/calculation/run", handler.RunCalculation)
	router.With(requireAPIKey).Post(prefix+"/calculation/preview", handler.PreviewCalculation)
	router.With(requireAPIKey).Post(prefix+"/trigger-recompute", handler.TriggerRecompute)
}
