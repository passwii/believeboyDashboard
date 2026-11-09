package amazon_review_tracking

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

func (*Registrar) ModuleName() string {
	return "amazon_review_tracking"
}

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler

	router.With(requireAPIKey).Get("/api/v1/amazon-review-tracking/external-targets", handler.ListExternalTargets)
	router.With(requireAPIKey).Post("/api/v1/amazon-review-tracking/external-targets", handler.CreateExternalTarget)

	router.With(requireAPIKey).Get("/api/v1/amazon-review-tracking/groups", handler.ListGroups)
	router.With(requireAPIKey).Post("/api/v1/amazon-review-tracking/groups", handler.CreateReviewGroup)
	router.With(requireAPIKey).Patch("/api/v1/amazon-review-tracking/groups/{group_id}", handler.PatchReviewGroup)
	router.With(requireAPIKey).Post("/api/v1/amazon-review-tracking/groups/{group_id}/deactivate", handler.DeactivateReviewGroup)

	router.With(requireAPIKey).Get("/api/v1/amazon-review-tracking/targets", handler.ListTargets)
	router.With(requireAPIKey).Post("/api/v1/amazon-review-tracking/targets/{target_id}/external-links", handler.CreateExternalLink)
	router.With(requireAPIKey).Delete("/api/v1/amazon-review-tracking/targets/{target_id}/external-links/{link_id}", handler.DeleteExternalLink)
	router.With(requireAPIKey).Get("/api/v1/amazon-review-tracking/targets/{target_id}/rating-snapshots", handler.ListRatingSnapshots)
	router.With(requireAPIKey).Get("/api/v1/amazon-review-tracking/targets/{target_id}/reviews", handler.ListReviews)
	router.With(requireAPIKey).Get("/api/v1/amazon-review-tracking/targets/{target_id}/runs", handler.ListRuns)
}
