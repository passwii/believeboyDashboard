package agent_monthly_reports

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
	auth    func(http.Handler) http.Handler
	scoped  func(http.Handler) http.Handler
	read    func(http.Handler) http.Handler
	write   func(http.Handler) http.Handler
}

func NewRegistrar(store Store, auditor audit.Service, options Options) *Registrar {
	now := options.Now
	if now == nil {
		now = defaultNow()
	}
	maxFileBytes := options.MaxFileBytes
	if maxFileBytes <= 0 {
		maxFileBytes = defaultMaxFileBytes()
	}
	uploadTTL := options.UploadTTL
	if uploadTTL <= 0 {
		uploadTTL = defaultUploadTTL()
	}
	readLimiter := options.ReadLimiter
	if readLimiter == nil {
		readLimiter = agentauth.NewMemoryRateLimiter(defaultReadRateLimit())
	}
	writeLimiter := options.WriteLimiter
	if writeLimiter == nil {
		writeLimiter = agentauth.NewMemoryRateLimiter(defaultWriteRateLimit())
	}
	handler := &Handler{
		store:        store,
		auditor:      auditor,
		confirmStore: options.ConfirmStore,
		dispatcher:   options.Dispatcher,
		now:          now,
		maxFileBytes: maxFileBytes,
		uploadTTL:    uploadTTL,
	}
	return &Registrar{
		handler: handler,
		auth:    agentauth.RequireAgentCredential(options.Credentials),
		scoped:  agentauth.RequireBusinessScope(businessScope),
		read:    agentauth.RequireRateLimit(readLimiter),
		write:   agentauth.RequireRateLimit(writeLimiter),
	}
}

func (*Registrar) ModuleName() string { return ModuleName }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	_ func(http.Handler) http.Handler,
) {
	if registrar == nil || registrar.handler == nil {
		return
	}
	h := registrar.handler
	read := func(handler http.HandlerFunc, projectScoped bool) http.HandlerFunc {
		chain := []func(http.Handler) http.Handler{
			registrar.auth,
			registrar.scoped,
			registrar.read,
		}
		if projectScoped {
			chain = append(chain, requireQueryProjectScope)
		}
		return withAgentMonthlyMiddleware(handler, chain...)
	}
	write := func(handler http.HandlerFunc, projectScoped bool) http.HandlerFunc {
		chain := []func(http.Handler) http.Handler{
			registrar.auth,
			registrar.scoped,
			registrar.write,
		}
		if projectScoped {
			chain = append(chain, requireQueryProjectScope)
		}
		return withAgentMonthlyMiddleware(handler, chain...)
	}

	router.Get("/api/v1/agent/monthly-reports", read(h.List, true))
	router.Get("/api/v1/agent/monthly-reports/financial-series", read(h.FinancialSeries, true))
	router.Get(
		"/api/v1/agent/monthly-reports/financial-series/accounting-detail",
		read(h.AccountingDetail, true),
	)
	router.Get(
		"/api/v1/agent/monthly-reports/financial-series/accounting-detail/export",
		read(h.ExportAccountingDetail, true),
	)
	router.Post("/api/v1/agent/monthly-reports/uploads", write(h.CreateUpload, false))
	router.Post(
		"/api/v1/agent/monthly-reports/uploads/{upload_id}/files",
		write(h.UploadFile, false),
	)
	router.Post("/api/v1/agent/monthly-reports/builds", write(h.CreateBuild, false))
	router.Get("/api/v1/agent/monthly-reports/builds/{build_id}", read(h.GetBuild, false))
	router.Get(
		"/api/v1/agent/monthly-reports/builds/{build_id}/preview",
		read(h.GetBuildPreview, false),
	)
	router.Get(
		"/api/v1/agent/monthly-reports/builds/{build_id}/result",
		read(h.DownloadBuildResult, false),
	)
	router.Post(
		"/api/v1/agent/monthly-reports/builds/{build_id}/confirm",
		write(h.ConfirmBuild, false),
	)
	router.Get("/api/v1/agent/monthly-reports/{report_id}", read(h.GetDetail, false))
	router.Get(
		"/api/v1/agent/monthly-reports/{report_id}/export",
		read(h.DownloadReport, false),
	)
	router.Get(
		"/api/v1/agent/monthly-reports/{report_id}/reconciliation",
		read(h.ReconciliationHistory, false),
	)
	router.Post(
		"/api/v1/agent/monthly-reports/{report_id}/reconciliation/auto",
		write(h.ReconcileAuto, false),
	)
	router.Post(
		"/api/v1/agent/monthly-reports/{report_id}/reconciliation/manual",
		write(h.ReconcileManual, false),
	)
}

func withAgentMonthlyMiddleware(
	handler http.HandlerFunc,
	middleware ...func(http.Handler) http.Handler,
) http.HandlerFunc {
	next := http.Handler(handler)
	for index := len(middleware) - 1; index >= 0; index-- {
		next = middleware[index](next)
	}
	return next.ServeHTTP
}

func requireQueryProjectScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		projectID, err := strconv.ParseInt(
			r.URL.Query().Get("project_id"),
			10,
			64,
		)
		if err != nil || projectID <= 0 {
			writeValidationError(w, map[string]any{
				"loc":  []string{"query", "project_id"},
				"msg":  "project_id must be a positive integer",
				"type": "value_error",
			})
			return
		}
		agentauth.RequireProjectScope(projectID)(next).ServeHTTP(w, r)
	})
}
