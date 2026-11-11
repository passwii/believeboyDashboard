package inventory_replenishment

import (
	"context"
	"errors"
)

var (
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限访问该项目")
	ErrAdminRequired    = errors.New("仅管理员可操作")
)

type InventoryDecisionPath struct {
	StateRule         *string `json:"state_rule"`
	CriticalSubtype   *string `json:"critical_subtype"`
	ActionRule        *string `json:"action_rule"`
	SeasonalOverride  bool    `json:"seasonal_override"`
	SeasonalPhaseUsed *string `json:"seasonal_phase_used"`
}

type InventorySignals struct {
	SellableDays      *float64           `json:"sellable_days"`
	DMS3              *float64           `json:"dms_3"`
	DMS7              *float64           `json:"dms_7"`
	DMS14             *float64           `json:"dms_14"`
	DMS30             *float64           `json:"dms_30"`
	TrendRatio730     *float64           `json:"trend_ratio_7_30"`
	TrendRatio37      *float64           `json:"trend_ratio_3_7"`
	TrendLabel        *string            `json:"trend_label"`
	TrendMomentum     *string            `json:"trend_momentum"`
	AgingShare        map[string]float64 `json:"aging_share"`
	TransitRatio      *float64           `json:"transit_ratio"`
	DataFreshnessDays int                `json:"data_freshness_days"`
	Confidence        string             `json:"confidence"`
	SeasonalFactor    *float64           `json:"seasonal_factor"`
	SeasonalPhase     *string            `json:"seasonal_phase"`
	SeasonalSource    *string            `json:"seasonal_source"`
}

type InventoryReplenishmentSummary struct {
	SKUCount                int                       `json:"sku_count"`
	OutOfStockRiskCount     int                       `json:"out_of_stock_risk_count"`
	HealthyCount            int                       `json:"healthy_count"`
	SlowMovingCount         int                       `json:"slow_moving_count"`
	PendingDataCount        int                       `json:"pending_data_count"`
	TotalAvailableInventory int                       `json:"total_available_inventory"`
	TotalInTransitQuantity  int                       `json:"total_in_transit_quantity"`
	CriticalCount           int                       `json:"critical_count"`
	DeterioratingCount      int                       `json:"deteriorating_count"`
	WatchCount              int                       `json:"watch_count"`
	HealthyCountV2          int                       `json:"healthy_count_v2"`
	UnknownCount            int                       `json:"unknown_count"`
	StateDistribution       map[string]int            `json:"state_distribution"`
	ActionDistribution      map[string]int            `json:"action_distribution"`
	StateActionMatrix       map[string]map[string]int `json:"state_action_matrix"`
}

type InventoryReplenishmentListItem struct {
	ProjectID                      int64                  `json:"project_id"`
	ProjectName                    string                 `json:"project_name"`
	SKU                            string                 `json:"sku"`
	Country                        string                 `json:"country"`
	ASIN                           *string                `json:"asin"`
	ProductName                    *string                `json:"product_name"`
	AvailableInventory             int                    `json:"available_inventory"`
	InTransitQuantity              int                    `json:"in_transit_quantity"`
	DMS30                          *float64               `json:"dms_30"`
	DMS14                          *float64               `json:"dms_14"`
	DMS7                           *float64               `json:"dms_7"`
	DMS3                           *float64               `json:"dms_3"`
	BaseDMS                        *float64               `json:"base_dms"`
	SafetyFactor                   float64                `json:"safety_factor"`
	ProductionLeadDays             int                    `json:"production_lead_days"`
	ShippingDays                   int                    `json:"shipping_days"`
	WeightedDMS                    *float64               `json:"weighted_dms"`
	SellableDays                   *float64               `json:"sellable_days"`
	SelloutDate                    *string                `json:"sellout_date"`
	SelloutDateWithTransit         *string                `json:"sellout_date_with_transit"`
	ReplenishmentOrderDate         *string                `json:"replenishment_order_date"`
	WarehouseEntryDate             *string                `json:"warehouse_entry_date"`
	ShipmentOrderDate              *string                `json:"shipment_order_date"`
	EstimatedReplenishmentQuantity *int                   `json:"estimated_replenishment_quantity"`
	RiskStatus                     string                 `json:"risk_status"`
	RiskAnchorDate                 *string                `json:"risk_anchor_date"`
	ProductionPlusShippingDays     int                    `json:"production_plus_shipping_days"`
	LatestOrderDate                *string                `json:"latest_order_date"`
	OrderBufferDays                *int                   `json:"order_buffer_days"`
	CoverageEndDate                *string                `json:"coverage_end_date"`
	GapDays                        int                    `json:"gap_days"`
	GapStartDate                   *string                `json:"gap_start_date"`
	NextTransitETA                 *string                `json:"next_transit_eta"`
	TargetDays                     int                    `json:"target_days"`
	InventoryState                 string                 `json:"inventory_state"`
	ReplenishmentAction            string                 `json:"replenishment_action"`
	Age0To90Qty                    int                    `json:"age_0_90_qty"`
	Age91To180Qty                  int                    `json:"age_91_180_qty"`
	Age181To270Qty                 int                    `json:"age_181_270_qty"`
	Age271To365Qty                 int                    `json:"age_271_365_qty"`
	Age365PlusQty                  int                    `json:"age_365_plus_qty"`
	RecommendedAction              *string                `json:"recommended_action"`
	DecisionPath                   *InventoryDecisionPath `json:"decision_path"`
	Signals                        *InventorySignals      `json:"signals"`
}

type InventoryReplenishmentListResponse struct {
	Items    []InventoryReplenishmentListItem `json:"items"`
	Summary  InventoryReplenishmentSummary    `json:"summary"`
	Total    int                              `json:"total"`
	Page     int                              `json:"page"`
	PageSize int                              `json:"page_size"`
	HasNext  bool                             `json:"has_next"`
}

type InventoryReplenishmentSettingUpdate struct {
	Country            string   `json:"country,omitempty"`
	ASIN               *string  `json:"asin"`
	SafetyFactor       *float64 `json:"safety_factor"`
	ProductionLeadDays *int     `json:"production_lead_days"`
	ShippingDays       *int     `json:"shipping_days"`
	TargetDays         *int     `json:"target_days"`
	BaseDMSOverride    *float64 `json:"base_dms_override,omitempty"`
}

type InventoryReplenishmentSettingItem struct {
	ID                 int64    `json:"-"`
	ProjectID          int64    `json:"project_id"`
	ProjectName        string   `json:"project_name"`
	SKU                string   `json:"sku"`
	Country            string   `json:"country"`
	ASIN               *string  `json:"asin"`
	SafetyFactor       float64  `json:"safety_factor"`
	ProductionLeadDays int      `json:"production_lead_days"`
	ShippingDays       int      `json:"shipping_days"`
	TargetDays         int      `json:"target_days"`
	BaseDMSOverride    *float64 `json:"-"`
	UpdatedAt          string   `json:"-"`
}

type InventoryReplenishmentShipmentItem struct {
	ShipmentNo     string  `json:"shipment_no"`
	SKU            string  `json:"sku"`
	Quantity       int     `json:"quantity"`
	ShippingMethod string  `json:"shipping_method"`
	EtdDate        *string `json:"etd_date"`
	EtaDate        *string `json:"eta_date"`
	ShipmentStatus string  `json:"shipment_status"`
}

type InventoryReplenishmentShipmentResponse struct {
	Items []InventoryReplenishmentShipmentItem `json:"items"`
}

type InventoryAnalysisItem struct {
	ProjectID              int64            `json:"project_id"`
	ProjectName            string           `json:"project_name"`
	Country                string           `json:"country"`
	SKU                    string           `json:"sku"`
	ASIN                   *string          `json:"asin"`
	ProductName            *string          `json:"product_name"`
	AvailableQty           int64            `json:"available_qty"`
	Age0To90Qty            int64            `json:"age_0_90_qty"`
	Age91To180Qty          int64            `json:"age_91_180_qty"`
	Age181To270Qty         int64            `json:"age_181_270_qty"`
	Age271To365Qty         int64            `json:"age_271_365_qty"`
	Age365PlusQty          int64            `json:"age_365_plus_qty"`
	RecommendedAction      *string          `json:"recommended_action"`
	RecommendedActionLabel string           `json:"recommended_action_label"`
	StockStatus            string           `json:"stock_status"`
	AgingStatus            string           `json:"aging_status"`
	ShipmentQuantities     map[string]int64 `json:"shipment_quantities"`
}

type InventoryAnalysisSummary struct {
	SKUCount            int   `json:"sku_count"`
	OutOfStockCount     int   `json:"out_of_stock_count"`
	AgingSKUCount       int   `json:"aging_sku_count"`
	OverAgedSKUCount    int   `json:"over_aged_sku_count"`
	TotalAvailableQty   int64 `json:"total_available_qty"`
	TotalAge0To90Qty    int64 `json:"total_age_0_90_qty"`
	TotalAge91To180Qty  int64 `json:"total_age_91_180_qty"`
	TotalAge181To270Qty int64 `json:"total_age_181_270_qty"`
	TotalAge271To365Qty int64 `json:"total_age_271_365_qty"`
	TotalAge365PlusQty  int64 `json:"total_age_365_plus_qty"`
	ActionTypeCount     int   `json:"action_type_count"`
}

type ShipmentColumn struct {
	ShipmentNo     string  `json:"shipment_no"`
	Label          string  `json:"label"`
	ShippingMethod *string `json:"shipping_method"`
	ForwarderName  *string `json:"forwarder_name"`
	EtdDate        *string `json:"etd_date"`
	EtaDate        *string `json:"eta_date"`
}

type InventoryAnalysisResponse struct {
	ProjectID            int64                    `json:"project_id"`
	ProjectName          string                   `json:"project_name"`
	Country              string                   `json:"country"`
	ReportDate           *string                  `json:"report_date"`
	Summary              InventoryAnalysisSummary `json:"summary"`
	ActionOptions        []string                 `json:"action_options"`
	Items                []InventoryAnalysisItem  `json:"items"`
	ShipmentColumns      []ShipmentColumn         `json:"shipment_columns"`
	ShipmentColumnTotals map[string]int64         `json:"shipment_column_totals"`
}

type InventorySnapshotOption struct {
	SnapshotDate string  `json:"snapshot_date"`
	Label        string  `json:"label"`
	IsCurrent    bool    `json:"is_current"`
	ID           *int64  `json:"id,omitempty"`
	Name         *string `json:"name,omitempty"`
}

type CalendarRowItem struct {
	Date   string `json:"date"`
	Action string `json:"action"`
	SKU    string `json:"sku"`
}

type CalendarResponse struct {
	Items []CalendarRowItem `json:"items"`
}

type SeasonalReplenishmentListItem struct {
	SKU    string  `json:"sku"`
	Phase  string  `json:"phase"`
	Factor float64 `json:"factor"`
}

type SeasonalReplenishmentListResponse struct {
	Items []SeasonalReplenishmentListItem `json:"items"`
}

type InventoryReplenishmentSnapshotSummary struct {
	SKUCount                int `json:"sku_count"`
	OutOfStockRiskCount     int `json:"out_of_stock_risk_count"`
	HealthyCount            int `json:"healthy_count"`
	SlowMovingCount         int `json:"slow_moving_count"`
	PendingDataCount        int `json:"pending_data_count"`
	TotalAvailableInventory int `json:"total_available_inventory"`
	TotalInTransitQuantity  int `json:"total_in_transit_quantity"`
}

type InventoryReplenishmentSnapshotListItem struct {
	ID                  int64                                 `json:"id"`
	ProjectID           int64                                 `json:"project_id"`
	ProjectName         string                                `json:"project_name"`
	Country             string                                `json:"country"`
	SnapshotDate        string                                `json:"snapshot_date"`
	IsCurrent           bool                                  `json:"is_current"`
	Name                *string                               `json:"name"`
	Description         *string                               `json:"description"`
	InventoryReportDate *string                               `json:"inventory_report_date"`
	BusinessReportDate  *string                               `json:"business_report_date"`
	SalesReportDate     *string                               `json:"sales_report_date"`
	RowCount            int                                   `json:"row_count"`
	CreatedBy           *string                               `json:"created_by"`
	CreatedAt           string                                `json:"created_at"`
	Summary             InventoryReplenishmentSnapshotSummary `json:"summary"`
}

type InventoryReplenishmentSnapshotItem struct {
	SourceRowNo                    int      `json:"source_row_no"`
	SKU                            string   `json:"sku"`
	ASIN                           *string  `json:"asin"`
	AvailableInventory             int      `json:"available_inventory"`
	InTransitQuantity              int      `json:"in_transit_quantity"`
	DMS30                          *float64 `json:"dms_30"`
	DMS14                          *float64 `json:"dms_14"`
	DMS7                           *float64 `json:"dms_7"`
	DMS3                           *float64 `json:"dms_3"`
	BaseDMS                        *float64 `json:"base_dms"`
	SafetyFactor                   float64  `json:"safety_factor"`
	ProductionLeadDays             int      `json:"production_lead_days"`
	ShippingDays                   int      `json:"shipping_days"`
	WeightedDMS                    *float64 `json:"weighted_dms"`
	SellableDays                   *float64 `json:"sellable_days"`
	SelloutDate                    *string  `json:"sellout_date"`
	SelloutDateWithTransit         *string  `json:"sellout_date_with_transit"`
	ReplenishmentOrderDate         *string  `json:"replenishment_order_date"`
	WarehouseEntryDate             *string  `json:"warehouse_entry_date"`
	ShipmentOrderDate              *string  `json:"shipment_order_date"`
	EstimatedReplenishmentQuantity *int     `json:"estimated_replenishment_quantity"`
	RiskStatus                     string   `json:"risk_status"`
	RiskAnchorDate                 *string  `json:"risk_anchor_date"`
}

type InventoryReplenishmentSnapshotDetail struct {
	InventoryReplenishmentSnapshotListItem
	Items []InventoryReplenishmentSnapshotItem `json:"items"`
}

type CreateSnapshotRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

type UpdateSnapshotRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

type ReplenishmentFilter struct {
	ProjectID    *int64
	ProjectIDs   []int64
	Country      *string
	RiskStatus   *string
	Keyword      *string
	SnapshotDate *string
	ReportDate   *string
	Page         int
	PageSize     int
	Operator     string
	IsAdmin      bool
}

type SnapshotItemsFilter struct {
	Keyword       *string
	RiskStatus    *string
	InTransitOnly bool
	Page          int
	PageSize      int
}

type Store interface {
	GetInventoryAnalysis(ctx context.Context, filter ReplenishmentFilter) (InventoryAnalysisResponse, error)
	ListSnapshotOptions(ctx context.Context, projectID *int64, country *string) ([]InventorySnapshotOption, error)
	ListAnalysis(ctx context.Context, filter ReplenishmentFilter) (InventoryReplenishmentListResponse, error)
	UpdateSetting(ctx context.Context, projectID int64, sku string, update InventoryReplenishmentSettingUpdate, op string) (InventoryReplenishmentSettingItem, error)
	ListShipments(ctx context.Context, projectID *int64, country *string) (InventoryReplenishmentShipmentResponse, error)
	ListCalendar(ctx context.Context, projectID *int64, country *string) (CalendarResponse, error)
	ListSeasonal(ctx context.Context, projectID *int64, country *string) (SeasonalReplenishmentListResponse, error)
	ListSnapshots(ctx context.Context, projectID *int64, country *string) ([]InventoryReplenishmentSnapshotListItem, error)
	GetSnapshot(ctx context.Context, snapshotID int64) (*InventoryReplenishmentSnapshotListItem, error)
	ListSnapshotItems(ctx context.Context, snapshotID int64) ([]InventoryReplenishmentSnapshotItem, error)
	ListSnapshotItemsPage(ctx context.Context, snapshot *InventoryReplenishmentSnapshotListItem, filter SnapshotItemsFilter) (InventoryReplenishmentListResponse, error)
	CreateSnapshot(ctx context.Context, projectID int64, country string, req CreateSnapshotRequest, op string) (InventoryReplenishmentSnapshotListItem, error)
	UpdateSnapshot(ctx context.Context, snapshotID int64, req UpdateSnapshotRequest, op string) (*InventoryReplenishmentSnapshotListItem, error)
	DeleteSnapshot(ctx context.Context, snapshotID int64, op string) (bool, error)
	VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error
}

func (summary InventoryReplenishmentSnapshotSummary) ReplenishmentSummary() InventoryReplenishmentSummary {
	return InventoryReplenishmentSummary{
		SKUCount:                summary.SKUCount,
		OutOfStockRiskCount:     summary.OutOfStockRiskCount,
		HealthyCount:            summary.HealthyCount,
		SlowMovingCount:         summary.SlowMovingCount,
		PendingDataCount:        summary.PendingDataCount,
		TotalAvailableInventory: summary.TotalAvailableInventory,
		TotalInTransitQuantity:  summary.TotalInTransitQuantity,
		StateDistribution:       map[string]int{},
		ActionDistribution:      map[string]int{},
		StateActionMatrix:       map[string]map[string]int{},
	}
}
