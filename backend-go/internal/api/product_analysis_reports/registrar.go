package product_analysis_reports

import (
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditor audit.Service) *Registrar {
	return NewRegistrarWithDependencies(
		store,
		auditor,
		nil,
		defaultResultRoot(),
		nil,
	)
}

func NewRegistrarWithEnqueuer(
	store Store,
	auditor audit.Service,
	enqueuer Enqueuer,
) *Registrar {
	return NewRegistrarWithDependencies(
		store,
		auditor,
		enqueuer,
		defaultResultRoot(),
		nil,
	)
}

func NewRegistrarWithDependencies(
	store Store,
	auditor audit.Service,
	enqueuer Enqueuer,
	resultRoot string,
	objectURLs ObjectURLBuilder,
) *Registrar {
	return &Registrar{
		handler: NewHandler(
			store,
			auditor,
			enqueuer,
			resultRoot,
			objectURLs,
		),
	}
}

func (*Registrar) ModuleName() string { return "product_analysis_reports" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Post(
		"/api/v1/product-analysis-reports",
		handler.Create,
	)
	router.With(requireAPIKey).Get(
		"/api/v1/product-analysis-reports/tasks/{task_id}",
		handler.Status,
	)
	router.With(requireAPIKey).Get(
		"/api/v1/product-analysis-reports/tasks/{task_id}/result",
		handler.Result,
	)
}

func defaultResultRoot() string {
	for _, key := range []string{"PRODUCT_ANALYSIS_RESULT_ROOT", "RESULT_ROOT"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return "backend/storage/results"
}
