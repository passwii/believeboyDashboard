package agent_monthly_reports

import (
	"context"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const ModuleName = "agent_monthly_reports"

const (
	businessScope       = "monthly_reports"
	confirmAction       = "monthly_reports.confirm"
	agentMonthlyCSVKind = "transaction_csv"
	agentMonthlyPDFKind = "summary_pdf"
)

type Store interface {
	ListAgentMonthlyReports(
		ctx context.Context,
		filter store.AgentMonthlyReportListFilter,
	) ([]store.AgentMonthlyReportItem, error)
	GetAgentMonthlyReport(
		ctx context.Context,
		reportID int64,
	) (*store.AgentMonthlyReportDetail, error)
	ExportAgentMonthlyReport(
		ctx context.Context,
		reportID int64,
		entry audit.Entry,
	) (*store.AgentMonthlyStoredFile, error)
	GetAgentMonthlyReportProjectID(
		ctx context.Context,
		reportID int64,
	) (int64, error)
	GetAgentMonthlyFinancialSeries(
		ctx context.Context,
		filter store.AgentMonthlyFinancialSeriesFilter,
	) (*store.AgentMonthlyFinancialSeriesResponse, error)
	GetAgentMonthlyAccountingDetail(
		ctx context.Context,
		filter store.AgentMonthlyAccountingFilter,
	) (*store.AgentMonthlyFinancialAccountingDetailResponse, error)
	ExportAgentMonthlyAccountingDetail(
		ctx context.Context,
		filter store.AgentMonthlyAccountingFilter,
		entry audit.Entry,
	) (*store.AgentMonthlyFileResult, error)
	GetAgentMonthlyReconciliationHistory(
		ctx context.Context,
		reportID int64,
		limit int,
		offset int,
	) (*store.AgentMonthlyReconciliationHistory, error)
	AutoReconcileAgentMonthlyReport(
		ctx context.Context,
		input store.AgentMonthlyAutoReconcileInput,
		entry audit.Entry,
	) (map[string]any, error)
	ManualReconcileAgentMonthlyReport(
		ctx context.Context,
		input store.AgentMonthlyManualReconcileInput,
		entry audit.Entry,
	) (map[string]any, error)

	CreateAgentMonthlyUpload(
		ctx context.Context,
		input store.AgentMonthlyUploadCreateInput,
		entry audit.Entry,
	) (*store.AgentMonthlyUpload, error)
	GetAgentMonthlyUpload(
		ctx context.Context,
		uploadID int64,
		agentKeyID int64,
	) (*store.AgentMonthlyUpload, error)
	UploadAgentMonthlyFile(
		ctx context.Context,
		input store.AgentMonthlyUploadFileInput,
		entry audit.Entry,
	) (*store.AgentMonthlyUploadedFile, error)
	CreateAgentMonthlyBuild(
		ctx context.Context,
		input store.AgentMonthlyBuildCreateInput,
		entry audit.Entry,
	) (*store.AgentMonthlyBuild, bool, error)
	GetAgentMonthlyBuild(
		ctx context.Context,
		buildID int64,
		agentKeyID int64,
	) (*store.AgentMonthlyBuild, error)
	GetAgentMonthlyBuildPreview(
		ctx context.Context,
		buildID int64,
		agentKeyID int64,
	) (*store.AgentMonthlyBuildPreview, error)
	GetAgentMonthlyBuildResult(
		ctx context.Context,
		buildID int64,
		agentKeyID int64,
	) (*store.AgentMonthlyStoredFile, error)
	MarkAgentMonthlyBuildDispatchFailed(
		ctx context.Context,
		buildID int64,
	) error
	ConfirmAgentMonthlyBuild(
		ctx context.Context,
		input store.AgentMonthlyBuildConfirmInput,
		entry audit.Entry,
	) (*store.AgentMonthlyConfirmResult, error)
	GetAgentMonthlyConfirmReplay(
		ctx context.Context,
		input store.AgentMonthlyBuildConfirmInput,
	) (*store.AgentMonthlyConfirmResult, error)

	ClaimAgentMonthlyBuild(
		ctx context.Context,
		buildID int64,
	) (*store.AgentMonthlyBuildClaim, error)
	CompleteAgentMonthlyBuild(
		ctx context.Context,
		buildID int64,
		result store.MonthlyReportComputedResult,
	) error
	FailAgentMonthlyBuild(
		ctx context.Context,
		buildID int64,
		reason string,
	) error
}

type BuildDispatcher interface {
	EnqueueBuild(ctx context.Context, buildID int64) error
}

type Options struct {
	Credentials  agentauth.CredentialStore
	ConfirmStore agentauth.ConfirmStore
	ReadLimiter  agentauth.RateLimiter
	WriteLimiter agentauth.RateLimiter
	Dispatcher   BuildDispatcher
	Now          func() time.Time
	MaxFileBytes int64
	UploadTTL    time.Duration
}

type MonthlyReportItem struct {
	ID                 int64   `json:"id"`
	ProjectID          int64   `json:"project_id"`
	ProjectName        string  `json:"project_name"`
	Country            string  `json:"country"`
	ReportMonth        string  `json:"report_month"`
	Version            int     `json:"version"`
	IsCurrent          bool    `json:"is_current"`
	SupersededAt       *string `json:"superseded_at"`
	Status             string  `json:"status"`
	SettlementID       *string `json:"settlement_id"`
	TotalTransactions  int     `json:"total_transactions"`
	TotalOrders        int     `json:"total_orders"`
	TotalRefunds       int     `json:"total_refunds"`
	TotalAdjustments   int     `json:"total_adjustments"`
	TotalServiceFees   int     `json:"total_service_fees"`
	TotalTransFees     int     `json:"total_trans_fees"`
	ResultFilePath     *string `json:"result_file_path"`
	ErrorMessage       *string `json:"error_message"`
	CalculationVersion int     `json:"calculation_version"`
	ComputedAt         *string `json:"computed_at"`
	CreatedAt          *string `json:"created_at"`
	UpdatedAt          *string `json:"updated_at"`
}

type MonthlyReportDetail struct {
	Report MonthlyReportItem  `json:"report"`
	PT3    map[string]float64 `json:"pt3"`
	PT4    map[string]float64 `json:"pt4"`
}

type UploadCreateRequest struct {
	ProjectID   int64  `json:"project_id"`
	Country     string `json:"country"`
	ReportMonth string `json:"report_month"`
}

type BuildCreateRequest struct {
	UploadID          int64   `json:"upload_id"`
	TransactionFileID string  `json:"transaction_file_id"`
	SummaryPDFFileID  *string `json:"summary_pdf_file_id"`
}

type uploadCreateResponse struct {
	UploadID     int64    `json:"upload_id"`
	ProjectID    int64    `json:"project_id"`
	ProjectName  string   `json:"project_name"`
	Country      string   `json:"country"`
	ReportMonth  string   `json:"report_month"`
	Status       string   `json:"status"`
	ExpiresAt    string   `json:"expires_at"`
	MaxFileBytes int64    `json:"max_file_bytes"`
	AllowedKinds []string `json:"allowed_kinds"`
}

type uploadFileResponse struct {
	UploadID         int64          `json:"upload_id"`
	FileID           string         `json:"file_id"`
	Kind             string         `json:"kind"`
	OriginalFilename string         `json:"original_filename"`
	SHA256           string         `json:"sha256"`
	Bytes            int64          `json:"bytes"`
	Validation       map[string]any `json:"validation"`
}

type buildStatusResponse struct {
	BuildID                 int64   `json:"build_id"`
	UploadID                int64   `json:"upload_id"`
	Status                  string  `json:"status"`
	ProjectID               int64   `json:"project_id"`
	ProjectName             string  `json:"project_name"`
	Country                 string  `json:"country"`
	ReportMonth             string  `json:"report_month"`
	InputSHA256             string  `json:"input_sha256"`
	CalculationVersion      *int    `json:"calculation_version"`
	ReportID                *int64  `json:"report_id"`
	ConfirmedAt             *string `json:"confirmed_at"`
	ErrorMessage            *string `json:"error_message"`
	ExpiresAt               string  `json:"expires_at"`
	ExistingSuccessReportID *int64  `json:"existing_success_report_id"`
	CreatedAt               string  `json:"created_at"`
	UpdatedAt               string  `json:"updated_at"`
}

type buildPreviewResponse struct {
	BuildID              int64             `json:"build_id"`
	ProjectID            int64             `json:"project_id"`
	ProjectName          string            `json:"project_name"`
	Country              string            `json:"country"`
	ReportMonth          string            `json:"report_month"`
	InputSHA256          string            `json:"input_sha256"`
	CalculationVersion   *int              `json:"calculation_version"`
	TransactionsCount    int               `json:"transactions_count"`
	PT3                  map[string]string `json:"pt3"`
	PT4                  map[string]string `json:"pt4"`
	ExpiresAt            string            `json:"expires_at"`
	RequiresConfirmation bool              `json:"requires_confirmation"`
}

type confirmationPreview struct {
	BuildID              int64   `json:"build_id"`
	ProjectID            int64   `json:"project_id"`
	ProjectName          string  `json:"project_name"`
	Country              string  `json:"country"`
	ReportMonth          string  `json:"report_month"`
	TransactionsCount    int     `json:"transactions_count"`
	InputSHA256          string  `json:"input_sha256"`
	SummaryPDFIncluded   bool    `json:"summary_pdf_included"`
	CalculationVersion   *int    `json:"calculation_version"`
	ExistingReportID     *int64  `json:"existing_report_id"`
	ExistingReportStatus *string `json:"existing_report_status"`
	WillConflict         bool    `json:"will_conflict"`
	ExpiresAt            string  `json:"expires_at"`
}

func defaultNow() func() time.Time {
	return time.Now
}

func defaultMaxFileBytes() int64 {
	return 50 * 1024 * 1024
}

func defaultUploadTTL() time.Duration {
	return 24 * time.Hour
}

func defaultReadRateLimit() agentauth.RateLimit {
	return agentauth.RateLimit{Requests: 240, Window: time.Minute}
}

func defaultWriteRateLimit() agentauth.RateLimit {
	return agentauth.RateLimit{Requests: 30, Window: time.Minute}
}
