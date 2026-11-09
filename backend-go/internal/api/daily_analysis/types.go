package daily_analysis

import (
	"context"
	"errors"
)

var (
	ErrProjectNotFound     = errors.New("project not found")
	ErrProjectForbidden    = errors.New("project forbidden")
	ErrExchangeRateMissing = errors.New("exchange rate missing")
)

type DailyAnalysisConsoleResponse struct {
	ProjectID            int64    `json:"project_id"`
	ProjectName          string   `json:"project_name"`
	Country              string   `json:"country"`
	StartDate            string   `json:"start_date"`
	EndDate              string   `json:"end_date"`
	RequestedDays        int      `json:"requested_days"`
	SummaryDays          int      `json:"summary_days"`
	DetailRows           int      `json:"detail_rows"`
	SalesSourceDays      int      `json:"sales_source_days"`
	AdSourceDays         int      `json:"ad_source_days"`
	InventorySourceDays  int      `json:"inventory_source_days"`
	BusinessSourceDays   int      `json:"business_source_days"`
	MissingDates         []string `json:"missing_dates"`
	LatestSalesDate      *string  `json:"latest_sales_date"`
	LatestAdDate         *string  `json:"latest_ad_date"`
	LatestInventoryDate  *string  `json:"latest_inventory_date"`
	LatestBusinessDate   *string  `json:"latest_business_date"`
}

type DailyAnalysisSummaryRow struct {
	Date               string  `json:"date"`
	OrderQty           int     `json:"order_qty"`
	PendingOrderQty    int     `json:"pending_order_qty"`
	SalesAmount        float64 `json:"sales_amount"`
	Impressions        int     `json:"impressions"`
	Clicks             int     `json:"clicks"`
	CPC                float64 `json:"cpc"`
	AdSpend            float64 `json:"ad_spend"`
	AdOrders           int     `json:"ad_orders"`
	AvailableQty       int     `json:"available_qty"`
	PageViews          int     `json:"page_views"`
	UnitsOrdered       int     `json:"units_ordered"`
	Sessions           int     `json:"sessions"`
	OrderedSalesAmount float64 `json:"ordered_sales_amount"`
	ConversionRate     float64 `json:"conversion_rate"`
}

type DailyAnalysisDetailRow struct {
	Date               string  `json:"date"`
	SKU                string  `json:"sku"`
	ASIN               *string `json:"asin"`
	OrderQty           int     `json:"order_qty"`
	PendingOrderQty    int     `json:"pending_order_qty"`
	SalesAmount        float64 `json:"sales_amount"`
	Impressions        int     `json:"impressions"`
	Clicks             int     `json:"clicks"`
	CPC                float64 `json:"cpc"`
	AdSpend            float64 `json:"ad_spend"`
	AdOrders           int     `json:"ad_orders"`
	AvailableQty       int     `json:"available_qty"`
	InTransitQty       int     `json:"in_transit_qty"`
	PageViews          int     `json:"page_views"`
	UnitsOrdered       int     `json:"units_ordered"`
	Sessions           int     `json:"sessions"`
	OrderedSalesAmount float64 `json:"ordered_sales_amount"`
	ConversionRate     float64 `json:"conversion_rate"`
	Country            *string `json:"country,omitempty"`
}

type DailyAnalysisResponse struct {
	Console                DailyAnalysisConsoleResponse `json:"console"`
	SummaryRows            []DailyAnalysisSummaryRow    `json:"summary_rows"`
	DetailRows             []DailyAnalysisDetailRow     `json:"detail_rows"`
	AvailableDates         map[string][]string          `json:"available_dates"`
	ComparisonSummaryRows  *[]DailyAnalysisSummaryRow   `json:"comparison_summary_rows,omitempty"`
}

type ProjectBreakdownBlock struct {
	ProjectName string                    `json:"project_name"`
	SummaryRows []DailyAnalysisSummaryRow `json:"summary_rows"`
	DetailRows  []DailyAnalysisDetailRow  `json:"detail_rows"`
}

type DailyAnalysisAllProjectsResponse struct {
	SummaryRows      []DailyAnalysisSummaryRow        `json:"summary_rows"`
	DetailRows       []DailyAnalysisDetailRow         `json:"detail_rows"`
	AvailableDates   map[string][]string              `json:"available_dates"`
	ProjectBreakdown map[int64]ProjectBreakdownBlock  `json:"project_breakdown"`
}

type CountryBreakdownBlock struct {
	SummaryRows    []DailyAnalysisSummaryRow `json:"summary_rows"`
	DetailRows     []DailyAnalysisDetailRow  `json:"detail_rows"`
	Currency       string                    `json:"currency"`
	SourceCurrency string                    `json:"source_currency"`
}

type DailyAnalysisAllCountriesResponse struct {
	Console          DailyAnalysisConsoleResponse     `json:"console"`
	SummaryRows      []DailyAnalysisSummaryRow        `json:"summary_rows"`
	DetailRows       []DailyAnalysisDetailRow         `json:"detail_rows"`
	AvailableDates   map[string][]string              `json:"available_dates"`
	CountryBreakdown map[string]CountryBreakdownBlock `json:"country_breakdown"`
	Currency         string                           `json:"currency"`
	CurrencyNote     *string                          `json:"currency_note"`
}

type DailyAnalysisAllProjectsCountriesResponse struct {
	Console          DailyAnalysisConsoleResponse     `json:"console"`
	SummaryRows      []DailyAnalysisSummaryRow        `json:"summary_rows"`
	DetailRows       []DailyAnalysisDetailRow         `json:"detail_rows"`
	AvailableDates   map[string][]string              `json:"available_dates"`
	ProjectBreakdown map[int64]ProjectBreakdownBlock  `json:"project_breakdown"`
	CountryBreakdown map[string]CountryBreakdownBlock `json:"country_breakdown"`
	Currency         string                           `json:"currency"`
	CurrencyNote     *string                          `json:"currency_note"`
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	AccessibleProjectIDs(ctx context.Context, operator string, isAdmin bool) ([]int64, error)
	GetDailyAnalysis(ctx context.Context, projectID int64, country string, startDate, endDate string, sku *string) (*DailyAnalysisResponse, error)
	GetDailyAnalysisAll(ctx context.Context, projectIDs []int64, country string, startDate, endDate string, sku *string, includeDetail bool) (*DailyAnalysisAllProjectsResponse, error)
	GetDailyAnalysisAllCountries(ctx context.Context, projectID int64, startDate, endDate string) (*DailyAnalysisAllCountriesResponse, error)
	GetDailyAnalysisAllProjectsCountries(ctx context.Context, projectIDs []int64, startDate, endDate string) (*DailyAnalysisAllProjectsCountriesResponse, error)
}
