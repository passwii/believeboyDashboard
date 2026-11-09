package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const shanghaiLocationName = "Asia/Shanghai"

// Executor owns AI/report-delivery work that has not moved into this package yet.
// A nil Executor is a runtime dependency error, never a successful no-op.
type Executor interface {
	Execute(ctx context.Context, taskType string, payload any) (any, error)
}

type MonthlyReportFinalizer interface {
	Finalize(
		ctx context.Context,
		reportID int64,
		jobID int64,
		result store.MonthlyReportComputedResult,
	) error
}

type MonthlyReportGenerator interface {
	Generate(
		ctx context.Context,
		input MonthlyReportGenerationInput,
	) (*store.MonthlyReportComputedResult, error)
}

type MonthlyReportBuildExecutor interface {
	ExecuteBuild(ctx context.Context, buildID int64) (any, error)
}

type Mailer interface {
	Send(ctx context.Context, to, subject, body string) error
}

// StaleEmailMailer is kept as an alias for integrations that use the narrower name.
type StaleEmailMailer = Mailer

type HandlerConfig struct {
	OperationAuditRetentionDays    int
	AgentAPIAuditRetentionDays     int
	CRMSeaReclaimDays              int
	CRMTaskReminderLeadHours       int
	CRMFollowUpReminderDays        int
	CRMRuleEngineEnabled           bool
	CRMStaleEmailEnabled           bool
	Location                       *time.Location
	Now                            func() time.Time
	Executor                       Executor
	InsightGenerator               ai_insight.Generator
	InsightRunExecutor             insight_runs.RunExecutor
	MonthlyReportGenerator         MonthlyReportGenerator
	MonthlyReportFinalizer         MonthlyReportFinalizer
	MonthlyReportBuildExecutor     MonthlyReportBuildExecutor
	ProductAnalysisReportExecutor  ProductAnalysisReportExecutor
	Mailer                         Mailer
	AgentMonthlyReportRoot         string
	AgentMonthlyReportBuildTimeout time.Duration
}

func DefaultHandlerConfig() HandlerConfig {
	location, err := time.LoadLocation(shanghaiLocationName)
	if err != nil {
		location = time.FixedZone("CST", 8*60*60)
	}
	return HandlerConfig{
		OperationAuditRetentionDays:    90,
		AgentAPIAuditRetentionDays:     90,
		CRMSeaReclaimDays:              15,
		CRMTaskReminderLeadHours:       24,
		CRMFollowUpReminderDays:        7,
		CRMRuleEngineEnabled:           true,
		CRMStaleEmailEnabled:           true,
		Location:                       location,
		Now:                            time.Now,
		AgentMonthlyReportRoot:         defaultAgentMonthlyReportRoot(),
		AgentMonthlyReportBuildTimeout: 25 * time.Minute,
	}
}

func defaultAgentMonthlyReportRoot() string {
	if root := os.Getenv("AGENT_MONTHLY_REPORT_ROOT"); root != "" {
		return root
	}
	return filepath.Join("backend", "storage", "agent_monthly_reports")
}

type HandlerRegistrar interface {
	RegisterHandler(taskType string, handler asynq.HandlerFunc)
}

type TaskHandler struct {
	pool   *pgxpool.Pool
	db     store.FullDB
	config HandlerConfig
}

// NewTaskHandler creates a task handler backed by the shared pgx pool.
func NewTaskHandler(pool *pgxpool.Pool, config HandlerConfig) *TaskHandler {
	var db store.FullDB
	if pool != nil {
		db = store.NewPGXDB(pool)
	}
	return &TaskHandler{
		pool:   pool,
		db:     db,
		config: normalizeHandlerConfig(config),
	}
}

// NewTaskHandlerWithDB creates a task handler with an injected DB surface.
func NewTaskHandlerWithDB(db store.FullDB, config HandlerConfig) *TaskHandler {
	return &TaskHandler{
		db:     db,
		config: normalizeHandlerConfig(config),
	}
}

// ValidateRuntime checks dependencies that every registered task needs.
// Stage 7 executors are intentionally not startup requirements: their handlers
// fail closed when invoked, while the monthly-report worker can start with only
// the generator/finalizer it actually owns.
func (handler *TaskHandler) ValidateRuntime() error {
	if handler == nil {
		return errors.Join(
			ErrDatabaseNotConfigured,
			fmt.Errorf("%w: monthly report generator", ErrDependencyNotConfigured),
			fmt.Errorf("%w: monthly report finalizer", ErrDependencyNotConfigured),
			fmt.Errorf("%w: crm stale email mailer", ErrDependencyNotConfigured),
			fmt.Errorf("%w: agent monthly report root", ErrDependencyNotConfigured),
		)
	}

	var problems []error
	if handler.db == nil {
		problems = append(problems, ErrDatabaseNotConfigured)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.db.Ping(ctx); err != nil {
			problems = append(problems, fmt.Errorf("database ping failed: %w", err))
		}
	}
	if handler.config.MonthlyReportGenerator == nil {
		problems = append(problems, fmt.Errorf("%w: monthly report generator", ErrDependencyNotConfigured))
	}
	if handler.config.MonthlyReportFinalizer == nil {
		problems = append(problems, fmt.Errorf("%w: monthly report finalizer", ErrDependencyNotConfigured))
	}
	if handler.config.CRMStaleEmailEnabled && handler.config.Mailer == nil {
		problems = append(problems, fmt.Errorf("%w: crm stale email mailer", ErrDependencyNotConfigured))
	}
	if handler.config.AgentMonthlyReportRoot == "" {
		problems = append(problems, fmt.Errorf("%w: agent monthly report root", ErrDependencyNotConfigured))
	}
	return errors.Join(problems...)
}

// RegisterAll binds all 18 Stage 6A handlers to a queue server.
func (handler *TaskHandler) RegisterAll(registrar HandlerRegistrar) error {
	if handler == nil {
		return fmt.Errorf("register all handlers: task handler is nil")
	}
	if registrar == nil {
		return fmt.Errorf("register all handlers: registrar is nil")
	}

	registrations := []struct {
		taskType string
		handler  asynq.HandlerFunc
	}{
		{queue.TypeRunJob, handler.HandleRunJob},
		{queue.TypeBuildMonthlyReportPreview, handler.HandleBuildMonthlyReportPreview},
		{queue.TypeAgentMonthlyReportCleanup, handler.HandleAgentMonthlyReportCleanup},
		{queue.TypeGenerateInsight, handler.HandleGenerateInsight},
		{queue.TypeExecuteInsightRun, handler.HandleExecuteInsightRun},
		{queue.TypeDispatchOne, handler.HandleDispatchOne},
		{queue.TypeGenerateDeliverySummary, handler.HandleGenerateDeliverySummary},
		{queue.TypeAlertDetect, handler.HandleAlertDetect},
		{queue.TypeReturnAnalysisRefreshDaily, handler.HandleReturnAnalysisRefreshDaily},
		{queue.TypeReturnAnalysisRebuild, handler.HandleReturnAnalysisRebuild},
		{queue.TypeCRMSeaReclaim, handler.HandleCRMSeaReclaim},
		{queue.TypeCRMTaskReminder, handler.HandleCRMTaskReminder},
		{queue.TypeCRMFollowUpReminder, handler.HandleCRMFollowUpReminder},
		{queue.TypeCRMRuleEngine, handler.HandleCRMRuleEngine},
		{queue.TypeCRMStaleEmail, handler.HandleCRMStaleEmail},
		{queue.TypeAgentAPIAuditCleanup, handler.HandleAgentAPIAuditCleanup},
		{queue.TypeOperationAuditCleanup, handler.HandleOperationAuditCleanup},
		{queue.TypeAIChatTokenUsageRefreshDaily, handler.HandleAIChatTokenUsageRefreshDaily},
	}
	for _, registration := range registrations {
		registrar.RegisterHandler(registration.taskType, registration.handler)
	}
	return nil
}

type taskResult struct {
	TaskType string `json:"task_type"`
	Status   string `json:"status"`
	Reason   string `json:"reason,omitempty"`
	Data     any    `json:"data,omitempty"`
}

func (handler *TaskHandler) runSafely(taskType string, operation func() error) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("task %s panicked: %v", taskType, recovered)
		}
	}()
	if err := operation(); err != nil {
		return fmt.Errorf("task %s: %w", taskType, err)
	}
	return nil
}

func (handler *TaskHandler) decodePayload(task *asynq.Task, destination any) error {
	if task == nil {
		return fmt.Errorf("task is nil")
	}
	if err := queue.DecodePayload(task.Payload(), destination); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	return nil
}

func (handler *TaskHandler) requireDB() (store.FullDB, error) {
	if handler == nil || handler.db == nil {
		return nil, ErrDatabaseNotConfigured
	}
	return handler.db, nil
}

func (handler *TaskHandler) execute(
	ctx context.Context,
	task *asynq.Task,
	taskType string,
	payload any,
) error {
	if handler.config.Executor == nil {
		return ErrExecutorNotConfigured
	}

	result, err := handler.config.Executor.Execute(ctx, taskType, payload)
	if err != nil {
		return fmt.Errorf("execute external task: %w", err)
	}
	return handler.writeResult(task, taskResult{
		TaskType: taskType,
		Status:   "completed",
		Data:     result,
	})
}

func (handler *TaskHandler) writeResult(task *asynq.Task, result taskResult) error {
	if task == nil {
		return fmt.Errorf("task is nil")
	}
	writer := task.ResultWriter()
	if writer == nil {
		return nil
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("encode task result: %w", err)
	}
	if _, err := writer.Write(encoded); err != nil {
		return fmt.Errorf("write task result: %w", err)
	}
	return nil
}

func (handler *TaskHandler) currentTime(override *time.Time) time.Time {
	if override != nil {
		return *override
	}
	if handler != nil && handler.config.Now != nil {
		return handler.config.Now()
	}
	return time.Now()
}

func (handler *TaskHandler) location() *time.Location {
	if handler != nil && handler.config.Location != nil {
		return handler.config.Location
	}
	location, err := time.LoadLocation(shanghaiLocationName)
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return location
}

func normalizeHandlerConfig(config HandlerConfig) HandlerConfig {
	if config.Location == nil {
		location, err := time.LoadLocation(shanghaiLocationName)
		if err != nil {
			location = time.FixedZone("CST", 8*60*60)
		}
		config.Location = location
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return config
}

func intValue(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func boolValue(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}
