package shipping_plan

import (
	"context"
	"errors"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
)

type ShippingPlanSkuItem struct {
	SKU                          string   `json:"sku"`
	ASIN                         *string  `json:"asin"`
	ProductName                  *string  `json:"product_name"`
	AvailableInventory           *int     `json:"available_inventory"`
	InventorySnapshotDate        *string  `json:"inventory_snapshot_date"`
	BaseDMS                      *float64 `json:"base_dms"`
	GrowthFactor                 float64  `json:"growth_factor"`
	DemandSource                 string   `json:"demand_source"`
	InTransitQuantity            int      `json:"in_transit_quantity"`
	DraftQuantity                int      `json:"draft_quantity"`
	ActivePlanRemainingQuantity  int      `json:"active_plan_remaining_quantity"`
	Confirmed180dSalesUpperBound *float64 `json:"confirmed_180d_sales_upper_bound"`
	Planned180dSalesUpperBound   *float64 `json:"planned_180d_sales_upper_bound"`
	DataQuality                  []string `json:"data_quality"`
}

type ShippingPlanSkuListResponse struct {
	Items                         []ShippingPlanSkuItem `json:"items"`
	Total                         int                   `json:"total"`
	Page                          int                   `json:"page"`
	PageSize                      int                   `json:"page_size"`
	ValidForecastSKUCount         int                   `json:"valid_forecast_sku_count"`
	MissingForecastSKUCount       int                   `json:"missing_forecast_sku_count"`
	KnownConfirmedSalesUpperBound float64               `json:"known_confirmed_sales_upper_bound"`
	KnownPlannedSalesUpperBound   float64               `json:"known_planned_sales_upper_bound"`
}

type ShippingPlanGrowthFactorUpdate struct {
	ProjectID    int64   `json:"project_id"`
	Country      string  `json:"country"`
	GrowthFactor float64 `json:"growth_factor"`
}

type ShippingPlanGrowthFactorResponse struct {
	ProjectID    int64   `json:"project_id"`
	Country      string  `json:"country"`
	SKU          string  `json:"sku"`
	GrowthFactor float64 `json:"growth_factor"`
	DemandSource string  `json:"demand_source"`
}

type ForecastPoint struct {
	ForecastDate              string   `json:"forecast_date"`
	Demand                    *float64 `json:"demand"`
	ConfirmedSales            *float64 `json:"confirmed_sales"`
	PlannedSales              *float64 `json:"planned_sales"`
	ConfirmedClosingInventory *float64 `json:"confirmed_closing_inventory"`
	PlannedClosingInventory   *float64 `json:"planned_closing_inventory"`
	HistoricalOrderSales      *int     `json:"historical_order_sales"`
}

type ForecastArrival struct {
	ArrivalDate string  `json:"arrival_date"`
	SKU         string  `json:"sku"`
	Quantity    int     `json:"quantity"`
	SourceType  string  `json:"source_type"`
	Reference   *string `json:"reference"`
	DataQuality *string `json:"data_quality"`
}

type ShippingPlanForecastResponse struct {
	ProjectID                    int64             `json:"project_id"`
	Country                      string            `json:"country"`
	SKU                          string            `json:"sku"`
	AsOfDate                     string            `json:"as_of_date"`
	ForecastStartDate            string            `json:"forecast_start_date"`
	ForecastEndDate              string            `json:"forecast_end_date"`
	InventorySnapshotDate        *string           `json:"inventory_snapshot_date"`
	SalesBaselineStartDate       string            `json:"sales_baseline_start_date"`
	SalesBaselineEndDate         string            `json:"sales_baseline_end_date"`
	BaseDMS                      *float64          `json:"base_dms"`
	GrowthFactor                 float64           `json:"growth_factor"`
	DemandSource                 string            `json:"demand_source"`
	DataQuality                  []string          `json:"data_quality"`
	DailyPoints                  []ForecastPoint   `json:"daily_points"`
	Arrivals                     []ForecastArrival `json:"arrivals"`
	Confirmed180dSalesUpperBound *float64          `json:"confirmed_180d_sales_upper_bound"`
	Planned180dSalesUpperBound   *float64          `json:"planned_180d_sales_upper_bound"`
	UnverifiedCompletedQuantity  int               `json:"unverified_completed_quantity"`
	OverdueShipmentQuantity      int               `json:"overdue_shipment_quantity"`
	OverduePlanQuantity          int               `json:"overdue_plan_quantity"`
}

type ShipmentHistoryMonth struct {
	Month         string `json:"month"`
	ShipmentCount int    `json:"shipment_count"`
	Quantity      int    `json:"quantity"`
}

type ShipmentHistorySalesMonth struct {
	Month                    string  `json:"month"`
	SalesQuantity            *int    `json:"sales_quantity"`
	Covered                  bool    `json:"covered"`
	ProvisionalSalesQuantity *int    `json:"provisional_sales_quantity"`
	ProvisionalSalesThrough  *string `json:"provisional_sales_through"`
	CoverageThrough          *string `json:"coverage_through"`
}

type ShipmentHistoryResponse struct {
	ProjectID               int64                       `json:"project_id"`
	Country                 string                      `json:"country"`
	EtdFrom                 string                      `json:"etd_from"`
	EtdTo                   string                      `json:"etd_to"`
	Months                  []ShipmentHistoryMonth      `json:"months"`
	MissingEtdShipmentCount int                         `json:"missing_etd_shipment_count"`
	MissingEtdQuantity      int                         `json:"missing_etd_quantity"`
	IncludedStatuses        []string                    `json:"included_statuses"`
	DateBasis               string                      `json:"date_basis"`
	SalesMonths             []ShipmentHistorySalesMonth `json:"sales_months"`
	SalesBasis              string                      `json:"sales_basis"`
}

type ShippingPlanItemInput struct {
	SKU      string `json:"sku"`
	Quantity int    `json:"quantity"`
}

type ShippingPlanBatchCreate struct {
	ProjectID           int64                   `json:"project_id"`
	Country             string                  `json:"country"`
	Name                string                  `json:"name"`
	ExpectedArrivalDate string                  `json:"expected_arrival_date"`
	Remark              *string                 `json:"remark"`
	Items               []ShippingPlanItemInput `json:"items"`
}

type ShippingPlanBatchUpdate struct {
	Name                *string                 `json:"name"`
	ExpectedArrivalDate *string                 `json:"expected_arrival_date"`
	Remark              *string                 `json:"remark"`
	Items               []ShippingPlanItemInput `json:"items"`
}

type ShippingPlanAllocationCreate struct {
	PlanItemID         int64 `json:"plan_item_id"`
	ShipmentScheduleID int64 `json:"shipment_schedule_id"`
	Quantity           int   `json:"quantity"`
}

type ShippingPlanAllocationResponse struct {
	ID                 int64  `json:"id"`
	PlanItemID         int64  `json:"plan_item_id"`
	ShipmentScheduleID int64  `json:"shipment_schedule_id"`
	SKU                string `json:"sku"`
	Quantity           int    `json:"quantity"`
}

type ShippingPlanBatchItemResponse struct {
	ID                int64                            `json:"id"`
	SKU               string                           `json:"sku"`
	Quantity          int                              `json:"quantity"`
	AllocatedQuantity int                              `json:"allocated_quantity"`
	RemainingQuantity int                              `json:"remaining_quantity"`
	Allocations       []ShippingPlanAllocationResponse `json:"allocations"`
}

type ShippingPlanBatchResponse struct {
	ID                  int64                           `json:"id"`
	ProjectID           int64                           `json:"project_id"`
	Country             string                          `json:"country"`
	Name                string                          `json:"name"`
	ExpectedArrivalDate string                          `json:"expected_arrival_date"`
	Status              string                          `json:"status"`
	Remark              *string                         `json:"remark"`
	Items               []ShippingPlanBatchItemResponse `json:"items"`
}

type ShippingPlanBatchListResponse struct {
	Items []ShippingPlanBatchResponse `json:"items"`
	Total int                         `json:"total"`
}

type ShippingPlanAllocationResult struct {
	Allocation                   ShippingPlanAllocationResponse `json:"allocation"`
	PlanItemRemainingQuantity    int                            `json:"plan_item_remaining_quantity"`
	ShipmentSKURemainingQuantity int                            `json:"shipment_sku_remaining_quantity"`
}

var (
	ErrForbidden     = errors.New("无权限访问该项目")
	ErrNotFound      = errors.New("not found")
	ErrSKUNotFound   = errors.New("项目站点下未找到该 SKU")
	ErrConflict      = errors.New("conflict")
	ErrUnprocessable = errors.New("unprocessable")
)

type ProjectReader interface {
	GetProject(ctx context.Context, id int64) (*projects.ProjectItem, error)
	ListManage(ctx context.Context, operator string, isAdmin bool, isLeader bool) ([]projects.ProjectItem, error)
}

type Store interface {
	ListSkus(ctx context.Context, projectID int64, country string, page, pageSize int) (ShippingPlanSkuListResponse, error)
	GetForecast(ctx context.Context, projectID int64, country, sku string) (ShippingPlanForecastResponse, error)
	UpdateGrowthFactor(ctx context.Context, sku string, update ShippingPlanGrowthFactorUpdate) (ShippingPlanGrowthFactorResponse, error)
	GetShipmentHistory(ctx context.Context, projectID int64, country, etdFrom, etdTo string) (ShipmentHistoryResponse, error)
	ListBatches(ctx context.Context, projectID int64, country string) (ShippingPlanBatchListResponse, error)
	GetBatch(ctx context.Context, batchID int64) (*ShippingPlanBatchResponse, error)
	CreateBatch(ctx context.Context, create ShippingPlanBatchCreate, op string) (ShippingPlanBatchResponse, error)
	UpdateBatch(ctx context.Context, batchID int64, update ShippingPlanBatchUpdate, op string) (*ShippingPlanBatchResponse, error)
	CancelBatch(ctx context.Context, batchID int64, op string) (*ShippingPlanBatchResponse, error)
	GetAllocationProjectID(ctx context.Context, allocationID int64) (int64, error)
	CreateAllocation(ctx context.Context, batchID int64, create ShippingPlanAllocationCreate, op string) (ShippingPlanAllocationResult, error)
	DeleteAllocation(ctx context.Context, allocationID int64, op string) (bool, error)
}
