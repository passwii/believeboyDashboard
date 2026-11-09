package product_analysis

import (
	"context"
	"errors"
	"net/http"
	"time"
)

var (
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限访问该项目")
	ErrNotFound         = errors.New("记录不存在")
	ErrConflict         = errors.New("记录冲突")
	ErrInvalid          = errors.New("请求参数无效")
)

// StatusError lets the optional calculation engine return FastAPI-compatible
// HTTP status codes without coupling the engine to net/http.
type StatusError struct {
	Status int
	Detail string
}

func (e *StatusError) Error() string {
	if e == nil {
		return ""
	}
	return e.Detail
}

func (e *StatusError) Unwrap() error {
	switch e.Status {
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusForbidden:
		return ErrProjectForbidden
	case http.StatusConflict:
		return ErrConflict
	case http.StatusUnprocessableEntity, http.StatusBadRequest:
		return ErrInvalid
	default:
		return nil
	}
}

type Principal struct {
	Operator string
	IsAdmin  bool
}

// AnalysisSourceFileItem is the public projection of analysis_source_files and
// the compatible projection of ad_upload_files used by the product-analysis API.
type AnalysisSourceFileItem struct {
	ID               int64   `json:"id"`
	ProjectID        int64   `json:"project_id"`
	ReportType       string  `json:"report_type"`
	ReportDate       *string `json:"report_date"`
	PeriodStartDate  *string `json:"period_start_date"`
	PeriodEndDate    *string `json:"period_end_date"`
	SnapshotAt       *string `json:"snapshot_at"`
	Version          int     `json:"version"`
	IsCurrent        bool    `json:"is_current"`
	SupersededAt     *string `json:"superseded_at"`
	UploadFileID     string  `json:"upload_file_id"`
	UploadFilePath   string  `json:"upload_file_path"`
	OriginalFilename *string `json:"original_filename"`
	StoredFilename   string  `json:"stored_filename"`
	LogicalFilename  string  `json:"logical_filename"`
	StorageKey       string  `json:"storage_key"`
	FileSizeBytes    *int64  `json:"file_size_bytes"`
	FileSHA256       *string `json:"file_sha256"`
	IngestionStatus  string  `json:"ingestion_status"`
	IngestionError   *string `json:"ingestion_error"`
	RowCountTotal    int     `json:"row_count_total"`
	RowCountIncluded int     `json:"row_count_included"`
	CreatedBy        *string `json:"created_by"`
	CreatedAt        *string `json:"created_at"`
	UpdatedAt        *string `json:"updated_at"`

	SourceKind    string    `json:"-"`
	CreatedAtSort time.Time `json:"-"`
}

type SourceFilter struct {
	ProjectID       *int64
	ProjectIDs      []int64
	ReportType      *string
	PeriodStartDate *time.Time
	PeriodEndDate   *time.Time
	CurrentOnly     bool
}

type SourceRows struct {
	Source   AnalysisSourceFileItem `json:"source"`
	Page     int                    `json:"page"`
	PageSize int                    `json:"page_size"`
	HasNext  bool                   `json:"has_next"`
	Rows     []map[string]any       `json:"rows"`
}

type CurrentInventorySnapshot struct {
	Source AnalysisSourceFileItem `json:"source"`
	Rows   []map[string]any       `json:"rows"`
}

type PT1CalculationItem struct {
	ID                 int64          `json:"id"`
	ProjectID          int64          `json:"project_id"`
	ProjectName        string         `json:"project_name"`
	Country            string         `json:"country"`
	ReportStartDate    string         `json:"report_start_date"`
	ReportEndDate      string         `json:"report_end_date"`
	Version            int            `json:"version"`
	IsCurrent          bool           `json:"is_current"`
	RowCount           int            `json:"row_count"`
	SummaryRow         map[string]any `json:"summary_row"`
	ResultFilePath     *string        `json:"result_file_path"`
	CalculationVersion int            `json:"calculation_version"`
	ComputedAt         *string        `json:"computed_at"`
	CreatedAt          *string        `json:"created_at"`
}

type PT1Filter struct {
	ProjectID   *int64
	ProjectIDs  []int64
	Country     *string
	StartDate   *time.Time
	EndDate     *time.Time
	CurrentOnly bool
}

type PT1Details struct {
	PT1ID           int64          `json:"pt1_id"`
	ProjectID       int64          `json:"project_id"`
	ProjectName     string         `json:"project_name"`
	ReportStartDate string         `json:"report_start_date"`
	ReportEndDate   string         `json:"report_end_date"`
	Version         int            `json:"version"`
	Page            int            `json:"page"`
	PageSize        int            `json:"page_size"`
	HasNext         bool           `json:"has_next"`
	Rows            []PT1DetailRow `json:"rows"`
}

type PT1DetailRow struct {
	ID           int64          `json:"id"`
	SourceRowNo  int            `json:"source_row_no"`
	SKU          *string        `json:"sku"`
	ASIN         *string        `json:"asin"`
	SKUSortOrder *int           `json:"sku_sort_order"`
	RawRow       map[string]any `json:"raw_row"`
}

type WeeklyAnalysisItem struct {
	ID               int64          `json:"id"`
	ProjectID        int64          `json:"project_id"`
	ProjectName      string         `json:"project_name"`
	Country          string         `json:"country"`
	ReportStartDate  string         `json:"report_start_date"`
	ReportEndDate    string         `json:"report_end_date"`
	Version          int            `json:"version"`
	IsCurrent        bool           `json:"is_current"`
	RowCount         int            `json:"row_count"`
	TotalSales       float64        `json:"total_sales"`
	TotalUnits       int            `json:"total_units"`
	TotalAdSpend     float64        `json:"total_ad_spend"`
	SummaryRow       map[string]any `json:"summary_row"`
	WeeklySummaryRaw map[string]any `json:"weekly_summary_raw"`
}

type PeriodCompleteness struct {
	TotalDays                  int      `json:"total_days"`
	AvailableBusinessDays      int      `json:"available_business_days"`
	AvailableAdDays            int      `json:"available_ad_days"`
	BusinessMissingDates       []string `json:"business_missing_dates"`
	ADMissingDates             []string `json:"ad_missing_dates"`
	PaymentCovered             bool     `json:"payment_covered"`
	PaymentType                string   `json:"payment_type"`
	PaymentMissing             bool     `json:"payment_missing"`
	PaymentMissingDates        []string `json:"payment_missing_dates"`
	PaymentObjectiveEmpty      bool     `json:"payment_objective_empty"`
	PaymentObjectiveEmptyDates []string `json:"payment_objective_empty_dates"`
}

type PeriodCoverageInfo struct {
	PeriodStartDate string   `json:"period_start_date"`
	PeriodEndDate   string   `json:"period_end_date"`
	SourceID        int64    `json:"source_id"`
	CoveredDates    []string `json:"covered_dates"`
}

type PaymentPeriodOverlap struct {
	PeriodStartDate string `json:"period_start_date"`
	PeriodEndDate   string `json:"period_end_date"`
	SourceID        int64  `json:"source_id"`
}

type WeeklyAvailability struct {
	ISOYear                     int      `json:"iso_year"`
	ISOWeek                     int      `json:"iso_week"`
	WeekStartDate               string   `json:"week_start_date"`
	WeekEndDate                 string   `json:"week_end_date"`
	TotalDays                   int      `json:"total_days"`
	BusinessReportAvailableDays int      `json:"business_report_available_days"`
	ADReportAvailableDays       int      `json:"ad_report_available_days"`
	BusinessPeriodicCovered     bool     `json:"business_periodic_covered"`
	ADPeriodicCovered           bool     `json:"ad_periodic_covered"`
	PaymentCovered              bool     `json:"payment_covered"`
	CanCalculate                bool     `json:"can_calculate"`
	IsPartial                   bool     `json:"is_partial"`
	BusinessMissingDates        []string `json:"business_missing_dates"`
	ADMissingDates              []string `json:"ad_missing_dates"`
	PaymentObjectiveEmptyDates  []string `json:"payment_objective_empty_dates"`
}

type AvailabilityCheck struct {
	BusinessReportMissing       []string               `json:"business_report_missing"`
	ADReportMissing             []string               `json:"ad_report_missing"`
	InventoryMissing            []string               `json:"inventory_missing"`
	BusinessPeriodInfo          []PeriodCoverageInfo   `json:"business_period_info"`
	ADPeriodInfo                []PeriodCoverageInfo   `json:"ad_period_info"`
	BusinessPeriodicOnlyMissing []string               `json:"business_periodic_only_missing"`
	ADPeriodicOnlyMissing       []string               `json:"ad_periodic_only_missing"`
	PaymentPeriodsOverlapping   []PaymentPeriodOverlap `json:"payment_periods_overlapping"`
	PaymentFullPeriodCovered    bool                   `json:"payment_full_period_covered"`
	PaymentDailyCoveredDates    []string               `json:"payment_daily_covered_dates"`
	PaymentObjectiveEmptyDates  []string               `json:"payment_objective_empty_dates"`
	HasMinimumData              bool                   `json:"has_minimum_data"`
	WeeklyAvailability          []WeeklyAvailability   `json:"weekly_availability"`
}

type CheckRequest struct {
	ProjectID int64  `json:"project_id"`
	Country   string `json:"country"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
}

type RunRequest struct {
	ProjectID   int64  `json:"project_id"`
	Country     string `json:"country"`
	StartDate   string `json:"start_date"`
	EndDate     string `json:"end_date"`
	CurrentOnly bool   `json:"current_only"`
}

type PreviewRequest struct {
	ProjectID          int64   `json:"project_id"`
	Country            string  `json:"country"`
	StartDate          string  `json:"start_date"`
	EndDate            string  `json:"end_date"`
	BusinessTempFileID *string `json:"business_temp_file_id"`
	PaymentTempFileID  *string `json:"payment_temp_file_id"`
	ADTempFileID       *string `json:"ad_temp_file_id"`
}

type WeeklyRecomputeRequest struct {
	ProjectID   int64   `json:"project_id"`
	Country     string  `json:"country"`
	StartDate   *string `json:"start_date"`
	EndDate     *string `json:"end_date"`
	CurrentOnly bool    `json:"current_only"`
}

type TriggerRecomputeRequest struct {
	ProjectID       int64  `json:"project_id"`
	Country         string `json:"country"`
	PeriodStartDate string `json:"period_start_date"`
	PeriodEndDate   string `json:"period_end_date"`
}

type UploadSourcesRequest struct {
	ProjectName       string            `json:"project_name"`
	Country           string            `json:"country"`
	ReportStartDate   string            `json:"report_start_date"`
	ReportEndDate     string            `json:"report_end_date"`
	FileIDs           map[string]string `json:"file_ids"`
	ResolvedFilePaths map[string]string `json:"resolved_file_paths"`
}

type CalculationPeriod struct {
	ReportStartDate string              `json:"report_start_date"`
	ReportEndDate   string              `json:"report_end_date"`
	Summary         map[string]any      `json:"summary"`
	Details         []map[string]any    `json:"details"`
	IsPartial       bool                `json:"is_partial"`
	Completeness    *PeriodCompleteness `json:"completeness"`
	Persisted       bool                `json:"persisted"`
	PT1ID           *int64              `json:"pt1_id"`
	Version         *int                `json:"version"`
}

type RunResponse struct {
	ProjectID    int64               `json:"project_id"`
	ProjectName  string              `json:"project_name"`
	Country      string              `json:"country"`
	TotalPeriods int                 `json:"total_periods"`
	Periods      []CalculationPeriod `json:"periods"`
}

type WeeklyRecomputePeriod struct {
	PT1ID                  int64               `json:"pt1_id"`
	Version                int                 `json:"version"`
	ReportStartDate        string              `json:"report_start_date"`
	ReportEndDate          string              `json:"report_end_date"`
	RowCount               int                 `json:"row_count"`
	BusinessReportSourceID int64               `json:"business_report_source_id"`
	ADReportSourceID       int64               `json:"ad_report_source_id"`
	PaymentReportSourceID  *int64              `json:"payment_report_source_id"`
	IsPartial              bool                `json:"is_partial"`
	Completeness           *PeriodCompleteness `json:"completeness"`
}

type WeeklyRecomputeResponse struct {
	ProjectID   int64                   `json:"project_id"`
	ProjectName string                  `json:"project_name"`
	Country     string                  `json:"country"`
	Recomputed  int                     `json:"recomputed"`
	Skipped     int                     `json:"skipped"`
	Periods     []WeeklyRecomputePeriod `json:"periods"`
}

type SourcePersistOutcome struct {
	ReportType   string  `json:"report_type"`
	SourceID     *int64  `json:"source_id"`
	Success      bool    `json:"success"`
	ErrorMessage *string `json:"error_message"`
}

type UploadSourcesResponse struct {
	Outcomes []SourcePersistOutcome `json:"outcomes"`
}

// CalculationEngine is the product-analysis calculation seam. Production
// stores provide the DB-backed implementation; tests may inject one explicitly.
type CalculationEngine interface {
	Run(context.Context, RunRequest, Principal) (*RunResponse, error)
	Preview(context.Context, PreviewRequest, Principal) (*RunResponse, error)
	RecomputeWeekly(context.Context, WeeklyRecomputeRequest, Principal) (*WeeklyRecomputeResponse, error)
	TriggerRecompute(context.Context, TriggerRecomputeRequest, Principal) (map[string]any, error)
	UploadSources(context.Context, UploadSourcesRequest, Principal) (*UploadSourcesResponse, error)
}

// CalculationEngineProvider lets the production store expose its DB-backed
// engine without making central route wiring aware of the calculation package.
type CalculationEngineProvider interface {
	CalculationEngine() CalculationEngine
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	AccessibleProjectIDs(ctx context.Context, operator string, isAdmin bool) ([]int64, error)
	ProjectIDByName(ctx context.Context, projectName string) (int64, error)
	SourceProjectID(ctx context.Context, sourceID int64) (int64, error)
	ListSources(ctx context.Context, filter SourceFilter) ([]AnalysisSourceFileItem, error)
	GetSourceRows(ctx context.Context, sourceID int64, page, pageSize int, includeExcluded bool) (*SourceRows, error)
	GetCurrentInventory(ctx context.Context, projectID int64, country string, startDate, endDate *time.Time) (*CurrentInventorySnapshot, error)
	ListPT1(ctx context.Context, filter PT1Filter) ([]PT1CalculationItem, error)
	GetPT1(ctx context.Context, pt1ID int64) (*PT1CalculationItem, error)
	ListPT1Details(ctx context.Context, pt1 PT1CalculationItem, country string, page, pageSize int) (*PT1Details, error)
	ListWeekly(ctx context.Context, filter PT1Filter) ([]WeeklyAnalysisItem, error)
	CheckAvailability(ctx context.Context, projectID int64, country string, startDate, endDate time.Time) (*AvailabilityCheck, error)
}
