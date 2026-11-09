package agent_inspection

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

const (
	ModuleName = "agent_inspection"

	DefaultReadRateRequests  = 300
	DefaultWriteRateRequests = 120

	MaxScreenshotBytes int64 = 10 * 1024 * 1024
	MaxJSONBodyBytes   int64 = 1 * 1024 * 1024
)

var (
	ErrPeriodNotFound        = errors.New("inspection period not found")
	ErrProjectNotFound       = errors.New("project not found")
	ErrReportNotFound        = errors.New("inspection report not found")
	ErrScreenshotNotFound    = errors.New("inspection screenshot not found")
	ErrReportState           = errors.New("inspection report state conflict")
	ErrIdempotencyConflict   = errors.New("idempotency key conflict")
	ErrDependencyUnavailable = errors.New("required dependency unavailable")
)

// ValidationError carries a stable agent error code for request-domain
// validation failures. It never includes internal implementation details.
type ValidationError struct {
	Code   string
	Detail string
}

func (e *ValidationError) Error() string {
	if e == nil {
		return "validation failed"
	}
	if e.Detail == "" {
		return e.Code
	}
	return e.Code + ": " + e.Detail
}

type Period struct {
	ID             int64  `json:"period_id"`
	WeekStart      string `json:"week_start"`
	WeekEnd        string `json:"week_end"`
	Deadline       string `json:"deadline"`
	SubmittedCount *int   `json:"submitted_count,omitempty"`
}

type PeriodPage struct {
	Items []Period `json:"items"`
	Total int64    `json:"total"`
}

type PeriodListFilter struct {
	Limit     int
	Offset    int
	Countries []string
}

type Project struct {
	ID      int64
	Name    string
	Country string
}

type Report struct {
	ID              int64
	PeriodID        int64
	ProjectID       int64
	ProjectName     string
	ProjectCountry  string
	Country         string
	Status          string
	HealthData      map[string]any
	ComplianceData  map[string]any
	StatusSummary   *string
	SubmittedBy     *string
	SubmittedAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
	ScreenshotCount int
}

type ReportPatch struct {
	HealthDataSet     bool
	HealthData        map[string]any
	ComplianceDataSet bool
	ComplianceData    map[string]any
	StatusSummarySet  bool
	StatusSummary     *string
}

type UpsertReportInput struct {
	PeriodID  int64
	ProjectID int64
	Country   string
	Patch     ReportPatch
}

type ThresholdWarning struct {
	Metric    string `json:"metric"`
	Value     any    `json:"value"`
	Threshold any    `json:"threshold"`
	Severity  string `json:"severity"`
	Message   string `json:"message"`
}

type OverviewFilter struct {
	PeriodID    int64
	Countries   []string
	AllProjects bool
	ProjectIDs  []int64
	Now         time.Time
}

type AccountHealthRow struct {
	PeriodID                      int64    `json:"period_id"`
	WeekStart                     string   `json:"week_start"`
	WeekEnd                       string   `json:"week_end"`
	ProjectID                     int64    `json:"project_id"`
	ProjectName                   string   `json:"project_name"`
	Country                       string   `json:"country"`
	Status                        string   `json:"status"`
	SubmittedAt                   *string  `json:"submitted_at"`
	AccountHealthRating           *string  `json:"account_health_rating"`
	NegativeFeedback              *int     `json:"negative_feedback"`
	A2ZClaims                     *int     `json:"a2z_claims"`
	ChargebackClaims              *int     `json:"chargeback_claims"`
	LateShipmentRate              *float64 `json:"late_shipment_rate"`
	PreFulfillmentCancelRate      *float64 `json:"pre_fulfillment_cancel_rate"`
	ValidTrackingRate             *float64 `json:"valid_tracking_rate"`
	OnTimeDeliveryRate            *float64 `json:"on_time_delivery_rate"`
	IPInfringement                *int     `json:"ip_infringement"`
	IPComplaints                  *int     `json:"ip_complaints"`
	ProductAuthenticityComplaints *int     `json:"product_authenticity_complaints"`
	ProductConditionComplaints    *int     `json:"product_condition_complaints"`
	FoodProductSafety             *int     `json:"food_product_safety"`
	ListingPolicyViolations       *int     `json:"listing_policy_violations"`
	RestrictedProductViolations   *int     `json:"restricted_product_violations"`
	ReviewPolicyViolations        *int     `json:"review_policy_violations"`
	OtherPolicyViolations         *int     `json:"other_policy_violations"`
	RegulatoryCompliance          *int     `json:"regulatory_compliance"`
	ComplianceTotal               *int     `json:"compliance_total"`
	ScreenshotCount               int      `json:"screenshot_count"`
}

type OverviewResult struct {
	Period         Period             `json:"period"`
	Items          []AccountHealthRow `json:"items"`
	TotalProjects  int                `json:"total_projects"`
	SubmittedCount int                `json:"submitted_count"`
	OverdueCount   int                `json:"overdue_count"`
}

type HistoryFilter struct {
	PeriodID    *int64
	ProjectID   *int64
	Limit       int
	Offset      int
	OrderBy     string
	OrderDir    string
	Countries   []string
	AllProjects bool
	ProjectIDs  []int64
}

type HistoryItem struct {
	PeriodID            int64   `json:"period_id"`
	WeekStart           string  `json:"week_start"`
	WeekEnd             string  `json:"week_end"`
	ProjectID           int64   `json:"project_id"`
	ProjectName         string  `json:"project_name"`
	Country             string  `json:"country"`
	Status              string  `json:"status"`
	AccountHealthRating *string `json:"account_health_rating"`
	ComplianceTotal     *int    `json:"compliance_total"`
	SubmittedAt         *string `json:"submitted_at"`
	ScreenshotCount     int     `json:"screenshot_count"`
}

type HistoryPage struct {
	Items []HistoryItem `json:"items"`
	Total int64         `json:"total"`
}

type Screenshot struct {
	ID           int64
	ReportID     int64
	PeriodID     int64
	ProjectID    int64
	ProjectName  string
	WeekStart    string
	R2Key        string
	ThumbnailKey *string
	Filename     string
	ContentType  string
	FileSize     int64
	Caption      *string
	SortOrder    int
	CreatedAt    time.Time
}

type InsertScreenshotInput struct {
	ReportID     int64
	R2Key        string
	ThumbnailKey *string
	Filename     string
	ContentType  string
	FileSize     int64
	Caption      *string
}

// AuditEntry is the domain-local audit payload. The PostgreSQL store writes it
// in the same transaction as the business mutation, avoiding a dependency
// cycle through the shared HTTP server audit package.
type AuditEntry struct {
	Action         string
	TargetType     string
	TargetID       *string
	BeforeJSON     any
	AfterJSON      any
	AgentID        *string
	AgentName      *string
	IdempotencyKey *string
	TraceID        *string
	RequestMethod  *string
	RequestPath    *string
	IPAddress      *string
	UserAgent      *string
}

type RunSummary struct {
	TotalNeedsReply         int `json:"total_needs_reply"`
	TotalReportedUnresolved int `json:"total_reported_unresolved"`
	ShopsWithPending        int `json:"shops_with_pending"`
}

type ShopMetrics struct {
	NeedsReply         int `json:"needs_reply"`
	ReportedUnresolved int `json:"reported_unresolved"`
	ResolvedTotal      int `json:"resolved_total"`
	ResolvedToday      int `json:"resolved_today"`
}

type IdentityCheck struct {
	ExpectedAlias   *string  `json:"expected_alias"`
	ObservedAlias   *string  `json:"observed_alias"`
	ObservedCountry []string `json:"observed_country"`
	Verified        bool     `json:"verified"`
	Source          string   `json:"source"`
}

type ShopCheckInput struct {
	ProjectID     int64          `json:"project_id"`
	Country       string         `json:"country"`
	CheckStatus   string         `json:"check_status"`
	ErrorMessage  *string        `json:"error_message"`
	IdentityCheck *IdentityCheck `json:"identity_check"`
	Metrics       ShopMetrics    `json:"metrics"`
}

type Triage struct {
	Category  string `json:"category"`
	HasOrder  bool   `json:"has_order"`
	SummaryZH string `json:"summary_zh"`
}

type ComplaintInput struct {
	ProjectID        int64          `json:"project_id"`
	Country          string         `json:"country"`
	FirstMessageDate string         `json:"first_message_date"`
	MessageDate      string         `json:"message_date"`
	BuyerName        string         `json:"buyer_name"`
	Subject          string         `json:"subject"`
	MessageBody      string         `json:"message_body"`
	Triage           Triage         `json:"triage"`
	Order            map[string]any `json:"order"`
	SLA              map[string]any `json:"sla"`
	MessageCount     int            `json:"message_count"`
}

type ComplaintBatchInput struct {
	RunDate      string           `json:"run_date"`
	Trigger      string           `json:"trigger"`
	ShopsTotal   int              `json:"shops_total"`
	ShopsChecked int              `json:"shops_checked"`
	ShopsFailed  []string         `json:"shops_failed"`
	Summary      RunSummary       `json:"summary"`
	ShopChecks   []ShopCheckInput `json:"shop_checks"`
	Complaints   []ComplaintInput `json:"complaints"`
}

type ShopCheckResult struct {
	ShopCheckID int64  `json:"shop_check_id"`
	ProjectID   int64  `json:"project_id"`
	Country     string `json:"country"`
}

type ComplaintResult struct {
	ComplaintID      int64  `json:"complaint_id"`
	ProjectID        int64  `json:"project_id"`
	Country          string `json:"country"`
	BuyerName        string `json:"buyer_name"`
	FirstMessageDate string `json:"first_message_date"`
	MessageDate      string `json:"message_date"`
}

type ComplaintBatchResult struct {
	RunID          int64             `json:"run_id"`
	RunDate        string            `json:"run_date"`
	IdempotencyKey *string           `json:"idempotency_key"`
	ShopChecks     []ShopCheckResult `json:"shop_checks"`
	Complaints     []ComplaintResult `json:"complaints"`
}

// Store is the persistence surface used by the agent inspection domain.
// Mutating methods must run against the Store supplied by RunInTx so the data
// change and its audit row commit atomically.
type Store interface {
	ListPeriods(context.Context, PeriodListFilter) (PeriodPage, error)
	GetCurrentPeriod(context.Context, time.Time) (*Period, error)
	GetPeriod(context.Context, int64) (*Period, error)
	GetOverview(context.Context, OverviewFilter) (*OverviewResult, error)
	GetProject(context.Context, int64) (*Project, error)
	GetReport(context.Context, int64, int64, string) (*Report, error)
	ListHistory(context.Context, HistoryFilter) (HistoryPage, error)

	UpsertReport(context.Context, UpsertReportInput) (*Report, error)
	SubmitReport(context.Context, int64, string, time.Time) (*Report, []ThresholdWarning, error)

	GetScreenshot(context.Context, int64) (*Screenshot, error)
	LockScreenshot(context.Context, int64) (*Screenshot, error)
	GetScreenshotByIdempotency(context.Context, string, string, string) (*Screenshot, error)
	InsertScreenshot(context.Context, InsertScreenshotInput) (*Screenshot, error)
	DeleteScreenshot(context.Context, int64) (bool, error)

	ValidateComplaintBatch(context.Context, ComplaintBatchInput) error
	UpsertComplaintBatch(context.Context, ComplaintBatchInput, string) (ComplaintBatchResult, error)

	LogAudit(context.Context, pgx.Tx, AuditEntry) error
}

// TransactionRunner is implemented by the PostgreSQL store. Handlers fall
// back to the plain Store only for in-memory contract fakes.
type TransactionRunner interface {
	RunInTx(
		context.Context,
		func(context.Context, pgx.Tx, Store) error,
	) error
}

type BlobStore interface {
	Put(ctx context.Context, key string, data []byte, contentType string) (string, error)
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
}

type Options struct {
	ReadRateLimiter  agentauth.RateLimiter
	WriteRateLimiter agentauth.RateLimiter
	Now              func() time.Time
}

type Option func(*Options)

func WithReadRateLimiter(limiter agentauth.RateLimiter) Option {
	return func(options *Options) {
		options.ReadRateLimiter = limiter
	}
}

func WithWriteRateLimiter(limiter agentauth.RateLimiter) Option {
	return func(options *Options) {
		options.WriteRateLimiter = limiter
	}
}

func WithNow(now func() time.Time) Option {
	return func(options *Options) {
		if now != nil {
			options.Now = now
		}
	}
}

func NewOptions(options ...Option) Options {
	settings := Options{Now: time.Now}
	for _, option := range options {
		if option != nil {
			option(&settings)
		}
	}
	return settings
}
