package tasks

import "time"

type RunJobPayload struct {
	JobID int64 `json:"job_id"`
}

func (payload RunJobPayload) Validate() error {
	if payload.JobID <= 0 {
		return errRequired("job_id")
	}
	return nil
}

type MonthlyReportPreviewPayload struct {
	BuildID int64 `json:"build_id"`
}

func (payload MonthlyReportPreviewPayload) Validate() error {
	if payload.BuildID <= 0 {
		return errRequired("build_id")
	}
	return nil
}

type AgentMonthlyReportCleanupPayload struct {
	Now *time.Time `json:"now,omitempty"`
}

type GenerateInsightPayload struct {
	ScheduleID *int64 `json:"schedule_id,omitempty"`
	InsightID  *int64 `json:"insight_id,omitempty"`
}

func (payload GenerateInsightPayload) Validate() error {
	if payload.ScheduleID == nil && payload.InsightID == nil {
		return errRequired("schedule_id or insight_id")
	}
	if payload.ScheduleID != nil && *payload.ScheduleID <= 0 {
		return errPositive("schedule_id")
	}
	if payload.InsightID != nil && *payload.InsightID <= 0 {
		return errPositive("insight_id")
	}
	return nil
}

type ExecuteInsightRunPayload struct {
	RunID   string `json:"run_id"`
	Attempt int    `json:"attempt"`
}

func (payload ExecuteInsightRunPayload) Validate() error {
	if payload.RunID == "" {
		return errRequired("run_id")
	}
	if payload.Attempt < 0 {
		return errNonNegative("attempt")
	}
	return nil
}

type DispatchOnePayload struct {
	SubscriptionID   int64   `json:"subscription_id"`
	Email            string  `json:"email"`
	ProjectIDs       []int64 `json:"project_ids,omitempty"`
	Country          string  `json:"country"`
	Frequency        string  `json:"frequency"`
	AIModel          *string `json:"ai_model,omitempty"`
	UseCache         *bool   `json:"use_cache,omitempty"`
	TriggeredBy      string  `json:"triggered_by,omitempty"`
	ReportDate       string  `json:"report_date,omitempty"`
	PreExistingLogID *int64  `json:"pre_existing_log_id,omitempty"`
	OldLogID         *int64  `json:"old_log_id,omitempty"`
}

func (payload DispatchOnePayload) Validate() error {
	switch {
	case payload.SubscriptionID <= 0:
		return errRequired("subscription_id")
	case payload.Email == "":
		return errRequired("email")
	case payload.Country == "":
		return errRequired("country")
	case payload.Frequency == "":
		return errRequired("frequency")
	default:
		return nil
	}
}

type GenerateDeliverySummaryPayload struct {
	LogID           int64   `json:"log_id"`
	LedgerKey       *string `json:"ledger_key,omitempty"`
	OverrideAIModel *string `json:"override_ai_model,omitempty"`
}

func (payload GenerateDeliverySummaryPayload) Validate() error {
	if payload.LogID <= 0 {
		return errRequired("log_id")
	}
	return nil
}

type AlertDetectPayload struct {
	Now *time.Time `json:"now,omitempty"`
}

type ReturnAnalysisRefreshPayload struct {
	TargetDate   *string `json:"target_date,omitempty"`
	LookbackDays *int    `json:"lookback_days,omitempty"`
}

func (payload ReturnAnalysisRefreshPayload) Validate() error {
	if payload.TargetDate != nil {
		if _, err := time.Parse("2006-01-02", *payload.TargetDate); err != nil {
			return errInvalid("target_date", "must be YYYY-MM-DD")
		}
	}
	if payload.LookbackDays != nil && (*payload.LookbackDays < 1 || *payload.LookbackDays > 90) {
		return errInvalid("lookback_days", "must be between 1 and 90")
	}
	return nil
}

type ReturnAnalysisRebuildPayload struct{}

type CRMSeaReclaimPayload struct {
	Days *int       `json:"days,omitempty"`
	Now  *time.Time `json:"now,omitempty"`
}

type CRMTaskReminderPayload struct {
	LeadHours *int       `json:"lead_hours,omitempty"`
	Now       *time.Time `json:"now,omitempty"`
}

type CRMFollowUpReminderPayload struct {
	Days *int       `json:"days,omitempty"`
	Now  *time.Time `json:"now,omitempty"`
}

type CRMRuleEnginePayload struct {
	Now *time.Time `json:"now,omitempty"`
}

type CRMStaleEmailPayload struct{}

type AgentAPIAuditCleanupPayload struct {
	RetentionDays *int       `json:"retention_days,omitempty"`
	Now           *time.Time `json:"now,omitempty"`
}

type OperationAuditCleanupPayload struct {
	RetentionDays *int       `json:"retention_days,omitempty"`
	Now           *time.Time `json:"now,omitempty"`
}

type AIChatTokenUsageRefreshPayload struct {
	TargetDate *string `json:"target_date,omitempty"`
}
