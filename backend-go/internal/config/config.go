package config

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultAddr                    = "127.0.0.1:8200"
	defaultFastAPIOrigin           = "http://127.0.0.1:8100"
	defaultUploadRoot              = "backend/storage/uploads"
	defaultMonthlyReportResultRoot = "backend/storage/results"
	defaultAgentMonthlyReportRoot  = "backend/storage/agent_monthly_reports"
	defaultProjectLaunchDocsRoot   = "backend/app/resources/project_launch_documents"
	defaultAlertFromEmail          = "alerts@believeboy.com"
	defaultAlertFromName           = "BelieveBoy Dashboard"

	ModulePricingCalculation          = "pricing_calculation"
	ModulePricingCalculationSnapshots = "pricing_calculation_snapshots"
	ModuleNewProductCalculations      = "new_product_calculations"
	ModuleShopCalculation             = "shop_calculation"

	ModuleDailyAnalysis        = "daily_analysis"
	ModuleProjectGoals         = "project_goals"
	ModuleAdAnalysis           = "ad_analysis"
	ModuleRpaReports           = "rpa_reports"
	ModuleAdUpload             = "ad_upload"
	ModuleInternalAdData       = "internal_ad_data"
	ModulePlatformRevenues     = "platform_revenues"
	ModuleVatInvoices          = "vat_invoices"
	ModuleReportReconciliation = "report_reconciliation"
	ModuleReturnAnalysis       = "return_analysis"
	ModuleCategoryResearch     = "category_research"
	ModuleAgent                = "agent"
	ModuleCRMIntent            = "crm_intent"
	ModuleMonthlyReports       = "monthly_reports"
	ModuleQueue                = "queue"
	ModuleScheduler            = "scheduler"
)

// AllModules is the canonical set of module names accepted by GO_API_OWNED.
// It mirrors the ownership switches wired in cmd/gateway (dependencies.go) and
// internal/httpserver/routes.go. TestAllModulesWireAndBuildRouter in
// cmd/gateway fails when the wiring and this list drift apart.
var AllModules = []string{
	"ad_analysis",
	"ad_upload",
	"agent",
	"agent_commerce",
	"agent_credentials",
	"agent_inspection",
	"agent_monthly_reports",
	"agent_ops",
	"agent_review_tracking",
	"ai_chat",
	"ai_chat_usage",
	"ai_chat_v2",
	"ai_file_upload",
	"ai_insight",
	"alerts",
	"alerts_write",
	"amazon_review_tracking",
	"auth",
	"category_research",
	"complaints",
	"crm",
	"crm_intent",
	"daily_analysis",
	"digital_display",
	"digital_employees",
	"digital_office",
	"exchange_rates",
	"exchange_rates_write",
	"external_retired",
	"health",
	"insight_domains",
	"insight_observation",
	"insight_runs",
	"inspections",
	"internal_ad_data",
	"internal_jobs",
	"internal_keys",
	"inventory_ledger",
	"inventory_replenishment",
	"jobs",
	"monthly_reports",
	"new_product_calculations",
	"notification_settings",
	"notifications",
	"notifications_write",
	"order_info",
	"page_render",
	"platform_revenues",
	"presence",
	"pricing_calculation",
	"pricing_calculation_snapshots",
	"product_analysis",
	"product_analysis_reports",
	"product_label",
	"profile",
	"project_goals",
	"projects",
	"report_reconciliation",
	"return_analysis",
	"rpa_reports",
	"scheduled_reports",
	"shipment_schedules",
	"shipping_plan",
	"shop_calculation",
	"sku_info",
	"system_management",
	"uploads",
	"users",
	"vat_invoices",
	"workflows",
}

// AllModulesSet returns every known module as an ownership map.
func AllModulesSet() map[string]bool {
	owned := make(map[string]bool, len(AllModules))
	for _, module := range AllModules {
		owned[module] = true
	}
	return owned
}

// ExpandOwnedModules resolves the "all" sentinel and rejects module names that
// no gateway wiring or process configuration would act on. Silent typos used
// to leave a partially cut-over gateway that looked successful.
func ExpandOwnedModules(owned map[string]bool) (map[string]bool, error) {
	if len(owned) == 0 {
		return owned, nil
	}
	if owned["all"] {
		if len(owned) != 1 {
			return nil, fmt.Errorf(
				"GO_API_OWNED=all cannot be combined with other module names; got %d names",
				len(owned),
			)
		}
		return AllModulesSet(), nil
	}
	known := AllModulesSet()
	unknown := make([]string, 0, len(owned))
	for module := range owned {
		if !known[module] {
			unknown = append(unknown, module)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, fmt.Errorf(
			"GO_API_OWNED contains unknown module name(s): %s",
			strings.Join(unknown, ", "),
		)
	}
	return owned, nil
}

type Config struct {
	Addr          string
	FastAPIOrigin string
	APIKey        string
	// TrustedProxySecret gates master-key access to Go-owned routes. An empty
	// value leaves device-key access enabled but disables trusted proxy mode.
	TrustedProxySecret string
	DatabaseURL        string
	DatabaseReadURL    string
	RedisURL           string
	RedisKeyPrefix     string
	AppEnv             string
	OwnedModules       map[string]bool

	CRMSeaReclaimDays           int
	CRMTaskReminderLeadHours    int
	CRMFollowUpReminderDays     int
	OperationAuditRetentionDays int
	AgentAPIAuditRetentionDays  int
	CRMRuleEngineEnabled        bool
	CRMStaleEmailEnabled        bool
	UploadRoot                  string
	MonthlyReportResultRoot     string
	AgentMonthlyReportRoot      string
	ProjectLaunchDocumentsRoot  string
	R2EndpointURL               string
	R2BucketName                string
	R2AccessKeyID               string
	R2SecretAccessKey           string
	R2Region                    string
	R2PublicURL                 string
	ResendAPIKey                string
	ResendBaseURL               string
	AlertFromEmail              string
	AlertFromName               string

	AIChatProviderBaseURL          string
	AIChatProviderAPIKey           string
	AIChatDefaultModel             string
	AIChatTitleModel               string
	AIChatBackupModel              string
	AIChatModelBlocklist           string
	AIChatPremiumModels            string
	AIChatBasicModels              string
	AIChatReasoningModels          string
	AIChatDefaultReasoningEffort   string
	AIChatTimeoutSeconds           int
	AIChatWebSearchBaseURL         string
	AIChatWebSearchAPIKey          string
	AIChatWebSearchTopic           string
	AIChatWebSearchDepth           string
	AIChatWebSearchMaxResults      int
	AIChatMaxConversationTurns     int
	AIChatRedisDB                  int
	AIChatRedisURL                 string
	AIChatStreamPrefix             string
	AIChatStreamTTLSeconds         int
	AIChatStreamMaxLen             int
	AIChatStreamMaxDurationSeconds int
	AIChatStreamMemoryFallback     bool

	InsightCanonicalDomains          string
	InsightStreamRedisDB             int
	InsightStreamRedisURL            string
	InsightStreamTTLSeconds          int
	InsightStreamMaxLen              int
	InsightObservationEnabled        bool
	InsightObservationWindowDays     int
	InsightGateMaxDurationMS         int
	InsightGateMaxFirstDeltaMS       int
	InsightGateMaxStreamFrames       int
	InsightGateMaxFallbackRatio      float64
	InsightGateCostAnomalyMultiplier float64
	InsightSemaphoreWaitSeconds      int
	MaxConcurrentInsights            int
	MaxConcurrentAISummary           int
}

func Load() (Config, error) {
	return load(os.LookupEnv)
}

func load(lookup func(string) (string, bool)) (Config, error) {
	cfg := Config{
		Addr:               valueOrDefault(lookup, "GO_API_ADDR", defaultAddr),
		FastAPIOrigin:      valueOrDefault(lookup, "FASTAPI_ORIGIN", defaultFastAPIOrigin),
		TrustedProxySecret: valueOrDefault(lookup, "GO_API_TRUSTED_PROXY_SECRET", ""),
		RedisURL:           firstNonEmpty(lookup, "REDIS_URL"),
		RedisKeyPrefix:     valueOrDefault(lookup, "REDIS_KEY_PREFIX", "bb"),
		AppEnv:             valueOrDefault(lookup, "APP_ENV", "development"),
		// Default to serving every route the Go gateway implements. Unmatched
		// paths still proxy to FastAPI through the catch-all handler, so this
		// yields "Go first, FastAPI for what is left" without any opt-in; an
		// explicit list narrows it back to a staged cutover.
		OwnedModules:                 parseOwnedModules(valueOrDefault(lookup, "GO_API_OWNED", "all")),
		UploadRoot:                   valueOrDefault(lookup, "UPLOAD_ROOT", defaultUploadRoot),
		MonthlyReportResultRoot:      valueOrDefault(lookup, "MONTHLY_REPORT_RESULT_ROOT", defaultMonthlyReportResultRoot),
		AgentMonthlyReportRoot:       valueOrDefault(lookup, "AGENT_MONTHLY_REPORT_ROOT", defaultAgentMonthlyReportRoot),
		ProjectLaunchDocumentsRoot:   valueOrDefault(lookup, "PROJECT_LAUNCH_DOCUMENTS_ROOT", defaultProjectLaunchDocsRoot),
		R2EndpointURL:                firstNonEmpty(lookup, "R2_ENDPOINT_URL"),
		R2BucketName:                 firstNonEmpty(lookup, "R2_BUCKET_NAME"),
		R2AccessKeyID:                firstNonEmpty(lookup, "R2_ACCESS_KEY_ID"),
		R2SecretAccessKey:            firstNonEmpty(lookup, "R2_SECRET_ACCESS_KEY"),
		R2Region:                     valueOrDefault(lookup, "R2_REGION", "auto"),
		R2PublicURL:                  firstNonEmpty(lookup, "R2_PUBLIC_URL"),
		ResendAPIKey:                 firstNonEmpty(lookup, "RESEND_API_KEY"),
		ResendBaseURL:                firstNonEmpty(lookup, "RESEND_BASE_URL"),
		AlertFromEmail:               valueOrDefault(lookup, "ALERT_FROM_EMAIL", defaultAlertFromEmail),
		AlertFromName:                valueOrDefault(lookup, "ALERT_FROM_NAME", defaultAlertFromName),
		AIChatProviderBaseURL:        valueOrDefault(lookup, "AI_CHAT_PROVIDER_BASE_URL", ""),
		AIChatProviderAPIKey:         valueOrDefault(lookup, "AI_CHAT_PROVIDER_API_KEY", ""),
		AIChatDefaultModel:           valueOrDefault(lookup, "AI_CHAT_DEFAULT_MODEL", ""),
		AIChatTitleModel:             valueOrDefault(lookup, "AI_CHAT_TITLE_MODEL", ""),
		AIChatBackupModel:            valueOrDefault(lookup, "AI_CHAT_BACKUP_MODEL", ""),
		AIChatModelBlocklist:         valueOrDefault(lookup, "AI_CHAT_MODEL_BLOCKLIST", ""),
		AIChatPremiumModels:          valueOrDefault(lookup, "AI_CHAT_PREMIUM_MODELS", ""),
		AIChatBasicModels:            valueOrDefault(lookup, "AI_CHAT_BASIC_MODELS", ""),
		AIChatReasoningModels:        valueOrDefault(lookup, "AI_CHAT_REASONING_MODELS", ""),
		AIChatDefaultReasoningEffort: valueOrDefault(lookup, "AI_CHAT_DEFAULT_REASONING_EFFORT", "medium"),
		AIChatWebSearchBaseURL:       valueOrDefault(lookup, "AI_CHAT_WEB_SEARCH_BASE_URL", "https://search.believeboy.com"),
		AIChatWebSearchAPIKey:        valueOrDefault(lookup, "AI_CHAT_WEB_SEARCH_API_KEY", ""),
		AIChatWebSearchTopic:         valueOrDefault(lookup, "AI_CHAT_WEB_SEARCH_TOPIC", "general"),
		AIChatWebSearchDepth:         valueOrDefault(lookup, "AI_CHAT_WEB_SEARCH_DEPTH", "advanced"),
		AIChatStreamPrefix:           valueOrDefault(lookup, "AI_CHAT_STREAM_PREFIX", "ai:chat"),
		InsightCanonicalDomains:      valueOrDefault(lookup, "INSIGHT_CANONICAL_DOMAINS", ""),
	}

	for _, required := range []struct {
		key    string
		target *string
	}{
		{key: "API_KEY", target: &cfg.APIKey},
		{key: "DATABASE_URL", target: &cfg.DatabaseURL},
	} {
		value := firstNonEmpty(lookup, required.key)
		if value == "" {
			return Config{}, fmt.Errorf("%s is required", required.key)
		}
		*required.target = value
	}

	// Resolve GO_API_OWNED=all and reject unknown module names before any
	// process builds its wiring off a silently ignored typo.
	expandedOwned, expandErr := ExpandOwnedModules(cfg.OwnedModules)
	if expandErr != nil {
		return Config{}, expandErr
	}
	cfg.OwnedModules = expandedOwned

	// Reuse the host, port, database, and optional password settings used by FastAPI.
	if cfg.RedisURL == "" {
		redisURL, err := redisURLFromEnvironment(lookup)
		if err != nil {
			return Config{}, err
		}
		cfg.RedisURL = redisURL
	}

	cfg.DatabaseReadURL = firstNonEmpty(lookup, "DATABASE_READ_URL")
	if cfg.DatabaseReadURL != "" {
		readURL, err := url.Parse(cfg.DatabaseReadURL)
		if err != nil || readURL.Scheme == "" || readURL.Host == "" {
			return Config{}, fmt.Errorf("DATABASE_READ_URL must be a valid URL")
		}
	}

	origin, err := url.Parse(cfg.FastAPIOrigin)
	if err != nil || origin.Scheme == "" || origin.Host == "" {
		return Config{}, fmt.Errorf("FASTAPI_ORIGIN must be an absolute HTTP URL")
	}
	if origin.Scheme != "http" && origin.Scheme != "https" {
		return Config{}, fmt.Errorf("FASTAPI_ORIGIN must use http or https")
	}

	if cfg.CRMSeaReclaimDays, err = intFromEnvironment(lookup, "CRM_SEA_RECLAIM_DAYS", 15, 0, 365); err != nil {
		return Config{}, err
	}
	if cfg.CRMTaskReminderLeadHours, err = intFromEnvironment(lookup, "CRM_TASK_REMINDER_LEAD_HOURS", 24, 1, 168); err != nil {
		return Config{}, err
	}
	if cfg.CRMFollowUpReminderDays, err = intFromEnvironment(lookup, "CRM_FOLLOW_UP_REMINDER_DAYS", 7, 0, 365); err != nil {
		return Config{}, err
	}
	if cfg.OperationAuditRetentionDays, err = intFromEnvironment(lookup, "OPERATION_AUDIT_RETENTION_DAYS", 90, 1, 3650); err != nil {
		return Config{}, err
	}
	if cfg.AgentAPIAuditRetentionDays, err = intFromEnvironment(lookup, "AGENT_API_AUDIT_RETENTION_DAYS", 90, 1, 3650); err != nil {
		return Config{}, err
	}
	if cfg.CRMRuleEngineEnabled, err = boolFromEnvironment(lookup, "CRM_RULE_ENGINE_ENABLED", true); err != nil {
		return Config{}, err
	}
	if cfg.CRMStaleEmailEnabled, err = boolFromEnvironment(lookup, "CRM_STALE_EMAIL_ENABLED", true); err != nil {
		return Config{}, err
	}
	if cfg.AIChatTimeoutSeconds, err = intFromEnvironment(lookup, "AI_CHAT_TIMEOUT_SECONDS", 90, 10, 300); err != nil {
		return Config{}, err
	}
	if cfg.AIChatWebSearchMaxResults, err = intFromEnvironment(lookup, "AI_CHAT_WEB_SEARCH_MAX_RESULTS", 20, 1, 100); err != nil {
		return Config{}, err
	}
	if cfg.AIChatMaxConversationTurns, err = intFromEnvironment(lookup, "AI_CHAT_MAX_CONVERSATION_TURNS", 10, 1, 50); err != nil {
		return Config{}, err
	}
	if cfg.AIChatRedisDB, err = intFromEnvironment(lookup, "AI_CHAT_REDIS_DB", 3, 0, 15); err != nil {
		return Config{}, err
	}
	if cfg.AIChatStreamTTLSeconds, err = intFromEnvironment(lookup, "AI_CHAT_STREAM_TTL_SECONDS", 86400, 60, 604800); err != nil {
		return Config{}, err
	}
	if cfg.AIChatStreamMaxLen, err = intFromEnvironment(lookup, "AI_CHAT_STREAM_MAXLEN", 10000, 100, 100000); err != nil {
		return Config{}, err
	}
	if cfg.AIChatStreamMaxDurationSeconds, err = intFromEnvironment(lookup, "AI_CHAT_STREAM_MAX_DURATION_SECONDS", 900, 60, 900); err != nil {
		return Config{}, err
	}
	if cfg.AIChatStreamMemoryFallback, err = boolFromEnvironment(lookup, "AI_CHAT_STREAM_MEMORY_FALLBACK", false); err != nil {
		return Config{}, err
	}
	if cfg.InsightStreamRedisDB, err = intFromEnvironment(lookup, "INSIGHT_STREAM_REDIS_DB", 4, 0, 15); err != nil {
		return Config{}, err
	}
	if cfg.InsightStreamTTLSeconds, err = intFromEnvironment(lookup, "INSIGHT_STREAM_TTL_SECONDS", 86400, 60, 604800); err != nil {
		return Config{}, err
	}
	if cfg.InsightStreamMaxLen, err = intFromEnvironment(lookup, "INSIGHT_STREAM_MAXLEN", 10000, 100, 100000); err != nil {
		return Config{}, err
	}
	if cfg.InsightObservationEnabled, err = boolFromEnvironment(lookup, "INSIGHT_OBSERVATION_ENABLED", true); err != nil {
		return Config{}, err
	}
	if cfg.InsightObservationWindowDays, err = intFromEnvironment(lookup, "INSIGHT_OBSERVATION_WINDOW_DAYS", 7, 1, 90); err != nil {
		return Config{}, err
	}
	if cfg.InsightGateMaxDurationMS, err = intFromEnvironment(lookup, "INSIGHT_GATE_MAX_DURATION_MS", 300000, 0, 86400000); err != nil {
		return Config{}, err
	}
	if cfg.InsightGateMaxFirstDeltaMS, err = intFromEnvironment(lookup, "INSIGHT_GATE_MAX_FIRST_DELTA_MS", 90000, 0, 86400000); err != nil {
		return Config{}, err
	}
	if cfg.InsightGateMaxStreamFrames, err = intFromEnvironment(lookup, "INSIGHT_GATE_MAX_STREAM_FRAMES", 10000, 0, 1000000); err != nil {
		return Config{}, err
	}
	if cfg.InsightGateMaxFallbackRatio, err = floatFromEnvironment(lookup, "INSIGHT_GATE_MAX_FALLBACK_RATIO", 0, 0, 1); err != nil {
		return Config{}, err
	}
	if cfg.InsightGateCostAnomalyMultiplier, err = floatFromEnvironment(lookup, "INSIGHT_GATE_COST_ANOMALY_MULTIPLIER", 5, 0, 100); err != nil {
		return Config{}, err
	}
	if cfg.InsightSemaphoreWaitSeconds, err = intFromEnvironment(lookup, "INSIGHT_SEMAPHORE_WAIT_SECONDS", 60, 0, 280); err != nil {
		return Config{}, err
	}
	if cfg.MaxConcurrentInsights, err = intFromEnvironment(lookup, "MAX_CONCURRENT_INSIGHTS", 3, 1, 10); err != nil {
		return Config{}, err
	}
	if cfg.MaxConcurrentAISummary, err = intFromEnvironment(lookup, "MAX_CONCURRENT_AI_SUMMARY", 5, 1, 20); err != nil {
		return Config{}, err
	}
	cfg.AIChatRedisURL, err = redisURLWithDB(cfg.RedisURL, cfg.AIChatRedisDB)
	if err != nil {
		return Config{}, err
	}
	cfg.InsightStreamRedisURL, err = redisURLWithDB(cfg.RedisURL, cfg.InsightStreamRedisDB)
	if err != nil {
		return Config{}, err
	}

	return cfg, nil
}

func redisURLWithDB(rawURL string, db int) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("REDIS_URL must be a valid URL")
	}
	parsed.Path = "/" + strconv.Itoa(db)
	parsed.RawPath = ""
	return parsed.String(), nil
}

func redisURLFromEnvironment(lookup func(string) (string, bool)) (string, error) {
	host := valueOrDefault(lookup, "REDIS_HOST", "127.0.0.1")
	portValue := valueOrDefault(lookup, "REDIS_PORT", "6379")
	port, err := strconv.Atoi(portValue)
	if err != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("REDIS_PORT must be between 1 and 65535")
	}

	dbValue := valueOrDefault(lookup, "REDIS_DB", "0")
	db, err := strconv.Atoi(dbValue)
	if err != nil || db < 0 || db > 15 {
		return "", fmt.Errorf("REDIS_DB must be between 0 and 15")
	}

	redisURL := url.URL{
		Scheme: "redis",
		Host:   net.JoinHostPort(host, strconv.Itoa(port)),
		Path:   fmt.Sprintf("/%d", db),
	}
	passwordEnvKey := "REDIS_" + "PASS" + "WORD"
	if password, ok := lookup(passwordEnvKey); ok && password != "" {
		redisURL.User = url.UserPassword("", password)
	}
	return redisURL.String(), nil
}

func firstNonEmpty(lookup func(string) (string, bool), keys ...string) string {
	for _, key := range keys {
		value, ok := lookup(key)
		value = strings.TrimSpace(value)
		if ok && value != "" {
			return value
		}
	}
	return ""
}

func valueOrDefault(lookup func(string) (string, bool), key, fallback string) string {
	value, ok := lookup(key)
	value = strings.TrimSpace(value)
	if !ok || value == "" {
		return fallback
	}
	return value
}

func intFromEnvironment(
	lookup func(string) (string, bool),
	key string,
	fallback int,
	minValue int,
	maxValue int,
) (int, error) {
	raw := valueOrDefault(lookup, key, "")
	if raw == "" {
		return fallback, nil
	}

	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer between %d and %d", key, minValue, maxValue)
	}
	if value < minValue || value > maxValue {
		return 0, fmt.Errorf("%s must be between %d and %d", key, minValue, maxValue)
	}
	return value, nil
}

func floatFromEnvironment(
	lookup func(string) (string, bool),
	key string,
	fallback float64,
	minValue float64,
	maxValue float64,
) (float64, error) {
	raw := valueOrDefault(lookup, key, "")
	if raw == "" {
		return fallback, nil
	}

	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("%s must be a finite number", key)
	}
	if value < minValue || value > maxValue {
		return 0, fmt.Errorf("%s must be between %g and %g", key, minValue, maxValue)
	}
	return value, nil
}

func boolFromEnvironment(lookup func(string) (string, bool), key string, fallback bool) (bool, error) {
	raw := valueOrDefault(lookup, key, "")
	if raw == "" {
		return fallback, nil
	}

	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf(
			"%s=%q is invalid; expected one of 1, true, yes, on, 0, false, no, off",
			key,
			raw,
		)
	}
}

func parseOwnedModules(raw string) map[string]bool {
	owned := make(map[string]bool)
	for _, module := range strings.Split(raw, ",") {
		module = strings.TrimSpace(module)
		if module != "" {
			owned[module] = true
		}
	}
	return owned
}
