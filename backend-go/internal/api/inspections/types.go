package inspections

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

var (
	ErrProjectNotFound    = errors.New("project not found")
	ErrProjectForbidden   = errors.New("project forbidden")
	ErrPeriodNotFound     = errors.New("inspection period not found")
	ErrReportNotFound     = errors.New("inspection report not found")
	ErrScreenshotNotFound = errors.New("inspection screenshot not found")
	ErrConflict           = errors.New("inspection report conflict")
	ErrAuditUnavailable   = errors.New("audit service is not configured")
)

type BlobStore interface {
	Put(ctx context.Context, key string, data []byte, contentType string) (string, error)
	Delete(ctx context.Context, key string) error
}

type BlobURLResolver interface {
	Presign(ctx context.Context, key string) (string, error)
}

type HealthData struct {
	AccountHealthRating      *string  `json:"account_health_rating"`
	NegativeFeedback         *int     `json:"negative_feedback"`
	A2ZClaims                *int     `json:"a2z_claims"`
	ChargebackClaims         *int     `json:"chargeback_claims"`
	LateShipmentRate         *float64 `json:"late_shipment_rate"`
	PreFulfillmentCancelRate *float64 `json:"pre_fulfillment_cancel_rate"`
	ValidTrackingRate        *float64 `json:"valid_tracking_rate"`
	OnTimeDeliveryRate       *float64 `json:"on_time_delivery_rate"`
}

type ComplianceData struct {
	IPInfringement                *int `json:"ip_infringement"`
	IPComplaints                  *int `json:"ip_complaints"`
	ProductAuthenticityComplaints *int `json:"product_authenticity_complaints"`
	ProductConditionComplaints    *int `json:"product_condition_complaints"`
	FoodProductSafety             *int `json:"food_product_safety"`
	ListingPolicyViolations       *int `json:"listing_policy_violations"`
	RestrictedProductViolations   *int `json:"restricted_product_violations"`
	ReviewPolicyViolations        *int `json:"review_policy_violations"`
	OtherPolicyViolations         *int `json:"other_policy_violations"`
	RegulatoryCompliance          *int `json:"regulatory_compliance"`
}

type TemplateField struct {
	Key                string   `json:"key"`
	Label              string   `json:"label"`
	LabelEN            string   `json:"label_en"`
	Type               string   `json:"type"`
	Unit               *string  `json:"unit"`
	Options            []string `json:"options"`
	ThresholdWarning   *float64 `json:"threshold_warning"`
	ThresholdCritical  *float64 `json:"threshold_critical"`
	ThresholdDirection *string  `json:"threshold_direction"`
}

type TemplateResponse struct {
	HealthFields              []TemplateField `json:"health_fields"`
	ServicePerformanceFields  []TemplateField `json:"service_performance_fields"`
	ShippingPerformanceFields []TemplateField `json:"shipping_performance_fields"`
	ComplianceFields          []TemplateField `json:"compliance_fields"`
}

type Period struct {
	ID        int64  `json:"id"`
	WeekStart string `json:"week_start"`
	WeekEnd   string `json:"week_end"`
	Deadline  string `json:"deadline"`
	CreatedAt string `json:"created_at"`
}

type PeriodListResponse struct {
	Items []Period `json:"items"`
	Total int64    `json:"total"`
}

type ScreenshotItem struct {
	ID           int64   `json:"id"`
	R2Key        string  `json:"r2_key"`
	ThumbnailKey *string `json:"-"`
	Filename     string  `json:"filename"`
	ContentType  string  `json:"content_type"`
	FileSize     int64   `json:"file_size"`
	Caption      *string `json:"caption"`
	SortOrder    int     `json:"sort_order"`
	URL          string  `json:"url"`
	ThumbnailURL *string `json:"thumbnail_url"`
	CreatedAt    string  `json:"created_at"`
}

type Report struct {
	ID             int64            `json:"id"`
	PeriodID       int64            `json:"period_id"`
	ProjectID      int64            `json:"project_id"`
	ProjectName    string           `json:"-"`
	Status         string           `json:"status"`
	HealthData     *HealthData      `json:"health_data"`
	ComplianceData *ComplianceData  `json:"compliance_data"`
	StatusSummary  *string          `json:"status_summary"`
	SubmittedBy    *string          `json:"submitted_by"`
	SubmittedAt    *string          `json:"submitted_at"`
	Screenshots    []ScreenshotItem `json:"screenshots"`
	CreatedAt      string           `json:"created_at"`
	UpdatedAt      string           `json:"updated_at"`
}

type ReportWriteInput struct {
	HealthDataSet     bool
	HealthData        *HealthData
	ComplianceDataSet bool
	ComplianceData    *ComplianceData
	StatusSummarySet  bool
	StatusSummary     *string
	ScreenshotIDsSet  bool
	ScreenshotIDs     []int64
}

func (input ReportWriteInput) AuditPayload() map[string]any {
	payload := make(map[string]any)
	if input.HealthDataSet {
		payload["health_data"] = input.HealthData
	}
	if input.ComplianceDataSet {
		payload["compliance_data"] = input.ComplianceData
	}
	if input.StatusSummarySet {
		payload["status_summary"] = input.StatusSummary
	}
	if input.ScreenshotIDsSet {
		payload["screenshot_ids"] = input.ScreenshotIDs
	}
	return payload
}

type ThresholdWarning struct {
	Metric    string  `json:"metric"`
	Value     any     `json:"value"`
	Threshold float64 `json:"threshold"`
	Severity  string  `json:"severity"`
	Message   string  `json:"message"`
}

type OverviewScreenshot struct {
	ID           int64   `json:"id"`
	URL          string  `json:"url"`
	ThumbnailURL *string `json:"thumbnail_url"`
	Caption      *string `json:"caption"`
	R2Key        string  `json:"-"`
	ThumbnailKey *string `json:"-"`
}

type OverviewItem struct {
	ProjectID           int64                `json:"project_id"`
	ProjectName         string               `json:"project_name"`
	Status              string               `json:"status"`
	AccountHealthRating *string              `json:"account_health_rating"`
	NegativeFeedback    *int                 `json:"negative_feedback"`
	A2ZClaims           *int                 `json:"a2z_claims"`
	ChargebackClaims    *int                 `json:"chargeback_claims"`
	LateShipmentRate    *float64             `json:"late_shipment_rate"`
	ValidTrackingRate   *float64             `json:"valid_tracking_rate"`
	OnTimeDeliveryRate  *float64             `json:"on_time_delivery_rate"`
	ComplianceTotal     *int                 `json:"compliance_total"`
	StatusSummary       *string              `json:"status_summary"`
	SubmittedBy         *string              `json:"submitted_by"`
	SubmittedAt         *string              `json:"submitted_at"`
	Screenshots         []OverviewScreenshot `json:"screenshots"`
}

type OverviewResponse struct {
	Period         Period         `json:"period"`
	Items          []OverviewItem `json:"items"`
	TotalProjects  int            `json:"total_projects"`
	SubmittedCount int            `json:"submitted_count"`
	OverdueCount   int            `json:"overdue_count"`
}

type HistoryScreenshot struct {
	ID           int64   `json:"id"`
	URL          string  `json:"url"`
	ThumbnailURL *string `json:"thumbnail_url"`
	Caption      *string `json:"caption"`
	R2Key        string  `json:"-"`
	ThumbnailKey *string `json:"-"`
}

type HistoryItem struct {
	ID                  int64               `json:"id"`
	PeriodID            int64               `json:"period_id"`
	WeekStart           string              `json:"week_start"`
	WeekEnd             string              `json:"week_end"`
	ProjectID           int64               `json:"project_id"`
	ProjectName         string              `json:"project_name"`
	Status              string              `json:"status"`
	AccountHealthRating *string             `json:"account_health_rating"`
	ComplianceTotal     *int                `json:"compliance_total"`
	StatusSummary       *string             `json:"status_summary"`
	SubmittedBy         *string             `json:"submitted_by"`
	SubmittedAt         *string             `json:"submitted_at"`
	Screenshots         []HistoryScreenshot `json:"screenshots"`
}

type HistoryResponse struct {
	Items []HistoryItem `json:"items"`
	Total int64         `json:"total"`
}

type HistoryFilter struct {
	PeriodID  *int64
	ProjectID *int64
	Limit     int
	Offset    int
	Operator  string
	IsAdmin   bool
}

type ScreenshotRecord struct {
	ID           int64
	ReportID     int64
	ProjectID    int64
	R2Key        string
	ThumbnailKey *string
	Filename     string
	ContentType  string
	FileSize     int64
	Caption      *string
	SortOrder    int
	CreatedAt    string
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

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	ListPeriods(ctx context.Context, limit, offset int) (PeriodListResponse, error)
	GetOrCreateCurrentPeriod(ctx context.Context) (Period, error)
	GetPeriod(ctx context.Context, periodID int64) (*Period, error)
	GetOverview(ctx context.Context, periodID int64, operator string, isAdmin bool) (*OverviewResponse, error)
	GetReport(ctx context.Context, periodID, projectID int64) (*Report, error)
	GetReportByID(ctx context.Context, reportID int64) (*Report, error)
	CreateOrUpdateReport(ctx context.Context, periodID, projectID int64, input ReportWriteInput) (*Report, error)
	SubmitReport(ctx context.Context, reportID int64, operator *string) (*Report, []ThresholdWarning, error)
	GetScreenshot(ctx context.Context, screenshotID int64) (*ScreenshotRecord, error)
	InsertScreenshot(ctx context.Context, input InsertScreenshotInput) (*ScreenshotRecord, error)
	DeleteScreenshot(ctx context.Context, screenshotID int64) (bool, error)
	ListHistory(ctx context.Context, filter HistoryFilter) (HistoryResponse, error)
}

type TransactionRunner interface {
	RunInTx(
		ctx context.Context,
		fn func(context.Context, pgx.Tx, Store) error,
	) error
}

type RegistrarDependencies struct {
	Store   Store
	Blobs   BlobStore
	Auditor audit.Service
}
