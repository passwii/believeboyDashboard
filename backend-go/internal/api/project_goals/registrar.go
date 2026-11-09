package project_goals

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

func (*Registrar) ModuleName() string { return "project_goals" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/project-goals", handler.ListGoals)
	router.With(requireAPIKey).Get("/api/v1/project-goals/progress", handler.GetProgress)
	router.With(requireAPIKey).Get("/api/v1/project-goals/{goal_id}", handler.GetGoal)
	router.With(requireAPIKey).Post("/api/v1/project-goals", handler.CreateGoal)
	router.With(requireAPIKey).Put("/api/v1/project-goals/{goal_id}", handler.UpdateGoal)
	router.With(requireAPIKey).Delete("/api/v1/project-goals/{goal_id}", handler.DeleteGoal)
}
