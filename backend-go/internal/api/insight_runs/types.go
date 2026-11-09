package insight_runs

import (
	"context"
	"errors"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

const ModuleName = "insight_runs"

var (
	ErrRunNotFound           = errors.New("insight run not found")
	ErrIdempotencyConflict   = errors.New("idempotency key conflict")
	ErrInvalidRequest        = errors.New("invalid insight run request")
	ErrProjectNotFound       = errors.New("project not found")
	ErrProjectOutOfScope     = errors.New("project out of scope")
	ErrCountryMismatch       = errors.New("country mismatch")
	ErrRunTerminal           = errors.New("insight run is terminal")
	ErrInvalidTransition     = errors.New("invalid insight run state transition")
	ErrStreamUnavailable     = errors.New("insight stream transport unavailable")
	ErrProviderNotConfigured = errors.New("insight ai provider is not configured")
)

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) (ai_insight.ProjectInfo, error)
	CreateRun(ctx context.Context, input CreateRunInput, meta ai_insight.MutationMeta) (*Run, bool, error)
	GetRun(ctx context.Context, runID string) (*Run, error)
	CancelRun(ctx context.Context, runID string, meta ai_insight.MutationMeta) (*Run, bool, error)
	RetryRun(ctx context.Context, runID string, meta ai_insight.MutationMeta) (*Run, error)
	RecordStreamMetric(ctx context.Context, runID string, reconnect, reconnectCompleted bool) error
	LoadRunExecution(ctx context.Context, runID string) (*Run, error)
	RunTransition(ctx context.Context, runID string, attempt int, target string, stage string, progress int, usage *Usage, outputs map[string]Output, content *string, runErr *Error) (bool, error)
}

type CreateRunRequest struct {
	SchemaVersion   int            `json:"schema_version"`
	RoleID          string         `json:"role_id"`
	RoleVersion     int            `json:"role_version"`
	ProjectID       int64          `json:"project_id"`
	Country         string         `json:"country"`
	Slots           map[string]any `json:"slots"`
	IdempotencyKey  string         `json:"idempotency_key"`
	ClientRequestID *string        `json:"client_request_id"`
	EndpointID      *string        `json:"endpoint_id"`
	ModelID         *string        `json:"model_id"`
}

type CreateRunInput struct {
	RoleID         string
	RoleVersion    int
	ProjectID      int64
	Country        string
	Slots          map[string]any
	SlotsJSON      []byte
	IdempotencyKey string
	Fingerprint    string
	EndpointID     string
	ModelID        string
	Capability     string
	Operator       string
}

type Run struct {
	RunID              string
	Attempt            int
	Capability         string
	UseCase            string
	ProjectID          int64
	Country            string
	RoleID             string
	RoleVersion        int
	EndpointID         string
	ModelID            string
	Status             string
	Stage              string
	ProgressPercent    int
	IdempotencyKey     string
	RequestFingerprint string
	SlotsJSON          []byte
	StatusTimelineJSON []byte
	UsageJSON          []byte
	OutputsJSON        []byte
	ContentMarkdown    *string
	ErrorJSON          []byte
	DurationMS         *int
	CreatedAt          time.Time
	StartedAt          *time.Time
	CompletedAt        *time.Time
	UpdatedAt          time.Time
}

type Output struct {
	Format        string `json:"format"`
	Content       string `json:"content"`
	ContentSHA256 string `json:"content_sha256"`
}

type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

type Error struct {
	Code              string         `json:"code"`
	Message           string         `json:"message"`
	Retryable         bool           `json:"retryable"`
	RetryAfterSeconds *int           `json:"retry_after_seconds"`
	PartialAvailable  bool           `json:"partial_available"`
	Field             *string        `json:"field"`
	Slot              *string        `json:"slot"`
	Details           map[string]any `json:"details"`
}

type ResumeInfo struct {
	LatestEventID    *string `json:"latest_event_id"`
	CurrentAttempt   int     `json:"current_attempt"`
	HistoryAvailable bool    `json:"history_available"`
}

type RunResponse struct {
	SchemaVersion int       `json:"schema_version"`
	RunID         string    `json:"run_id"`
	Attempt       int       `json:"attempt"`
	RoleID        string    `json:"role_id"`
	RoleVersion   int       `json:"role_version"`
	ProjectID     int64     `json:"project_id"`
	Country       string    `json:"country"`
	Status        string    `json:"status"`
	OutputFormat  string    `json:"output_format"`
	DetailURL     string    `json:"detail_url"`
	StreamURL     string    `json:"stream_url"`
	CancelURL     string    `json:"cancel_url"`
	RetryURL      string    `json:"retry_url"`
	Replayed      bool      `json:"replayed"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type RunDetail struct {
	SchemaVersion   int               `json:"schema_version"`
	RunID           string            `json:"run_id"`
	Attempt         int               `json:"attempt"`
	RoleID          string            `json:"role_id"`
	RoleVersion     int               `json:"role_version"`
	ProjectID       int64             `json:"project_id"`
	Country         string            `json:"country"`
	Status          string            `json:"status"`
	Stage           string            `json:"stage"`
	ProgressPercent int               `json:"progress_percent"`
	OutputFormat    string            `json:"output_format"`
	Title           *string           `json:"title"`
	Outputs         map[string]Output `json:"outputs"`
	ArtifactID      *string           `json:"artifact_id"`
	Usage           *Usage            `json:"usage"`
	Error           *Error            `json:"error"`
	Resume          ResumeInfo        `json:"resume"`
	CreatedAt       time.Time         `json:"created_at"`
	StartedAt       *time.Time        `json:"started_at"`
	CompletedAt     *time.Time        `json:"completed_at"`
	UpdatedAt       time.Time         `json:"updated_at"`
}

type ActionResponse struct {
	SchemaVersion int    `json:"schema_version"`
	RunID         string `json:"run_id"`
	Attempt       int    `json:"attempt"`
	Status        string `json:"status"`
	DetailURL     string `json:"detail_url"`
	StreamURL     string `json:"stream_url"`
	Replayed      bool   `json:"replayed"`
}

type Event struct {
	SchemaVersion   int               `json:"schema_version"`
	RunID           string            `json:"run_id"`
	Attempt         int               `json:"attempt"`
	Seq             int               `json:"seq"`
	Type            string            `json:"type"`
	Status          string            `json:"status,omitempty"`
	Stage           string            `json:"stage,omitempty"`
	ProgressPercent *int              `json:"progress_percent,omitempty"`
	Detail          *string           `json:"detail,omitempty"`
	Outputs         map[string]Output `json:"outputs,omitempty"`
	IsTerminal      *bool             `json:"is_terminal,omitempty"`
	Error           *Error            `json:"error,omitempty"`
	Slot            string            `json:"slot,omitempty"`
	BlockID         string            `json:"block_id,omitempty"`
	Format          string            `json:"format,omitempty"`
	Delta           string            `json:"delta,omitempty"`
	Content         string            `json:"content,omitempty"`
	ContentSHA256   string            `json:"content_sha256,omitempty"`
	CheckpointSeq   int               `json:"checkpoint_seq,omitempty"`
	ArtifactID      *string           `json:"artifact_id,omitempty"`
	Title           *string           `json:"title,omitempty"`
	Usage           *Usage            `json:"usage,omitempty"`
}

type Cursor struct {
	RunID   string
	Attempt int
	Seq     int
}

type EventStore interface {
	Available(ctx context.Context) error
	Append(ctx context.Context, runID string, event Event) (Event, error)
	ReadAfter(ctx context.Context, runID string, cursor *Cursor) ([]Event, error)
	Reset(ctx context.Context, runID string) error
}

type Config struct {
	CanonicalDomains string
	SSEPollInterval  time.Duration
	SSETimeout       time.Duration
	StreamTTL        time.Duration
}

func DefaultConfig() Config {
	return Config{
		SSEPollInterval: time.Second,
		SSETimeout:      time.Hour,
		StreamTTL:       24 * time.Hour,
	}
}

func (cfg Config) normalized() Config {
	if cfg.SSEPollInterval <= 0 {
		cfg.SSEPollInterval = time.Second
	}
	if cfg.SSETimeout <= 0 {
		cfg.SSETimeout = time.Hour
	}
	if cfg.StreamTTL <= 0 {
		cfg.StreamTTL = 24 * time.Hour
	}
	return cfg
}

type Executor struct {
	store    Store
	provider ai.Provider
	events   EventStore
}

type RunExecutor interface {
	Execute(ctx context.Context, runID string, attempt int) error
}

func NewExecutor(store Store, provider ai.Provider, events EventStore) *Executor {
	return &Executor{store: store, provider: provider, events: events}
}

var _ RunExecutor = (*Executor)(nil)
