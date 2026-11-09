package agent_credentials

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

// agentAPIPrefix is the Agent API namespace shared by every Agent-domain
// registrar. Routes are registered through router.With(...) with full paths
// instead of router.Route(...)/Mount: chi panics when a prefix is mounted twice,
// and GO_API_OWNED can enable several Agent registrars at the same time.
const agentAPIPrefix = "/api/v1/agent"

type Registrar struct {
	handler     *Handler
	auth        func(http.Handler) http.Handler
	rateLimiter func(http.Handler) http.Handler
}

func NewRegistrar(keys KeyStore, uploadsStore UploadStore, options Options) *Registrar {
	if options.RateLimiter == nil {
		options.RateLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: 120,
			Window:   time.Minute,
		})
	}
	return &Registrar{
		handler:     NewHandler(keys, uploadsStore, options),
		auth:        agentauth.RequireAgentCredential(options.Credentials),
		rateLimiter: agentauth.RequireRateLimit(options.RateLimiter),
	}
}

func (*Registrar) ModuleName() string {
	return "agent_credentials"
}

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	_ func(http.Handler) http.Handler,
) {
	if registrar == nil || registrar.handler == nil {
		return
	}
	agent := router.With(registrar.auth)

	provisioning := func(method, path string, handler http.HandlerFunc) {
		agent.With(
			agentauth.RequireBusinessScope("agent_provisioning"),
			registrar.rateLimiter,
		).Method(method, agentAPIPrefix+path, handler)
	}
	provisioning(http.MethodGet, "/provisioning/keys", registrar.handler.ListAgentKeys)
	provisioning(http.MethodPost, "/provisioning/keys", registrar.handler.CreateAgentKey)
	provisioning(http.MethodPatch, "/provisioning/keys/{key_id}", registrar.handler.UpdateAgentKey)

	upload := func(method, path string, handler http.HandlerFunc) {
		agent.With(
			agentauth.RequireBusinessScope("report_upload"),
			registrar.rateLimiter,
		).Method(method, agentAPIPrefix+path, handler)
	}
	upload(http.MethodPost, "/upload/validate", registrar.handler.ValidateUpload)
	upload(http.MethodPost, "/upload/commit", registrar.handler.CommitUpload)
}
