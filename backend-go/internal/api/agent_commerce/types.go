package agent_commerce

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

var (
	ErrProjectNotFound    = errors.New("agent commerce project not found")
	ErrSKUNotFound        = errors.New("agent commerce sku not found")
	ErrShipmentNotFound   = errors.New("agent commerce shipment not found")
	ErrDuplicate          = errors.New("agent commerce duplicate")
	ErrConflict           = errors.New("agent commerce conflict")
	ErrValidation         = errors.New("agent commerce validation failed")
	ErrExportTooLarge     = errors.New("agent commerce export too large")
	ErrServiceUnavailable = errors.New("agent commerce service unavailable")
)

type ErrorCode string

const (
	CodeAgentAuthFailed         ErrorCode = "AGENT_AUTH_FAILED"
	CodeAgentProjectOutOfScope  ErrorCode = "AGENT_PROJECT_OUT_OF_SCOPE"
	CodeAgentBusinessOutOfScope ErrorCode = "AGENT_BUSINESS_OUT_OF_SCOPE"
	CodeAgentRateLimitExceeded  ErrorCode = "AGENT_RATE_LIMIT_EXCEEDED"
	CodeSKUInfoInvalidSource    ErrorCode = "SKU_INFO_INVALID_SOURCE"
	CodeSKUInfoDuplicate        ErrorCode = "SKU_INFO_DUPLICATE"
	CodeConfirmTokenInvalid     ErrorCode = "CONFIRM_TOKEN_INVALID"
	CodeConfirmTokenExpired     ErrorCode = "CONFIRM_TOKEN_EXPIRED"
	CodeValidationFailed        ErrorCode = "VALIDATION_FAILED"
	CodeResourceNotFound        ErrorCode = "RESOURCE_NOT_FOUND"
	CodeServiceUnavailable      ErrorCode = "SERVICE_UNAVAILABLE"
	CodeInternalError           ErrorCode = "INTERNAL_ERROR"
)

var errorStatuses = map[ErrorCode]int{
	CodeAgentAuthFailed:         http.StatusUnauthorized,
	CodeAgentProjectOutOfScope:  http.StatusForbidden,
	CodeAgentBusinessOutOfScope: http.StatusForbidden,
	CodeAgentRateLimitExceeded:  http.StatusTooManyRequests,
	CodeSKUInfoInvalidSource:    http.StatusBadRequest,
	CodeSKUInfoDuplicate:        http.StatusConflict,
	CodeConfirmTokenInvalid:     http.StatusBadRequest,
	CodeConfirmTokenExpired:     http.StatusConflict,
	CodeValidationFailed:        http.StatusBadRequest,
	CodeResourceNotFound:        http.StatusNotFound,
	CodeServiceUnavailable:      http.StatusServiceUnavailable,
	CodeInternalError:           http.StatusInternalServerError,
}

var errorDefaults = map[ErrorCode][2]string{
	CodeSKUInfoInvalidSource: {
		"写入来源不合法",
		"合法来源：agent_listing_pull、agent_user_supplied、external_api（禁 manual）",
	},
	CodeSKUInfoDuplicate: {
		"SKU 主数据更新后与现有记录重复",
		"唯一键为 (project_id, sku, asin, country)；请核对 sku/asin/country 后重试",
	},
	CodeConfirmTokenInvalid: {
		"确认凭证无效或与请求体不匹配",
		"请重新发起预览请求，向用户确认后用同一请求体重放",
	},
	CodeConfirmTokenExpired: {
		"确认凭证已过期",
		"请重新发起预览请求，向用户再次确认后再调用",
	},
	CodeValidationFailed: {
		"请求参数校验失败",
		"请根据 details 修正参数后重试",
	},
	CodeResourceNotFound: {
		"请求的资源不存在",
		"请检查资源 id；可用对应的列表端点查询可用 id",
	},
	CodeServiceUnavailable: {
		"Agent 业务 Store 或依赖尚未装配",
		"请由网关装配对应业务 Store 后重试",
	},
	CodeInternalError: {
		"服务器内部错误",
		"请稍后重试；若持续出现请联系管理员",
	},
}

type APIError struct {
	Code    ErrorCode
	Reason  string
	Human   string
	Hint    string
	Details any
}

func (e *APIError) Error() string {
	if e == nil {
		return "nil agent commerce API error"
	}
	return string(e.Code)
}

func newAPIError(code ErrorCode) *APIError {
	defaults := errorDefaults[code]
	return &APIError{Code: code, Human: defaults[0], Hint: defaults[1]}
}

func APIErrorWithMessage(code ErrorCode, message string) *APIError {
	result := newAPIError(code)
	result.Human = message
	return result
}

type ProjectInfo struct {
	ID   int64  `json:"id"`
	Name string `json:"project_name"`
}

type SKUFilter struct {
	Country      *string
	IsActive     *bool
	SKU          *string
	ASIN         *string
	Page         int
	PageSize     int
	IncludeTotal bool
}

type SKURecord struct {
	ID                         int64          `json:"id"`
	ProjectID                  int64          `json:"-"`
	ProjectName                string         `json:"project_name"`
	SKU                        string         `json:"sku"`
	ASIN                       string         `json:"asin"`
	FNSKU                      *string        `json:"fnsku"`
	ProductName                *string        `json:"product_name"`
	FatherID                   *string        `json:"father_id"`
	FOBUnitCost                float64        `json:"fob_unit_cost"`
	FirstLegCostRMB            float64        `json:"first_leg_cost_rmb"`
	PackageLengthCM            float64        `json:"package_length_cm"`
	PackageWidthCM             float64        `json:"package_width_cm"`
	PackageHeightCM            float64        `json:"package_height_cm"`
	WeightKG                   float64        `json:"weight_kg"`
	CartonLengthCM             float64        `json:"carton_length_cm"`
	CartonWidthCM              float64        `json:"carton_width_cm"`
	CartonHeightCM             float64        `json:"carton_height_cm"`
	CartonWeightKG             float64        `json:"carton_weight_kg"`
	UnitsPerCarton             int            `json:"units_per_carton"`
	Currency                   string         `json:"currency"`
	Country                    string         `json:"country"`
	SortOrder                  int            `json:"sort_order"`
	IsActive                   bool           `json:"is_active"`
	SKUFactoryInfo             map[string]any `json:"sku_factory_info"`
	SKUFactoryInfoUpdatedAt    *string        `json:"sku_factory_info_updated_at"`
	SKUFactoryInfoUpdatedBy    *string        `json:"sku_factory_info_updated_by"`
	ListingTitle               *string        `json:"listing_title"`
	ListingBullet1             *string        `json:"listing_bullet_1"`
	ListingBullet2             *string        `json:"listing_bullet_2"`
	ListingBullet3             *string        `json:"listing_bullet_3"`
	ListingBullet4             *string        `json:"listing_bullet_4"`
	ListingBullet5             *string        `json:"listing_bullet_5"`
	ListingDescription         *string        `json:"listing_description"`
	ListingSellingPoints       *string        `json:"listing_selling_points"`
	ListingCopyUpdatedAt       *string        `json:"listing_copy_updated_at"`
	ListingCopyUpdatedBy       *string        `json:"listing_copy_updated_by"`
	FNSKULabelR2Key            *string        `json:"-"`
	FNSKULabelR2URL            *string        `json:"fnsku_label_r2_url"`
	ProductImageR2URL          *string        `json:"product_image_r2_url"`
	ProductImageThumbnailR2URL *string        `json:"product_image_thumbnail_r2_url"`
	ProductImageUploadedAt     *string        `json:"product_image_uploaded_at"`
	ProductImageUploadedBy     *string        `json:"product_image_uploaded_by"`
	MarketplaceURL             *string        `json:"marketplace_url"`
	CreatedAt                  string         `json:"created_at"`
	UpdatedAt                  string         `json:"updated_at"`
}

type SKUSPage struct {
	Items    []SKURecord `json:"items"`
	Page     int         `json:"page"`
	PageSize int         `json:"page_size"`
	Total    *int        `json:"total"`
	HasNext  bool        `json:"has_next"`
}

type SKUUpsertInput struct {
	SKU             string
	ASIN            string
	Country         string
	Source          string
	Provided        map[string]bool
	FNSKU           *string
	ProductName     *string
	FatherID        *string
	FOBUnitCost     *float64
	FirstLegCostRMB *float64
	PackageLengthCM *float64
	PackageWidthCM  *float64
	PackageHeightCM *float64
	WeightKG        *float64
	CartonLengthCM  *float64
	CartonWidthCM   *float64
	CartonHeightCM  *float64
	CartonWeightKG  *float64
	UnitsPerCarton  *int
	IsActive        *bool
	SortOrder       *int
	SKUFactoryInfo  map[string]any
	ListingCopy     map[string]*string
}

type SKUUpdateInput struct {
	Source          string
	Provided        map[string]bool
	FNSKU           *string
	ProductName     *string
	FatherID        *string
	FOBUnitCost     *float64
	FirstLegCostRMB *float64
	PackageLengthCM *float64
	PackageWidthCM  *float64
	PackageHeightCM *float64
	WeightKG        *float64
	CartonLengthCM  *float64
	CartonWidthCM   *float64
	CartonHeightCM  *float64
	CartonWeightKG  *float64
	UnitsPerCarton  *int
	IsActive        *bool
	SortOrder       *int
	SKUFactoryInfo  map[string]any
	ListingCopy     map[string]*string
}

type ListingCopyItem struct {
	SKURecordID int64
	Values      map[string]*string
}

type ListingCopyBatchInput struct {
	Source string
	Items  []ListingCopyItem
}

type ListingCopyBatchResult struct {
	Updated    int         `json:"updated"`
	Unchanged  int         `json:"unchanged"`
	UpdatedIDs []int64     `json:"updated_ids"`
	Items      []SKURecord `json:"items"`
}

type SKUStatusInput struct {
	IsActive bool
	Source   string
}

type AuditItem struct {
	ID             int64   `json:"id"`
	CreatedAt      *string `json:"created_at"`
	Action         string  `json:"action"`
	AgentID        *string `json:"agent_id"`
	Operator       *string `json:"operator"`
	IdempotencyKey *string `json:"idempotency_key"`
	Result         string  `json:"result"`
	Before         any     `json:"before"`
	After          any     `json:"after"`
	ErrorMessage   *string `json:"error_message"`
}

type AuditEntry struct {
	Action         string
	TargetType     string
	TargetID       *string
	Operator       *string
	Result         string
	TraceID        *string
	RequestMethod  *string
	RequestPath    *string
	IPAddress      *string
	UserAgent      *string
	BeforeJSON     any
	AfterJSON      any
	AgentID        *string
	AgentName      *string
	IdempotencyKey *string
	ErrorMessage   *string
}

type NewProductExportRow struct {
	ID                        int64
	ProjectName               string
	SKU                       string
	Country                   string
	CalculationType           string
	PackageLengthCM           float64
	PackageWidthCM            float64
	PackageHeightCM           float64
	WeightKG                  float64
	FOBProductCostRMB         float64
	FirstLegCostRMB           float64
	DDPCostRMB                float64
	DDPCostUSD                float64
	SalePriceUSD              float64
	ReferralFeeUSD            float64
	AdvertisingFeeUSD         float64
	AdvertisingRate           float64
	ReturnLossUSD             float64
	ReturnLossRate            float64
	FBAFulfillmentFeeUSD      float64
	InboundConfigFeeUSD       float64
	StorageFeeUSD             float64
	StorageMonths             float64
	TotalFeeUSD               float64
	PayoutUSD                 float64
	ProfitUSD                 float64
	ProfitRate                float64
	VolumeCubicIn             float64
	VolumeCubicFt             float64
	LongestSideIn             float64
	MiddleSideIn              float64
	ShortestSideIn            float64
	SizeTierLabel             string
	PriceBandLabel            string
	ChargeableWeightLB        float64
	ProductWeightLB           float64
	DimensionalWeightLB       float64
	ChargeableWeightRule      string
	FulfillmentFeeRuleLabel   string
	InboundConfigFeeRuleLabel string
	StorageFeeRuleLabel       string
	USDToRMBRate              float64
	CreatedAt                 time.Time
}

type ShopExportFilter struct {
	Country           *string
	SKU               *string
	Mode              string
	AsOf              *time.Time
	IncludeUncomputed bool
}

type ShopExportRow struct {
	ID                        int64
	SKU                       string
	ASIN                      *string
	Country                   string
	Source                    string
	ObservedAt                time.Time
	Warnings                  []string
	FOBProductCostRMB         float64
	PackageLengthCM           float64
	PackageWidthCM            float64
	PackageHeightCM           float64
	WeightKG                  float64
	FirstLegCostRMB           float64
	DDPCostRMB                float64
	DDPCostUSD                float64
	USDToRMBRate              float64
	SalePriceUSD              float64
	AdvertisingRate           float64
	AdvertisingFeeUSD         float64
	ReturnLossRate            float64
	ReturnLossUSD             float64
	ReferralFeeUSD            float64
	FBAFulfillmentFeeUSD      float64
	InboundConfigFeeUSD       float64
	StorageMonths             float64
	StorageFeeUSD             float64
	TotalFeeUSD               float64
	PayoutUSD                 float64
	ProfitUSD                 float64
	ProfitRate                float64
	SizeTierLabel             string
	PriceBandLabel            string
	FulfillmentFeeRuleLabel   string
	InboundConfigFeeRuleLabel string
	StorageFeeRuleLabel       string
	PlatformFeeUSD            float64
	DeliveryFeeUSD            float64
	InboundConfigFeeManualUSD float64
	StorageFeeManualUSD       float64
	VATUSD                    float64
	ProfitAfterVATUSD         *float64
	ProfitAfterVATRate        *float64
}

type ShopExportMaster struct {
	SKU             string
	ASIN            *string
	Country         string
	FOBUnitCost     float64
	PackageLengthCM float64
	PackageWidthCM  float64
	PackageHeightCM float64
	WeightKG        float64
	FirstLegCostRMB float64
	SortOrder       int
}

type ShopExportData struct {
	Calculations []ShopExportRow
	Masters      []ShopExportMaster
	Countries    []string
	RowCount     int
}

type CartonInfo struct {
	UnitsPerCarton int
	CartonLengthCM float64
	CartonWidthCM  float64
	CartonHeightCM float64
	CartonWeightKG float64
}

type ShipmentItemRow struct {
	SKU         string
	Quantity    int
	CartonCount *int
}

type ShipmentDetail struct {
	ID          int64
	ProjectID   int64
	ProjectName string
	Country     string
	ShipmentNo  string
	Items       []ShipmentItemRow
}

type ShipmentTemplateData struct {
	Detail  *ShipmentDetail
	Cartons map[string]CartonInfo
}

type FBABoxItem struct {
	ProjectID                  int64    `json:"project_id"`
	ProjectName                string   `json:"project_name"`
	Country                    string   `json:"country"`
	ShipmentNo                 string   `json:"shipment_no"`
	WarehouseCode              *string  `json:"warehouse_code"`
	SKU                        string   `json:"sku"`
	ProductName                *string  `json:"product_name"`
	ASIN                       *string  `json:"asin"`
	FNSKU                      *string  `json:"fnsku"`
	PackageLengthCM            *float64 `json:"package_length_cm"`
	PackageWidthCM             *float64 `json:"package_width_cm"`
	PackageHeightCM            *float64 `json:"package_height_cm"`
	WeightKG                   *float64 `json:"weight_kg"`
	LengthCM                   float64  `json:"length_cm"`
	WidthCM                    float64  `json:"width_cm"`
	HeightCM                   float64  `json:"height_cm"`
	CartonWeightKG             *float64 `json:"carton_weight_kg"`
	Quantity                   int      `json:"quantity"`
	UnitsPerCarton             int      `json:"units_per_carton"`
	CartonCount                int      `json:"carton_count"`
	FullCartonCount            int      `json:"full_carton_count"`
	PartialCartonUnits         int      `json:"partial_carton_units"`
	OuterBoxText               string   `json:"outer_box_text"`
	TotalWeightKG              float64  `json:"total_weight_kg"`
	TotalVolumeM3              float64  `json:"total_volume_m3"`
	FBALabelPrefix             string   `json:"fba_label_prefix"`
	TrackingNo                 *string  `json:"tracking_no"`
	ProductImageThumbnailR2URL *string  `json:"product_image_thumbnail_r2_url"`
	ProductImageR2URL          *string  `json:"product_image_r2_url"`
	ProductImageThumbnailR2Key *string  `json:"-"`
	ProductImageR2Key          *string  `json:"-"`
}

type FBABoxData struct {
	Items []FBABoxItem
}

type BlobStore interface {
	Put(ctx context.Context, key string, data []byte, contentType string) (string, error)
	Delete(ctx context.Context, key string) error
}

// BlobReader is the optional read surface used to embed FBA product images.
// A production blob.Store implements both BlobStore and BlobReader.
type BlobReader interface {
	Get(ctx context.Context, key string) (io.ReadCloser, error)
}

type Store interface {
	VerifyProject(ctx context.Context, projectID int64) (*ProjectInfo, error)
	ListSKU(ctx context.Context, projectID int64, filter SKUFilter) (SKUSPage, error)
	GetSKU(ctx context.Context, projectID, skuRecordID int64) (*SKURecord, error)
	UpsertSKU(
		ctx context.Context,
		projectID int64,
		input SKUUpsertInput,
		entry AuditEntry,
	) (SKURecord, string, error)
	UpdateSKU(
		ctx context.Context,
		projectID, skuRecordID int64,
		input SKUUpdateInput,
		entry AuditEntry,
	) (*SKURecord, *SKURecord, error)
	BatchUpdateListingCopy(
		ctx context.Context,
		projectID int64,
		input ListingCopyBatchInput,
		entry AuditEntry,
	) (ListingCopyBatchResult, error)
	TransitionSKUStatus(
		ctx context.Context,
		projectID, skuRecordID int64,
		input SKUStatusInput,
		entry AuditEntry,
	) (SKURecord, bool, error)
	DeleteSKU(
		ctx context.Context,
		projectID, skuRecordID int64,
		entry AuditEntry,
	) (SKURecord, error)
	ListSKUAudit(
		ctx context.Context,
		projectID, skuRecordID int64,
		limit int,
	) ([]AuditItem, error)
	SetFNSKULabel(
		ctx context.Context,
		projectID, skuRecordID int64,
		key, publicURL string,
		fileSize int64,
		entry AuditEntry,
	) (*string, error)
	RecordAudit(ctx context.Context, entry AuditEntry) error

	ResolveShipment(
		ctx context.Context,
		projectID int64,
		shipmentNo string,
	) (*ShipmentDetail, error)
	ListFBABoxDetails(
		ctx context.Context,
		projectID int64,
		shipmentNos []string,
	) (FBABoxData, error)
	PrepareShipmentTemplate(
		ctx context.Context,
		projectID int64,
		shipmentNo string,
	) (*ShipmentTemplateData, error)
	ListNewProductExports(
		ctx context.Context,
		projectID int64,
		snapshotIDs []int64,
	) ([]NewProductExportRow, error)
	ListShopExport(
		ctx context.Context,
		projectID int64,
		filter ShopExportFilter,
	) (ShopExportData, error)
}

type Options struct {
	Credentials      agentauth.CredentialStore
	ConfirmStore     agentauth.ConfirmStore
	Blobs            BlobStore
	ReadRateLimiter  agentauth.RateLimiter
	WriteRateLimiter agentauth.RateLimiter
	Now              func() time.Time
}

func (options Options) now() time.Time {
	if options.Now != nil {
		return options.Now()
	}
	return time.Now()
}

func rawValuePresent(values map[string]json.RawMessage, key string) bool {
	_, ok := values[key]
	return ok
}
