package scheduled_reports

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

const (
	MaxProjectIDs = 100

	FrequencyDaily   = "daily"
	FrequencyWeekly  = "weekly"
	FrequencyMonthly = "monthly"

	StatusSent    = "sent"
	StatusFailed  = "failed"
	StatusMissing = "missing"
)

var (
	ErrProjectNotFound       = errors.New("项目不存在")
	ErrProjectForbidden      = errors.New("无权限访问该项目")
	ErrSubscriptionNotFound  = errors.New("subscription not found")
	ErrLedgerNotFound        = errors.New("ledger entry not found")
	ErrAlreadySent           = errors.New("ledger entry already sent")
	ErrMissingDeliveryLog    = errors.New("delivery log missing")
	ErrDeliveryNotSent       = errors.New("delivery not sent")
	ErrMailerNotConfigured   = errors.New("test report mailer not configured")
	ErrEnqueuerNotConfigured = errors.New("scheduled report enqueuer not configured")
	ErrAuditNotConfigured    = errors.New("scheduled report auditor not configured")
	ErrIdempotencyConflict   = errors.New("idempotency key reused with a different request")
	ErrIDempotencyConflict   = ErrIdempotencyConflict
)

type Optional[T any] struct {
	Set   bool
	Value *T
}

func (optional *Optional[T]) UnmarshalJSON(data []byte) error {
	optional.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		optional.Value = nil
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	optional.Value = &value
	return nil
}

func (optional Optional[T]) Get() (T, bool) {
	var zero T
	if optional.Value == nil {
		return zero, false
	}
	return *optional.Value, true
}

type Subscription struct {
	ID              int64   `json:"id"`
	UserID          *int    `json:"user_id"`
	Email           *string `json:"email"`
	ProjectIDs      string  `json:"project_ids"`
	Country         string  `json:"country"`
	Frequency       string  `json:"frequency"`
	DispatchHour    int     `json:"dispatch_hour"`
	DispatchMinute  int     `json:"dispatch_minute"`
	DispatchWeekday *int    `json:"dispatch_weekday"`
	DispatchDay     *int    `json:"dispatch_day"`
	AIModel         *string `json:"ai_model"`
	Enabled         bool    `json:"enabled"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}

type SubscriptionListResponse struct {
	Items []Subscription `json:"items"`
	Total int            `json:"total"`
}

type SubscriptionCreateRequest struct {
	Email           *string `json:"email"`
	ProjectIDs      string  `json:"project_ids"`
	Country         string  `json:"country"`
	Frequency       string  `json:"frequency"`
	DispatchHour    *int    `json:"dispatch_hour"`
	DispatchMinute  *int    `json:"dispatch_minute"`
	DispatchWeekday *int    `json:"dispatch_weekday"`
	DispatchDay     *int    `json:"dispatch_day"`
	AIModel         *string `json:"ai_model"`
}

type SubscriptionCreateInput struct {
	UserID          *int
	Email           *string
	ProjectIDs      string
	Country         string
	Frequency       string
	DispatchHour    int
	DispatchMinute  int
	DispatchWeekday *int
	DispatchDay     *int
	AIModel         *string
}

type SubscriptionUpdateRequest struct {
	Email           Optional[string] `json:"email"`
	ProjectIDs      Optional[string] `json:"project_ids"`
	Country         Optional[string] `json:"country"`
	Frequency       Optional[string] `json:"frequency"`
	DispatchHour    Optional[int]    `json:"dispatch_hour"`
	DispatchMinute  Optional[int]    `json:"dispatch_minute"`
	DispatchWeekday Optional[int]    `json:"dispatch_weekday"`
	DispatchDay     Optional[int]    `json:"dispatch_day"`
	AIModel         Optional[string] `json:"ai_model"`
	Enabled         Optional[bool]   `json:"enabled"`
}

type SubscriptionPatch struct {
	Email           Optional[string]
	ProjectIDs      Optional[string]
	Country         Optional[string]
	Frequency       Optional[string]
	DispatchHour    Optional[int]
	DispatchMinute  Optional[int]
	DispatchWeekday Optional[int]
	DispatchDay     Optional[int]
	AIModel         Optional[string]
	Enabled         Optional[bool]
}

type DeliveryLog struct {
	ID                   int64   `json:"id"`
	SubscriptionID       int64   `json:"subscription_id"`
	Frequency            string  `json:"frequency"`
	ReportDate           string  `json:"report_date"`
	ReportMonth          *string `json:"report_month"`
	Email                *string `json:"email"`
	Status               string  `json:"status"`
	Stage                string  `json:"stage"`
	ErrorMessage         *string `json:"error_message"`
	SentAt               *string `json:"sent_at"`
	ScreenshotR2Key      *string `json:"screenshot_r2_key"`
	ScreenshotR2URL      *string `json:"screenshot_r2_url"`
	ScreenshotR2ThumbKey *string `json:"screenshot_r2_thumb_key"`
	ScreenshotR2ThumbURL *string `json:"screenshot_r2_thumb_url"`
	AISummary            *string `json:"ai_summary"`
	AISummaryStatus      string  `json:"ai_summary_status"`
	AISummaryError       *string `json:"ai_summary_error"`
	AISummaryModel       *string `json:"ai_summary_model"`
	InsightRunID         *string `json:"insight_run_id"`
	AISummaryUpdatedAt   *string `json:"ai_summary_updated_at"`
	CreatedAt            string  `json:"created_at"`
}

type DeliveryLogListResponse struct {
	Items []DeliveryLog `json:"items"`
	Total int           `json:"total"`
}

type TestEmailRequest struct {
	Email      string  `json:"email"`
	Frequency  string  `json:"frequency"`
	ProjectIDs string  `json:"project_ids"`
	Country    string  `json:"country"`
	AIModel    *string `json:"ai_model"`
}

type TestEmailMessage struct {
	Email      string  `json:"email"`
	Frequency  string  `json:"frequency"`
	ProjectIDs string  `json:"project_ids"`
	Country    string  `json:"country"`
	AIModel    *string `json:"ai_model"`
}

type TestEmailResponse struct {
	Success  bool    `json:"success"`
	Message  string  `json:"message"`
	ResendID *string `json:"resend_id"`
}

type TriggerReportResponse struct {
	Success               bool   `json:"success"`
	Frequency             string `json:"frequency"`
	SubscriptionsAffected int    `json:"subscriptions_affected"`
	Skipped               int    `json:"skipped"`
	Message               string `json:"message"`
}

type LedgerSummary struct {
	Expected   int `json:"expected"`
	Sent       int `json:"sent"`
	Failed     int `json:"failed"`
	Missing    int `json:"missing"`
	Resendable int `json:"resendable"`
}

type LedgerItem struct {
	ID                   int64    `json:"id"`
	LedgerKey            string   `json:"ledger_key"`
	ExpectedDate         string   `json:"expected_date"`
	ExpectedAt           string   `json:"expected_at"`
	Frequency            string   `json:"frequency"`
	SubscriptionID       int64    `json:"subscription_id"`
	Email                *string  `json:"email"`
	ProjectIDs           string   `json:"project_ids"`
	ProjectNames         []string `json:"project_names"`
	Country              string   `json:"country"`
	Status               string   `json:"status"`
	LatestDeliveryLogID  *int64   `json:"latest_delivery_log_id"`
	ErrorMessage         *string  `json:"error_message"`
	SentAt               *string  `json:"sent_at"`
	CanResend            bool     `json:"can_resend"`
	LastCheckedAt        string   `json:"last_checked_at"`
	ScreenshotR2URL      *string  `json:"screenshot_r2_url"`
	ScreenshotR2ThumbURL *string  `json:"screenshot_r2_thumb_url"`
	AISummary            *string  `json:"ai_summary"`
	AISummaryStatus      string   `json:"ai_summary_status"`
	AISummaryError       *string  `json:"ai_summary_error"`
	AISummaryModel       *string  `json:"ai_summary_model"`
	InsightRunID         *string  `json:"insight_run_id"`
	AISummaryUpdatedAt   *string  `json:"ai_summary_updated_at"`
}

type LedgerListResponse struct {
	Items   []LedgerItem  `json:"items"`
	Total   int           `json:"total"`
	Summary LedgerSummary `json:"summary"`
}

type LedgerResendResponse struct {
	Success       bool   `json:"success"`
	LedgerKey     string `json:"ledger_key"`
	DeliveryLogID *int64 `json:"delivery_log_id"`
	Status        string `json:"status"`
	Message       string `json:"message"`
}

type LedgerRegenerateSummaryResponse struct {
	Success       bool    `json:"success"`
	LedgerKey     string  `json:"ledger_key"`
	DeliveryLogID *int64  `json:"delivery_log_id"`
	Status        string  `json:"status"`
	InsightRunID  *string `json:"insight_run_id"`
	Message       string  `json:"message"`
}

type Scope struct {
	UserID   *int
	Operator string
	IsAdmin  bool
}

type LedgerQuery struct {
	StartDate string
	EndDate   string
	Frequency string
	Status    string
	ProjectID *int64
	Email     *string
	Limit     int
	Offset    int
	Scope     Scope
}

type ResendRequest struct {
	LedgerKey   string
	Force       bool
	OverrideAI  *string
	Idempotency string
}

type ResendResult struct {
	DeliveryLogID  *int64
	Status         string
	Message        string
	OldLogID       *int64
	AIModel        *string
	SubscriptionID int64
	Frequency      string
	Email          *string
	ProjectIDs     string
	Country        string
	ReportDate     string
	Reused         bool
}

type RegenerateRequest struct {
	LedgerKey   string
	OverrideAI  *string
	Idempotency string
}

type RegenerateResult struct {
	DeliveryLogID *int64
	Status        string
	InsightRunID  *string
	Message       string
	AIModel       *string
	Reused        bool
}

type IdempotencyRecord struct {
	Fingerprint string
	Response    json.RawMessage
}

type Store interface {
	RunInTx(ctx context.Context, fn func(context.Context, pgx.Tx, Store) error) error
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	ListSubscriptions(ctx context.Context, scope Scope, frequency *string) ([]Subscription, error)
	GetSubscription(ctx context.Context, subscriptionID int64) (*Subscription, error)
	CreateSubscription(ctx context.Context, input SubscriptionCreateInput) (*Subscription, error)
	UpdateSubscription(ctx context.Context, subscriptionID int64, patch SubscriptionPatch) (*Subscription, error)
	DeleteSubscription(ctx context.Context, subscriptionID int64) (bool, error)
	ListDeliveryLogs(ctx context.Context, scope Scope, status *string, limit, offset int) (DeliveryLogListResponse, error)
	RefreshLedger(ctx context.Context, query LedgerQuery) (LedgerListResponse, error)
	PrepareResend(ctx context.Context, request ResendRequest) (ResendResult, error)
	PrepareAISummaryRegeneration(ctx context.Context, request RegenerateRequest) (RegenerateResult, error)
	ListActiveSubscriptions(ctx context.Context, frequency string) ([]Subscription, error)
	AcquireTriggerLock(ctx context.Context, frequency string) error
	FindIdempotencyRecord(ctx context.Context, action, idempotencyKey string) (*IdempotencyRecord, error)
}

type EnqueueRequest struct {
	TaskType       string
	Payload        any
	IdempotencyKey string
}

type Enqueuer interface {
	Enqueue(ctx context.Context, request EnqueueRequest) (string, error)
}

type Runner interface {
	Run(ctx context.Context, request EnqueueRequest) (string, error)
}

type Mailer interface {
	SendTestReport(ctx context.Context, message TestEmailMessage) (*string, error)
}

type APIError struct {
	Status int
	Detail string
}

func (apiError *APIError) Error() string {
	return apiError.Detail
}

func NewAPIError(status int, detail string) error {
	return &APIError{Status: status, Detail: detail}
}

func ErrorStatus(err error) (int, string, bool) {
	var apiError *APIError
	if errors.As(err, &apiError) {
		return apiError.Status, apiError.Detail, true
	}
	switch {
	case errors.Is(err, ErrProjectNotFound):
		return http.StatusNotFound, ErrProjectNotFound.Error(), true
	case errors.Is(err, ErrProjectForbidden):
		return http.StatusForbidden, ErrProjectForbidden.Error(), true
	case errors.Is(err, ErrSubscriptionNotFound), errors.Is(err, ErrLedgerNotFound):
		return http.StatusNotFound, err.Error(), true
	case errors.Is(err, ErrAlreadySent), errors.Is(err, ErrMissingDeliveryLog), errors.Is(err, ErrDeliveryNotSent):
		return http.StatusConflict, err.Error(), true
	case errors.Is(err, ErrIdempotencyConflict):
		return http.StatusConflict, err.Error(), true
	case errors.Is(err, ErrAuditNotConfigured):
		return http.StatusServiceUnavailable, err.Error(), true
	}
	return 0, "", false
}
