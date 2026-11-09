package queue

// Task type names are wire contracts with the Python Celery task catalog.
const (
	TypeRunJob                       = "app.celery_tasks.run_job.run_job"
	TypeBuildMonthlyReportPreview    = "app.celery_tasks.monthly_report_preview.build_monthly_report_preview"
	TypeAgentMonthlyReportCleanup    = "agent_monthly_report_cleanup"
	TypeGenerateInsight              = "generate_insight"
	TypeExecuteInsightRun            = "execute_insight_run"
	TypeDispatchOne                  = "dispatch_one"
	TypeGenerateDeliverySummary      = "generate_delivery_summary"
	TypeAlertDetect                  = "alert_detect"
	TypeReturnAnalysisRefreshDaily   = "return_analysis.refresh_daily"
	TypeReturnAnalysisRebuild        = "return_analysis.rebuild"
	TypeCRMSeaReclaim                = "crm_sea_reclaim"
	TypeCRMTaskReminder              = "crm_task_reminder"
	TypeCRMFollowUpReminder          = "crm_follow_up_reminder"
	TypeCRMRuleEngine                = "crm_rule_engine"
	TypeCRMStaleEmail                = "crm_stale_email"
	TypeAgentAPIAuditCleanup         = "agent_api_audit_cleanup"
	TypeOperationAuditCleanup        = "operation_audit_cleanup"
	TypeAIChatTokenUsageRefreshDaily = "ai_chat_token_usage.refresh_daily"
)

const (
	QueueReports   = "reports"
	QueueInsights  = "insights"
	QueueScheduled = "scheduled"
	QueueAISummary = "ai_summary"
	QueueDefault   = "default"
)

var taskQueueByType = map[string]string{
	TypeRunJob:                       QueueReports,
	TypeBuildMonthlyReportPreview:    QueueReports,
	TypeAgentMonthlyReportCleanup:    QueueDefault,
	TypeGenerateInsight:              QueueInsights,
	TypeExecuteInsightRun:            QueueInsights,
	TypeDispatchOne:                  QueueScheduled,
	TypeGenerateDeliverySummary:      QueueAISummary,
	TypeAlertDetect:                  QueueDefault,
	TypeReturnAnalysisRefreshDaily:   QueueDefault,
	TypeReturnAnalysisRebuild:        QueueDefault,
	TypeCRMSeaReclaim:                QueueDefault,
	TypeCRMTaskReminder:              QueueDefault,
	TypeCRMFollowUpReminder:          QueueDefault,
	TypeCRMRuleEngine:                QueueDefault,
	TypeCRMStaleEmail:                QueueDefault,
	TypeAgentAPIAuditCleanup:         QueueDefault,
	TypeOperationAuditCleanup:        QueueDefault,
	TypeAIChatTokenUsageRefreshDaily: QueueDefault,
}

var allTaskTypes = []string{
	TypeRunJob,
	TypeBuildMonthlyReportPreview,
	TypeAgentMonthlyReportCleanup,
	TypeGenerateInsight,
	TypeExecuteInsightRun,
	TypeDispatchOne,
	TypeGenerateDeliverySummary,
	TypeAlertDetect,
	TypeReturnAnalysisRefreshDaily,
	TypeReturnAnalysisRebuild,
	TypeCRMSeaReclaim,
	TypeCRMTaskReminder,
	TypeCRMFollowUpReminder,
	TypeCRMRuleEngine,
	TypeCRMStaleEmail,
	TypeAgentAPIAuditCleanup,
	TypeOperationAuditCleanup,
	TypeAIChatTokenUsageRefreshDaily,
}

// QueueForTask returns the Celery-compatible queue for a task type.
// Unknown task types are safe to leave on the default queue.
func QueueForTask(taskType string) string {
	if queueName, ok := taskQueueByType[taskType]; ok {
		return queueName
	}
	return QueueDefault
}

// AllTaskTypes returns the complete Stage 6A task catalog.
func AllTaskTypes() []string {
	return append([]string(nil), allTaskTypes...)
}

// DefaultQueueWeights returns the Celery-aligned weighted priority map.
func DefaultQueueWeights() map[string]int {
	return map[string]int{
		QueueReports:   6,
		QueueInsights:  4,
		QueueScheduled: 3,
		QueueAISummary: 2,
		QueueDefault:   1,
	}
}
