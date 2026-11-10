package crm_intent

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
)

// Default agent rate limits (spec §1.2).
const (
	DefaultReadRateRequests       = 120
	DefaultWriteRateRequests      = 30
	DefaultBatchWriteRateRequests = 60
)

// BlobStore is the R2 surface required for batch archival.
type BlobStore interface {
	Put(ctx context.Context, key string, data []byte, contentType string) (string, error)
	TryDelete(ctx context.Context, key string) blob.DeleteResult
}

// Handler carries the shared dependencies of the crm_intent endpoints.
type Handler struct {
	store   Store
	blobs   BlobStore
	auditor audit.Service
	now     func() time.Time
}

func NewHandler(store Store, blobs BlobStore, auditor audit.Service) *Handler {
	return &Handler{store: store, blobs: blobs, auditor: auditor, now: time.Now}
}

// Registrar wires user and agent routes for the crm_intent module.
type Registrar struct {
	handler         *Handler
	credentials     agentauth.CredentialStore
	readLimit       func(http.Handler) http.Handler
	writeLimit      func(http.Handler) http.Handler
	batchWriteLimit func(http.Handler) http.Handler
}

type registrarOptions struct {
	readLimiter       agentauth.RateLimiter
	writeLimiter      agentauth.RateLimiter
	batchWriteLimiter agentauth.RateLimiter
	now               func() time.Time
}

// Option customises the registrar (used by contract tests).
type Option func(*registrarOptions)

func WithReadRateLimiter(limiter agentauth.RateLimiter) Option {
	return func(options *registrarOptions) { options.readLimiter = limiter }
}

func WithWriteRateLimiter(limiter agentauth.RateLimiter) Option {
	return func(options *registrarOptions) { options.writeLimiter = limiter }
}

func WithBatchWriteRateLimiter(limiter agentauth.RateLimiter) Option {
	return func(options *registrarOptions) { options.batchWriteLimiter = limiter }
}

func WithClock(now func() time.Time) Option {
	return func(options *registrarOptions) {
		if now != nil {
			options.now = now
		}
	}
}

func NewRegistrar(
	store Store,
	blobs BlobStore,
	credentials agentauth.CredentialStore,
	auditor audit.Service,
	options ...Option,
) *Registrar {
	settings := registrarOptions{now: time.Now}
	for _, option := range options {
		if option != nil {
			option(&settings)
		}
	}
	if settings.readLimiter == nil {
		settings.readLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: DefaultReadRateRequests, Window: time.Minute,
		})
	}
	if settings.writeLimiter == nil {
		settings.writeLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: DefaultWriteRateRequests, Window: time.Minute,
		})
	}
	if settings.batchWriteLimiter == nil {
		settings.batchWriteLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: DefaultBatchWriteRateRequests, Window: time.Minute,
		})
	}
	handler := NewHandler(store, blobs, auditor)
	handler.now = settings.now
	return &Registrar{
		handler:         handler,
		credentials:     credentials,
		readLimit:       agentauth.RequireRateLimit(settings.readLimiter),
		writeLimit:      agentauth.RequireRateLimit(settings.writeLimiter),
		batchWriteLimit: agentauth.RequireRateLimit(settings.batchWriteLimiter),
	}
}

func (*Registrar) ModuleName() string { return ModuleName }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler

	router.With(requireAPIKey).Get(userPrefix+"/meta", handler.Meta)
	router.With(requireAPIKey).Get(userPrefix+"/companies", handler.ListCompanies)
	router.With(requireAPIKey).Get(userPrefix+"/companies/{company_id}", handler.GetCompany)
	router.With(requireAPIKey).Patch(userPrefix+"/companies/{company_id}/followup", handler.UpdateFollowup)
	router.With(requireAPIKey).Post(userPrefix+"/companies/{company_id}/claim", handler.ClaimCompany)
	router.With(requireAPIKey).Patch(userPrefix+"/companies/{company_id}/profile", handler.UpdateProfile)
	router.With(requireAPIKey).Post(userPrefix+"/companies/{company_id}/phones", handler.AddPhone)
	router.With(requireAPIKey).Patch(userPrefix+"/companies/{company_id}/phones/{phone_id}", handler.UpdatePhone)
	router.With(requireAPIKey).Delete(userPrefix+"/companies/{company_id}/phones/{phone_id}", handler.DeletePhone)
	router.With(requireAPIKey).Post(userPrefix+"/companies/{company_id}/convert", handler.ConvertCompany)
	router.With(requireAPIKey).Get(userPrefix+"/board", handler.Board)
	router.With(requireAPIKey).Get(userPrefix+"/pool", handler.ListPool)
	router.With(requireAPIKey).Get(userPrefix+"/facets", handler.Facets)
	router.With(requireAPIKey).Get(userPrefix+"/export", handler.ExportCompanies)
	router.With(requireAPIKey).Post(userPrefix+"/batches/upload", handler.UploadBatch)
	router.With(requireAPIKey).Get(userPrefix+"/batches", handler.ListBatches)
	router.With(requireAPIKey).Get(userPrefix+"/batches/{batch_id}", handler.GetBatch)

	registrar.registerAgentRoutes(router)
}

// registerAgentRoutes mounts /api/v1/agent/crm-intent/* with agent credential +
// business scope + in-memory rate limiting.
func (registrar *Registrar) registerAgentRoutes(router chi.Router) {
	handler := registrar.handler
	base := []func(http.Handler) http.Handler{
		agentauth.RequireAgentCredential(registrar.credentials),
		agentauth.RequireBusinessScope(BusinessScope),
	}
	read := func(method, path string, target http.HandlerFunc) {
		middlewares := append(append([]func(http.Handler) http.Handler{}, base...), registrar.readLimit)
		router.With(middlewares...).Method(method, path, target)
	}
	write := func(method, path string, target http.HandlerFunc) {
		middlewares := append(append([]func(http.Handler) http.Handler{}, base...), registrar.writeLimit)
		router.With(middlewares...).Method(method, path, target)
	}
	batchWrite := func(method, path string, target http.HandlerFunc) {
		middlewares := append(append([]func(http.Handler) http.Handler{}, base...), registrar.batchWriteLimit)
		router.With(middlewares...).Method(method, path, target)
	}

	read(http.MethodGet, agentPrefix+"/health", handler.AgentHealth)
	batchWrite(http.MethodPost, agentPrefix+"/batches", handler.AgentImportBatchJSON)
	batchWrite(http.MethodPost, agentPrefix+"/batches/upload", handler.AgentImportBatchUpload)
	read(http.MethodGet, agentPrefix+"/batches", handler.AgentListBatches)
	read(http.MethodGet, agentPrefix+"/batches/{batch_id}", handler.AgentGetBatch)
	write(http.MethodPost, agentPrefix+"/companies", handler.AgentCreateCompany)
	write(http.MethodPatch, agentPrefix+"/companies/{company_id}", handler.AgentPatchCompany)
	read(http.MethodGet, agentPrefix+"/companies", handler.AgentListCompanies)
	read(http.MethodGet, agentPrefix+"/companies/{company_id}", handler.AgentGetCompany)
	read(http.MethodGet, agentPrefix+"/pool", handler.AgentListPool)
	write(http.MethodPatch, agentPrefix+"/pool/{pool_id}", handler.AgentUpdatePool)
	write(http.MethodPost, agentPrefix+"/pool/{pool_id}/screen", handler.AgentScreenPool)
}
