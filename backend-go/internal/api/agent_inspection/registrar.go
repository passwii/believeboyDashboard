package agent_inspection

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

type Registrar struct {
	handler    *Handler
	confirms   agentauth.ConfirmStore
	auth       func(http.Handler) http.Handler
	readLimit  func(http.Handler) http.Handler
	writeLimit func(http.Handler) http.Handler
}

func NewRegistrar(
	store Store,
	credentials agentauth.CredentialStore,
	confirms agentauth.ConfirmStore,
	blobs BlobStore,
	options ...Option,
) *Registrar {
	settings := NewOptions(options...)
	if settings.ReadRateLimiter == nil {
		settings.ReadRateLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: DefaultReadRateRequests,
			Window:   time.Minute,
		})
	}
	if settings.WriteRateLimiter == nil {
		settings.WriteRateLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: DefaultWriteRateRequests,
			Window:   time.Minute,
		})
	}
	handler := NewHandler(store, blobs, settings)
	return &Registrar{
		handler:    handler,
		confirms:   confirms,
		auth:       agentauth.RequireAgentCredential(credentials),
		readLimit:  agentauth.RequireRateLimit(settings.ReadRateLimiter),
		writeLimit: agentauth.RequireRateLimit(settings.WriteRateLimiter),
	}
}

func (*Registrar) ModuleName() string {
	return ModuleName
}

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	_ func(http.Handler) http.Handler,
) {
	h := registrar.handler

	registrar.route(router, http.MethodGet,
		"/api/v1/agent/account-health/history", "account_health",
		false, "", "", nil, h.AccountHealthHistory)
	registrar.route(router, http.MethodGet,
		"/api/v1/agent/account-health/periods", "account_health",
		false, "", "", nil, h.AccountHealthPeriods)
	registrar.route(router, http.MethodGet,
		"/api/v1/agent/account-health/periods/current", "account_health",
		false, "", "", nil, h.AccountHealthCurrentPeriod)
	registrar.route(router, http.MethodGet,
		"/api/v1/agent/account-health/periods/{period_id}/overview", "account_health",
		false, "", "", nil, h.AccountHealthOverview)
	registrar.route(router, http.MethodGet,
		"/api/v1/agent/account-health/periods/{period_id}/projects/{project_id}", "account_health",
		false, "project_id", "", nil, h.AccountHealthProjectReport)

	registrar.route(router, http.MethodPost,
		"/api/v1/agent/complaint-center/batch", "complaint_center",
		true, "", "", nil, h.ComplaintBatch)

	registrar.route(router, http.MethodPut,
		"/api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}",
		"platform_inspection", true, "project_id", "", nil, h.UpsertInspectionReport)
	registrar.route(router, http.MethodPost,
		"/api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}/submit",
		"platform_inspection", true, "project_id", "platform_inspection.submit",
		h.ValidateSubmitConfirmation, h.SubmitInspectionReport)
	registrar.route(router, http.MethodPost,
		"/api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}/screenshots",
		"platform_inspection", true, "project_id", "", nil, h.UploadInspectionScreenshot)
	registrar.route(router, http.MethodDelete,
		"/api/v1/agent/platform-inspection/screenshots/{screenshot_id}",
		"platform_inspection", true, "", "platform_inspection.delete_screenshot",
		h.ValidateDeleteScreenshotConfirmation, h.DeleteInspectionScreenshot)
	registrar.route(router, http.MethodGet,
		"/api/v1/agent/platform-inspection/template", "platform_inspection",
		false, "", "", nil, h.PlatformInspectionTemplate)
}

func (registrar *Registrar) route(
	router chi.Router,
	method string,
	path string,
	businessScope string,
	write bool,
	projectParam string,
	confirmAction string,
	confirmValidator agentauth.ConfirmValidator,
	target http.HandlerFunc,
) {
	middlewares := []func(http.Handler) http.Handler{
		registrar.auth,
		registrar.readLimit,
		agentauth.RequireBusinessScope(businessScope),
	}
	if projectParam != "" {
		middlewares = append(middlewares, requireProjectScopeParam(projectParam))
	}
	if write {
		middlewares = append(middlewares, registrar.writeLimit)
	}
	if confirmAction != "" {
		middlewares = append(middlewares, registrar.confirmation(confirmAction, confirmValidator))
	}
	router.With(middlewares...).Method(method, path, target)
}

func (registrar *Registrar) confirmation(
	action string,
	validator agentauth.ConfirmValidator,
) func(http.Handler) http.Handler {
	if registrar.confirms == nil {
		return func(http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeAPIError(w, unavailable("confirmation service is not configured"))
			})
		}
	}
	return agentauth.RequireConfirmation(
		registrar.confirms,
		action,
		agentauth.WithConfirmValidator(validator),
	)
}

func requireProjectScopeParam(param string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			projectID, err := parsePositiveID(chi.URLParam(r, param), "project_id")
			if err != nil {
				writeAPIError(w, err)
				return
			}
			agentauth.RequireProjectScope(projectID)(next).ServeHTTP(w, r)
		})
	}
}
