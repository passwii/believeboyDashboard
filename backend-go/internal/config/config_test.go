package config

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestLoadUsesDefaultsAndParsesOwnedModules(t *testing.T) {
	unsetEnv(t, "GO_API_ADDR")
	unsetEnv(t, "FASTAPI_ORIGIN")
	setRequiredEnv(t)
	t.Setenv("GO_API_OWNED", "health, exchange_rates,, alerts ")
	t.Setenv("GO_API_TRUSTED_PROXY_SECRET", "proxy-secret")
	t.Setenv("REDIS_KEY_PREFIX", "")
	t.Setenv("AGENT_MONTHLY_REPORT_ROOT", "")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.Addr != "127.0.0.1:8200" {
		t.Errorf("Addr = %q, want %q", got.Addr, "127.0.0.1:8200")
	}
	if got.FastAPIOrigin != "http://127.0.0.1:8100" {
		t.Errorf("FastAPIOrigin = %q, want %q", got.FastAPIOrigin, "http://127.0.0.1:8100")
	}
	if got.TrustedProxySecret != "proxy-secret" {
		t.Errorf("TrustedProxySecret = %q, want proxy-secret", got.TrustedProxySecret)
	}
	if got.RedisKeyPrefix != "bb" {
		t.Errorf("RedisKeyPrefix = %q, want %q", got.RedisKeyPrefix, "bb")
	}
	if got.AgentMonthlyReportRoot != "backend/storage/agent_monthly_reports" {
		t.Errorf("AgentMonthlyReportRoot = %q, want backend/storage/agent_monthly_reports", got.AgentMonthlyReportRoot)
	}
	wantOwned := map[string]bool{
		"health":         true,
		"exchange_rates": true,
		"alerts":         true,
	}
	if !reflect.DeepEqual(got.OwnedModules, wantOwned) {
		t.Errorf("OwnedModules = %#v, want %#v", got.OwnedModules, wantOwned)
	}
}

func TestLoadParsesRedisKeyPrefix(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("REDIS_KEY_PREFIX", "blf-prod")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.RedisKeyPrefix != "blf-prod" {
		t.Errorf("RedisKeyPrefix = %q, want blf-prod", got.RedisKeyPrefix)
	}
}

func TestLoadParsesInsightSettings(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("INSIGHT_CANONICAL_DOMAINS", "ad_analysis,inventory_health")
	t.Setenv("INSIGHT_STREAM_REDIS_DB", "4")
	t.Setenv("INSIGHT_STREAM_TTL_SECONDS", "7200")
	t.Setenv("INSIGHT_STREAM_MAXLEN", "20000")
	t.Setenv("INSIGHT_OBSERVATION_ENABLED", "false")
	t.Setenv("INSIGHT_OBSERVATION_WINDOW_DAYS", "14")
	t.Setenv("INSIGHT_GATE_MAX_DURATION_MS", "120000")
	t.Setenv("INSIGHT_GATE_MAX_FIRST_DELTA_MS", "45000")
	t.Setenv("INSIGHT_GATE_MAX_STREAM_FRAMES", "5000")
	t.Setenv("INSIGHT_GATE_MAX_FALLBACK_RATIO", "0.05")
	t.Setenv("INSIGHT_GATE_COST_ANOMALY_MULTIPLIER", "4.5")
	t.Setenv("INSIGHT_SEMAPHORE_WAIT_SECONDS", "30")
	t.Setenv("MAX_CONCURRENT_INSIGHTS", "2")
	t.Setenv("MAX_CONCURRENT_AI_SUMMARY", "4")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.InsightCanonicalDomains != "ad_analysis,inventory_health" ||
		got.InsightStreamRedisDB != 4 ||
		got.InsightStreamTTLSeconds != 7200 ||
		got.InsightStreamMaxLen != 20000 ||
		got.InsightObservationEnabled ||
		got.InsightObservationWindowDays != 14 ||
		got.InsightGateMaxDurationMS != 120000 ||
		got.InsightGateMaxFirstDeltaMS != 45000 ||
		got.InsightGateMaxStreamFrames != 5000 ||
		got.InsightGateMaxFallbackRatio != 0.05 ||
		got.InsightGateCostAnomalyMultiplier != 4.5 ||
		got.InsightSemaphoreWaitSeconds != 30 ||
		got.MaxConcurrentInsights != 2 ||
		got.MaxConcurrentAISummary != 4 {
		t.Fatalf("insight settings were not parsed: %#v", got)
	}
	if got.InsightStreamRedisURL == got.AIChatRedisURL {
		t.Fatalf("InsightStreamRedisURL = AIChatRedisURL = %q, want separate Redis DBs", got.InsightStreamRedisURL)
	}
}

func TestLoadRejectsInvalidInsightFallbackRatio(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("INSIGHT_GATE_MAX_FALLBACK_RATIO", "NaN")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "INSIGHT_GATE_MAX_FALLBACK_RATIO") {
		t.Fatalf("Load() error = %v, want finite ratio validation", err)
	}
}

func TestLoadDefaultsOwnedModulesToAll(t *testing.T) {
	unsetEnv(t, "GO_API_OWNED")
	setRequiredEnv(t)

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got.OwnedModules) != len(AllModules) {
		t.Fatalf("OwnedModules = %d, want %d (default is all modules)", len(got.OwnedModules), len(AllModules))
	}
	for _, module := range AllModules {
		if !got.OwnedModules[module] {
			t.Errorf("OwnedModules[%q] = false, want true", module)
		}
	}
}

func TestLoadParsesStage3OwnedModules(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("GO_API_OWNED", strings.Join([]string{
		ModulePricingCalculation,
		ModulePricingCalculationSnapshots,
		ModuleNewProductCalculations,
		ModuleShopCalculation,
	}, ","))

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	for _, module := range []string{
		ModulePricingCalculation,
		ModulePricingCalculationSnapshots,
		ModuleNewProductCalculations,
		ModuleShopCalculation,
	} {
		if !got.OwnedModules[module] {
			t.Errorf("OwnedModules[%q] = false, want true", module)
		}
	}
}

func TestLoadParsesStage4OwnedModules(t *testing.T) {
	setRequiredEnv(t)
	stage4Modules := []string{
		ModuleDailyAnalysis,
		ModuleProjectGoals,
		ModuleAdAnalysis,
		ModuleRpaReports,
		ModuleAdUpload,
		ModuleInternalAdData,
		ModulePlatformRevenues,
		ModuleVatInvoices,
		ModuleReportReconciliation,
		ModuleReturnAnalysis,
		ModuleCategoryResearch,
		ModuleAgent,
	}
	t.Setenv("GO_API_OWNED", strings.Join(stage4Modules, ","))

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	for _, module := range stage4Modules {
		if !got.OwnedModules[module] {
			t.Errorf("OwnedModules[%q] = false, want true", module)
		}
	}
}

func TestLoadRequiresCoreSettings(t *testing.T) {
	tests := []string{"API_KEY", "DATABASE_URL"}

	for _, key := range tests {
		t.Run(key, func(t *testing.T) {
			setRequiredEnv(t)
			unsetEnv(t, key)

			_, err := Load()
			if err == nil {
				t.Fatalf("Load() error = nil, want missing %s error", key)
			}
			if !strings.Contains(err.Error(), key) {
				t.Errorf("Load() error = %q, want it to mention %s", err, key)
			}
		})
	}
}

func TestLoadRejectsInvalidFastAPIOrigin(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("FASTAPI_ORIGIN", "localhost:8100")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() error = nil, want invalid FASTAPI_ORIGIN error")
	}
	if !strings.Contains(err.Error(), "FASTAPI_ORIGIN") {
		t.Errorf("Load() error = %q, want it to mention FASTAPI_ORIGIN", err)
	}
}

func TestLoadUsesBusinessDefaults(t *testing.T) {
	setRequiredEnv(t)

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.CRMSeaReclaimDays != 15 {
		t.Errorf("CRMSeaReclaimDays = %d, want 15", got.CRMSeaReclaimDays)
	}
	if got.CRMTaskReminderLeadHours != 24 {
		t.Errorf("CRMTaskReminderLeadHours = %d, want 24", got.CRMTaskReminderLeadHours)
	}
	if got.CRMFollowUpReminderDays != 7 {
		t.Errorf("CRMFollowUpReminderDays = %d, want 7", got.CRMFollowUpReminderDays)
	}
	if got.OperationAuditRetentionDays != 90 {
		t.Errorf("OperationAuditRetentionDays = %d, want 90", got.OperationAuditRetentionDays)
	}
	if got.AgentAPIAuditRetentionDays != 90 {
		t.Errorf("AgentAPIAuditRetentionDays = %d, want 90", got.AgentAPIAuditRetentionDays)
	}
	if !got.CRMRuleEngineEnabled {
		t.Error("CRMRuleEngineEnabled = false, want true")
	}
	if !got.CRMStaleEmailEnabled {
		t.Error("CRMStaleEmailEnabled = false, want true")
	}
	if got.UploadRoot != "backend/storage/uploads" {
		t.Errorf("UploadRoot = %q, want %q", got.UploadRoot, "backend/storage/uploads")
	}
	if got.MonthlyReportResultRoot != "backend/storage/results" {
		t.Errorf("MonthlyReportResultRoot = %q, want %q", got.MonthlyReportResultRoot, "backend/storage/results")
	}
	if got.ProjectLaunchDocumentsRoot != "backend-go/resources/project_launch_documents" {
		t.Errorf("ProjectLaunchDocumentsRoot = %q, want default launch docs root", got.ProjectLaunchDocumentsRoot)
	}
	if got.R2Region != "auto" {
		t.Errorf("R2Region = %q, want auto", got.R2Region)
	}
	if got.AlertFromEmail != "alerts@believeboy.com" {
		t.Errorf("AlertFromEmail = %q, want default sender", got.AlertFromEmail)
	}
	if got.AlertFromName != "BelieveBoy Dashboard" {
		t.Errorf("AlertFromName = %q, want default sender name", got.AlertFromName)
	}
}

func TestLoadParsesBusinessOverrides(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("CRM_SEA_RECLAIM_DAYS", "0")
	t.Setenv("CRM_TASK_REMINDER_LEAD_HOURS", "168")
	t.Setenv("CRM_FOLLOW_UP_REMINDER_DAYS", "0")
	t.Setenv("OPERATION_AUDIT_RETENTION_DAYS", "3650")
	t.Setenv("AGENT_API_AUDIT_RETENTION_DAYS", "365")
	t.Setenv("CRM_RULE_ENGINE_ENABLED", "off")
	t.Setenv("CRM_STALE_EMAIL_ENABLED", "no")
	t.Setenv("UPLOAD_ROOT", "/tmp/believeboy-uploads")
	t.Setenv("MONTHLY_REPORT_RESULT_ROOT", " tmp/report-results ")
	t.Setenv("PROJECT_LAUNCH_DOCUMENTS_ROOT", " tmp/launch-docs ")
	t.Setenv("R2_ENDPOINT_URL", "https://r2.example.com")
	t.Setenv("R2_BUCKET_NAME", "dashboard-assets")
	t.Setenv("R2_ACCESS_KEY_ID", "access-key")
	t.Setenv("R2_SECRET_ACCESS_KEY", "secret-key")
	t.Setenv("R2_REGION", "us-east-1")
	t.Setenv("R2_PUBLIC_URL", "https://assets.example.com")
	t.Setenv("RESEND_API_KEY", "resend-key")
	t.Setenv("RESEND_BASE_URL", "https://resend.example.com")
	t.Setenv("ALERT_FROM_EMAIL", "ops@example.com")
	t.Setenv("ALERT_FROM_NAME", "Operations")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.CRMSeaReclaimDays != 0 {
		t.Errorf("CRMSeaReclaimDays = %d, want 0", got.CRMSeaReclaimDays)
	}
	if got.CRMTaskReminderLeadHours != 168 {
		t.Errorf("CRMTaskReminderLeadHours = %d, want 168", got.CRMTaskReminderLeadHours)
	}
	if got.CRMFollowUpReminderDays != 0 {
		t.Errorf("CRMFollowUpReminderDays = %d, want 0", got.CRMFollowUpReminderDays)
	}
	if got.OperationAuditRetentionDays != 3650 {
		t.Errorf("OperationAuditRetentionDays = %d, want 3650", got.OperationAuditRetentionDays)
	}
	if got.AgentAPIAuditRetentionDays != 365 {
		t.Errorf("AgentAPIAuditRetentionDays = %d, want 365", got.AgentAPIAuditRetentionDays)
	}
	if got.CRMRuleEngineEnabled {
		t.Error("CRMRuleEngineEnabled = true, want false")
	}
	if got.CRMStaleEmailEnabled {
		t.Error("CRMStaleEmailEnabled = true, want false")
	}
	if got.UploadRoot != "/tmp/believeboy-uploads" {
		t.Errorf("UploadRoot = %q, want %q", got.UploadRoot, "/tmp/believeboy-uploads")
	}
	if got.MonthlyReportResultRoot != "tmp/report-results" {
		t.Errorf("MonthlyReportResultRoot = %q, want %q", got.MonthlyReportResultRoot, "tmp/report-results")
	}
	if got.ProjectLaunchDocumentsRoot != "tmp/launch-docs" {
		t.Errorf("ProjectLaunchDocumentsRoot = %q, want tmp/launch-docs", got.ProjectLaunchDocumentsRoot)
	}
	if got.R2EndpointURL != "https://r2.example.com" ||
		got.R2BucketName != "dashboard-assets" ||
		got.R2AccessKeyID != "access-key" ||
		got.R2SecretAccessKey != "secret-key" ||
		got.R2Region != "us-east-1" ||
		got.R2PublicURL != "https://assets.example.com" {
		t.Errorf("R2 config = %#v, want overrides", got)
	}
	if got.ResendAPIKey != "resend-key" ||
		got.ResendBaseURL != "https://resend.example.com" ||
		got.AlertFromEmail != "ops@example.com" ||
		got.AlertFromName != "Operations" {
		t.Errorf("mail config = key:%q base:%q from:%q name:%q", got.ResendAPIKey, got.ResendBaseURL, got.AlertFromEmail, got.AlertFromName)
	}
}

func TestLoadParsesBooleanVariants(t *testing.T) {
	tests := []struct {
		value string
		want  bool
	}{
		{value: "1", want: true},
		{value: "true", want: true},
		{value: "yes", want: true},
		{value: "on", want: true},
		{value: "0", want: false},
		{value: "false", want: false},
		{value: "no", want: false},
		{value: "off", want: false},
	}

	for _, test := range tests {
		t.Run(test.value, func(t *testing.T) {
			setRequiredEnv(t)
			t.Setenv("CRM_RULE_ENGINE_ENABLED", test.value)
			t.Setenv("CRM_STALE_EMAIL_ENABLED", test.value)

			got, err := Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if got.CRMRuleEngineEnabled != test.want {
				t.Errorf("CRMRuleEngineEnabled = %t, want %t", got.CRMRuleEngineEnabled, test.want)
			}
			if got.CRMStaleEmailEnabled != test.want {
				t.Errorf("CRMStaleEmailEnabled = %t, want %t", got.CRMStaleEmailEnabled, test.want)
			}
		})
	}
}

func TestLoadRejectsInvalidBusinessIntegers(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "sea reclaim is not an integer", key: "CRM_SEA_RECLAIM_DAYS", value: "abc"},
		{name: "sea reclaim exceeds maximum", key: "CRM_SEA_RECLAIM_DAYS", value: "366"},
		{name: "task reminder lead hours is zero", key: "CRM_TASK_REMINDER_LEAD_HOURS", value: "0"},
		{name: "task reminder lead hours exceeds maximum", key: "CRM_TASK_REMINDER_LEAD_HOURS", value: "169"},
		{name: "follow-up reminder days is negative", key: "CRM_FOLLOW_UP_REMINDER_DAYS", value: "-1"},
		{name: "follow-up reminder days exceeds maximum", key: "CRM_FOLLOW_UP_REMINDER_DAYS", value: "366"},
		{name: "operation audit retention is not an integer", key: "OPERATION_AUDIT_RETENTION_DAYS", value: "ninety"},
		{name: "operation audit retention exceeds maximum", key: "OPERATION_AUDIT_RETENTION_DAYS", value: "3651"},
		{name: "agent API audit retention is zero", key: "AGENT_API_AUDIT_RETENTION_DAYS", value: "0"},
		{name: "agent API audit retention exceeds maximum", key: "AGENT_API_AUDIT_RETENTION_DAYS", value: "3651"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setRequiredEnv(t)
			t.Setenv(test.key, test.value)

			_, err := Load()
			if err == nil {
				t.Fatalf("Load() error = nil, want invalid %s error", test.key)
			}
			if !strings.Contains(err.Error(), test.key) {
				t.Errorf("Load() error = %q, want it to mention %s", err, test.key)
			}
		})
	}
}

func TestLoadRejectsInvalidBusinessBooleans(t *testing.T) {
	for _, key := range []string{"CRM_RULE_ENGINE_ENABLED", "CRM_STALE_EMAIL_ENABLED"} {
		t.Run(key, func(t *testing.T) {
			setRequiredEnv(t)
			t.Setenv(key, "maybe")

			_, err := Load()
			if err == nil {
				t.Fatalf("Load() error = nil, want invalid %s error", key)
			}
			if !strings.Contains(err.Error(), key) {
				t.Errorf("Load() error = %q, want it to mention %s", err, key)
			}
		})
	}
}

func TestLoadEmptyBusinessPathsUseDefaults(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("UPLOAD_ROOT", "   ")
	t.Setenv("MONTHLY_REPORT_RESULT_ROOT", "")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.UploadRoot != "backend/storage/uploads" {
		t.Errorf("UploadRoot = %q, want default", got.UploadRoot)
	}
	if got.MonthlyReportResultRoot != "backend/storage/results" {
		t.Errorf("MonthlyReportResultRoot = %q, want default", got.MonthlyReportResultRoot)
	}
}

func TestLoadUsesAIChatDefaults(t *testing.T) {
	setRequiredEnv(t)

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.AIChatTimeoutSeconds != 90 {
		t.Errorf("AIChatTimeoutSeconds = %d, want 90", got.AIChatTimeoutSeconds)
	}
	if got.AIChatWebSearchMaxResults != 20 {
		t.Errorf("AIChatWebSearchMaxResults = %d, want 20", got.AIChatWebSearchMaxResults)
	}
	if got.AIChatMaxConversationTurns != 10 {
		t.Errorf("AIChatMaxConversationTurns = %d, want 10", got.AIChatMaxConversationTurns)
	}
	if got.AIChatRedisDB != 3 || got.AIChatRedisURL != "redis://localhost:6379/3" {
		t.Errorf("AI chat Redis = %d %q", got.AIChatRedisDB, got.AIChatRedisURL)
	}
	if got.AIChatStreamPrefix != "ai:chat" ||
		got.AIChatStreamTTLSeconds != 86400 ||
		got.AIChatStreamMaxLen != 10000 ||
		got.AIChatStreamMaxDurationSeconds != 900 ||
		got.AIChatStreamMemoryFallback {
		t.Errorf("AI chat stream defaults = %#v", got)
	}
	if got.AIChatDefaultReasoningEffort != "medium" {
		t.Errorf("AIChatDefaultReasoningEffort = %q", got.AIChatDefaultReasoningEffort)
	}
	if got.AIChatWebSearchBaseURL != "https://search.believeboy.com" {
		t.Errorf("AIChatWebSearchBaseURL = %q", got.AIChatWebSearchBaseURL)
	}
}

func TestLoadParsesAIChatOverrides(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("AI_CHAT_PROVIDER_BASE_URL", " https://provider.example/v1 ")
	t.Setenv("AI_CHAT_PROVIDER_API_KEY", "provider-key")
	t.Setenv("AI_CHAT_DEFAULT_MODEL", "model-a")
	t.Setenv("AI_CHAT_TITLE_MODEL", "title-model")
	t.Setenv("AI_CHAT_BACKUP_MODEL", "backup-model")
	t.Setenv("AI_CHAT_MODEL_BLOCKLIST", "blocked")
	t.Setenv("AI_CHAT_PREMIUM_MODELS", "premium")
	t.Setenv("AI_CHAT_BASIC_MODELS", "model-a")
	t.Setenv("AI_CHAT_REASONING_MODELS", "model-a")
	t.Setenv("AI_CHAT_DEFAULT_REASONING_EFFORT", "high")
	t.Setenv("AI_CHAT_TIMEOUT_SECONDS", "120")
	t.Setenv("AI_CHAT_WEB_SEARCH_BASE_URL", "https://search.example")
	t.Setenv("AI_CHAT_WEB_SEARCH_API_KEY", "search-key")
	t.Setenv("AI_CHAT_WEB_SEARCH_TOPIC", "news")
	t.Setenv("AI_CHAT_WEB_SEARCH_DEPTH", "basic")
	t.Setenv("AI_CHAT_WEB_SEARCH_MAX_RESULTS", "10")
	t.Setenv("AI_CHAT_MAX_CONVERSATION_TURNS", "20")
	t.Setenv("AI_CHAT_REDIS_DB", "5")
	t.Setenv("AI_CHAT_STREAM_PREFIX", "chat:test")
	t.Setenv("AI_CHAT_STREAM_TTL_SECONDS", "120")
	t.Setenv("AI_CHAT_STREAM_MAXLEN", "500")
	t.Setenv("AI_CHAT_STREAM_MAX_DURATION_SECONDS", "600")
	t.Setenv("AI_CHAT_STREAM_MEMORY_FALLBACK", "yes")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.AIChatProviderBaseURL != "https://provider.example/v1" ||
		got.AIChatDefaultModel != "model-a" ||
		got.AIChatTitleModel != "title-model" ||
		got.AIChatReasoningModels != "model-a" {
		t.Errorf("AI chat provider config = %#v", got)
	}
	if got.AIChatTimeoutSeconds != 120 ||
		got.AIChatWebSearchMaxResults != 10 ||
		got.AIChatMaxConversationTurns != 20 {
		t.Errorf("AI chat numeric config = %#v", got)
	}
	if got.AIChatRedisDB != 5 || got.AIChatRedisURL != "redis://localhost:6379/5" {
		t.Errorf("AI chat Redis = %d %q", got.AIChatRedisDB, got.AIChatRedisURL)
	}
	if got.AIChatStreamPrefix != "chat:test" ||
		got.AIChatStreamTTLSeconds != 120 ||
		got.AIChatStreamMaxLen != 500 ||
		got.AIChatStreamMaxDurationSeconds != 600 ||
		!got.AIChatStreamMemoryFallback {
		t.Errorf("AI chat stream config = %#v", got)
	}
}

func TestLoadRejectsInvalidAIChatSettings(t *testing.T) {
	tests := []struct {
		key   string
		value string
	}{
		{key: "AI_CHAT_TIMEOUT_SECONDS", value: "0"},
		{key: "AI_CHAT_WEB_SEARCH_MAX_RESULTS", value: "101"},
		{key: "AI_CHAT_MAX_CONVERSATION_TURNS", value: "51"},
		{key: "AI_CHAT_REDIS_DB", value: "16"},
		{key: "AI_CHAT_STREAM_TTL_SECONDS", value: "10"},
		{key: "AI_CHAT_STREAM_MAXLEN", value: "99"},
		{key: "AI_CHAT_STREAM_MAX_DURATION_SECONDS", value: "901"},
		{key: "AI_CHAT_STREAM_MEMORY_FALLBACK", value: "maybe"},
	}
	for _, test := range tests {
		t.Run(test.key, func(t *testing.T) {
			setRequiredEnv(t)
			t.Setenv(test.key, test.value)
			_, err := Load()
			if err == nil {
				t.Fatalf("Load() error = nil, want invalid %s error", test.key)
			}
			if !strings.Contains(err.Error(), test.key) {
				t.Errorf("Load() error = %q, want it to mention %s", err, test.key)
			}
		})
	}
}

func TestLoadExpandsAllOwnedModules(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("GO_API_OWNED", "all")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got.OwnedModules) != len(AllModules) {
		t.Fatalf("OwnedModules = %d, want %d", len(got.OwnedModules), len(AllModules))
	}
	for _, module := range AllModules {
		if !got.OwnedModules[module] {
			t.Errorf("OwnedModules[%q] = false, want true", module)
		}
	}
}

func TestLoadRejectsUnknownOwnedModule(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("GO_API_OWNED", "health,typo_module")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "typo_module") {
		t.Fatalf("Load() error = %v, want unknown module error", err)
	}
}

func TestLoadRejectsAllCombinedWithModules(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("GO_API_OWNED", "all,crm")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "all") {
		t.Fatalf("Load() error = %v, want all-combination error", err)
	}
}

func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("API_KEY", "test-api-key")
	t.Setenv("DATABASE_URL", "postgres://localhost/believeboy")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	for _, key := range []string{
		"CRM_SEA_RECLAIM_DAYS",
		"CRM_TASK_REMINDER_LEAD_HOURS",
		"CRM_FOLLOW_UP_REMINDER_DAYS",
		"OPERATION_AUDIT_RETENTION_DAYS",
		"AGENT_API_AUDIT_RETENTION_DAYS",
		"CRM_RULE_ENGINE_ENABLED",
		"CRM_STALE_EMAIL_ENABLED",
		"UPLOAD_ROOT",
		"MONTHLY_REPORT_RESULT_ROOT",
		"AI_CHAT_PROVIDER_BASE_URL",
		"AI_CHAT_PROVIDER_API_KEY",
		"AI_CHAT_DEFAULT_MODEL",
		"AI_CHAT_TITLE_MODEL",
		"AI_CHAT_BACKUP_MODEL",
		"AI_CHAT_MODEL_BLOCKLIST",
		"AI_CHAT_PREMIUM_MODELS",
		"AI_CHAT_BASIC_MODELS",
		"AI_CHAT_REASONING_MODELS",
		"AI_CHAT_DEFAULT_REASONING_EFFORT",
		"AI_CHAT_TIMEOUT_SECONDS",
		"AI_CHAT_WEB_SEARCH_BASE_URL",
		"AI_CHAT_WEB_SEARCH_API_KEY",
		"AI_CHAT_WEB_SEARCH_TOPIC",
		"AI_CHAT_WEB_SEARCH_DEPTH",
		"AI_CHAT_WEB_SEARCH_MAX_RESULTS",
		"AI_CHAT_MAX_CONVERSATION_TURNS",
		"AI_CHAT_REDIS_DB",
		"AI_CHAT_STREAM_PREFIX",
		"AI_CHAT_STREAM_TTL_SECONDS",
		"AI_CHAT_STREAM_MAXLEN",
		"AI_CHAT_STREAM_MAX_DURATION_SECONDS",
		"AI_CHAT_STREAM_MEMORY_FALLBACK",
	} {
		unsetEnv(t, key)
	}
}

func unsetEnv(t *testing.T, key string) {
	t.Helper()

	oldValue, existed := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("os.Unsetenv(%q) error = %v", key, err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, oldValue)
			return
		}
		_ = os.Unsetenv(key)
	})
}
