package ai_insight

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, enqueuer JobEnqueuer, cfg Config) *Registrar {
	return &Registrar{handler: NewHandler(store, enqueuer, cfg)}
}

func (*Registrar) ModuleName() string { return ModuleName }

func (registrar *Registrar) RegisterRoutes(router chi.Router, requireAPIKey func(http.Handler) http.Handler) {
	handler := registrar.handler
	router.With(requireAPIKey).Post("/api/v1/ai-insights/generate", handler.Generate)
	router.With(requireAPIKey).Get("/api/v1/ai-insights", handler.List)
	router.With(requireAPIKey).Get("/api/v1/ai-insights/latest", handler.Latest)
	router.With(requireAPIKey).Get("/api/v1/ai-insights/ad-agent/evolution-report", handler.EvolutionReport)
	router.With(requireAPIKey).Get("/api/v1/ai-insights/schedules", handler.ListSchedules)
	router.With(requireAPIKey).Post("/api/v1/ai-insights/schedules", handler.CreateSchedule)
	router.With(requireAPIKey).Patch("/api/v1/ai-insights/schedules/{schedule_id}", handler.UpdateSchedule)
	router.With(requireAPIKey).Delete("/api/v1/ai-insights/schedules/{schedule_id}", handler.DeleteSchedule)
	router.With(requireAPIKey).Post("/api/v1/ai-insights/schedules/{schedule_id}/toggle", handler.ToggleSchedule)
	router.With(requireAPIKey).Post("/api/v1/ai-insights/schedules/{schedule_id}/run-now", handler.RunScheduleNow)
	router.With(requireAPIKey).Get("/api/v1/ai-insights/{insight_id}", handler.Get)
	router.With(requireAPIKey).Put("/api/v1/ai-insights/{insight_id}", handler.Update)
	router.With(requireAPIKey).Post("/api/v1/ai-insights/{insight_id}/retry", handler.Retry)
	router.With(requireAPIKey).Delete("/api/v1/ai-insights/{insight_id}", handler.Delete)
	router.With(requireAPIKey).Get("/api/v1/ai-insights/{insight_id}/stream", handler.Stream)
}
