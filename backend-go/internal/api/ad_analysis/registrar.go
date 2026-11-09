package ad_analysis

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditor audit.Service) *Registrar {
	return &Registrar{handler: NewHandler(store, auditor)}
}

func (*Registrar) ModuleName() string { return "ad_analysis" }

func (r *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	h := r.handler
	prefix := "/api/v1/ad-analysis"

	router.With(requireAPIKey).Get(prefix+"/overview", h.GetOverview)
	router.With(requireAPIKey).Get(prefix+"/campaigns", h.GetCampaigns)
	router.With(requireAPIKey).Get(prefix+"/products", h.GetProducts)
	router.With(requireAPIKey).Get(prefix+"/time-trend", h.GetTimeTrend)
	router.With(requireAPIKey).Get(prefix+"/purchased-products", h.GetPurchasedProducts)
	router.With(requireAPIKey).Get(prefix+"/search-terms", h.GetSearchTerms)
	router.With(requireAPIKey).Get(prefix+"/targets", h.GetTargets)
	router.With(requireAPIKey).Get(prefix+"/budget", h.GetBudget)
	router.With(requireAPIKey).Get(prefix+"/placements", h.GetPlacements)
	router.With(requireAPIKey).Get(prefix+"/traffic-quality", h.GetTrafficQuality)
}
