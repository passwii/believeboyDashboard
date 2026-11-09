package pricing_calculation

import (
	"context"
	"errors"
)

var (
	ErrExchangeRateNotFound = errors.New("exchange rate not found")
	ErrProjectNotFound      = errors.New("项目不存在")
	ErrProjectForbidden     = errors.New("无权限访问该项目")
	ErrRunNotFound          = errors.New("测算记录不存在")
)

type PricingCalculationDimensions struct {
	LongestSideIn     float64 `json:"longest_side_in"`
	MiddleSideIn      float64 `json:"middle_side_in"`
	ShortestSideIn    float64 `json:"shortest_side_in"`
	LengthPlusGirthIn float64 `json:"length_plus_girth_in"`
	VolumeCubicIn     float64 `json:"volume_cubic_in"`
	VolumeCubicFt     float64 `json:"volume_cubic_ft"`
}

type PricingCalculationWeights struct {
	ProductWeightLB      float64 `json:"product_weight_lb"`
	ProductWeightOZ      float64 `json:"product_weight_oz"`
	DimensionalWeightLB  float64 `json:"dimensional_weight_lb"`
	ChargeableWeightLB   float64 `json:"chargeable_weight_lb"`
	ChargeableWeightOZ   float64 `json:"chargeable_weight_oz"`
	ChargeableWeightRule string  `json:"chargeable_weight_rule"`
}

type PricingCalculationFees struct {
	ReferralFeeUSD       float64 `json:"referral_fee_usd"`
	AdvertisingFeeUSD    float64 `json:"advertising_fee_usd"`
	ReturnLossUSD        float64 `json:"return_loss_usd"`
	FBAFulfillmentFeeUSD float64 `json:"fba_fulfillment_fee_usd"`
	InboundConfigFeeUSD  float64 `json:"inbound_config_fee_usd"`
	StorageFeeUSD        float64 `json:"storage_fee_usd"`
	TotalFeeUSD          float64 `json:"total_fee_usd"`
	PlatformFeeUSD       float64 `json:"platform_fee_usd"`
}

type PricingCalculationProfit struct {
	DDPCostRMB            float64  `json:"ddp_cost_rmb"`
	DDPCostUSD            float64  `json:"ddp_cost_usd"`
	PayoutUSD             float64  `json:"payout_usd"`
	ProfitUSD             float64  `json:"profit_usd"`
	ProfitRate            float64  `json:"profit_rate"`
	VATUSD                float64  `json:"vat_usd"`
	ProfitAfterVATUSD     *float64 `json:"profit_after_vat_usd"`
	ProfitAfterVATRate    *float64 `json:"profit_after_vat_rate"`
	DeliveryFeeUSD        float64  `json:"delivery_fee_usd"`
	FullContainerQuantity float64  `json:"full_container_quantity"`
	FullContainerPriceRMB float64  `json:"full_container_price_rmb"`
}

// RunItem matches FastAPI's PricingCalculationRunItem response schema.
type RunItem struct {
	ID                        int64                        `json:"id"`
	Country                   string                       `json:"country"`
	ProductName               string                       `json:"product_name"`
	CalculationType           string                       `json:"calculation_type"`
	ProjectID                 *int64                       `json:"project_id"`
	SKU                       *string                      `json:"sku"`
	PackageLengthCM           float64                      `json:"package_length_cm"`
	PackageWidthCM            float64                      `json:"package_width_cm"`
	PackageHeightCM           float64                      `json:"package_height_cm"`
	WeightKG                  float64                      `json:"weight_kg"`
	FOBProductCostRMB         float64                      `json:"fob_product_cost_rmb"`
	FirstLegCostRMB           float64                      `json:"first_leg_cost_rmb"`
	FirstLegUnitPriceRMBPerKG *float64                     `json:"first_leg_unit_price_rmb_per_kg"`
	SalePriceUSD              float64                      `json:"sale_price_usd"`
	CommissionRate            float64                      `json:"commission_rate"`
	AdvertisingRate           float64                      `json:"advertising_rate"`
	ReturnLossRate            float64                      `json:"return_loss_rate"`
	StorageMonths             float64                      `json:"storage_months"`
	InboundPlacementMode      string                       `json:"inbound_placement_mode"`
	SizeTier                  string                       `json:"size_tier"`
	SizeTierLabel             string                       `json:"size_tier_label"`
	PriceBand                 string                       `json:"price_band"`
	PriceBandLabel            string                       `json:"price_band_label"`
	USDToRMBRate              float64                      `json:"usd_to_rmb_rate"`
	USDToRMBRateSource        string                       `json:"usd_to_rmb_rate_source"`
	FulfillmentFeeRuleLabel   string                       `json:"fulfillment_fee_rule_label"`
	InboundConfigFeeRuleLabel string                       `json:"inbound_config_fee_rule_label"`
	StorageFeeRuleLabel       string                       `json:"storage_fee_rule_label"`
	Dimensions                PricingCalculationDimensions `json:"dimensions"`
	Weights                   PricingCalculationWeights    `json:"weights"`
	Fees                      PricingCalculationFees       `json:"fees"`
	Profit                    PricingCalculationProfit     `json:"profit"`
	Warnings                  []string                     `json:"warnings"`
	CreatedBy                 *string                      `json:"created_by"`
	CreatedAt                 string                       `json:"created_at"`
	UpdatedAt                 string                       `json:"updated_at"`
	DeliveryFeeUSD            float64                      `json:"delivery_fee_usd"`
	FullContainerQuantity     float64                      `json:"full_container_quantity"`
	FullContainerPriceRMB     float64                      `json:"full_container_price_rmb"`
	CompetitorURL             *string                      `json:"competitor_url"`
}

type RunListResponse struct {
	Items    []RunItem `json:"items"`
	Total    int       `json:"total"`
	Page     int       `json:"page"`
	PageSize int       `json:"page_size"`
}

type RunListFilter struct {
	Page             int
	PageSize         int
	ExcludeProjectID bool
	Country          string
	Keyword          string
	Operator         string
	IsAdmin          bool
}

type FBAQuoteRequest struct {
	Country                   *string  `json:"country"`
	ProductName               string   `json:"product_name"`
	PackageLengthCM           float64  `json:"package_length_cm"`
	PackageWidthCM            float64  `json:"package_width_cm"`
	PackageHeightCM           float64  `json:"package_height_cm"`
	WeightKG                  float64  `json:"weight_kg"`
	FOBProductCostRMB         *float64 `json:"fob_product_cost_rmb"`
	FirstLegCostRMB           *float64 `json:"first_leg_cost_rmb"`
	FirstLegUnitPriceRMBPerKG *float64 `json:"first_leg_unit_price_rmb"`
	ProjectID                 *int64   `json:"project_id"`
	SKU                       *string  `json:"sku"`
	UseHistoricalShippingCost bool     `json:"use_historical_shipping_cost"`
	SalePriceUSD              *float64 `json:"sale_price_usd"`
	CommissionRate            *float64 `json:"commission_rate"`
	AdvertisingRate           *float64 `json:"advertising_rate"`
	ReturnLossRate            *float64 `json:"return_loss_rate"`
	StorageMonths             *float64 `json:"storage_months"`
	InboundPlacementMode      *string  `json:"inbound_placement_mode"`
	USDToRMBRate              *float64 `json:"usd_to_rmb_rate"`
	CompetitorURL             *string  `json:"competitor_url"`
}

type ReverseQuoteRequest struct {
	Country                   *string  `json:"country"`
	ProductName               string   `json:"product_name"`
	PackageLengthCM           float64  `json:"package_length_cm"`
	PackageWidthCM            float64  `json:"package_width_cm"`
	PackageHeightCM           float64  `json:"package_height_cm"`
	WeightKG                  float64  `json:"weight_kg"`
	FOBProductCostRMB         *float64 `json:"fob_product_cost_rmb"`
	FirstLegCostRMB           *float64 `json:"first_leg_cost_rmb"`
	FirstLegUnitPriceRMBPerKG *float64 `json:"first_leg_unit_price_rmb"`
	ProjectID                 *int64   `json:"project_id"`
	SKU                       *string  `json:"sku"`
	UseHistoricalShippingCost bool     `json:"use_historical_shipping_cost"`
	TargetProfitRate          *float64 `json:"target_profit_rate"`
	CommissionRate            *float64 `json:"commission_rate"`
	AdvertisingRate           *float64 `json:"advertising_rate"`
	ReturnLossRate            *float64 `json:"return_loss_rate"`
	StorageMonths             *float64 `json:"storage_months"`
	InboundPlacementMode      *string  `json:"inbound_placement_mode"`
	USDToRMBRate              *float64 `json:"usd_to_rmb_rate"`
	CompetitorURL             *string  `json:"competitor_url"`
}

type CostReverseQuoteRequest struct {
	Country                   *string  `json:"country"`
	ProductName               string   `json:"product_name"`
	PackageLengthCM           float64  `json:"package_length_cm"`
	PackageWidthCM            float64  `json:"package_width_cm"`
	PackageHeightCM           float64  `json:"package_height_cm"`
	WeightKG                  float64  `json:"weight_kg"`
	FirstLegCostRMB           *float64 `json:"first_leg_cost_rmb"`
	FirstLegUnitPriceRMBPerKG *float64 `json:"first_leg_unit_price_rmb"`
	ProjectID                 *int64   `json:"project_id"`
	SKU                       *string  `json:"sku"`
	UseHistoricalShippingCost bool     `json:"use_historical_shipping_cost"`
	SalePriceUSD              *float64 `json:"sale_price_usd"`
	TargetProfitRate          *float64 `json:"target_profit_rate"`
	CommissionRate            *float64 `json:"commission_rate"`
	AdvertisingRate           *float64 `json:"advertising_rate"`
	ReturnLossRate            *float64 `json:"return_loss_rate"`
	StorageMonths             *float64 `json:"storage_months"`
	InboundPlacementMode      *string  `json:"inbound_placement_mode"`
	USDToRMBRate              *float64 `json:"usd_to_rmb_rate"`
	CompetitorURL             *string  `json:"competitor_url"`
}

type FBMQuoteRequest struct {
	Country                   *string  `json:"country"`
	ProductName               string   `json:"product_name"`
	PackageLengthCM           float64  `json:"package_length_cm"`
	PackageWidthCM            float64  `json:"package_width_cm"`
	PackageHeightCM           float64  `json:"package_height_cm"`
	WeightKG                  float64  `json:"weight_kg"`
	FOBProductCostRMB         *float64 `json:"fob_product_cost_rmb"`
	FirstLegCostRMB           *float64 `json:"first_leg_cost_rmb"`
	FullContainerQuantity     *float64 `json:"full_container_quantity"`
	FullContainerPriceRMB     *float64 `json:"full_container_price_rmb"`
	DeliveryFeeUSD            *float64 `json:"delivery_fee_usd"`
	ProjectID                 *int64   `json:"project_id"`
	SKU                       *string  `json:"sku"`
	UseHistoricalShippingCost bool     `json:"use_historical_shipping_cost"`
	SalePriceUSD              *float64 `json:"sale_price_usd"`
	CommissionRate            *float64 `json:"commission_rate"`
	AdvertisingRate           *float64 `json:"advertising_rate"`
	ReturnLossRate            *float64 `json:"return_loss_rate"`
	StorageMonths             *float64 `json:"storage_months"`
	InboundPlacementMode      *string  `json:"inbound_placement_mode"`
	USDToRMBRate              *float64 `json:"usd_to_rmb_rate"`
	CompetitorURL             *string  `json:"competitor_url"`
}

type EUQuoteRequest struct {
	Country                   string   `json:"country"`
	ProductName               string   `json:"product_name"`
	PackageLengthCM           float64  `json:"package_length_cm"`
	PackageWidthCM            float64  `json:"package_width_cm"`
	PackageHeightCM           float64  `json:"package_height_cm"`
	WeightKG                  float64  `json:"weight_kg"`
	FOBProductCostRMB         *float64 `json:"fob_product_cost_rmb"`
	FirstLegCostRMB           *float64 `json:"first_leg_cost_rmb"`
	FirstLegUnitPriceRMBPerKG *float64 `json:"first_leg_unit_price_rmb"`
	ProjectID                 *int64   `json:"project_id"`
	SKU                       *string  `json:"sku"`
	SalePriceUSD              *float64 `json:"sale_price_usd"`
	DeliveryFeeUSD            *float64 `json:"delivery_fee_usd"`
	InboundConfigFeeUSD       *float64 `json:"inbound_config_fee_usd"`
	StorageFeeUSD             *float64 `json:"storage_fee_usd"`
	CommissionRate            *float64 `json:"commission_rate"`
	AdvertisingRate           *float64 `json:"advertising_rate"`
	ReturnLossRate            *float64 `json:"return_loss_rate"`
	USDToRMBRate              *float64 `json:"usd_to_rmb_rate"`
	CompetitorURL             *string  `json:"competitor_url"`
}

type Store interface {
	GetLatestExchangeRate(ctx context.Context, currency string) (float64, string, error)
	GetHistoricalShippingCost(ctx context.Context, projectID int64, sku string) (*float64, error)
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	CreateRun(ctx context.Context, item RunItem) (RunItem, error)
	ListRuns(ctx context.Context, filter RunListFilter) ([]RunItem, int, error)
	GetRun(ctx context.Context, runID int64) (*RunItem, error)
	DeleteRun(ctx context.Context, runID int64) (bool, error)
	UpdateRun(ctx context.Context, runID int64, item RunItem) (*RunItem, error)
}
