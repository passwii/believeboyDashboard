package contract

import (
	"context"
	"encoding/json"
	"reflect"
	"sort"
	"testing"

	"github.com/hibiken/asynq"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
)

type stage6AContractRegistrar struct {
	taskTypes []string
	handlers  map[string]asynq.HandlerFunc
}

func (r *stage6AContractRegistrar) RegisterHandler(taskType string, handler asynq.HandlerFunc) {
	r.taskTypes = append(r.taskTypes, taskType)
	if r.handlers == nil {
		r.handlers = make(map[string]asynq.HandlerFunc)
	}
	r.handlers[taskType] = handler
}

func TestStage6AContractTaskCatalogAndQueueRouting(t *testing.T) {
	want := []string{
		"app.celery_tasks.run_job.run_job",
		"app.celery_tasks.monthly_report_preview.build_monthly_report_preview",
		"agent_monthly_report_cleanup",
		"generate_insight",
		"execute_insight_run",
		"dispatch_one",
		"generate_delivery_summary",
		"alert_detect",
		"return_analysis.refresh_daily",
		"return_analysis.rebuild",
		"crm_sea_reclaim",
		"crm_task_reminder",
		"crm_follow_up_reminder",
		"crm_rule_engine",
		"crm_stale_email",
		"agent_api_audit_cleanup",
		"operation_audit_cleanup",
		"ai_chat_token_usage.refresh_daily",
	}
	got := queue.AllTaskTypes()
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("AllTaskTypes() = %#v, want %#v", got, want)
	}

	routes := map[string]string{
		queue.TypeRunJob:                       queue.QueueReports,
		queue.TypeBuildMonthlyReportPreview:    queue.QueueReports,
		queue.TypeAgentMonthlyReportCleanup:    queue.QueueDefault,
		queue.TypeGenerateInsight:              queue.QueueInsights,
		queue.TypeExecuteInsightRun:            queue.QueueInsights,
		queue.TypeDispatchOne:                  queue.QueueScheduled,
		queue.TypeGenerateDeliverySummary:      queue.QueueAISummary,
		queue.TypeAlertDetect:                  queue.QueueDefault,
		queue.TypeReturnAnalysisRefreshDaily:   queue.QueueDefault,
		queue.TypeReturnAnalysisRebuild:        queue.QueueDefault,
		queue.TypeCRMSeaReclaim:                queue.QueueDefault,
		queue.TypeCRMTaskReminder:              queue.QueueDefault,
		queue.TypeCRMFollowUpReminder:          queue.QueueDefault,
		queue.TypeCRMRuleEngine:                queue.QueueDefault,
		queue.TypeCRMStaleEmail:                queue.QueueDefault,
		queue.TypeAgentAPIAuditCleanup:         queue.QueueDefault,
		queue.TypeOperationAuditCleanup:        queue.QueueDefault,
		queue.TypeAIChatTokenUsageRefreshDaily: queue.QueueDefault,
	}
	for taskType, wantQueue := range routes {
		if gotQueue := queue.QueueForTask(taskType); gotQueue != wantQueue {
			t.Fatalf("QueueForTask(%q) = %q, want %q", taskType, gotQueue, wantQueue)
		}
	}
}

func TestStage6AContractQueuePriorities(t *testing.T) {
	want := map[string]int{
		queue.QueueReports:   6,
		queue.QueueInsights:  4,
		queue.QueueScheduled: 3,
		queue.QueueAISummary: 2,
		queue.QueueDefault:   1,
	}
	if got := queue.DefaultQueueWeights(); !reflect.DeepEqual(got, want) {
		t.Fatalf("DefaultQueueWeights() = %#v, want %#v", got, want)
	}
}

func TestStage6AContractPayloadRoundTripsForAllTasks(t *testing.T) {
	cases := []struct {
		name   string
		value  any
		decode func([]byte) (any, error)
	}{
		{
			name:  "run job",
			value: tasks.RunJobPayload{JobID: 42},
			decode: func(raw []byte) (any, error) {
				var value tasks.RunJobPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "monthly preview",
			value: tasks.MonthlyReportPreviewPayload{BuildID: 7},
			decode: func(raw []byte) (any, error) {
				var value tasks.MonthlyReportPreviewPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "agent monthly cleanup",
			value: tasks.AgentMonthlyReportCleanupPayload{},
			decode: func(raw []byte) (any, error) {
				var value tasks.AgentMonthlyReportCleanupPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "generate insight",
			value: tasks.GenerateInsightPayload{ScheduleID: stage6AInt64Pointer(11)},
			decode: func(raw []byte) (any, error) {
				var value tasks.GenerateInsightPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "execute insight run",
			value: tasks.ExecuteInsightRunPayload{RunID: "run-1", Attempt: 2},
			decode: func(raw []byte) (any, error) {
				var value tasks.ExecuteInsightRunPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name: "dispatch one",
			value: tasks.DispatchOnePayload{
				SubscriptionID: 3,
				Email:          "ops@example.com",
				ProjectIDs:     []int64{1, 2},
				Country:        "US",
				Frequency:      "daily",
				UseCache:       stage6ABoolPointer(true),
				TriggeredBy:    "auto",
				ReportDate:     "2026-11-08",
			},
			decode: func(raw []byte) (any, error) {
				var value tasks.DispatchOnePayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "delivery summary",
			value: tasks.GenerateDeliverySummaryPayload{LogID: 8},
			decode: func(raw []byte) (any, error) {
				var value tasks.GenerateDeliverySummaryPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "alert detect",
			value: tasks.AlertDetectPayload{},
			decode: func(raw []byte) (any, error) {
				var value tasks.AlertDetectPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "return refresh",
			value: tasks.ReturnAnalysisRefreshPayload{TargetDate: stage6AStringPointer("2026-11-07"), LookbackDays: stage6AIntPointer(7)},
			decode: func(raw []byte) (any, error) {
				var value tasks.ReturnAnalysisRefreshPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "return rebuild",
			value: tasks.ReturnAnalysisRebuildPayload{},
			decode: func(raw []byte) (any, error) {
				var value tasks.ReturnAnalysisRebuildPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "crm sea reclaim",
			value: tasks.CRMSeaReclaimPayload{Days: stage6AIntPointer(15)},
			decode: func(raw []byte) (any, error) {
				var value tasks.CRMSeaReclaimPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "crm task reminder",
			value: tasks.CRMTaskReminderPayload{LeadHours: stage6AIntPointer(24)},
			decode: func(raw []byte) (any, error) {
				var value tasks.CRMTaskReminderPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "crm follow up",
			value: tasks.CRMFollowUpReminderPayload{Days: stage6AIntPointer(7)},
			decode: func(raw []byte) (any, error) {
				var value tasks.CRMFollowUpReminderPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "crm rule engine",
			value: tasks.CRMRuleEnginePayload{},
			decode: func(raw []byte) (any, error) {
				var value tasks.CRMRuleEnginePayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "crm stale email",
			value: tasks.CRMStaleEmailPayload{},
			decode: func(raw []byte) (any, error) {
				var value tasks.CRMStaleEmailPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "agent audit cleanup",
			value: tasks.AgentAPIAuditCleanupPayload{RetentionDays: stage6AIntPointer(90)},
			decode: func(raw []byte) (any, error) {
				var value tasks.AgentAPIAuditCleanupPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "operation audit cleanup",
			value: tasks.OperationAuditCleanupPayload{RetentionDays: stage6AIntPointer(90)},
			decode: func(raw []byte) (any, error) {
				var value tasks.OperationAuditCleanupPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
		{
			name:  "ai chat usage",
			value: tasks.AIChatTokenUsageRefreshPayload{TargetDate: stage6AStringPointer("2026-11-07")},
			decode: func(raw []byte) (any, error) {
				var value tasks.AIChatTokenUsageRefreshPayload
				err := queue.DecodePayload(raw, &value)
				return value, err
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			raw, err := queue.MarshalPayload(testCase.value)
			if err != nil {
				t.Fatalf("MarshalPayload() error = %v", err)
			}
			decoded, err := testCase.decode(raw)
			if err != nil {
				t.Fatalf("DecodePayload() error = %v", err)
			}
			if !reflect.DeepEqual(decoded, testCase.value) {
				t.Fatalf("payload round trip = %#v, want %#v", decoded, testCase.value)
			}
			if _, err := json.Marshal(decoded); err != nil {
				t.Fatalf("json.Marshal(decoded) error = %v", err)
			}
		})
	}
}

func TestStage6AContractRegisterAllHandlers(t *testing.T) {
	handler := tasks.NewTaskHandlerWithDB(nil, tasks.DefaultHandlerConfig())
	registrar := &stage6AContractRegistrar{}
	if err := handler.RegisterAll(registrar); err != nil {
		t.Fatalf("RegisterAll() error = %v", err)
	}
	if len(registrar.taskTypes) != 18 {
		t.Fatalf("registered %d handlers, want 18", len(registrar.taskTypes))
	}
	sort.Strings(registrar.taskTypes)
	want := queue.AllTaskTypes()
	sort.Strings(want)
	if !reflect.DeepEqual(registrar.taskTypes, want) {
		t.Fatalf("registered task types = %#v, want %#v", registrar.taskTypes, want)
	}
}

func TestStage6AContractHandlersDoNotDefaultToSkippedSuccess(t *testing.T) {
	handler := tasks.NewTaskHandlerWithDB(nil, tasks.DefaultHandlerConfig())
	registrar := &stage6AContractRegistrar{}
	if err := handler.RegisterAll(registrar); err != nil {
		t.Fatalf("RegisterAll() error = %v", err)
	}

	payloads := map[string]any{
		queue.TypeRunJob:                    tasks.RunJobPayload{JobID: 1},
		queue.TypeBuildMonthlyReportPreview: tasks.MonthlyReportPreviewPayload{BuildID: 1},
		queue.TypeAgentMonthlyReportCleanup: tasks.AgentMonthlyReportCleanupPayload{},
		queue.TypeGenerateInsight:           tasks.GenerateInsightPayload{ScheduleID: stage6AInt64Pointer(1)},
		queue.TypeExecuteInsightRun:         tasks.ExecuteInsightRunPayload{RunID: "run-1"},
		queue.TypeDispatchOne: tasks.DispatchOnePayload{
			SubscriptionID: 1,
			Email:          "ops@example.com",
			Country:        "US",
			Frequency:      "daily",
		},
		queue.TypeGenerateDeliverySummary:      tasks.GenerateDeliverySummaryPayload{LogID: 1},
		queue.TypeAlertDetect:                  tasks.AlertDetectPayload{},
		queue.TypeReturnAnalysisRefreshDaily:   tasks.ReturnAnalysisRefreshPayload{},
		queue.TypeReturnAnalysisRebuild:        tasks.ReturnAnalysisRebuildPayload{},
		queue.TypeCRMSeaReclaim:                tasks.CRMSeaReclaimPayload{},
		queue.TypeCRMTaskReminder:              tasks.CRMTaskReminderPayload{},
		queue.TypeCRMFollowUpReminder:          tasks.CRMFollowUpReminderPayload{},
		queue.TypeCRMRuleEngine:                tasks.CRMRuleEnginePayload{},
		queue.TypeCRMStaleEmail:                tasks.CRMStaleEmailPayload{},
		queue.TypeAgentAPIAuditCleanup:         tasks.AgentAPIAuditCleanupPayload{},
		queue.TypeOperationAuditCleanup:        tasks.OperationAuditCleanupPayload{},
		queue.TypeAIChatTokenUsageRefreshDaily: tasks.AIChatTokenUsageRefreshPayload{},
	}

	for _, taskType := range queue.AllTaskTypes() {
		taskType := taskType
		t.Run(taskType, func(t *testing.T) {
			payload, ok := payloads[taskType]
			if !ok {
				t.Fatalf("contract test has no payload for %q", taskType)
			}
			raw, err := queue.MarshalPayload(payload)
			if err != nil {
				t.Fatalf("MarshalPayload() error = %v", err)
			}
			handle, ok := registrar.handlers[taskType]
			if !ok {
				t.Fatalf("handler %q was not registered", taskType)
			}
			if err := handle(context.Background(), asynq.NewTask(taskType, raw)); err == nil {
				t.Fatalf("handler %q returned nil with default incomplete runtime", taskType)
			}
		})
	}
}

func stage6AIntPointer(value int) *int          { return &value }
func stage6AInt64Pointer(value int64) *int64    { return &value }
func stage6AStringPointer(value string) *string { return &value }
func stage6ABoolPointer(value bool) *bool       { return &value }
