package internal_ad_data

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

func (*Registrar) ModuleName() string { return "internal_ad_data" }

func (r *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	h := r.handler
	prefix := "/api/v1/internal/ad-data"

	router.With(requireAPIKey).Get(prefix, h.GetOverview)
	router.With(requireAPIKey).Get(prefix+"/projects/{project_id}/ad-upload-files", h.ListUploadFiles)

	endpoints := map[string]string{
		"ad-campaigns":          "ad_campaign_report",
		"ad-campaign":           "ad_campaign_report",
		"ad-search-terms":       "ad_search_term_report",
		"ad-budgets":            "ad_budget_report",
		"ad-targets":            "ad_target_report",
		"ad-placements":         "ad_placement_report",
		"ad-promoted-products":  "ad_promoted_product_report",
		"ad-time-trends":        "ad_time_trend_report",
		"ad-search-term-shares": "ad_search_term_share_report",
		"ad-invalid-traffic":    "ad_invalid_traffic_report",
		"ad-purchased-products": "ad_purchased_product_report",
	}

	for epName := range endpoints {
		router.With(requireAPIKey).Get(prefix+"/projects/{project_id}/"+epName+"-raw", h.QueryRaw(epName))
	}
}
