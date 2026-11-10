package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_upload"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_commerce"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_credentials"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_inspection"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_monthly_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_ops"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_review_tracking"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat_usage"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat_v2"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_file_upload"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/amazon_review_tracking"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/category_research"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/complaints"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm_intent"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/daily_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/digital_display"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/digital_employees"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/digital_office"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/external_retired"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_domains"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_observation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inspections"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_ad_data"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_jobs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_keys"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_ledger"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/jobs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notification_settings"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/order_info"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/page_render"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/platform_revenues"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/presence"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation_snapshots"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_label"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/project_goals"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/report_reconciliation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/return_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/rpa_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipment_schedules"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipping_plan"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shop_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/sku_info"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/system_management"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/users"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/vat_invoices"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/workflows"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
	"github.com/passwii/believeboyDashboard/backend-go/internal/internaljobsrunner"
	"github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
	"github.com/redis/go-redis/v9"
)

type dependencies struct {
	Stores httpserver.OwnedStores
	Close  func()
}

func newDependencies(ctx context.Context, cfg config.Config) (*dependencies, error) {
	deps := &dependencies{Close: func() {}}
	var pools []*pgxpool.Pool
	var queueClients []*queue.QueueClient
	var redisClients []*redis.Client
	var closers []io.Closer
	var sharedRedisClient *redis.Client
	var objectStore *blob.Store
	closeAll := func() {
		for _, closer := range closers {
			_ = closer.Close()
		}
		for _, client := range queueClients {
			_ = client.Close()
		}
		for _, client := range redisClients {
			_ = client.Close()
		}
		for _, pool := range pools {
			pool.Close()
		}
	}

	needsDatabase := cfg.OwnedModules["health"] ||
		cfg.OwnedModules["exchange_rates"] ||
		cfg.OwnedModules["notifications"] ||
		cfg.OwnedModules["alerts"] ||
		cfg.OwnedModules["profile"] ||
		cfg.OwnedModules["auth"] ||
		cfg.OwnedModules["users"] ||
		cfg.OwnedModules["internal_keys"] ||
		cfg.OwnedModules["internal_jobs"] ||
		cfg.OwnedModules["projects"] ||
		cfg.OwnedModules["workflows"] ||
		cfg.OwnedModules["notification_settings"] ||
		cfg.OwnedModules["order_info"] ||
		cfg.OwnedModules["sku_info"] ||
		cfg.OwnedModules["shipment_schedules"] ||
		cfg.OwnedModules["shipping_plan"] ||
		cfg.OwnedModules["inventory_ledger"] ||
		cfg.OwnedModules["inventory_replenishment"] ||
		cfg.OwnedModules["complaints"] ||
		cfg.OwnedModules[config.ModulePricingCalculation] ||
		cfg.OwnedModules[config.ModulePricingCalculationSnapshots] ||
		cfg.OwnedModules[config.ModuleNewProductCalculations] ||
		cfg.OwnedModules[config.ModuleShopCalculation] ||
		cfg.OwnedModules[config.ModuleDailyAnalysis] ||
		cfg.OwnedModules[config.ModuleProjectGoals] ||
		cfg.OwnedModules[config.ModuleAdAnalysis] ||
		cfg.OwnedModules[config.ModuleRpaReports] ||
		cfg.OwnedModules[config.ModuleAdUpload] ||
		cfg.OwnedModules[config.ModuleInternalAdData] ||
		cfg.OwnedModules[config.ModulePlatformRevenues] ||
		cfg.OwnedModules[config.ModuleVatInvoices] ||
		cfg.OwnedModules[config.ModuleReportReconciliation] ||
		cfg.OwnedModules[config.ModuleReturnAnalysis] ||
		cfg.OwnedModules[config.ModuleCategoryResearch] ||
		cfg.OwnedModules[config.ModuleMonthlyReports] ||
		cfg.OwnedModules[config.ModuleAgent] ||
		cfg.OwnedModules["ai_chat"] ||
		cfg.OwnedModules["ai_chat_v2"] ||
		cfg.OwnedModules["ai_chat_usage"] ||
		cfg.OwnedModules["uploads"] ||
		cfg.OwnedModules["page_render"] ||
		cfg.OwnedModules["jobs"] ||
		cfg.OwnedModules["scheduled_reports"] ||
		cfg.OwnedModules["crm"] ||
		cfg.OwnedModules[config.ModuleCRMIntent] ||
		cfg.OwnedModules["system_management"] ||
		cfg.OwnedModules["digital_employees"] ||
		cfg.OwnedModules["digital_office"] ||
		cfg.OwnedModules["digital_display"] ||
		cfg.OwnedModules["agent_ops"] ||
		cfg.OwnedModules["presence"] ||
		cfg.OwnedModules["agent_inspection"] ||
		cfg.OwnedModules["agent_credentials"] ||
		cfg.OwnedModules["agent_monthly_reports"] ||
		cfg.OwnedModules["agent_commerce"] ||
		cfg.OwnedModules["agent_review_tracking"] ||
		cfg.OwnedModules["product_analysis"] ||
		cfg.OwnedModules["product_analysis_reports"] ||
		cfg.OwnedModules["ai_insight"] ||
		cfg.OwnedModules["insight_runs"] ||
		cfg.OwnedModules["insight_domains"] ||
		cfg.OwnedModules["insight_observation"] ||
		cfg.OwnedModules["exchange_rates_write"] ||
		cfg.OwnedModules["inspections"] ||
		cfg.OwnedModules["amazon_review_tracking"]
	if needsDatabase {
		primary, err := store.OpenPool(ctx, cfg.DatabaseURL)
		if err != nil {
			return nil, fmt.Errorf("open primary database: %w", err)
		}
		pools = append(pools, primary)
		primaryDB := store.NewPGXDB(primary)
		auditSvc := audit.NewService(primaryDB)
		projectStore := store.NewProjectStore(primaryDB)
		if cfg.OwnedModules["profile"] ||
			cfg.OwnedModules["uploads"] ||
			cfg.OwnedModules["page_render"] ||
			cfg.OwnedModules["workflows"] ||
			cfg.OwnedModules["inspections"] ||
			cfg.OwnedModules["agent_inspection"] ||
			cfg.OwnedModules["agent_commerce"] ||
			cfg.OwnedModules["sku_info"] ||
			cfg.OwnedModules[config.ModuleCRMIntent] ||
			cfg.OwnedModules["exchange_rates_write"] {
			createdObjectStore, err := newObjectStore(cfg)
			if err != nil {
				closeAll()
				return nil, fmt.Errorf("create R2 object store: %w", err)
			}
			objectStore = createdObjectStore
		}
		deps.Stores.APIKeys = store.NewUserKeyStore(primaryDB)
		deps.Stores.HealthDatabase = primaryDB
		if cfg.OwnedModules["exchange_rates"] ||
			cfg.OwnedModules["exchange_rates_write"] ||
			cfg.OwnedModules["profile"] {
			deps.Stores.ExchangeRates = store.NewExchangeRateStore(primaryDB)
		}
		if cfg.OwnedModules["exchange_rates_write"] && objectStore != nil {
			deps.Stores.ExchangeRatesBlobs = objectStore
		}
		if cfg.OwnedModules["notifications"] {
			deps.Stores.Notifications = store.NewNotificationStore(primaryDB)
		}
		if cfg.OwnedModules["alerts"] {
			deps.Stores.Alerts = store.NewAlertStore(primaryDB)
		}
		if cfg.OwnedModules["profile"] {
			deps.Stores.Profile = store.NewProfileStore(primaryDB)
			deps.Stores.ProfileAuditor = store.NewProfileAvatarAuditor(auditSvc)
			if objectStore != nil {
				deps.Stores.ProfileBlobs = objectStore
			}
		}
		if cfg.OwnedModules["auth"] {
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, auth.NewRegistrar(store.NewUserStore(primaryDB)))
		}
		if cfg.OwnedModules["users"] {
			if sharedRedisClient == nil {
				client, err := newSharedRedisClient(cfg)
				if err != nil {
					closeAll()
					return nil, err
				}
				sharedRedisClient = client
				redisClients = append(redisClients, client)
			}
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				users.NewRegistrarWithOptions(
					store.NewUserStore(primaryDB),
					users.WithAuditor(auditSvc),
					users.WithSessionRevoker(
						store.NewRedisSessionRevoker(
							sharedRedisClient,
							cfg.RedisKeyPrefix,
						),
					),
				),
			)
		}
		if cfg.OwnedModules["internal_keys"] {
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, internal_keys.NewRegistrar(store.NewAPIKeyStore(primaryDB), auditSvc))
		}
		if cfg.OwnedModules["internal_jobs"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				internal_jobs.NewRegistrar(
					store.NewInternalJobStore(primaryDB),
					internaljobsrunner.New(primaryDB),
					auditSvc,
				),
			)
		}
		if cfg.OwnedModules["projects"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				projects.NewRegistrar(
					projectStore,
					auditSvc,
					projects.WithContextParser(
						projects.NewAIContextParser(
							ai_chat.ProviderFromConfig(cfg),
							cfg.AIChatDefaultModel,
						),
					),
				),
			)
			if cfg.OwnedModules["workflows"] {
				registrar, err := newWorkflowRegistrar(cfg, primaryDB, projectStore, objectStore)
				if err != nil {
					closeAll()
					return nil, err
				}
				deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, registrar)
			}
		} else if cfg.OwnedModules["workflows"] {
			registrar, err := newWorkflowRegistrar(cfg, primaryDB, projectStore, objectStore)
			if err != nil {
				closeAll()
				return nil, err
			}
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, registrar)
		}
		if cfg.OwnedModules["notification_settings"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				notification_settings.NewRegistrar(
					store.NewNotificationSettingsStore(primaryDB),
					notification_settings.WithMailer(newGatewayMailer(cfg)),
				),
			)
		}
		if cfg.OwnedModules["order_info"] {
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, order_info.NewRegistrar(store.NewOrderInfoStore(primaryDB), auditSvc))
		}
		if cfg.OwnedModules["sku_info"] {
			registrar := sku_info.NewRegistrar(
				store.NewSkuStore(primaryDB),
				auditSvc,
				projectStore,
			)
			if objectStore != nil {
				registrar.WithBlobStore(objectStore)
			}
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, registrar)
		}
		if cfg.OwnedModules["shipment_schedules"] {
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, shipment_schedules.NewRegistrar(store.NewShipmentScheduleStore(primaryDB), auditSvc, projectStore))
		}
		if cfg.OwnedModules["shipping_plan"] {
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, shipping_plan.NewRegistrar(store.NewShippingPlanStore(primaryDB), auditSvc, projectStore))
		}
		if cfg.OwnedModules["inventory_ledger"] {
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, inventory_ledger.NewRegistrar(store.NewInventoryLedgerStore(primaryDB)))
		}
		if cfg.OwnedModules["inventory_replenishment"] {
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, inventory_replenishment.NewRegistrar(store.NewInventoryReplenishmentStore(primaryDB), auditSvc, projectStore))
		}
		if cfg.OwnedModules["complaints"] {
			deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, complaints.NewRegistrar(store.NewComplaintStore(primaryDB), auditSvc))
		}
		if cfg.OwnedModules[config.ModulePricingCalculation] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				pricing_calculation.NewRegistrar(store.NewPricingCalculationStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModulePricingCalculationSnapshots] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				pricing_calculation_snapshots.NewRegistrar(
					store.NewPricingCalculationSnapshotStore(primaryDB),
					auditSvc,
				),
			)
		}
		if cfg.OwnedModules[config.ModuleNewProductCalculations] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				new_product_calculations.NewRegistrar(
					store.NewProductCalculationStore(primaryDB),
					auditSvc,
				),
			)
		}
		if cfg.OwnedModules[config.ModuleShopCalculation] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				shop_calculation.NewRegistrar(store.NewShopCalculationStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleDailyAnalysis] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				daily_analysis.NewRegistrar(store.NewDailyAnalysisStore(primaryDB)),
			)
		}
		if cfg.OwnedModules[config.ModuleProjectGoals] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				project_goals.NewRegistrar(store.NewProjectGoalStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleAdAnalysis] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				ad_analysis.NewRegistrar(store.NewAdAnalysisStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleRpaReports] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				rpa_reports.NewRegistrar(store.NewRpaReportsStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleAdUpload] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				ad_upload.NewRegistrar(store.NewAdUploadStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleInternalAdData] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				internal_ad_data.NewRegistrar(store.NewInternalAdDataStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModulePlatformRevenues] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				platform_revenues.NewRegistrar(store.NewPlatformRevenueStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleVatInvoices] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				vat_invoices.NewRegistrar(store.NewVatInvoiceStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleReportReconciliation] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				report_reconciliation.NewRegistrar(store.NewReportReconciliationStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules["product_analysis"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				product_analysis.NewRegistrar(
					store.NewProductAnalysisStore(primaryDB),
					auditSvc,
				),
			)
		}
		if cfg.OwnedModules["product_analysis_reports"] {
			queueClient, err := queue.NewQueueClient(cfg.RedisURL, queue.DefaultClientConfig())
			if err != nil {
				closeAll()
				return nil, fmt.Errorf("create product analysis report queue client: %w", err)
			}
			queueClients = append(queueClients, queueClient)
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				product_analysis_reports.NewRegistrarWithDependencies(
					store.NewProductAnalysisReportStoreWithUploadRoot(
						primaryDB,
						cfg.UploadRoot,
					),
					auditSvc,
					monthlyReportQueueEnqueuer{client: queueClient},
					cfg.MonthlyReportResultRoot,
					nil,
				),
			)
		}
		if cfg.OwnedModules[config.ModuleReturnAnalysis] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				return_analysis.NewRegistrar(store.NewReturnAnalysisStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleCategoryResearch] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				category_research.NewRegistrar(store.NewCategoryResearchStore(primaryDB), auditSvc),
			)
		}
		if cfg.OwnedModules[config.ModuleMonthlyReports] {
			queueClient, err := queue.NewQueueClient(cfg.RedisURL, queue.DefaultClientConfig())
			if err != nil {
				closeAll()
				return nil, fmt.Errorf("create monthly report queue client: %w", err)
			}
			queueClients = append(queueClients, queueClient)
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				monthly_reports.NewRegistrarWithEnqueuer(
					store.NewMonthlyReportStoreWithRoots(
						primaryDB,
						cfg.MonthlyReportResultRoot,
						cfg.UploadRoot,
					),
					auditSvc,
					monthlyReportQueueEnqueuer{client: queueClient},
				),
			)
		}
		if cfg.OwnedModules[config.ModuleAgent] {
			var confirmStore agent.ConfirmStore
			if cfg.RedisURL != "" {
				if sharedRedisClient == nil {
					client, err := newSharedRedisClient(cfg)
					if err != nil {
						closeAll()
						return nil, err
					}
					sharedRedisClient = client
					redisClients = append(redisClients, client)
				}
				confirmStore = agent.NewRedisConfirmStore(sharedRedisClient, "agent:confirm:")
			}
			if confirmStore == nil {
				confirmStore = agent.NewMemoryConfirmStore(time.Now)
			}
			agentStores := agent.Stores{
				Projects:         projectStore,
				Sales:            store.NewDailyAnalysisStore(primaryDB),
				Inventory:        store.NewInventoryReplenishmentStore(primaryDB),
				Ledger:           store.NewInventoryLedgerStore(primaryDB),
				Shipments:        store.NewShipmentScheduleStore(primaryDB),
				ShopCalculations: store.NewShopCalculationStore(primaryDB),
				NewProducts:      store.NewProductCalculationStore(primaryDB),
				PricingSnapshots: store.NewPricingCalculationSnapshotStore(primaryDB),
				Returns:          store.NewReturnAnalysisStore(primaryDB),
				Replenishment:    store.NewInventoryReplenishmentStore(primaryDB),
				ReportStatus:     store.NewRpaReportsStore(primaryDB),
				Complaints:       store.NewComplaintStore(primaryDB),
				Ads:              store.NewInternalAdDataStore(primaryDB),
				Audit:            store.NewAuditLogStore(primaryDB),
			}
			agentOptions := agent.Options{
				Credentials:  agent.NewDBCredentialResolver(primaryDB, time.Now),
				ConfirmStore: confirmStore,
				Auditor:      auditSvc,
				Now:          time.Now,
			}
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				agent.NewRegistrar(agentStores, agentOptions),
			)
		}

		if cfg.OwnedModules["agent_inspection"] ||
			cfg.OwnedModules["agent_credentials"] ||
			cfg.OwnedModules["agent_monthly_reports"] ||
			cfg.OwnedModules["agent_commerce"] ||
			cfg.OwnedModules["agent_review_tracking"] {
			agentCredentials := agentauth.NewPGXCredentialStore(primaryDB)
			var agentConfirms agentauth.ConfirmStore = agentauth.NewMemoryConfirmStore(
				agentauth.WithMemoryConfirmClock(time.Now),
			)
			if cfg.RedisURL != "" {
				if sharedRedisClient == nil {
					client, err := newSharedRedisClient(cfg)
					if err != nil {
						closeAll()
						return nil, err
					}
					sharedRedisClient = client
					redisClients = append(redisClients, client)
				}
				agentConfirms = agentauth.NewRedisConfirmStore(
					sharedRedisClient,
					"agentauth:confirm:",
				)
			}
			if cfg.OwnedModules["agent_inspection"] {
				var inspectionBlobs agent_inspection.BlobStore
				if objectStore != nil {
					inspectionBlobs = objectStore
				}
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					agent_inspection.NewRegistrar(
						store.NewAgentInspectionStore(primaryDB),
						agentCredentials,
						agentConfirms,
						inspectionBlobs,
					),
				)
			}
			if cfg.OwnedModules["agent_credentials"] {
				var agentUploadInvalidator uploads.CacheInvalidator
				if sharedRedisClient != nil {
					agentUploadInvalidator = store.NewRedisDailyAnalysisCacheInvalidator(
						sharedRedisClient,
						cfg.RedisKeyPrefix,
					)
				}
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					agent_credentials.NewRegistrar(
						store.NewAgentCredentialStore(primaryDB, auditSvc),
						store.NewAgentCredentialUploadStore(
							primaryDB,
							cfg.UploadRoot,
							50<<20,
							agentUploadInvalidator,
						),
						agent_credentials.Options{
							Credentials:  agentCredentials,
							ConfirmStore: agentConfirms,
							Auditor:      auditSvc,
							Now:          time.Now,
						},
					),
				)
			}
			if cfg.OwnedModules["agent_monthly_reports"] {
				queueClient, err := queue.NewQueueClient(
					cfg.RedisURL,
					queue.DefaultClientConfig(),
				)
				if err != nil {
					closeAll()
					return nil, fmt.Errorf(
						"create agent monthly report queue client: %w",
						err,
					)
				}
				queueClients = append(queueClients, queueClient)
				monthlyStore := store.NewAgentMonthlyReportStore(
					primaryDB,
					auditSvc,
					store.AgentMonthlyReportStoreOptions{
						Root:       cfg.AgentMonthlyReportRoot,
						UploadRoot: cfg.UploadRoot,
						ResultRoot: cfg.MonthlyReportResultRoot,
						Now:        time.Now,
					},
				)
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					agent_monthly_reports.NewRegistrar(
						monthlyStore,
						auditSvc,
						agent_monthly_reports.Options{
							Credentials:  agentCredentials,
							ConfirmStore: agentConfirms,
							Dispatcher: &agent_monthly_reports.QueueBuildDispatcher{
								Client: queueClient,
							},
							Now:          time.Now,
							MaxFileBytes: 50 << 20,
						},
					),
				)
			}
			if cfg.OwnedModules["agent_commerce"] {
				var commerceBlobs agent_commerce.BlobStore
				if objectStore != nil {
					commerceBlobs = objectStore
				}
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					agent_commerce.NewRegistrar(
						store.NewAgentCommerceStore(primaryDB, auditSvc),
						agent_commerce.Options{
							Credentials:  agentCredentials,
							ConfirmStore: agentConfirms,
							Blobs:        commerceBlobs,
							Now:          time.Now,
						},
					),
				)
			}
			if cfg.OwnedModules["agent_review_tracking"] {
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					agent_review_tracking.NewRegistrar(
						store.NewAgentReviewTrackingStore(primaryDB),
						agent_review_tracking.Options{
							Credentials: agentCredentials,
							Now:         time.Now,
						},
					),
				)
			}
		}

		if cfg.OwnedModules["ai_chat"] || cfg.OwnedModules["ai_chat_v2"] {
			chatStore := store.NewAIChatStore(primaryDB)
			if cfg.OwnedModules["ai_chat"] {
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					ai_chat.NewRegistrar(chatStore, cfg),
				)
			}
			if cfg.OwnedModules["ai_chat_v2"] {
				registrar := ai_chat_v2.NewRegistrar(chatStore, cfg)
				closers = append(closers, registrar)
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					registrar,
				)
			}
		}
		if cfg.OwnedModules["ai_chat_usage"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				ai_chat_usage.NewRegistrar(store.NewAIChatUsageStore(primaryDB)),
			)
		}

		if cfg.OwnedModules["ai_insight"] ||
			cfg.OwnedModules["insight_runs"] ||
			cfg.OwnedModules["insight_domains"] ||
			cfg.OwnedModules["insight_observation"] {
			insightStore := store.NewAIInsightStoreWithObservation(
				primaryDB,
				auditSvc,
				cfg.InsightObservationEnabled,
			)
			var insightEnqueuer ai_insight.JobEnqueuer
			var insightProvider ai.Provider
			var insightEvents insight_runs.EventStore
			if cfg.OwnedModules["ai_insight"] ||
				cfg.OwnedModules["insight_runs"] ||
				cfg.OwnedModules["insight_domains"] {
				queueClient, err := queue.NewQueueClient(
					cfg.RedisURL,
					queue.DefaultClientConfig(),
				)
				if err != nil {
					closeAll()
					return nil, fmt.Errorf("create insight queue client: %w", err)
				}
				queueClients = append(queueClients, queueClient)
				insightEnqueuer = aiInsightQueueEnqueuer{client: queueClient}
				insightProvider = ai.NewOpenAIProvider(ai.ProviderConfig{
					BaseURL:      cfg.AIChatProviderBaseURL,
					APIKey:       cfg.AIChatProviderAPIKey,
					DefaultModel: cfg.AIChatDefaultModel,
					Timeout:      time.Duration(cfg.AIChatTimeoutSeconds) * time.Second,
				})
			}
			if cfg.OwnedModules["insight_runs"] {
				insightRedisClient := health.NewRedisClient(cfg.InsightStreamRedisURL)
				if insightRedisClient == nil {
					closeAll()
					return nil, fmt.Errorf("parse INSIGHT_STREAM_REDIS_URL")
				}
				redisClients = append(redisClients, insightRedisClient)
				insightEvents = insight_runs.NewRedisEventStore(
					insightRedisClient,
					cfg.RedisKeyPrefix+":insight",
					time.Duration(cfg.InsightStreamTTLSeconds)*time.Second,
					int64(cfg.InsightStreamMaxLen),
				)
			}
			if cfg.OwnedModules["ai_insight"] {
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					ai_insight.NewRegistrar(
						insightStore,
						insightEnqueuer,
						ai_insight.Config{
							CanonicalDomains: cfg.InsightCanonicalDomains,
						},
					),
				)
			}
			if cfg.OwnedModules["insight_runs"] {
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					insight_runs.NewRegistrar(
						insightStore,
						insightEnqueuer,
						insightProvider,
						insightEvents,
						insight_runs.Config{
							CanonicalDomains: cfg.InsightCanonicalDomains,
							SSEPollInterval:  2 * time.Second,
							SSETimeout:       time.Hour,
							StreamTTL:        time.Duration(cfg.InsightStreamTTLSeconds) * time.Second,
						},
					),
				)
			}
			if cfg.OwnedModules["insight_domains"] {
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					insight_domains.NewRegistrar(
						insightStore,
						insightEnqueuer,
						insightProvider,
						insight_domains.Config{
							CanonicalDomains: cfg.InsightCanonicalDomains,
						},
					),
				)
			}
			if cfg.OwnedModules["insight_observation"] {
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					insight_observation.NewRegistrar(
						insightStore,
						insight_observation.Config{
							WindowDays: cfg.InsightObservationWindowDays,
							Thresholds: insight_observation.Thresholds{
								DurationMS:            cfg.InsightGateMaxDurationMS,
								FirstDeltaMS:          cfg.InsightGateMaxFirstDeltaMS,
								StreamFrames:          cfg.InsightGateMaxStreamFrames,
								FallbackRatio:         cfg.InsightGateMaxFallbackRatio,
								CostAnomalyMultiplier: cfg.InsightGateCostAnomalyMultiplier,
							},
							BucketCaps: map[string]int{
								"insights":   cfg.MaxConcurrentInsights,
								"ai_summary": cfg.MaxConcurrentAISummary,
							},
							CanonicalDomains: cfg.InsightCanonicalDomains,
						},
					),
				)
			}
		}

		if cfg.OwnedModules["uploads"] || cfg.OwnedModules["page_render"] {
			var uploadBlobs uploads.BlobStore
			var pageBlobs page_render.BlobStore
			if objectStore != nil {
				uploadBlobs = objectStore
				pageBlobs = objectStore
			}
			if cfg.OwnedModules["uploads"] {
				if sharedRedisClient == nil {
					sharedRedisClient, err = newSharedRedisClient(cfg)
					if err != nil {
						closeAll()
						return nil, err
					}
					redisClients = append(redisClients, sharedRedisClient)
				}
				uploadStore := store.NewUploadStore(
					primaryDB,
					cfg.UploadRoot,
					50<<20,
					store.NewRedisDailyAnalysisCacheInvalidator(
						sharedRedisClient,
						cfg.RedisKeyPrefix,
					),
				)
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					uploads.NewRegistrar(uploadStore, uploadBlobs, uploads.Config{}, auditSvc),
				)
			}
			if cfg.OwnedModules["page_render"] {
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					page_render.NewRegistrar(
						store.NewPageRenderStore(primaryDB),
						pageBlobs,
						page_render.Config{},
						auditSvc,
					),
				)
			}
		}
		if cfg.OwnedModules["jobs"] {
			queueClient, err := queue.NewQueueClient(cfg.RedisURL, queue.DefaultClientConfig())
			if err != nil {
				closeAll()
				return nil, fmt.Errorf("create jobs queue client: %w", err)
			}
			queueClients = append(queueClients, queueClient)
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				jobs.NewRegistrar(
					store.NewJobStore(primaryDB),
					monthlyReportQueueEnqueuer{client: queueClient},
					cfg.MonthlyReportResultRoot,
					auditSvc,
				),
			)
		}
		if cfg.OwnedModules["scheduled_reports"] {
			queueClient, err := queue.NewQueueClient(cfg.RedisURL, queue.DefaultClientConfig())
			if err != nil {
				closeAll()
				return nil, fmt.Errorf("create scheduled reports queue client: %w", err)
			}
			queueClients = append(queueClients, queueClient)
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				scheduled_reports.NewRegistrar(
					store.NewScheduledReportStore(primaryDB),
					scheduled_reports.NewQueueEnqueuer(queueClient),
					gatewayScheduledMailer{client: newGatewayMailer(cfg)},
					auditSvc,
				),
			)
		}

		if cfg.OwnedModules["crm"] {
			proposalStorage, err := store.NewLocalProposalStorage(
				filepath.Join(cfg.UploadRoot, "crm-proposals"),
			)
			if err != nil {
				closeAll()
				return nil, fmt.Errorf("create CRM proposal storage: %w", err)
			}
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				crm.NewRegistrarWithOptions(
					store.NewCRMStore(primaryDB),
					proposalStorage,
					auditSvc,
					crm.RegistrarOptions{
						TaskReminderTick:     time.Minute,
						FollowUpReminderTick: time.Minute,
						FollowUpReminderDays: cfg.CRMFollowUpReminderDays,
					},
				),
			)
		}

		if cfg.OwnedModules[config.ModuleCRMIntent] {
			var intentBlobs crm_intent.BlobStore
			if objectStore != nil {
				intentBlobs = objectStore
			}
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				crm_intent.NewRegistrar(
					store.NewCRMIntentStore(primaryDB, auditSvc),
					intentBlobs,
					agentauth.NewPGXCredentialStore(primaryDB),
					auditSvc,
				),
			)
		}

		if cfg.OwnedModules["system_management"] || cfg.OwnedModules["digital_office"] {
			if sharedRedisClient == nil {
				client, err := newSharedRedisClient(cfg)
				if err != nil {
					closeAll()
					return nil, err
				}
				sharedRedisClient = client
				redisClients = append(redisClients, client)
			}
			if cfg.OwnedModules["system_management"] {
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					system_management.NewRegistrar(
						store.NewSystemManagementStore(primaryDB),
						auditSvc,
						system_management.WithDatabaseURL(cfg.DatabaseURL),
						system_management.WithCacheClearer(
							system_management.NewRedisCacheClearer(
								sharedRedisClient,
								cfg.RedisKeyPrefix,
							),
						),
					),
				)
			}
			if cfg.OwnedModules["digital_office"] {
				digitalStore := store.NewDigitalEmployeeStore(primaryDB)
				deps.Stores.CustomRegistrars = append(
					deps.Stores.CustomRegistrars,
					digital_office.NewRegistrar(
						digitalStore,
						digital_office.WithCache(digital_office.NewRedisCache(sharedRedisClient)),
						digital_office.WithRedisPrefix(cfg.RedisKeyPrefix),
					),
				)
			}
		}
		if cfg.OwnedModules["digital_employees"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				digital_employees.NewRegistrar(store.NewDigitalEmployeeStore(primaryDB)),
			)
		}
		if cfg.OwnedModules["digital_display"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				digital_display.NewRegistrar(store.NewDigitalDisplayStore(primaryDB)),
			)
		}
		if cfg.OwnedModules["agent_ops"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				agent_ops.NewRegistrar(store.NewAgentOpsStore(primaryDB), time.Now),
			)
		}
		if cfg.OwnedModules["presence"] {
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				presence.NewRegistrar(store.NewPresenceStore(primaryDB), time.Now),
			)
		}
		if cfg.OwnedModules["inspections"] {
			var inspectionBlobs inspections.BlobStore
			if objectStore != nil {
				inspectionBlobs = objectStore
			}
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				inspections.NewRegistrar(
					store.NewInspectionStore(primaryDB),
					inspectionBlobs,
					auditSvc,
				),
			)
		}
		if cfg.OwnedModules["amazon_review_tracking"] {
			var sessionValidator amazon_review_tracking.SessionValidator
			if cfg.RedisURL != "" {
				if sharedRedisClient == nil {
					client, err := newSharedRedisClient(cfg)
					if err != nil {
						closeAll()
						return nil, err
					}
					sharedRedisClient = client
					redisClients = append(redisClients, client)
				}
				sessionValidator = store.NewRedisSessionValidator(
					sharedRedisClient,
					cfg.RedisKeyPrefix,
					8*time.Hour,
				)
			}
			deps.Stores.CustomRegistrars = append(
				deps.Stores.CustomRegistrars,
				amazon_review_tracking.NewRegistrar(
					store.NewAmazonReviewTrackingStore(primaryDB),
					auditSvc,
					amazon_review_tracking.WithSessionValidator(sessionValidator),
				),
			)
		}

		if cfg.OwnedModules["health"] && cfg.DatabaseReadURL != "" {
			replica, err := store.OpenPool(ctx, cfg.DatabaseReadURL)
			if err != nil {
				closeAll()
				return nil, fmt.Errorf("open read database: %w", err)
			}
			pools = append(pools, replica)
			deps.Stores.HealthReplica = health.NewPostgresProbe(store.NewPGXDB(replica))
		}
	}

	if cfg.OwnedModules["product_label"] {
		deps.Stores.CustomRegistrars = append(deps.Stores.CustomRegistrars, product_label.NewRegistrar(store.NewProductLabelService()))
	}
	if cfg.OwnedModules["ai_file_upload"] {
		deps.Stores.CustomRegistrars = append(
			deps.Stores.CustomRegistrars,
			ai_file_upload.NewRegistrar(),
		)
	}
	if cfg.OwnedModules["external_retired"] {
		deps.Stores.CustomRegistrars = append(
			deps.Stores.CustomRegistrars,
			external_retired.NewRegistrar(),
		)
	}

	if cfg.OwnedModules["health"] {
		redisClient := health.NewRedisClient(cfg.RedisURL)
		if redisClient == nil {
			closeAll()
			return nil, fmt.Errorf("parse REDIS_URL")
		}
		deps.Stores.HealthRedis = health.NewRedisProbe(redisClient, nil)
	}

	deps.Close = func() {
		if probe, ok := deps.Stores.HealthRedis.(*health.RedisProbe); ok {
			_ = probe.Close()
		}
		closeAll()
	}
	return deps, nil
}

type monthlyReportQueueEnqueuer struct {
	client *queue.QueueClient
}

type aiInsightQueueEnqueuer struct {
	client *queue.QueueClient
}

func (enqueuer aiInsightQueueEnqueuer) EnqueueGenerate(
	ctx context.Context,
	job ai_insight.GenerateJob,
) error {
	if enqueuer.client == nil {
		return fmt.Errorf("insight queue client is nil")
	}
	_, err := enqueuer.client.Enqueue(
		ctx,
		queue.TypeGenerateInsight,
		tasks.GenerateInsightPayload{
			ScheduleID: job.ScheduleID,
			InsightID:  job.InsightID,
		},
	)
	return err
}

func (enqueuer aiInsightQueueEnqueuer) EnqueueExecuteRun(
	ctx context.Context,
	job ai_insight.ExecuteRunJob,
) error {
	if enqueuer.client == nil {
		return fmt.Errorf("insight queue client is nil")
	}
	_, err := enqueuer.client.Enqueue(
		ctx,
		queue.TypeExecuteInsightRun,
		tasks.ExecuteInsightRunPayload{
			RunID:   job.RunID,
			Attempt: job.Attempt,
		},
	)
	return err
}

func (enqueuer monthlyReportQueueEnqueuer) EnqueueRunJob(
	ctx context.Context,
	jobID int64,
) error {
	if enqueuer.client == nil {
		return fmt.Errorf("monthly report queue client is nil")
	}
	_, err := enqueuer.client.Enqueue(ctx, queue.TypeRunJob, struct {
		JobID int64 `json:"job_id"`
	}{JobID: jobID})
	return err
}

func (enqueuer monthlyReportQueueEnqueuer) EnqueueJob(
	ctx context.Context,
	jobID int64,
) error {
	return enqueuer.EnqueueRunJob(ctx, jobID)
}

func (enqueuer monthlyReportQueueEnqueuer) EnqueueProductAnalysisReport(
	ctx context.Context,
	taskID int64,
) error {
	return enqueuer.EnqueueRunJob(ctx, taskID)
}

func newObjectStore(cfg config.Config) (*blob.Store, error) {
	configured := cfg.R2EndpointURL != "" ||
		cfg.R2BucketName != "" ||
		cfg.R2AccessKeyID != "" ||
		cfg.R2SecretAccessKey != ""
	if !configured {
		return nil, nil
	}
	return blob.New(blob.Config{
		EndpointURL:     cfg.R2EndpointURL,
		BucketName:      cfg.R2BucketName,
		AccessKeyID:     cfg.R2AccessKeyID,
		SecretAccessKey: cfg.R2SecretAccessKey,
		Region:          cfg.R2Region,
		PublicURL:       cfg.R2PublicURL,
		MaxPutBytes:     50 << 20,
		MaxGetBytes:     100 << 20,
	})
}

func newSharedRedisClient(cfg config.Config) (*redis.Client, error) {
	client := health.NewRedisClient(cfg.RedisURL)
	if client == nil {
		return nil, fmt.Errorf("parse REDIS_URL")
	}
	return client, nil
}

func newGatewayMailer(cfg config.Config) *mailer.Mailer {
	from := cfg.AlertFromEmail
	if cfg.AlertFromName != "" {
		from = fmt.Sprintf("%s <%s>", cfg.AlertFromName, cfg.AlertFromEmail)
	}
	return mailer.New(mailer.Config{
		APIKey:  cfg.ResendAPIKey,
		From:    from,
		BaseURL: cfg.ResendBaseURL,
		Timeout: 30 * time.Second,
	})
}

func newWorkflowRegistrar(
	cfg config.Config,
	db store.FullDB,
	projectStore *store.ProjectStore,
	objectStore *blob.Store,
) (httpserver.ModuleRegistrar, error) {
	documentStore, err := workflows.NewLocalDocumentFileStore(
		cfg.ProjectLaunchDocumentsRoot,
	)
	if err != nil {
		return nil, fmt.Errorf("create workflow document store: %w", err)
	}
	options := []workflows.Option{
		workflows.WithFileStore(documentStore),
	}
	if objectStore != nil {
		options = append(options, workflows.WithBlobStore(objectStore))
	}
	return workflows.NewRegistrarWithOptions(
		store.NewWorkflowStore(db),
		projectStore,
		options...,
	), nil
}

type gatewayScheduledMailer struct {
	client *mailer.Mailer
}

func (adapter gatewayScheduledMailer) SendTestReport(
	ctx context.Context,
	message scheduled_reports.TestEmailMessage,
) (*string, error) {
	if adapter.client == nil {
		return nil, scheduled_reports.ErrMailerNotConfigured
	}
	body := fmt.Sprintf(
		"定时报表测试\nfrequency=%s\nproject_ids=%s\ncountry=%s\n",
		message.Frequency,
		message.ProjectIDs,
		message.Country,
	)
	result, err := adapter.client.SendText(
		ctx,
		message.Email,
		"BelieveBoy Dashboard 定时报表测试",
		body,
		"",
	)
	if err != nil {
		if errors.Is(err, mailer.ErrNotConfigured) {
			return nil, scheduled_reports.ErrMailerNotConfigured
		}
		return nil, err
	}
	return &result.ID, nil
}
