package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/complaints"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/daily_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_ad_data"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_ledger"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation_snapshots"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/return_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/rpa_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipment_schedules"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shop_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type ErrorCode string

const (
	ErrAgentAuthFailed         ErrorCode = "AGENT_AUTH_FAILED"
	ErrAgentProjectOutOfScope  ErrorCode = "AGENT_PROJECT_OUT_OF_SCOPE"
	ErrAgentBusinessOutOfScope ErrorCode = "AGENT_BUSINESS_OUT_OF_SCOPE"
	CodeConfirmTokenInvalid    ErrorCode = "CONFIRM_TOKEN_INVALID"
	CodeConfirmTokenExpired    ErrorCode = "CONFIRM_TOKEN_EXPIRED"
	ErrValidationFailed        ErrorCode = "VALIDATION_FAILED"
	ErrResourceNotFound        ErrorCode = "RESOURCE_NOT_FOUND"
	ErrInternal                ErrorCode = "INTERNAL_ERROR"
	ErrServiceUnavailable      ErrorCode = "SERVICE_UNAVAILABLE"
)

var errorStatus = map[ErrorCode]int{
	ErrAgentAuthFailed:         http.StatusUnauthorized,
	ErrAgentProjectOutOfScope:  http.StatusForbidden,
	ErrAgentBusinessOutOfScope: http.StatusForbidden,
	CodeConfirmTokenInvalid:    http.StatusBadRequest,
	CodeConfirmTokenExpired:    http.StatusConflict,
	ErrValidationFailed:        http.StatusBadRequest,
	ErrResourceNotFound:        http.StatusNotFound,
	ErrInternal:                http.StatusInternalServerError,
	ErrServiceUnavailable:      http.StatusNotImplemented,
}

var errorDefaults = map[ErrorCode][2]string{
	ErrAgentAuthFailed: {
		"Agent 鉴权失败",
		"请确认 Authorization 与 X-Agent-Id 配对正确；如凭据失效请联系管理员重新生成",
	},
	ErrAgentProjectOutOfScope: {
		"本凭据未被授权访问该项目",
		"请在 Agent 平台为该 agent 配置项目访问权限",
	},
	ErrAgentBusinessOutOfScope: {
		"本凭据未被授权访问该业务域",
		"请在 Agent 平台为该 agent 配置业务域访问权限",
	},
	CodeConfirmTokenInvalid: {
		"确认凭证无效或与请求体不匹配",
		"请重新发起预览请求，向用户确认后用同一请求体重放",
	},
	CodeConfirmTokenExpired: {
		"确认凭证已过期",
		"请重新发起预览请求，向用户再次确认后再调用",
	},
	ErrValidationFailed: {
		"请求参数校验失败",
		"请根据 details 修正参数后重试",
	},
	ErrResourceNotFound: {
		"请求的资源不存在",
		"请检查资源 id；可用对应的列表端点查询可用 id",
	},
	ErrInternal: {
		"服务器内部错误",
		"请稍后重试；若持续出现请联系管理员",
	},
	ErrServiceUnavailable: {
		"Agent 业务 Store 尚未装配",
		"请由网关装配对应业务 Store 后重试",
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
	return string(e.Code)
}

func NewAPIError(code ErrorCode) *APIError {
	defaults := errorDefaults[code]
	return &APIError{
		Code:  code,
		Human: defaults[0],
		Hint:  defaults[1],
	}
}

func ErrorWithReason(code ErrorCode, reason string) *APIError {
	err := NewAPIError(code)
	err.Reason = reason
	return err
}

func ErrorWithMessage(code ErrorCode, message string) *APIError {
	err := NewAPIError(code)
	err.Human = message
	return err
}

type okResponse struct {
	OK             bool   `json:"ok"`
	Data           any    `json:"data"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

type errorResponse struct {
	OK    bool `json:"ok"`
	Error struct {
		Code   ErrorCode `json:"code"`
		Reason string    `json:"reason,omitempty"`
		Human  string    `json:"human_message"`
		Hint   string    `json:"agent_hint"`
		Detail any       `json:"details,omitempty"`
	} `json:"error"`
}

type Credential struct {
	KeyID         int64
	AgentID       string
	Label         string
	ProjectScope  string
	BusinessScope string
}

type CredentialResolver interface {
	ResolveAgentCredential(
		ctx context.Context,
		keyHash string,
		agentID string,
	) (*Credential, error)
}

type CredentialDB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type ConfirmRecord struct {
	Token               string         `json:"token"`
	AgentID             string         `json:"agent_id"`
	Action              string         `json:"action"`
	ResourceFingerprint string         `json:"resource_fingerprint,omitempty"`
	IdempotencyKey      string         `json:"idempotency_key,omitempty"`
	BodyHash            string         `json:"body_hash"`
	CreatedAt           time.Time      `json:"created_at"`
	Context             map[string]any `json:"context,omitempty"`
}

type ConfirmStore interface {
	Put(ctx context.Context, record ConfirmRecord, ttl time.Duration) error
	Pop(ctx context.Context, token string) (*ConfirmRecord, error)
}

var (
	ErrConfirmTokenInvalid = errors.New("confirm token invalid")
	ErrConfirmTokenExpired = errors.New("confirm token expired")
)

type ProjectStore interface {
	ListManage(
		ctx context.Context,
		operator string,
		isAdmin bool,
		showInactive bool,
	) ([]projects.ProjectItem, error)
	ListProjectShops(
		ctx context.Context,
		projectID int64,
	) ([]projects.ProjectShopItem, error)
}

type SalesStore interface {
	GetDailyAnalysis(
		ctx context.Context,
		projectID int64,
		country string,
		startDate string,
		endDate string,
		sku *string,
	) (*daily_analysis.DailyAnalysisResponse, error)
}

type InventoryStore interface {
	GetInventoryAnalysis(
		ctx context.Context,
		filter inventory_replenishment.ReplenishmentFilter,
	) (inventory_replenishment.InventoryAnalysisResponse, error)
}

type LedgerStore interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	ListMonths(ctx context.Context, projectID int64, country *string) (inventory_ledger.MonthsResponse, error)
	GetSnapshot(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.MonthlySnapshotResponse, error)
	GetEvents(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.EventsResponse, error)
	GetClusters(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.ReceiptClustersResponse, error)
	GetLocationDetail(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.LocationDetailResponse, error)
	GetTrend(ctx context.Context, projectID int64, country *string) (inventory_ledger.TrendResponse, error)
	GetDetail(ctx context.Context, projectID int64, country *string, month string, msku, eventType *string) (inventory_ledger.LedgerDetailResponse, error)
	GetSummary(ctx context.Context, projectID int64, country *string, month string, msku, disposition *string) (inventory_ledger.LedgerSummaryResponse, error)
	ListBatches(ctx context.Context, projectID int64, country *string) (inventory_ledger.IngestBatchesResponse, error)
	GetConsistency(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.ConsistencyCheckResult, error)
	GetMonthAnalysis(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.LedgerMonthAnalysisResponse, error)
}

type ShipmentStore interface {
	ListShipmentSchedules(
		ctx context.Context,
		filter shipment_schedules.ShipmentFilter,
	) (shipment_schedules.ShipmentScheduleListResponse, error)
	ListSkuSummary(
		ctx context.Context,
		projectID *int64,
		country, startDate, endDate *string,
	) (shipment_schedules.ShipmentSkuSummaryResponse, error)
	ListFbaBoxDetails(
		ctx context.Context,
		projectIDs []int64,
		countries, shipmentNos []string,
	) (shipment_schedules.ShipmentFbaBoxDetailResponse, error)
	ListBatches(
		ctx context.Context,
		projectID *int64,
		projectIDs []int64,
		country *string,
	) ([]string, error)
	GetShipmentSchedule(ctx context.Context, id int64) (*shipment_schedules.ShipmentScheduleDetail, error)
	CreateShipmentSchedule(
		ctx context.Context,
		create shipment_schedules.ShipmentScheduleCreate,
		operator string,
	) (shipment_schedules.ShipmentScheduleDetail, error)
	UpdateShipmentSchedule(
		ctx context.Context,
		id int64,
		update shipment_schedules.ShipmentScheduleUpdate,
		operator string,
	) (*shipment_schedules.ShipmentScheduleDetail, error)
	DeleteShipmentSchedule(ctx context.Context, id int64) (bool, error)
	CalculateCosts(
		ctx context.Context,
		id int64,
		req shipment_schedules.ShipmentCostCalculateRequest,
	) (*shipment_schedules.ShipmentScheduleDetail, error)
}

type ShopCalculationStore interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	List(
		ctx context.Context,
		filter shop_calculation.ShopCalculationListFilter,
	) ([]shop_calculation.ShopCalculationItem, int, error)
	History(
		ctx context.Context,
		filter shop_calculation.ShopCalculationHistoryFilter,
	) ([]shop_calculation.ShopCalculationItem, error)
	Append(
		ctx context.Context,
		request shop_calculation.ShopCalculationCreateRequest,
		operator string,
	) (shop_calculation.ShopCalculationItem, error)
	ProjectIDForItem(ctx context.Context, itemID int64) (int64, error)
	DeleteGroup(ctx context.Context, itemID int64) (bool, error)
	AggregateCurrent(
		ctx context.Context,
		projectID int64,
		country string,
	) (shop_calculation.ShopCalculationAggregate, error)
}

type NewProductStore interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	List(
		ctx context.Context,
		filter new_product_calculations.ListFilter,
	) (new_product_calculations.ListResponse, error)
	Get(
		ctx context.Context,
		projectID int64,
		sku, calculationType string,
	) (*new_product_calculations.NewProductCalculationItem, error)
	Upsert(
		ctx context.Context,
		input new_product_calculations.CreateRequest,
		operator string,
	) (*new_product_calculations.NewProductCalculationItem, error)
	ProjectID(ctx context.Context, snapshotID int64) (int64, error)
	Delete(ctx context.Context, snapshotID int64) (bool, error)
}

type PricingSnapshotStore interface {
	List(
		ctx context.Context,
		projectID int64,
		country string,
		page, pageSize int,
	) ([]pricing_calculation_snapshots.SnapshotListItem, error)
}

type ReturnStore interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	GetReturnAnalysis(
		ctx context.Context,
		filter return_analysis.ReturnAnalysisFilter,
	) (*return_analysis.ReturnAnalysisResponse, error)
	GetRawRows(
		ctx context.Context,
		filter return_analysis.ReturnAnalysisFilter,
		limit int,
	) ([]return_analysis.ReturnRawRowItem, error)
}

type ReplenishmentStore interface {
	GetInventoryAnalysis(
		ctx context.Context,
		filter inventory_replenishment.ReplenishmentFilter,
	) (inventory_replenishment.InventoryAnalysisResponse, error)
	ListSnapshotOptions(
		ctx context.Context,
		projectID *int64,
		country *string,
	) ([]inventory_replenishment.InventorySnapshotOption, error)
	ListAnalysis(
		ctx context.Context,
		filter inventory_replenishment.ReplenishmentFilter,
	) (inventory_replenishment.InventoryReplenishmentListResponse, error)
	UpdateSetting(
		ctx context.Context,
		projectID int64,
		sku string,
		update inventory_replenishment.InventoryReplenishmentSettingUpdate,
		operator string,
	) (inventory_replenishment.InventoryReplenishmentSettingItem, error)
	ListShipments(
		ctx context.Context,
		projectID *int64,
		country *string,
	) (inventory_replenishment.InventoryReplenishmentShipmentResponse, error)
	ListCalendar(ctx context.Context, projectID *int64, country *string) (inventory_replenishment.CalendarResponse, error)
	ListSeasonal(ctx context.Context, projectID *int64, country *string) (inventory_replenishment.SeasonalReplenishmentListResponse, error)
	ListSnapshots(ctx context.Context, projectID *int64, country *string) ([]inventory_replenishment.InventoryReplenishmentSnapshotListItem, error)
	CreateSnapshot(
		ctx context.Context,
		projectID int64,
		country string,
		req inventory_replenishment.CreateSnapshotRequest,
		operator string,
	) (inventory_replenishment.InventoryReplenishmentSnapshotListItem, error)
	UpdateSnapshot(
		ctx context.Context,
		snapshotID int64,
		req inventory_replenishment.UpdateSnapshotRequest,
		operator string,
	) (*inventory_replenishment.InventoryReplenishmentSnapshotListItem, error)
	DeleteSnapshot(ctx context.Context, snapshotID int64, operator string) (bool, error)
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
}

type ReportStatusStore interface {
	GetReportStatusForDate(
		ctx context.Context,
		reportDate, country, operator string,
		isAdmin bool,
	) (*rpa_reports.RpaReportStatusResponse, error)
}

type ComplaintStore interface {
	GetOverview(ctx context.Context, targetDate string, country *string) (complaints.OverviewResponse, error)
	ListComplaints(ctx context.Context, filter complaints.ComplaintFilter) (complaints.ComplaintListResponse, error)
}

type AdRawStore interface {
	QueryRaw(
		ctx context.Context,
		filter internal_ad_data.RawQueryFilter,
	) (*internal_ad_data.RawResponse, error)
}

type AuditItem struct {
	ID             int64          `json:"id"`
	CreatedAt      *string        `json:"created_at"`
	Action         string         `json:"action"`
	AgentID        *string        `json:"agent_id"`
	Operator       *string        `json:"operator"`
	IdempotencyKey *string        `json:"idempotency_key"`
	Result         string         `json:"result"`
	Before         map[string]any `json:"before"`
	After          map[string]any `json:"after"`
	ErrorMessage   *string        `json:"error_message"`
}

type AuditLogStore interface {
	QueryAuditLogs(
		ctx context.Context,
		targetType string,
		targetIDs []string,
		limit int,
	) ([]AuditItem, error)
}

type Stores struct {
	Projects         ProjectStore
	Sales            SalesStore
	Inventory        InventoryStore
	Ledger           LedgerStore
	Shipments        ShipmentStore
	ShopCalculations ShopCalculationStore
	NewProducts      NewProductStore
	PricingSnapshots PricingSnapshotStore
	Returns          ReturnStore
	Replenishment    ReplenishmentStore
	ReportStatus     ReportStatusStore
	Complaints       ComplaintStore
	Ads              AdRawStore
	Audit            AuditLogStore
}

type Options struct {
	Credentials  CredentialResolver
	ConfirmStore ConfirmStore
	RateLimiter  agentauth.RateLimiter
	Auditor      audit.Service
	Now          func() time.Time
}

func (options Options) now() time.Time {
	if options.Now != nil {
		return options.Now()
	}
	return time.Now()
}

func marshalDetail(detail any) json.RawMessage {
	if detail == nil {
		return nil
	}
	payload, err := json.Marshal(detail)
	if err != nil {
		return nil
	}
	return payload
}
