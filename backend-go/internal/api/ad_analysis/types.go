package ad_analysis

import (
	"context"
	"errors"
)

var (
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限访问该项目")
)

type AdAnalysisMetricCard struct {
	Label        string  `json:"label"`
	Value        float64 `json:"value"`
	DisplayValue string  `json:"display_value"`
	Helper       *string `json:"helper,omitempty"`
}

type AdAnalysisIssueCard struct {
	Title    string  `json:"title"`
	Level    string  `json:"level"`
	Summary  string  `json:"summary"`
	DrillTo  *string `json:"drill_to,omitempty"`
	NextStep *string `json:"next_step,omitempty"`
}

type AdAnalysisNarrativeSection struct {
	Title    string   `json:"title"`
	Summary  string   `json:"summary"`
	Evidence []string `json:"evidence"`
	Action   *string  `json:"action,omitempty"`
	DrillTo  *string  `json:"drill_to,omitempty"`
}

type AdAnalysisPeriodComparison struct {
	CurrentStart      *string  `json:"current_start"`
	CurrentEnd        *string  `json:"current_end"`
	PreviousStart     *string  `json:"previous_start"`
	PreviousEnd       *string  `json:"previous_end"`
	SpendChangeRatio  *float64 `json:"spend_change_ratio"`
	ClicksChangeRatio *float64 `json:"clicks_change_ratio"`
	SalesChangeRatio  *float64 `json:"sales_change_ratio"`
	OrdersChangeRatio *float64 `json:"orders_change_ratio"`
	CPCChangeRatio    *float64 `json:"cpc_change_ratio"`
	ACOSChangeRatio   *float64 `json:"acos_change_ratio"`
	Summary           *string  `json:"summary"`
}

type AdAnalysisOverviewResponse struct {
	ProjectID            int64                        `json:"project_id"`
	Country              string                       `json:"country"`
	Metrics              []AdAnalysisMetricCard       `json:"metrics"`
	IssueCards           []AdAnalysisIssueCard        `json:"issue_cards"`
	NarrativeSections    []AdAnalysisNarrativeSection `json:"narrative_sections"`
	Comparison           *AdAnalysisPeriodComparison  `json:"comparison"`
	TopCampaigns         []map[string]any             `json:"top_campaigns"`
	TopProducts          []map[string]any             `json:"top_products"`
	TopWasteTerms        []map[string]any             `json:"top_waste_terms"`
	TrendSummary         []map[string]any             `json:"trend_summary"`
	TopCrossSellProducts []map[string]any             `json:"top_cross_sell_products"`
}

type AdAnalysisCampaignsResponse struct {
	ProjectID         int64                        `json:"project_id"`
	Country           string                       `json:"country"`
	SummaryCards      []map[string]any             `json:"summary_cards"`
	NarrativeSections []AdAnalysisNarrativeSection `json:"narrative_sections"`
	Items             []map[string]any             `json:"items"`
}

type AdAnalysisProductsResponse struct {
	ProjectID    int64            `json:"project_id"`
	Country      string           `json:"country"`
	SummaryCards []map[string]any `json:"summary_cards"`
	Items        []map[string]any `json:"items"`
}

type AdAnalysisBudgetResponse struct {
	ProjectID         int64                        `json:"project_id"`
	Country           string                       `json:"country"`
	SummaryCards      []map[string]any             `json:"summary_cards"`
	NarrativeSections []AdAnalysisNarrativeSection `json:"narrative_sections"`
	Items             []map[string]any             `json:"items"`
}

type AdAnalysisPlacementsResponse struct {
	ProjectID         int64                        `json:"project_id"`
	Country           string                       `json:"country"`
	SummaryCards      []map[string]any             `json:"summary_cards"`
	NarrativeSections []AdAnalysisNarrativeSection `json:"narrative_sections"`
	Items             []map[string]any             `json:"items"`
}

type AdAnalysisTrafficQualityResponse struct {
	ProjectID         int64                        `json:"project_id"`
	Country           string                       `json:"country"`
	SummaryCards      []map[string]any             `json:"summary_cards"`
	NarrativeSections []AdAnalysisNarrativeSection `json:"narrative_sections"`
	Items             []map[string]any             `json:"items"`
}

type AdAnalysisSearchTermsResponse struct {
	ProjectID         int64                        `json:"project_id"`
	Country           string                       `json:"country"`
	SummaryCards      []map[string]any             `json:"summary_cards"`
	NarrativeSections []AdAnalysisNarrativeSection `json:"narrative_sections"`
	Items             []map[string]any             `json:"items"`
}

type AdAnalysisTargetsResponse struct {
	ProjectID    int64            `json:"project_id"`
	Country      string           `json:"country"`
	SummaryCards []map[string]any `json:"summary_cards"`
	Items        []map[string]any `json:"items"`
}

type AdAnalysisTimeTrendResponse struct {
	ProjectID  int64                       `json:"project_id"`
	Country    string                      `json:"country"`
	Summary    []map[string]any            `json:"summary"`
	Comparison *AdAnalysisPeriodComparison `json:"comparison"`
}

type AdAnalysisPurchasedProductsResponse struct {
	ProjectID int64            `json:"project_id"`
	Country   string           `json:"country"`
	Items     []map[string]any `json:"items"`
}

type BaseFilter struct {
	ProjectID int64
	Country   string
	DateFrom  *string
	DateTo    *string
	Operator  string
	IsAdmin   bool
}

type CampaignsFilter struct {
	BaseFilter
	Campaign   *string
	SKU        *string
	SearchTerm *string
	Placement  *string
}

type ProductsFilter struct {
	BaseFilter
	Campaign *string
	SKU      *string
}

type PurchasedProductsFilter struct {
	BaseFilter
	Campaign      *string
	SKU           *string
	PurchasedASIN *string
}

type SearchTermsFilter struct {
	BaseFilter
	Campaign   *string
	SearchTerm *string
	SKU        *string
}

type TargetsFilter struct {
	BaseFilter
	Campaign   *string
	TargetText *string
	SKU        *string
}

type BudgetFilter struct {
	BaseFilter
	Campaign *string
	SKU      *string
}

type PlacementsFilter struct {
	BaseFilter
	Campaign  *string
	SKU       *string
	Placement *string
}

type TrafficQualityFilter struct {
	BaseFilter
	Campaign *string
	SKU      *string
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	BuildOverview(ctx context.Context, filter BaseFilter) (*AdAnalysisOverviewResponse, error)
	BuildCampaigns(ctx context.Context, filter CampaignsFilter) (*AdAnalysisCampaignsResponse, error)
	BuildProducts(ctx context.Context, filter ProductsFilter) (*AdAnalysisProductsResponse, error)
	BuildTimeTrend(ctx context.Context, filter BaseFilter) (*AdAnalysisTimeTrendResponse, error)
	BuildPurchasedProducts(ctx context.Context, filter PurchasedProductsFilter) (*AdAnalysisPurchasedProductsResponse, error)
	BuildSearchTerms(ctx context.Context, filter SearchTermsFilter) (*AdAnalysisSearchTermsResponse, error)
	BuildTargets(ctx context.Context, filter TargetsFilter) (*AdAnalysisTargetsResponse, error)
	BuildBudget(ctx context.Context, filter BudgetFilter) (*AdAnalysisBudgetResponse, error)
	BuildPlacements(ctx context.Context, filter PlacementsFilter) (*AdAnalysisPlacementsResponse, error)
	BuildTrafficQuality(ctx context.Context, filter TrafficQualityFilter) (*AdAnalysisTrafficQualityResponse, error)
}
