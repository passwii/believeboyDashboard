package order_info

import (
	"context"
	"errors"
	"strings"
)

var (
	ErrOrderNotFound  = errors.New("订单不存在")
	ErrOrderForbidden = errors.New("无权限编辑该项目下的订单")
)

type OrderInfoItem struct {
	ID                 int64   `json:"id"`
	ProjectID          int64   `json:"project_id"`
	ProjectName        string  `json:"project_name"`
	BrandName          *string `json:"brand_name"`
	SourceFileID       int64   `json:"source_file_id"`
	PurchaseAtUTC      string  `json:"purchase_at_utc"`
	PurchaseAtPT       string  `json:"purchase_at_pt"`
	PurchaseDatePT     string  `json:"purchase_date_pt"`
	AmazonOrderID      string  `json:"amazon_order_id"`
	OrderStatus        string  `json:"order_status"`
	FulfillmentChannel string  `json:"fulfillment_channel"`
	FulfillmentLabel   string  `json:"fulfillment_label"`
	ShipServiceLevel   *string `json:"ship_service_level"`
	SKU                *string `json:"sku"`
	ASIN               *string `json:"asin"`
	ProductName        *string `json:"product_name"`
	Quantity           int     `json:"quantity"`
	ItemPrice          float64 `json:"item_price"`
	ShippingPrice      float64 `json:"shipping_price"`
	Currency           *string `json:"currency"`
	Country            string  `json:"country"`
	State              *string `json:"state"`
	City               *string `json:"city"`
	PostalCode         *string `json:"postal_code"`
	IsCountedSales     bool    `json:"is_counted_sales"`
	CreatedAt          string  `json:"created_at"`
	Carrier            *string `json:"carrier"`
	TrackingNo         *string `json:"tracking_no"`
	ShippedAt          *string `json:"shipped_at"`
	UpdatedBy          *string `json:"updated_by"`
	UpdatedAt          *string `json:"updated_at"`
}

type OrderInfoListResponse struct {
	Items    []OrderInfoItem `json:"items"`
	Total    int             `json:"total"`
	Page     int             `json:"page"`
	PageSize int             `json:"page_size"`
}

type FilterOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type OrderInfoFilterOptions struct {
	Projects            []FilterOption `json:"projects"`
	OrderStatuses       []FilterOption `json:"order_statuses"`
	FulfillmentChannels []FilterOption `json:"fulfillment_channels"`
	Countries           []FilterOption `json:"countries"`
	Currencies          []FilterOption `json:"currencies"`
}

type OrderInfoStats struct {
	TotalOrders   int     `json:"total_orders"`
	TotalQuantity int     `json:"total_quantity"`
	TotalAmount   float64 `json:"total_amount"`
	Currency      *string `json:"currency"`
	FBACount      int     `json:"fba_count"`
	FBMCount      int     `json:"fbm_count"`
}

type OrderInfoPageData struct {
	Items         []OrderInfoItem        `json:"items"`
	Total         int                    `json:"total"`
	Page          int                    `json:"page"`
	PageSize      int                    `json:"page_size"`
	Stats         OrderInfoStats         `json:"stats"`
	FilterOptions OrderInfoFilterOptions `json:"filter_options"`
}

type OrderInfoOverview struct {
	Items    []OrderInfoItem `json:"items"`
	Total    int             `json:"total"`
	Page     int             `json:"page"`
	PageSize int             `json:"page_size"`
	Stats    OrderInfoStats  `json:"stats"`
}

type OrderInfoExportRequest struct {
	ProjectIDs          []int64  `json:"project_ids"`
	FulfillmentChannels []string `json:"fulfillment_channels"`
	OrderStatuses       []string `json:"order_statuses"`
	Countries           []string `json:"countries"`
	Currencies          []string `json:"currencies"`
	SKUKeyword          *string  `json:"sku_keyword"`
	OrderIDKeyword      *string  `json:"order_id_keyword"`
	ASINKeyword         *string  `json:"asin_keyword"`
	DateFrom            *string  `json:"date_from"`
	DateTo              *string  `json:"date_to"`
}

type OrderInfoExportResponse struct {
	Filename      string `json:"filename"`
	ContentType   string `json:"content_type"`
	ContentBase64 string `json:"content_base64"`
}

type OrderLiveStreamItem struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	TimeLabel   string  `json:"time_label"`
	OccurredAt  string  `json:"occurred_at"`
	ProjectID   int64   `json:"project_id"`
	ProjectName *string `json:"project_name"`
	Country     *string `json:"country"`
	Currency    *string `json:"currency"`
	Amount      float64 `json:"amount"`
	Quantity    int     `json:"quantity"`
	OrderStatus *string `json:"order_status"`
}

type OrderInfoUpdate struct {
	Carrier    *string `json:"carrier"`
	TrackingNo *string `json:"tracking_no"`
	ShippedAt  *string `json:"shipped_at"`
	UpdatedBy  *string `json:"updated_by"`
}

type OrderInfoFilter struct {
	ProjectIDs          []int64
	FulfillmentChannels []string
	OrderStatuses       []string
	Countries           []string
	Currencies          []string
	SKUKeyword          *string
	OrderIDKeyword      *string
	ASINKeyword         *string
	DateFrom            *string
	DateTo              *string
	SortBy              string
	SortDir             string
	Page                int
	PageSize            int
	Offset              int
	Operator            string
	IsAdmin             bool
}

type Store interface {
	GetPageData(ctx context.Context, filter OrderInfoFilter) (OrderInfoPageData, error)
	ListOrders(ctx context.Context, filter OrderInfoFilter) (OrderInfoListResponse, error)
	ComputeStats(ctx context.Context, filter OrderInfoFilter) (OrderInfoStats, error)
	GetOverview(ctx context.Context, filter OrderInfoFilter) (OrderInfoOverview, error)
	CollectFilterOptions(ctx context.Context, operator string, isAdmin bool) (OrderInfoFilterOptions, error)
	QueryLiveStream(ctx context.Context, projectIDs []int64, countries []string, limit int, operator string, isAdmin bool) ([]OrderLiveStreamItem, error)
	ExportOrders(ctx context.Context, filter OrderInfoFilter) (string, []byte, error)
	GetOrderByID(ctx context.Context, id int64) (*OrderInfoItem, error)
	UpdateOrderByID(ctx context.Context, id int64, update OrderInfoUpdate, operator string, isAdmin bool) (*OrderInfoItem, error)
}

func FulfillmentLabel(channel string) string {
	switch strings.TrimSpace(channel) {
	case "Amazon", "FBA":
		return "FBA（亚马逊配送）"
	case "Merchant", "FBM":
		return "FBM（自发货配送）"
	default:
		return channel
	}
}
