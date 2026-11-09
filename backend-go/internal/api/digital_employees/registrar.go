package digital_employees

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, options ...Option) *Registrar {
	return &Registrar{handler: NewHandler(store, options...)}
}

func (*Registrar) ModuleName() string { return "digital_employees" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	if requireAPIKey == nil {
		requireAPIKey = func(next http.Handler) http.Handler { return next }
	}
	handler := registrar.handler

	router.With(requireAPIKey).Get("/api/v1/digital-employees", handler.ListEmployees)
	router.With(requireAPIKey).Get("/api/v1/digital-employees/{employee_id}", handler.GetEmployee)
	router.With(requireAPIKey).Post("/api/v1/digital-employees", handler.CreateEmployee)
	router.With(requireAPIKey).Patch("/api/v1/digital-employees/{employee_id}/status", handler.UpdateStatus)
	router.With(requireAPIKey).Delete("/api/v1/digital-employees/{employee_id}", handler.DeleteEmployee)
	router.With(requireAPIKey).Get("/api/v1/digital-employees/{employee_id}/tasks", handler.ListTasks)
	router.With(requireAPIKey).Get("/api/v1/digital-employees/{employee_id}/tasks/{task_id}", handler.GetTask)
	router.With(requireAPIKey).Get("/api/v1/digital-employees/{employee_id}/tasks/{task_id}/logs", handler.ListLogs)
	router.With(requireAPIKey).Get("/api/v1/digital-employees/{employee_id}/recent-logs", handler.ListRecentLogs)

	// Internal registration and heartbeat intentionally mirror FastAPI: register is
	// unauthenticated and heartbeat validates only the optional per-employee secret.
	router.Post("/api/v1/digital-employees/register", handler.Register)
	router.Post("/api/v1/digital-employees/{employee_id}/heartbeat", handler.Heartbeat)
}
