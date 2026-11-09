package shipment_schedules

import (
	"context"
	"errors"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
)

type ShipmentScheduleListItem struct {
	ID                           int64   `json:"id"`
	ProjectID                    int64   `json:"project_id"`
	ProjectName                  string  `json:"project_name"`
	Country                      string  `json:"country"`
	ShipmentNo                   string  `json:"shipment_no"`
	TrackingNo                   *string `json:"tracking_no"`
	WarehouseCode                *string `json:"warehouse_code"`
	ForwarderName                *string `json:"forwarder_name"`
	ShippingMethod               string  `json:"shipping_method"`
	CreatedDate                  *string `json:"created_date"`
	EtdDate                      *string `json:"etd_date"`
	EtaDate                      *string `json:"eta_date"`
	ActualInboundDate            *string `json:"actual_inbound_date"`
	ShipmentStatus               string  `json:"shipment_status"`
	Remark                       *string `json:"remark"`
	SKUCount                     int     `json:"sku_count"`
	TotalQuantity                int     `json:"total_quantity"`
	LogisticsUnitPrice           float64 `json:"logistics_unit_price"`
	TotalVolumeM3                float64 `json:"total_volume_m3"`
	TotalChargeableWeightKG      float64 `json:"total_chargeable_weight_kg"`
	LogisticsTotalPrice          float64 `json:"logistics_total_price"`
	IncludeInHistoryShippingCalc bool    `json:"include_in_history_shipping_calc"`
	UpdatedAt                    string  `json:"updated_at"`
	ShipmentBatch                *string `json:"shipment_batch"`
}

type ShipmentScheduleListResponse struct {
	Items    []ShipmentScheduleListItem `json:"items"`
	Page     int                        `json:"page"`
	PageSize int                        `json:"page_size"`
	Total    *int                       `json:"total"`
	HasNext  bool                       `json:"has_next"`
}

type ShipmentScheduleCostSummary struct {
	ShipmentCount           int     `json:"shipment_count"`
	TotalSKU                int     `json:"total_sku"`
	TotalQuantity           int     `json:"total_quantity"`
	TotalChargeableWeightKG float64 `json:"total_chargeable_weight_kg"`
	TotalLogisticsCost      float64 `json:"total_logistics_cost"`
}

type ShipmentScheduleItemRow struct {
	ID                        int64   `json:"id"`
	ItemDate                  *string `json:"item_date"`
	SKU                       string  `json:"sku"`
	Quantity                  int     `json:"quantity"`
	CartonCount               *int    `json:"carton_count"`
	Remark                    *string `json:"remark"`
	VolumeM3                  float64 `json:"volume_m3"`
	ActualWeightKG            float64 `json:"actual_weight_kg"`
	VolumetricWeightKG        float64 `json:"volumetric_weight_kg"`
	ChargeableWeightKG        float64 `json:"chargeable_weight_kg"`
	EstimatedLogisticsCost    float64 `json:"estimated_logistics_cost"`
	AverageLogisticsUnitPrice float64 `json:"average_logistics_unit_price"`
}

type ShipmentScheduleItemInput struct {
	SKU         string  `json:"sku"`
	Quantity    int     `json:"quantity"`
	CartonCount *int    `json:"carton_count"`
	ItemDate    *string `json:"item_date"`
	Remark      *string `json:"remark"`
}

type ShipmentScheduleDetail struct {
	ID                           int64                     `json:"id"`
	ProjectID                    int64                     `json:"project_id"`
	ProjectName                  string                    `json:"project_name"`
	Country                      string                    `json:"country"`
	ShipmentNo                   string                    `json:"shipment_no"`
	TrackingNo                   *string                   `json:"tracking_no"`
	WarehouseCode                *string                   `json:"warehouse_code"`
	ForwarderName                *string                   `json:"forwarder_name"`
	ShippingMethod               string                    `json:"shipping_method"`
	CreatedDate                  *string                   `json:"created_date"`
	EtdDate                      *string                   `json:"etd_date"`
	EtaDate                      *string                   `json:"eta_date"`
	ActualInboundDate            *string                   `json:"actual_inbound_date"`
	Remark                       *string                   `json:"remark"`
	ShipmentStatus               string                    `json:"shipment_status"`
	SKUCount                     int                       `json:"sku_count"`
	TotalQuantity                int                       `json:"total_quantity"`
	LogisticsUnitPrice           float64                   `json:"logistics_unit_price"`
	TotalVolumeM3                float64                   `json:"total_volume_m3"`
	TotalChargeableWeightKG      float64                   `json:"total_chargeable_weight_kg"`
	LogisticsTotalPrice          float64                   `json:"logistics_total_price"`
	IncludeInHistoryShippingCalc bool                      `json:"include_in_history_shipping_calc"`
	Items                        []ShipmentScheduleItemRow `json:"items"`
	UpdatedAt                    string                    `json:"updated_at"`
	ShipmentBatch                *string                   `json:"shipment_batch"`
}

type ShipmentCostCalculateRequest struct {
	LogisticsUnitPrice float64 `json:"logistics_unit_price"`
}

type ShipmentScheduleCreate struct {
	ProjectID                    int64                       `json:"project_id"`
	Country                      string                      `json:"country"`
	ShipmentNo                   string                      `json:"shipment_no"`
	TrackingNo                   *string                     `json:"tracking_no"`
	WarehouseCode                *string                     `json:"warehouse_code"`
	ForwarderName                *string                     `json:"forwarder_name"`
	ShippingMethod               string                      `json:"shipping_method"`
	CreatedDate                  *string                     `json:"created_date"`
	EtdDate                      *string                     `json:"etd_date"`
	EtaDate                      *string                     `json:"eta_date"`
	ActualInboundDate            *string                     `json:"actual_inbound_date"`
	LogisticsUnitPrice           float64                     `json:"logistics_unit_price"`
	IncludeInHistoryShippingCalc bool                        `json:"include_in_history_shipping_calc"`
	Remark                       *string                     `json:"remark"`
	ShipmentStatus               string                      `json:"shipment_status"`
	SourceFile                   *string                     `json:"source_file"`
	ShipmentBatch                *string                     `json:"shipment_batch"`
	Items                        []ShipmentScheduleItemInput `json:"items"`
}

type ShipmentScheduleUpdate struct {
	ProjectID                    int64                       `json:"project_id"`
	Country                      string                      `json:"country"`
	ShipmentNo                   string                      `json:"shipment_no"`
	TrackingNo                   *string                     `json:"tracking_no"`
	WarehouseCode                *string                     `json:"warehouse_code"`
	ForwarderName                *string                     `json:"forwarder_name"`
	ShippingMethod               string                      `json:"shipping_method"`
	CreatedDate                  *string                     `json:"created_date"`
	EtdDate                      *string                     `json:"etd_date"`
	EtaDate                      *string                     `json:"eta_date"`
	ActualInboundDate            *string                     `json:"actual_inbound_date"`
	LogisticsUnitPrice           float64                     `json:"logistics_unit_price"`
	IncludeInHistoryShippingCalc bool                        `json:"include_in_history_shipping_calc"`
	Remark                       *string                     `json:"remark"`
	ShipmentStatus               string                      `json:"shipment_status"`
	SourceFile                   *string                     `json:"source_file"`
	Items                        []ShipmentScheduleItemInput `json:"items"`
	ShipmentBatch                *string                     `json:"shipment_batch"`
}

type ShipmentItemsImportResponse struct {
	ShipmentScheduleID int64  `json:"shipment_schedule_id"`
	ShipmentNo         string `json:"shipment_no"`
	Inserted           int    `json:"inserted"`
	Replaced           int    `json:"replaced"`
	TotalQuantity      int    `json:"total_quantity"`
}

type ShipmentSchedulesImportResponse struct {
	Inserted    int      `json:"inserted"`
	ShipmentNos []string `json:"shipment_nos"`
}

type ShipmentSkuSummaryItem struct {
	ProjectID                 int64   `json:"project_id"`
	ProjectName               string  `json:"project_name"`
	Country                   string  `json:"country"`
	SKU                       string  `json:"sku"`
	ShipmentCount             int     `json:"shipment_count"`
	TotalQuantity             int     `json:"total_quantity"`
	TotalChargeableWeightKG   float64 `json:"total_chargeable_weight_kg"`
	TotalLogisticsCost        float64 `json:"total_logistics_cost"`
	AverageLogisticsUnitPrice float64 `json:"average_logistics_unit_price"`
}

type ShipmentSkuSummaryResponse struct {
	Items []ShipmentSkuSummaryItem `json:"items"`
}

type ShipmentFbaBoxDetailItem struct {
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
}

type ShipmentFbaBoxDetailResponse struct {
	ProjectIDs   []int64                    `json:"project_ids"`
	ProjectNames []string                   `json:"project_names"`
	Countries    []string                   `json:"countries"`
	ShipmentNos  []string                   `json:"shipment_nos"`
	Items        []ShipmentFbaBoxDetailItem `json:"items"`
}

type ShipmentBatchHiddenDeleteRequest struct {
	ProjectID     int64  `json:"project_id"`
	Country       string `json:"country"`
	ShipmentBatch string `json:"shipment_batch"`
}

type ShipmentFilter struct {
	ProjectID      *int64
	ProjectIDs     []int64
	Operator       string
	IsAdmin        bool
	Country        *string
	Keyword        *string
	ShipmentStatus *string
	StartDate      *string
	EndDate        *string
	Page           int
	PageSize       int
	IncludeTotal   bool
}

var (
	ErrForbidden = errors.New("无权限访问该项目")
	ErrNotFound  = errors.New("排期不存在")
)

type ProjectReader interface {
	GetProject(ctx context.Context, id int64) (*projects.ProjectItem, error)
	ListManage(ctx context.Context, operator string, isAdmin bool, isLeader bool) ([]projects.ProjectItem, error)
}

type Store interface {
	ListShipmentSchedules(ctx context.Context, filter ShipmentFilter) (ShipmentScheduleListResponse, error)
	SummarizeCosts(ctx context.Context, projectID *int64, projectIDs []int64, country, startDate, endDate *string) (ShipmentScheduleCostSummary, error)
	ListSkuSummary(ctx context.Context, projectID *int64, country, startDate, endDate *string) (ShipmentSkuSummaryResponse, error)
	ListFbaBoxDetails(ctx context.Context, projectIDs []int64, countries, shipmentNos []string) (ShipmentFbaBoxDetailResponse, error)
	ListBatches(ctx context.Context, projectID *int64, projectIDs []int64, country *string) ([]string, error)
	HideBatch(ctx context.Context, req ShipmentBatchHiddenDeleteRequest) (bool, error)
	GetShipmentSchedule(ctx context.Context, id int64) (*ShipmentScheduleDetail, error)
	CreateShipmentSchedule(ctx context.Context, create ShipmentScheduleCreate, op string) (ShipmentScheduleDetail, error)
	UpdateShipmentSchedule(ctx context.Context, id int64, update ShipmentScheduleUpdate, op string) (*ShipmentScheduleDetail, error)
	DeleteShipmentSchedule(ctx context.Context, id int64) (bool, error)
	ImportSchedulesCSV(ctx context.Context, data []byte, op string, isAdmin bool) (ShipmentSchedulesImportResponse, error)
	ImportItemsCSV(ctx context.Context, id int64, data []byte, op string) (ShipmentItemsImportResponse, error)
	CalculateCosts(ctx context.Context, id int64, req ShipmentCostCalculateRequest) (*ShipmentScheduleDetail, error)
}
