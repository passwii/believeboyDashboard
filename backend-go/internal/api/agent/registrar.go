package agent

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

type Registrar struct {
	handler     *Handler
	auth        func(http.Handler) http.Handler
	rateLimiter func(http.Handler) http.Handler
}

func NewRegistrar(stores Stores, options Options) *Registrar {
	limiter := options.RateLimiter
	if limiter == nil {
		limiter = agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: 120,
			Window:   time.Minute,
		})
	}
	return &Registrar{
		handler:     NewHandler(stores, options),
		auth:        RequireAgentCredential(options.Credentials),
		rateLimiter: agentauth.RequireRateLimit(limiter),
	}
}

func (*Registrar) ModuleName() string { return "agent" }

func (r *Registrar) RegisterRoutes(
	router chi.Router,
	_ func(http.Handler) http.Handler,
) {
	h := r.handler
	router.Route("/api/v1/agent", func(agent chi.Router) {
		agent.Use(r.auth, r.rateLimiter)

		agent.Get("/health", h.Health)
		agent.Get("/projects", h.ListProjects)
		agent.With(RequireBusinessScope("report_upload_status")).
			Get("/report-upload-status", h.GetReportUploadStatus)
		agent.With(RequireBusinessScope("complaint_center")).
			Get("/complaint-center/complaints", h.ListComplaints)
		agent.With(RequireBusinessScope("complaint_center")).
			Get("/complaint-center/overview", h.GetComplaintOverview)

		// Sales / inventory snapshots.
		agent.With(RequireProjectScope, RequireBusinessScope("sales")).
			Get("/projects/{project_id}/sales/summary", h.GetSalesSummary)
		agent.With(RequireProjectScope, RequireBusinessScope("inventory")).
			Get("/projects/{project_id}/inventory", h.GetInventory)

		// Inventory ledger.
		ledger := func(method, pattern string, handler http.HandlerFunc) {
			agent.With(RequireProjectScope, RequireBusinessScope("inventory_ledger")).
				Method(method, "/projects/{project_id}/inventory-ledger"+pattern, handler)
		}
		ledger(http.MethodGet, "/months", h.ListInventoryLedgerMonths)
		ledger(http.MethodGet, "/snapshot", h.GetInventoryLedgerSnapshot)
		ledger(http.MethodGet, "/events", h.GetInventoryLedgerEvents)
		ledger(http.MethodGet, "/receipt-clusters", h.GetInventoryLedgerReceiptClusters)
		ledger(http.MethodGet, "/integrity", h.GetInventoryLedgerIntegrity)
		ledger(http.MethodGet, "/trend", h.GetInventoryLedgerTrend)
		ledger(http.MethodGet, "/detail", h.GetInventoryLedgerDetail)
		ledger(http.MethodGet, "/summary", h.GetInventoryLedgerSummary)
		ledger(http.MethodGet, "/batches", h.GetInventoryLedgerBatches)
		ledger(http.MethodGet, "/consistency", h.GetInventoryLedgerConsistency)

		// Shipment schedules.
		shipment := func(method, pattern string, handler http.HandlerFunc) {
			agent.With(RequireProjectScope, RequireBusinessScope("shipments")).
				Method(method, "/projects/{project_id}/shipments"+pattern, handler)
		}
		shipment(http.MethodGet, "", h.ListShipments)
		shipment(http.MethodGet, "/batches", h.ListShipmentBatches)
		shipment(http.MethodGet, "/{shipment_no}", h.GetShipment)
		shipment(http.MethodGet, "/{shipment_no}/sku-summary", h.GetShipmentSkuSummary)
		shipment(http.MethodGet, "/{shipment_no}/fba-box-detail", h.GetShipmentFbaBoxDetail)
		shipment(http.MethodGet, "/{shipment_no}/audit", h.GetShipmentAudit)
		shipment(http.MethodPost, "", h.CreateShipment)
		shipment(http.MethodPut, "/{shipment_no}/items", h.ReplaceShipmentItems)
		shipment(http.MethodPatch, "/{shipment_no}", h.PatchShipment)
		shipment(http.MethodPost, "/{shipment_no}/status", h.UpdateShipmentStatus)
		shipment(http.MethodPost, "/{shipment_no}/recalculate-costs", h.RecalculateShipmentCosts)
		shipment(http.MethodDelete, "/{shipment_no}", h.DeleteShipment)

		// Shop calculations.
		shop := func(method, pattern string, handler http.HandlerFunc) {
			agent.With(RequireProjectScope, RequireBusinessScope("shop_calculations")).
				Method(method, "/projects/{project_id}/shop-calculations"+pattern, handler)
		}
		shop(http.MethodGet, "", h.ListShopCalculations)
		shop(http.MethodGet, "/skus/{sku}", h.GetShopCalculationSKU)
		shop(http.MethodGet, "/skus/{sku}/history", h.ListShopCalculationHistory)
		shop(http.MethodGet, "/skus/{sku}/audit", h.GetShopCalculationAudit)
		shop(http.MethodPost, "", h.AppendShopCalculation)
		shop(http.MethodPost, "/compute", h.ComputeShopCalculation)
		agent.With(RequireProjectScope, RequireBusinessScope("shop_calculations")).
			Get("/projects/{project_id}/shop-calculation-history", h.ListShopCalculationHistory)
		agent.With(RequireProjectScope, RequireBusinessScope("shop_calculations")).
			Get("/projects/{project_id}/shop-calculation/snapshots", h.ListShopCalculationHistory)

		// New product calculations.
		newProduct := func(method, pattern string, handler http.HandlerFunc) {
			agent.With(RequireProjectScope, RequireBusinessScope("new_product_calculations")).
				Method(method, "/projects/{project_id}/new-product-calculations"+pattern, handler)
		}
		newProduct(http.MethodGet, "", h.ListNewProductCalculations)
		newProduct(http.MethodGet, "/skus/{sku}", h.GetNewProductCalculationSKU)
		newProduct(http.MethodGet, "/skus/{sku}/audit", h.GetNewProductCalculationAudit)
		newProduct(http.MethodPost, "", h.UpsertNewProductCalculation)
		newProduct(http.MethodPost, "/compute", h.ComputeNewProductCalculation)

		// Pricing snapshots.
		agent.With(RequireProjectScope, RequireBusinessScope("shop_calculations")).
			Get("/projects/{project_id}/pricing-snapshots", h.ListPricingSnapshots)

		// Return analysis.
		returnAnalysis := func(method, pattern string, handler http.HandlerFunc) {
			agent.With(RequireProjectScope, RequireBusinessScope("return_analysis")).
				Method(method, "/projects/{project_id}"+pattern, handler)
		}
		returnAnalysis(http.MethodGet, "/return-analysis/overview", h.GetReturnOverview)
		returnAnalysis(http.MethodGet, "/return-analysis", h.GetReturnAggregate)
		returnAnalysis(http.MethodGet, "/return-analysis-raw", h.GetReturnRaw)
		returnAnalysis(http.MethodGet, "/return-analysis/skus/{sku}", h.GetReturnSKU)
		returnAnalysis(http.MethodGet, "/return-analysis/coverage", h.GetReturnCoverage)

		// Replenishment analysis.
		agent.With(RequireProjectScope, RequireBusinessScope("replenishment_analysis")).
			Get("/projects/{project_id}/replenishment-analysis", h.ListReplenishmentAnalysis)
		agent.With(RequireProjectScope, RequireBusinessScope("replenishment_analysis")).
			Get("/projects/{project_id}/replenishment-analysis/skus/{sku}", h.GetReplenishmentSKU)
		agent.With(RequireProjectScope, RequireBusinessScope("replenishment_analysis")).
			Get("/projects/{project_id}/replenishment-analysis/summary", h.GetReplenishmentSummary)
		agent.With(RequireProjectScope, RequireBusinessScope("replenishment_analysis")).
			Get("/projects/{project_id}/replenishment-analysis/coverage", h.GetReplenishmentCoverage)
		agent.With(RequireProjectScope, RequireBusinessScope("replenishment_analysis")).
			Get("/projects/{project_id}/replenishment-analysis/settings", h.ListReplenishmentSettings)
		agent.With(RequireProjectScope, RequireBusinessScope("replenishment_analysis")).
			Put("/projects/{project_id}/replenishment-analysis/settings/{sku}", h.UpdateReplenishmentSetting)

		registerAdRoutes(agent, h)
	})
}

func registerAdRoutes(
	router chi.Router,
	h *Handler,
) {
	type adRoute struct {
		aggregate   string
		rawPlural   string
		rawSingular string
		endpoint    string
	}
	routes := []adRoute{
		{"ad-campaigns", "ad-campaigns-raw", "ad-campaign-raw", "ad-campaigns"},
		{"ad-budgets", "ad-budgets-raw", "ad-budget-raw", "ad-budgets"},
		{"ad-targets", "ad-targets-raw", "ad-target-raw", "ad-targets"},
		{"ad-placements", "ad-placements-raw", "ad-placement-raw", "ad-placements"},
		{"ad-promoted-products", "ad-promoted-products-raw", "ad-promoted-product-raw", "ad-promoted-products"},
		{"ad-time-trends", "ad-time-trends-raw", "ad-time-trend-raw", "ad-time-trends"},
		{"ad-search-terms", "ad-search-terms-raw", "ad-search-term-raw", "ad-search-terms"},
		{"ad-search-term-shares", "ad-search-term-shares-raw", "ad-search-term-share-raw", "ad-search-term-shares"},
		{"ad-invalid-traffic", "ad-invalid-traffic-raw", "", "ad-invalid-traffic"},
		{"ad-purchased-products", "ad-purchased-products-raw", "ad-purchased-product-raw", "ad-purchased-products"},
	}
	for _, route := range routes {
		route := route
		router.With(RequireProjectScope, RequireBusinessScope("ad_analysis")).
			Get("/projects/{project_id}/"+route.aggregate, h.GetAdAggregate(route.endpoint))
		router.With(RequireProjectScope, RequireBusinessScope("ad_analysis")).
			Get("/projects/{project_id}/"+route.rawPlural, h.GetAdRaw(route.endpoint))
		if route.rawSingular != "" {
			router.With(RequireProjectScope, RequireBusinessScope("ad_analysis")).
				Get("/projects/{project_id}/"+route.rawSingular, h.GetAdRaw(route.endpoint))
		}
	}
}
