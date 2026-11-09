package agent_review_tracking

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

const (
	ModuleName = "agent_review_tracking"

	DefaultSource            = "agent_review_tracking"
	DefaultReadRateRequests  = 300
	DefaultWriteRateRequests = 120

	MaxReviewsPerRun        = 500
	MaxIdempotencyKey       = 64
	MaxInt4                 = 2_147_483_647
	MaxBodyBytes      int64 = 16 * 1024 * 1024

	ErrorCodeReviewTrackingCaptureOutOfOrder = "REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER"
	ErrorCodeResourceNotFound                = "RESOURCE_NOT_FOUND"
)

var (
	FutureTolerance = 2 * time.Hour

	ErrResourceNotFound       = errors.New("review tracking target not found")
	ErrDependencyUnavailable  = errors.New("required dependency unavailable")
	ErrIdempotencyKeyConflict = errors.New("review tracking idempotency key conflict")
)

// APIError is serialized with the FastAPI agent error envelope.
type APIError struct {
	Status       int
	Code         string
	Reason       string
	HumanMessage string
	AgentHint    string
	Details      any
}

func (e *APIError) Error() string {
	if e == nil {
		return "agent review tracking API error"
	}
	if e.Reason != "" {
		return e.Code + ": " + e.Reason
	}
	if e.HumanMessage != "" {
		return e.Code + ": " + e.HumanMessage
	}
	return e.Code
}

type Date struct {
	time.Time
}

func (d Date) MarshalJSON() ([]byte, error) {
	return []byte(fmt.Sprintf("%q", d.Time.Format("2006-01-02"))), nil
}

func (d *Date) UnmarshalJSON(value []byte) error {
	if string(value) == "null" {
		return nil
	}
	text := string(value)
	if len(text) >= 2 && text[0] == '"' && text[len(text)-1] == '"' {
		text = text[1 : len(text)-1]
	}
	parsed, err := time.Parse("2006-01-02", text)
	if err != nil {
		return fmt.Errorf("review_date must use YYYY-MM-DD: %w", err)
	}
	d.Time = parsed
	return nil
}

type RatingInput struct {
	AverageRating    *float64    `json:"average_rating"`
	RatingCount      *int64      `json:"rating_count"`
	ReviewCount      *int64      `json:"review_count"`
	StarPercentages  *[]float64  `json:"star_percentages"`
	StarCounts       *[]int64    `json:"star_counts"`
	StarCountQuality StringField `json:"star_count_quality"`
}

// StringField distinguishes an omitted string from an explicit JSON null while
// keeping the request shape strict.
type StringField struct {
	Value string
	Set   bool
}

func (field *StringField) UnmarshalJSON(value []byte) error {
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return errors.New("value must be a string, not null")
	}
	var decoded string
	if err := json.Unmarshal(value, &decoded); err != nil {
		return err
	}
	field.Value = decoded
	field.Set = true
	return nil
}

type ReviewInput struct {
	ReviewKey        string  `json:"review_key"`
	IDConfidence     string  `json:"id_confidence"`
	Rating           *int    `json:"rating"`
	Title            *string `json:"title"`
	Body             *string `json:"body"`
	ReviewerID       *string `json:"reviewer_id"`
	ReviewerName     *string `json:"reviewer_name"`
	ReviewDate       *Date   `json:"review_date"`
	VerifiedPurchase *bool   `json:"verified_purchase"`
	HelpfulCount     *int64  `json:"helpful_count"`
}

type CrawlRunInput struct {
	CapturedAt     time.Time      `json:"captured_at"`
	Status         string         `json:"status"`
	Rating         *RatingInput   `json:"rating"`
	Reviews        *[]ReviewInput `json:"reviews"`
	IsCompleteList BoolField      `json:"is_complete_list"`
	IdempotencyKey *string        `json:"idempotency_key"`
	ASINScraped    *string        `json:"asin_scraped"`
	ErrorMessage   *string        `json:"error_message"`
	Source         *string        `json:"source"`
}

type BoolField struct {
	Value bool
	Set   bool
}

func (field *BoolField) UnmarshalJSON(value []byte) error {
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return errors.New("value must be a boolean, not null")
	}
	var decoded bool
	if err := json.Unmarshal(value, &decoded); err != nil {
		return err
	}
	field.Value = decoded
	field.Set = true
	return nil
}

type RatingCapture struct {
	AverageRating    *float64
	RatingCount      *int64
	ReviewCount      *int64
	StarPercentages  []float64
	StarCounts       []int64
	StarCountQuality string
}

type ReviewCapture struct {
	ReviewKey        string
	IDConfidence     string
	Rating           *int
	Title            *string
	Body             *string
	ReviewerID       *string
	ReviewerName     *string
	ReviewDate       *Date
	VerifiedPurchase *bool
	HelpfulCount     *int64
}

type CrawlResultInput struct {
	TargetID       int64
	CapturedAt     time.Time
	Status         string
	Rating         *RatingCapture
	Reviews        *[]ReviewCapture
	IsCompleteList bool
	IdempotencyKey *string
	ASINScraped    *string
	Source         *string
	ErrorMessage   *string
}

type CrawlResult struct {
	TargetID                int64
	RunID                   int64
	Status                  string
	StartedAt               time.Time
	SnapshotUpdated         bool
	ReviewsUpserted         int
	ReviewsSuspectedRemoved int
	Replayed                bool
}

type CrawlRun struct {
	ID             int64
	TargetID       int64
	IdempotencyKey *string
	Status         string
	StartedAt      time.Time
}

type Target struct {
	ID          int64
	Kind        string
	GroupID     *int64
	ProjectID   *int64
	Marketplace string
	ASIN        *string
	DisplayName *string
	IsActive    bool
}

type LastRun struct {
	RunID     int64  `json:"run_id"`
	Status    string `json:"status"`
	StartedAt string `json:"started_at"`
}

type TargetItem struct {
	TargetID        int64    `json:"target_id"`
	Kind            string   `json:"kind"`
	GroupID         *int64   `json:"group_id"`
	ProjectID       *int64   `json:"project_id"`
	Marketplace     string   `json:"marketplace"`
	ASIN            *string  `json:"asin"`
	DisplayName     *string  `json:"display_name"`
	ExternalShopIDs []int64  `json:"external_shop_ids"`
	LastRun         *LastRun `json:"last_run"`
}

type TargetPage struct {
	Items []TargetItem
	Total int64
}

type TargetListFilter struct {
	ScopeAll    bool
	ProjectIDs  []int64
	ProjectID   *int64
	Marketplace *string
	Kind        *string
	Limit       int
	Offset      int
}

type TargetsResponse struct {
	Items      []TargetItem `json:"items"`
	Total      int64        `json:"total"`
	CrawlRules CrawlRules   `json:"crawl_rules"`
}

type CrawlRules struct {
	SchemaVersion              int              `json:"schema_version"`
	BusinessTimezone           string           `json:"business_timezone"`
	SnapshotGranularity        string           `json:"snapshot_granularity"`
	RemovalRule                RemovalRule      `json:"removal_rule"`
	Idempotency                IdempotencyRules `json:"idempotency"`
	MaxReviewsPerRun           int              `json:"max_reviews_per_run"`
	MaxCapturedAtFutureSeconds int64            `json:"max_captured_at_future_seconds"`
	MaxCountValue              int64            `json:"max_count_value"`
	StatusValues               []string         `json:"status_values"`
	StarCountQualityValues     []string         `json:"star_count_quality_values"`
	IDConfidenceValues         []string         `json:"id_confidence_values"`
	Notes                      []string         `json:"notes"`
}

type RemovalRule struct {
	RequiresStatus       string `json:"requires_status"`
	RequiresCompleteList bool   `json:"requires_complete_list"`
	ConsecutiveMisses    int    `json:"consecutive_misses"`
}

type IdempotencyRules struct {
	KeyScope  string `json:"key_scope"`
	MaxLength int    `json:"max_length"`
}

type SubmitCrawlResponse struct {
	TargetID                int64  `json:"target_id"`
	RunID                   int64  `json:"run_id"`
	Status                  string `json:"status"`
	CaptureDate             string `json:"capture_date"`
	SnapshotUpdated         bool   `json:"snapshot_updated"`
	ReviewsUpserted         int    `json:"reviews_upserted"`
	ReviewsSuspectedRemoved int    `json:"reviews_suspected_removed"`
	Replayed                bool   `json:"replayed"`
}

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

type Store interface {
	ListTargets(context.Context, TargetListFilter) (TargetPage, error)
	GetTargetForUpdate(context.Context, int64) (*Target, error)
	FindRunByIdempotency(context.Context, int64, *string) (*CrawlRun, error)
	LatestStartedAt(context.Context, int64, time.Time) (*time.Time, error)
	InsertCrawlResult(context.Context, CrawlResultInput) (CrawlResult, error)
	LogAudit(context.Context, pgx.Tx, AuditEntry) error
}

type TransactionRunner interface {
	RunInTx(
		context.Context,
		func(context.Context, pgx.Tx, Store) error,
	) error
}

type Options struct {
	Credentials      agentauth.CredentialStore
	ReadRateLimiter  agentauth.RateLimiter
	WriteRateLimiter agentauth.RateLimiter
	Now              func() time.Time
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

type Option func(*Options)

func WithCredentials(credentials agentauth.CredentialStore) Option {
	return func(options *Options) {
		options.Credentials = credentials
	}
}

func WithNow(now func() time.Time) Option {
	return func(options *Options) {
		if now != nil {
			options.Now = now
		}
	}
}

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

func NewRegistrarWithOptions(store Store, options ...Option) *Registrar {
	settings := NewOptions(options...)
	return NewRegistrar(store, settings)
}

func CrawlRulesValue() CrawlRules {
	return CrawlRules{
		SchemaVersion:       1,
		BusinessTimezone:    "Asia/Shanghai",
		SnapshotGranularity: "one_per_target_per_business_date",
		RemovalRule: RemovalRule{
			RequiresStatus:       "success",
			RequiresCompleteList: true,
			ConsecutiveMisses:    2,
		},
		Idempotency: IdempotencyRules{
			KeyScope:  "per_target",
			MaxLength: MaxIdempotencyKey,
		},
		MaxReviewsPerRun:           MaxReviewsPerRun,
		MaxCapturedAtFutureSeconds: int64(FutureTolerance / time.Second),
		MaxCountValue:              MaxInt4,
		StatusValues:               []string{"success", "partial", "failed"},
		StarCountQualityValues:     []string{"exact", "estimated", "unavailable"},
		IDConfidenceValues:         []string{"original", "derived"},
		Notes: []string{
			"失败（status=failed）只落运行记录，不写评分快照与评论",
			"评分与评论分开处理：本次没有抓到评论也要提交已取得的评分快照",
			"1–5 星百分比是页面原始比例，不能据此声称精确星数",
			"同一目标同一业务日期只有一份快照，同日重试更新当天快照并保留每次运行记录",
			"captured_at 不能晚于服务器当前时间 2 小时：超限按客户端时钟/时区标错拒绝，不会写入快照或抬高风险水位",
			"计数类字段（评分数/评论数/星数/helpful）上限 2147483647，超限 400 而不是 500",
		},
	}
}

func BusinessLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err == nil {
		return location
	}
	return time.FixedZone("Asia/Shanghai", 8*60*60)
}

func BusinessDate(value time.Time) time.Time {
	return value.In(BusinessLocation())
}

func BusinessDateString(value time.Time) string {
	return BusinessDate(value).Format("2006-01-02")
}

func stringPtr(value string) *string {
	return &value
}
