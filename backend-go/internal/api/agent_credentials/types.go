package agent_credentials

import (
	"context"
	"errors"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

var (
	ErrAgentKeyExists          = errors.New("agent credential already has an active key")
	ErrAgentKeyNotFound        = errors.New("agent credential not found")
	ErrAgentProjectOutOfScope  = errors.New("project is outside the credential scope")
	ErrUploadTempNotFound      = errors.New("upload temp_file_id not found")
	ErrUploadTypeMismatch      = errors.New("report_type does not match recognized report")
	ErrUploadDependencyMissing = errors.New("report upload dependency is unavailable")
	ErrAuditUnavailable        = errors.New("audit service is unavailable")
	ErrIdempotencyConflict     = errors.New("Idempotency-Key was reused with a different request")
)

type AgentKey struct {
	ID            int64
	KeyPrefix     string
	Label         string
	Scope         string
	ProjectScope  string
	BusinessScope string
	AgentID       *string
	ItemKey       *string
	IsRevoked     bool
	ExpiresAt     *time.Time
	CreatedAt     time.Time
	LastUsedAt    *time.Time
	DeletedAt     *time.Time
}

type AgentKeyCreateInput struct {
	Label         string
	AgentID       string
	ProjectScope  string
	BusinessScope string
	ItemKey       *string
	ExpiresAt     *time.Time
}

type AgentKeyUpdateInput struct {
	Label         *string
	ProjectScope  *string
	BusinessScope *string
	ItemKey       *string
}

type Actor struct {
	AgentID string
	Name    string
}

type AgentKeyCreateRequest struct {
	Label         string     `json:"label"`
	AgentID       string     `json:"agent_id"`
	ProjectScope  string     `json:"project_scope"`
	BusinessScope string     `json:"business_scope"`
	ItemKey       *string    `json:"item_key"`
	ExpiresAt     *time.Time `json:"expires_at"`
}

type AgentKeyUpdateRequest struct {
	Label         *string `json:"label"`
	ProjectScope  *string `json:"project_scope"`
	BusinessScope *string `json:"business_scope"`
	ItemKey       *string `json:"item_key"`
}

type ProjectValidation struct {
	InvalidIDs   []int64
	AvailableIDs []int64
}

type AgentKeyItem struct {
	ID            int64   `json:"id"`
	KeyPrefix     string  `json:"key_prefix"`
	Label         string  `json:"label"`
	Scope         string  `json:"scope"`
	ProjectScope  string  `json:"project_scope"`
	BusinessScope string  `json:"business_scope"`
	AgentID       *string `json:"agent_id"`
	ItemKey       *string `json:"item_key"`
	IsRevoked     bool    `json:"is_revoked"`
	ExpiresAt     *string `json:"expires_at"`
	CreatedAt     string  `json:"created_at"`
	LastUsedAt    *string `json:"last_used_at"`
}

type AgentKeyCreateResponse struct {
	ID            int64   `json:"id"`
	KeyPrefix     string  `json:"key_prefix"`
	Label         string  `json:"label"`
	ProjectScope  string  `json:"project_scope"`
	BusinessScope string  `json:"business_scope"`
	AgentID       *string `json:"agent_id"`
	ItemKey       *string `json:"item_key"`
	ExpiresAt     *string `json:"expires_at"`
	PlaintextKey  string  `json:"plaintext_key"`
}

type AgentKeyUpdateResponse struct {
	ID            int64   `json:"id"`
	KeyPrefix     string  `json:"key_prefix"`
	Label         string  `json:"label"`
	Scope         string  `json:"scope"`
	ProjectScope  string  `json:"project_scope"`
	BusinessScope string  `json:"business_scope"`
	AgentID       *string `json:"agent_id"`
	ItemKey       *string `json:"item_key"`
	IsRevoked     bool    `json:"is_revoked"`
	ExpiresAt     *string `json:"expires_at"`
	CreatedAt     string  `json:"created_at"`
	LastUsedAt    *string `json:"last_used_at"`
}

type AgentUploadValidateRequest struct {
	Filename   string
	ReportType string
	Country    string
	Data       []byte
}

type AgentUploadValidateResponse struct {
	TempFileID          string   `json:"temp_file_id"`
	OriginalFilename    string   `json:"original_filename"`
	ReportType          string   `json:"report_type"`
	Status              string   `json:"status"`
	MatchedColumns      []string `json:"matched_columns"`
	MissingColumns      []string `json:"missing_columns"`
	ColumnMatchRatio    float64  `json:"column_match_ratio"`
	DetectedCountries   []string `json:"detected_countries"`
	PrimaryCountry      string   `json:"primary_country"`
	RowCountPreview     *int     `json:"row_count_preview"`
	DateInputMode       string   `json:"date_input_mode"`
	DetectedDate        *string  `json:"detected_date"`
	DetectedStartDate   *string  `json:"detected_start_date"`
	DetectedEndDate     *string  `json:"detected_end_date"`
	SuggestedReportType *string  `json:"suggested_report_type"`
	Warnings            []string `json:"warnings"`
}

type AgentUploadCommitRequest struct {
	TempFileID       string  `json:"temp_file_id"`
	ReportType       string  `json:"report_type"`
	OriginalFilename *string `json:"original_filename"`
	ProjectName      *string `json:"project_name"`
	ReportDate       *string `json:"report_date"`
	ReportStartDate  *string `json:"report_start_date"`
	ReportEndDate    *string `json:"report_end_date"`
	Country          string  `json:"country"`
	UsePeriodDates   bool    `json:"use_period_dates"`
	DryRun           bool    `json:"dry_run"`
}

type AgentUploadCommitResponse struct {
	ReportType        string                     `json:"report_type"`
	Status            string                     `json:"status"`
	ProjectName       *string                    `json:"project_name"`
	Country           string                     `json:"country"`
	ReportDate        *string                    `json:"report_date"`
	ReportStartDate   *string                    `json:"report_start_date"`
	ReportEndDate     *string                    `json:"report_end_date"`
	FileID            string                     `json:"file_id"`
	FilePath          string                     `json:"file_path"`
	PersistedSourceID *int64                     `json:"persisted_source_id"`
	PersistedTable    *string                    `json:"persisted_table"`
	Message           string                     `json:"message"`
	DuplicateWarnings []uploads.DuplicateWarning `json:"duplicate_warnings"`
	RowsIngested      *int                       `json:"rows_ingested"`
}

type KeyStore interface {
	ListAgentKeys(ctx context.Context) ([]AgentKey, error)
	CreateAgentKey(
		ctx context.Context,
		input AgentKeyCreateInput,
		actor Actor,
		auditEntry audit.Entry,
	) (*AgentKey, string, error)
	UpdateAgentKey(
		ctx context.Context,
		id int64,
		input AgentKeyUpdateInput,
		actor Actor,
		auditEntry audit.Entry,
	) (*AgentKey, error)
	ValidateProjects(ctx context.Context, ids []int64) (ProjectValidation, error)
	ActiveAgentKeyExists(ctx context.Context, agentID string) (bool, error)
	ProjectByName(ctx context.Context, name string) (id int64, active bool, err error)
}

type UploadStore interface {
	Validate(
		ctx context.Context,
		request AgentUploadValidateRequest,
	) (*AgentUploadValidateResponse, error)
	Commit(
		ctx context.Context,
		request AgentUploadCommitRequest,
		projectScope string,
	) (*AgentUploadCommitResponse, error)
}

type Options struct {
	Credentials  agentauth.CredentialStore
	ConfirmStore agentauth.ConfirmStore
	RateLimiter  agentauth.RateLimiter
	Auditor      audit.Service
	Idempotency  IdempotencyStore
	Now          func() time.Time
}
