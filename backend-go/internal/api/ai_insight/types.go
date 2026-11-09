package ai_insight

import (
	"context"
	"errors"
	"time"
)

const ModuleName = "ai_insight"

var (
	ErrProjectNotFound      = errors.New("project not found")
	ErrProjectForbidden     = errors.New("project forbidden")
	ErrInsightNotFound      = errors.New("insight not found")
	ErrScheduleNotFound     = errors.New("insight schedule not found")
	ErrInsightCompleted     = errors.New("completed insight cannot be retried")
	ErrDomainSwitchNeeded   = errors.New("domain switch conflict")
	ErrScheduleInactive     = errors.New("insight schedule is inactive")
	ErrDomainMigrated       = errors.New("insight domain migrated to canonical")
	ErrScheduleStoreMissing = errors.New("insight schedule generator store is not configured")
	ErrEnqueuerMissing      = errors.New("insight job enqueuer is not configured")
	ErrProviderMissing      = errors.New("insight ai provider is not configured")
	ErrInvalidState         = errors.New("insight is not in a retryable state")
)

// MutationMeta carries request-scoped audit metadata without coupling the
// persistence layer to net/http.
type MutationMeta struct {
	Operator       string
	TraceID        string
	RequestMethod  string
	RequestPath    string
	IPAddress      string
	UserAgent      string
	IdempotencyKey string
}

type ProjectInfo struct {
	ID                int64
	Name              string
	Country           string
	ProjectOperator   *string
	AssistantOperator *string
}

type ListFilter struct {
	ProjectID *int64
	Country   *string
	Status    *string
	Type      *string
	Limit     int
	Offset    int
	Operator  string
	IsAdmin   bool
}

type InsightItem struct {
	ID             int64     `json:"id"`
	ProjectID      int64     `json:"project_id"`
	ProjectName    string    `json:"project_name"`
	Country        string    `json:"country"`
	Title          string    `json:"title"`
	InsightType    string    `json:"insight_type"`
	DateRangeStart string    `json:"date_range_start"`
	DateRangeEnd   string    `json:"date_range_end"`
	Status         string    `json:"status"`
	SubStatus      *string   `json:"sub_status"`
	ErrorMessage   *string   `json:"error_message"`
	CreatedBy      string    `json:"created_by"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type InsightDetail struct {
	InsightItem
	Content          string  `json:"content"`
	StrategyMetadata *string `json:"strategy_metadata"`
}

type InsightListResponse struct {
	Items []InsightItem `json:"items"`
	Total int           `json:"total"`
}

type GenerateRequest struct {
	ProjectID      int64    `json:"project_id"`
	Country        string   `json:"country"`
	DateRangeStart string   `json:"date_range_start"`
	DateRangeEnd   string   `json:"date_range_end"`
	InsightType    string   `json:"insight_type"`
	Model          *string  `json:"model"`
	FocusAreas     []string `json:"focus_areas"`
}

type StatusResponse struct {
	Status       string  `json:"status"`
	InsightID    *int64  `json:"insight_id"`
	ErrorMessage *string `json:"error_message"`
}

type RetryResponse struct {
	Status    string `json:"status"`
	InsightID int64  `json:"insight_id"`
}

type DeleteResponse struct {
	Deleted bool  `json:"deleted"`
	ID      int64 `json:"id"`
}

type UpdateInsightInput struct {
	Content  string
	Operator string
	IsAdmin  bool
	Audit    MutationMeta
}

type CreateInsightInput struct {
	ProjectID      int64
	Country        string
	DateRangeStart time.Time
	DateRangeEnd   time.Time
	InsightType    string
	Model          *string
	FocusAreas     []string
	Operator       string
	Audit          MutationMeta
}

type ScheduleFilter struct {
	ProjectID *int64
	IsActive  *bool
	Type      *string
	Operator  string
	IsAdmin   bool
}

type CreateScheduleInput struct {
	ProjectID         int64
	Country           string
	InsightType       string
	CronExpression    string
	DateRangeStrategy string
	Model             *string
	Operator          string
	Audit             MutationMeta
}

type UpdateScheduleInput struct {
	Country           *string
	InsightType       *string
	CronExpression    *string
	DateRangeStrategy *string
	Model             *string
	ModelSet          bool
	IsActive          *bool
	Operator          string
	IsAdmin           bool
	Audit             MutationMeta
}

type Schedule struct {
	ID                int64      `json:"id"`
	ProjectID         int64      `json:"project_id"`
	ProjectName       string     `json:"project_name"`
	Country           string     `json:"country"`
	InsightType       string     `json:"insight_type"`
	CronExpression    string     `json:"cron_expression"`
	DateRangeStrategy string     `json:"date_range_strategy"`
	Model             *string    `json:"model"`
	IsActive          bool       `json:"is_active"`
	RunCount          int        `json:"run_count"`
	FailureCount      int        `json:"failure_count"`
	LastRunAt         *time.Time `json:"last_run_at"`
	LastInsightID     *int64     `json:"last_insight_id"`
	LastError         *string    `json:"last_error"`
	NextRunAt         *time.Time `json:"next_run_at"`
	CreatedBy         string     `json:"created_by"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type ScheduleListResponse struct {
	Items []Schedule `json:"items"`
	Total int        `json:"total"`
}

type ScheduleToggleResponse struct {
	ID       int64  `json:"id"`
	IsActive bool   `json:"is_active"`
	Message  string `json:"message"`
}

type ScheduleRunNowResponse struct {
	ID        int64  `json:"id"`
	InsightID int64  `json:"insight_id"`
	Status    string `json:"status"`
	Message   string `json:"message"`
}

type ScheduleDeleteResponse struct {
	Deleted bool  `json:"deleted"`
	ID      int64 `json:"id"`
}

type RunScheduleResult struct {
	ScheduleID int64
	InsightID  int64
	Status     string
	Message    string
}

type InsightStatusSnapshot struct {
	ID           int64
	ProjectID    int64
	Title        string
	Content      string
	Status       string
	SubStatus    *string
	ErrorMessage *string
}

// JobEnqueuer is the transport-neutral bridge to Asynq/Celery-compatible jobs.
// The gateway adapter maps Generate to queue.TypeGenerateInsight and ExecuteRun
// to queue.TypeExecuteInsightRun.
type JobEnqueuer interface {
	EnqueueGenerate(ctx context.Context, job GenerateJob) error
	EnqueueExecuteRun(ctx context.Context, job ExecuteRunJob) error
}

type GenerateJob struct {
	ScheduleID *int64 `json:"schedule_id,omitempty"`
	InsightID  *int64 `json:"insight_id,omitempty"`
}

type ExecuteRunJob struct {
	RunID   string `json:"run_id"`
	Attempt int    `json:"attempt"`
}

type AdAgentRun struct {
	RunID              string
	ProjectID          int64
	DimensionsAnalyzed []map[string]any
	DimensionsSkipped  []map[string]any
}

type AdAgentEvolutionReport struct {
	Suggestions     []DimensionSuggestion      `json:"suggestions"`
	DimensionHealth map[string]DimensionHealth `json:"dimension_health"`
}

type DimensionSuggestion struct {
	DimensionID string `json:"dimension_id"`
	Action      string `json:"action"`
	Reason      string `json:"reason"`
}

type DimensionHealth struct {
	RunCount           int            `json:"run_count"`
	SignalDistribution map[string]int `json:"signal_distribution"`
	EmptyRatio         float64        `json:"empty_ratio"`
	StrongRatio        float64        `json:"strong_ratio"`
}

type Config struct {
	CanonicalDomains string
	SSEPollInterval  time.Duration
	SSETimeout       time.Duration
	Now              func() time.Time
}

func DefaultConfig() Config {
	return Config{
		SSEPollInterval: 2 * time.Second,
		SSETimeout:      time.Hour,
		Now:             time.Now,
	}
}

func (cfg Config) normalized() Config {
	if cfg.SSEPollInterval <= 0 {
		cfg.SSEPollInterval = 2 * time.Second
	}
	if cfg.SSETimeout <= 0 {
		cfg.SSETimeout = time.Hour
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return cfg
}
