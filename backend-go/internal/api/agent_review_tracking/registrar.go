package agent_review_tracking

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

type Registrar struct {
	handler      *Handler
	auth         func(http.Handler) http.Handler
	readLimiter  func(http.Handler) http.Handler
	writeLimiter func(http.Handler) http.Handler
}

func NewRegistrar(store Store, options Options) *Registrar {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.ReadRateLimiter == nil {
		options.ReadRateLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: DefaultReadRateRequests,
			Window:   time.Minute,
		})
	}
	if options.WriteRateLimiter == nil {
		options.WriteRateLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: DefaultWriteRateRequests,
			Window:   time.Minute,
		})
	}
	return &Registrar{
		handler:      NewHandler(store, options),
		auth:         agentauth.RequireAgentCredential(options.Credentials),
		readLimiter:  agentauth.RequireRateLimit(options.ReadRateLimiter),
		writeLimiter: agentauth.RequireRateLimit(options.WriteRateLimiter),
	}
}

func (*Registrar) ModuleName() string {
	return ModuleName
}

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	_ func(http.Handler) http.Handler,
) {
	router.With(
		registrar.auth,
		agentauth.RequireBusinessScope("review_tracking"),
		registrar.readLimiter,
	).Get(
		"/api/v1/agent/review-tracking/targets",
		registrar.handler.ListTargets,
	)

	router.With(
		registrar.auth,
		agentauth.RequireBusinessScope("review_tracking"),
		registrar.writeLimiter,
	).Post(
		"/api/v1/agent/review-tracking/targets/{target_id}/runs",
		registrar.handler.SubmitCrawlRun,
	)
}
