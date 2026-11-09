package digital_display

import (
	"context"
	"errors"
	"strings"
	"time"
)

var (
	ErrProjectNotFound = errors.New("项目不存在")
	ErrInvalidCountry  = errors.New("country must be one of: DE, UK, US")
)

type SalesSnapshot struct {
	TodayOrderQty           int     `json:"today_order_qty"`
	TodaySalesAmount        float64 `json:"today_sales_amount"`
	TodaySessions           int     `json:"today_sessions"`
	TodayOrderedSalesAmount float64 `json:"today_ordered_sales_amount"`
	PrevOrderQty            int     `json:"prev_order_qty"`
	PrevSalesAmount         float64 `json:"prev_sales_amount"`
	PrevSessions            int     `json:"prev_sessions"`
}

type SalesTrendItem struct {
	Date        string  `json:"date"`
	OrderQty    int     `json:"order_qty"`
	SalesAmount float64 `json:"sales_amount"`
	Sessions    int     `json:"sessions"`
}

type InventorySnapshot struct {
	SKUCount        int `json:"sku_count"`
	OutOfStockCount int `json:"out_of_stock_count"`
	AvailableQty    int `json:"available_qty"`
}

type ShipmentSnapshot struct {
	InTransitCount int `json:"in_transit_count"`
	InTransitQty   int `json:"in_transit_qty"`
}

type ReturnSnapshot struct {
	TotalReturns  int     `json:"total_returns"`
	TotalQuantity int     `json:"total_quantity"`
	ReturnRate    float64 `json:"return_rate"`
	TopReason     *string `json:"top_reason"`
}

type AdSnapshot struct {
	PeriodSpend       float64 `json:"period_spend"`
	PeriodSales       float64 `json:"period_sales"`
	PeriodROAS        float64 `json:"period_roas"`
	PeriodACOS        float64 `json:"period_acos"`
	PeriodCTR         float64 `json:"period_ctr"`
	PeriodImpressions int     `json:"period_impressions"`
	PeriodClicks      int     `json:"period_clicks"`
	PeriodOrders      int     `json:"period_orders"`
}

type Response struct {
	ProjectID   int64             `json:"project_id"`
	ProjectName string            `json:"project_name"`
	Country     string            `json:"country"`
	ServerTime  string            `json:"server_time"`
	Sales       SalesSnapshot     `json:"sales"`
	SalesTrend  []SalesTrendItem  `json:"sales_trend"`
	Inventory   InventorySnapshot `json:"inventory"`
	Shipments   ShipmentSnapshot  `json:"shipments"`
	Returns     ReturnSnapshot    `json:"returns"`
	Ads         AdSnapshot        `json:"ads"`
}

type Store interface {
	BuildDigitalDisplay(
		ctx context.Context,
		projectID int64,
		country string,
		days int,
		now time.Time,
	) (Response, error)
}

func NormalizeCountry(value string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	switch normalized {
	case "", "US", "USA", "美国", "美国站":
		return "US", nil
	case "DE", "GERMANY", "德国", "德国站":
		return "DE", nil
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK", nil
	default:
		return "", ErrInvalidCountry
	}
}
