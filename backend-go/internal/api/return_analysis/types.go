package return_analysis

import (
	"context"
	"errors"
	"strings"
)

var (
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限访问该项目")
)

type ReturnRankingItem struct {
	SKU                string   `json:"sku"`
	ASIN               *string  `json:"asin"`
	ProductName        *string  `json:"product_name"`
	TotalQuantity      int      `json:"total_quantity"`
	ReturnCount        int      `json:"return_count"`
	SalesQuantity      int      `json:"sales_quantity"`
	ReturnRate         *float64 `json:"return_rate"`
	AvgReturnCycleDays *float64 `json:"avg_return_cycle_days"`
	MinReturnCycleDays *int     `json:"min_return_cycle_days"`
	MaxReturnCycleDays *int     `json:"max_return_cycle_days"`
}

type ReturnDataSpan struct {
	MinReturnDate *string `json:"min_return_date"`
	MaxReturnDate *string `json:"max_return_date"`
}

type ReturnReasonItem struct {
	Reason        string  `json:"reason"`
	ReasonDisplay string  `json:"reason_display"`
	TotalQuantity int     `json:"total_quantity"`
	ReturnCount   int     `json:"return_count"`
	Percentage    float64 `json:"percentage"`
}

type ReturnTrendItem struct {
	Date          string   `json:"date"`
	TotalQuantity int      `json:"total_quantity"`
	ReturnCount   int      `json:"return_count"`
	SalesQuantity int      `json:"sales_quantity"`
	SalesAmount   float64  `json:"sales_amount"`
	ReturnRate    *float64 `json:"return_rate"`
}

type DispositionItem struct {
	DetailedDisposition string  `json:"detailed_disposition"`
	DispositionDisplay  string  `json:"disposition_display"`
	TotalQuantity       int     `json:"total_quantity"`
	ReturnCount         int     `json:"return_count"`
	Percentage          float64 `json:"percentage"`
}

type StatusItem struct {
	Status        string  `json:"status"`
	StatusDisplay string  `json:"status_display"`
	TotalQuantity int     `json:"total_quantity"`
	ReturnCount   int     `json:"return_count"`
	Percentage    float64 `json:"percentage"`
}

type WeekdayItem struct {
	Weekday        int     `json:"weekday"`
	WeekdayDisplay string  `json:"weekday_display"`
	ReturnCount    int     `json:"return_count"`
	Percentage     float64 `json:"percentage"`
}

type FulfillmentCenterItem struct {
	FulfillmentCenterID string  `json:"fulfillment_center_id"`
	ReturnCount         int     `json:"return_count"`
	Quantity            int     `json:"quantity"`
	Percentage          float64 `json:"percentage"`
}

type CustomerFeedbackItem struct {
	SKU             string `json:"sku"`
	OrderID         string `json:"order_id"`
	Reason          string `json:"reason"`
	ReasonDisplay   string `json:"reason_display"`
	CustomerComment string `json:"customer_comment"`
	ReturnDate      string `json:"return_date"`
}

type ReturnAnalysisSummary struct {
	TotalReturns           int             `json:"total_returns"`
	TotalQuantity          int             `json:"total_quantity"`
	UniqueSKUs             int             `json:"unique_skus"`
	TopReturnSKU           *string         `json:"top_return_sku"`
	TopReturnReason        *string         `json:"top_return_reason"`
	TopReturnReasonDisplay *string         `json:"top_return_reason_display"`
	TotalSalesQuantity     int             `json:"total_sales_quantity"`
	TotalSalesAmount       float64         `json:"total_sales_amount"`
	OverallReturnRate      float64         `json:"overall_return_rate"`
	DataAvailable          bool            `json:"data_available"`
	DataSpan               *ReturnDataSpan `json:"data_span"`
}

type ReturnAnalysisResponse struct {
	ProjectID               int64                   `json:"project_id"`
	ProjectName             string                  `json:"project_name"`
	Country                 string                  `json:"country"`
	StartDate               string                  `json:"start_date"`
	EndDate                 string                  `json:"end_date"`
	Summary                 ReturnAnalysisSummary   `json:"summary"`
	SummaryText             string                  `json:"summary_text"`
	RankingRows             []ReturnRankingItem     `json:"ranking_rows"`
	RankingTruncated        bool                    `json:"ranking_truncated"`
	RankingTotalCount       int                     `json:"ranking_total_count"`
	ReasonRows              []ReturnReasonItem      `json:"reason_rows"`
	TrendRows               []ReturnTrendItem       `json:"trend_rows"`
	DispositionRows         []DispositionItem       `json:"disposition_rows"`
	StatusRows              []StatusItem            `json:"status_rows"`
	FeedbackRows            []CustomerFeedbackItem  `json:"feedback_rows"`
	WeekdayRows             []WeekdayItem           `json:"weekday_rows"`
	FulfillmentCenterRows   []FulfillmentCenterItem `json:"fulfillment_center_rows"`
	MultiItemReturnCount    int                     `json:"multi_item_return_count"`
	MultiItemReturnQuantity int                     `json:"multi_item_return_quantity"`
}

type ReturnRawRowItem struct {
	ReturnDate             string  `json:"return_date"`
	OriginalReturnDatetime string  `json:"original_return_datetime"`
	OrderID                string  `json:"order_id"`
	SKU                    string  `json:"sku"`
	ASIN                   *string `json:"asin"`
	FNSKU                  *string `json:"fnsku"`
	ProductName            *string `json:"product_name"`
	Quantity               int     `json:"quantity"`
	FulfillmentCenterID    *string `json:"fulfillment_center_id"`
	DetailedDisposition    string  `json:"detailed_disposition"`
	DispositionDisplay     string  `json:"disposition_display"`
	Reason                 string  `json:"reason"`
	ReasonDisplay          string  `json:"reason_display"`
	Status                 string  `json:"status"`
	StatusDisplay          string  `json:"status_display"`
	LicensePlateNumber     *string `json:"license_plate_number"`
	CustomerComment        *string `json:"customer_comment"`
}

type ReturnRawRowsResponse struct {
	ProjectID int64              `json:"project_id"`
	Country   string             `json:"country"`
	StartDate string             `json:"start_date"`
	EndDate   string             `json:"end_date"`
	RowCount  int                `json:"row_count"`
	Rows      []ReturnRawRowItem `json:"rows"`
}

type ReturnAnalysisFilter struct {
	ProjectID int64
	Country   string
	StartDate string
	EndDate   string
	SKU       *string
	Operator  string
	IsAdmin   bool
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	GetReturnAnalysis(ctx context.Context, filter ReturnAnalysisFilter) (*ReturnAnalysisResponse, error)
	GetRawRows(ctx context.Context, filter ReturnAnalysisFilter, limit int) ([]ReturnRawRowItem, error)
}

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

var returnReasonMap = map[string]string{
	"DEFECTIVE":                              "有缺陷",
	"QUALITY_UNACCEPTABLE":                   "质量不合格",
	"WARRANTY":                               "保修期内损坏",
	"MISSING_PARTS":                          "缺少配件",
	"EXTRA_ITEM":                             "多发货品",
	"UNWANTED_ITEM":                          "不需要",
	"NO_REASON_GIVEN":                        "未说明原因",
	"CHANGED_MIND":                           "改变主意",
	"FOUND_BETTER_PRICE":                     "找到更低价",
	"NOT_AS_DESCRIBED":                       "与描述不符",
	"SWITCHEROO":                             "与订单不符",
	"ORDERED_WRONG_ITEM":                     "误购商品",
	"MISORDERED":                             "订错款式尺码",
	"WRONG_ITEM":                             "错发商品",
	"APPAREL_TOO_LARGE":                      "服装过大",
	"APPAREL_TOO_SMALL":                      "服装过小",
	"APPAREL_STYLE":                          "款式问题",
	"DID_NOT_LIKE_FABRIC":                    "不喜欢面料",
	"DID_NOT_LIKE_COLOR":                     "不喜欢颜色",
	"POOR_FIT":                               "不合身",
	"JEWELRY_TOO_SMALL":                      "首饰过小或过短",
	"JEWELRY_TOO_LARGE":                      "首饰过大或过长",
	"JEWELRY_BATTERY":                        "首饰电池失效",
	"JEWELRY_NO_DOCS":                        "首饰缺少说明书或保修卡",
	"JEWELRY_BAD_CLASP":                      "首饰搭扣损坏",
	"JEWELRY_LOOSE_STONE":                    "首饰宝石脱落或松动",
	"JEWELRY_NO_CERT":                        "首饰缺少承诺的证书",
	"JEWELRY_TARNISHED":                      "首饰氧化变色",
	"NOT_COMPATIBLE":                         "不兼容",
	"PART_NOT_COMPATIBLE":                    "配件不兼容",
	"DAMAGED_BY_FC":                          "仓库致损",
	"DAMAGED_BY_CARRIER":                     "运输致损",
	"MISSED_ESTIMATED_DELIVERY":              "配送超时",
	"NEVER_ARRIVED":                          "未收到",
	"LATE_ARRIVAL":                           "到货延迟",
	"UNDELIVERABLE_UNKNOWN":                  "无法投递",
	"UNDELIVERABLE_REFUSED":                  "无法投递（拒收）",
	"UNDELIVERABLE_UNCLAIMED":                "无法投递（无人认领）",
	"UNDELIVERABLE_INSUFFICIENT_ADDRESS":     "无法投递（地址不详）",
	"UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS": "无法投递（多次派送失败）",
	"UNAUTHORIZED_PURCHASE":                  "未经授权购买",
	"OTHER":                                  "其他",
	"NOT_AS_PHOTO":                           "与图片不符",
	"WRONG_SIZE":                             "尺码错误",
	"NOT_COMFORTABLE":                        "穿着不舒适",
	"EXCESSIVE_INSTALLATION":                 "无法安装",
	"ACTIVATION_FAILURE":                     "激活失败",
	"CARRIER_BILL_NOT_AS_EXPECTED":           "承运商账单不符预期",
	"CARRIER_SWITCHING_COST":                 "承运商切换成本",
}

var returnReasonAliases = map[string]string{
	"AMZ-PG-WJ-TOO-LARGE":    "JEWELRY_TOO_LARGE",
	"AMZ-PG-WJ-TOO-SMALL":    "JEWELRY_TOO_SMALL",
	"AMZ-PG-WJ-BATTERY":      "JEWELRY_BATTERY",
	"AMZ-PG-WJ-NO-DOCS":      "JEWELRY_NO_DOCS",
	"AMZ-PG-WJ-BAD-CLASP":    "JEWELRY_BAD_CLASP",
	"AMZ-PG-WJ-LOOSE-STONE":  "JEWELRY_LOOSE_STONE",
	"AMZ-PG-WJ-NO-CERT":      "JEWELRY_NO_CERT",
	"AMZ-PG-WJ-TARNISHED":    "JEWELRY_TARNISHED",
	"AMZ-PG-APP-STYLE":       "APPAREL_STYLE",
	"AMZ-PG-APP-TOO-LARGE":   "APPAREL_TOO_LARGE",
	"AMZ-PG-APP-TOO-SMALL":   "APPAREL_TOO_SMALL",
	"AMZ-PG-BAD-DESC":        "NOT_AS_DESCRIBED",
	"AMZ-PG-MISORDERED":      "MISORDERED",
	"CR-MISSING_ITEM_IN_SET": "MISSING_PARTS",
}

var dispositionMap = map[string]string{
	"SELLABLE":            "可售",
	"CUSTOMER_DAMAGED":    "顾客损坏",
	"DAMAGED_BY_CUSTOMER": "顾客损坏",
	"CARRIER_DAMAGED":     "运输损坏",
	"DEFECTIVE":           "有缺陷",
	"DAMAGED":             "亚马逊致损",
	"EXPIRED":             "已过期",
}

var statusMap = map[string]string{
	"Unit returned to inventory": "退回库存",
	"Reimbursed":                 "已赔偿",
	"IMMEDIATE_LIQUIDATION":      "立即清算",
	"Immediate liquidation":      "立即清算",
	"Liquidated":                 "已清算",
	"Refunded":                   "已退款",
	"IMMEDIATE_DONATION":         "立即捐赠",
	"Immediate donation":         "立即捐赠",
	"IMMEDIATE_DISPOSAL":         "立即弃置",
	"Immediate disposal":         "立即弃置",
	"Pending":                    "处理中",
	"Pending repackaging":        "待重新包装",
	"Repackaged successfully":    "重新包装完成",
	"To be autoremoved":          "待自动移除",
	"Policy-related disposal":    "政策原因弃置",
	"Closed":                     "已关闭",
}

func TranslateReason(val string) string {
	val = strings.TrimSpace(val)
	if alias, ok := returnReasonAliases[val]; ok {
		val = alias
	}
	if strings.HasPrefix(val, "CR-") {
		val = val[3:]
	}
	if zh, ok := returnReasonMap[val]; ok {
		return zh
	}
	return val
}

func TranslateDisposition(val string) string {
	val = strings.TrimSpace(val)
	if zh, ok := dispositionMap[val]; ok {
		return zh
	}
	return val
}

func TranslateStatus(val string) string {
	val = strings.TrimSpace(val)
	if zh, ok := statusMap[val]; ok {
		return zh
	}
	return val
}
