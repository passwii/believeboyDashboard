package agent_commerce

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
	if options.ReadRateLimiter == nil {
		options.ReadRateLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: 120,
			Window:   time.Minute,
		})
	}
	if options.WriteRateLimiter == nil {
		options.WriteRateLimiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: 120,
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
	return "agent_commerce"
}

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	_ func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.Route("/api/v1/agent", func(agent chi.Router) {
		agent.Use(registrar.auth)

		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("new_product_calculations"),
			registrar.readLimiter,
		).Get(
			"/projects/{project_id}/new-product-calculations/export.xlsx",
			handler.ExportNewProductCalculations,
		)

		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("shipments"),
			registrar.readLimiter,
		).Get(
			"/projects/{project_id}/shipments/fba-box-details.xlsx",
			handler.ExportFBABoxDetails,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("shipments"),
			registrar.readLimiter,
		).Get(
			"/projects/{project_id}/shipments/{shipment_no}/fba-delivery-template",
			handler.ExportFBADeliveryTemplate,
		)

		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("shop_calculations"),
			registrar.readLimiter,
		).Get(
			"/projects/{project_id}/shop-calculations/export.xlsx",
			handler.ExportShopCalculations,
		)

		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.readLimiter,
		).Get(
			"/projects/{project_id}/sku-info",
			handler.ListSKUInfo,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.writeLimiter,
		).Post(
			"/projects/{project_id}/sku-info",
			handler.UpsertSKUInfo,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.writeLimiter,
		).Post(
			"/projects/{project_id}/sku-info/listing-copy/batch",
			handler.BatchUpdateListingCopy,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.readLimiter,
		).Get(
			"/projects/{project_id}/sku-info/{sku_record_id}",
			handler.GetSKUInfo,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.writeLimiter,
		).Patch(
			"/projects/{project_id}/sku-info/{sku_record_id}",
			handler.UpdateSKUInfo,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.writeLimiter,
		).Delete(
			"/projects/{project_id}/sku-info/{sku_record_id}",
			handler.DeleteSKUInfo,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.readLimiter,
		).Get(
			"/projects/{project_id}/sku-info/{sku_record_id}/audit",
			handler.GetSKUInfoAudit,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.writeLimiter,
		).Post(
			"/projects/{project_id}/sku-info/{sku_record_id}/fnsku-label",
			handler.UploadFNSKULabel,
		)
		agent.With(
			agentauth.RequireProjectScopeParam("project_id"),
			agentauth.RequireBusinessScope("sku_info"),
			registrar.writeLimiter,
		).Post(
			"/projects/{project_id}/sku-info/{sku_record_id}/status",
			handler.UpdateSKUStatus,
		)
	})
}
