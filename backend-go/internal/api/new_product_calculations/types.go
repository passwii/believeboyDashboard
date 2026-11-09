package new_product_calculations

import (
	"context"
	"errors"
	"time"
)

var (
	ErrProjectNotFound    = errors.New("项目不存在")
	ErrProjectForbidden   = errors.New("无权限访问该项目")
	ErrProductNotFound    = errors.New("商品不存在")
	ErrNotFound           = errors.New("记录不存在")
	ErrInvalidCalculation = errors.New("新品测算参数无效")
)

type NewProductCalculationDimensions struct {
	LongestSideIn     float64 `json:"longest_side_in"`
	MiddleSideIn      float64 `json:"middle_side_in"`
	ShortestSideIn    float64 `json:"shortest_side_in"`
	LengthPlusGirthIn float64 `json:"length_plus_girth_in"`
	VolumeCubicIn     float64 `json:"volume_cubic_in"`
	VolumeCubicFt     float64 `json:"volume_cubic_ft"`
}

type NewProductCalculationWeight struct {
	ProductWeightLB      float64 `json:"product_weight_lb"`
	ProductWeightOZ      float64 `json:"product_weight_oz"`
	DimensionalWeightLB  float64 `json:"dimensional_weight_lb"`
	ChargeableWeightLB   float64 `json:"chargeable_weight_lb"`
	ChargeableWeightOZ   float64 `json:"chargeable_weight_oz"`
	ChargeableWeightRule string  `json:"chargeable_weight_rule"`
}

type NewProductCalculationFees struct {
	ReferralFeeUSD            float64 `json:"referral_fee_usd"`
	AdvertisingFeeUSD         float64 `json:"advertising_fee_usd"`
	ReturnLossUSD             float64 `json:"return_loss_usd"`
	FBAFulfillmentFeeUSD      float64 `json:"fba_fulfillment_fee_usd"`
	InboundConfigFeeUSD       float64 `json:"inbound_config_fee_usd"`
	StorageFeeUSD             float64 `json:"storage_fee_usd"`
	TotalFeeUSD               float64 `json:"total_fee_usd"`
	DeliveryFeeUSD            float64 `json:"delivery_fee_usd"`
	InboundConfigFeeManualUSD float64 `json:"inbound_config_fee_manual_usd"`
	StorageFeeManualUSD       float64 `json:"storage_fee_manual_usd"`
}

type NewProductCalculationProfit struct {
	DDPCostRMB         float64  `json:"ddp_cost_rmb"`
	DDPCostUSD         float64  `json:"ddp_cost_usd"`
	PayoutUSD          float64  `json:"payout_usd"`
	ProfitUSD          float64  `json:"profit_usd"`
	ProfitRate         float64  `json:"profit_rate"`
	VATUSD             float64  `json:"vat_usd"`
	ProfitAfterVATUSD  *float64 `json:"profit_after_vat_usd"`
	ProfitAfterVATRate *float64 `json:"profit_after_vat_rate"`
}

type PricingAnchorBasis struct {
	ObservedAt         *time.Time `json:"observed_at"`
	USDToRMBRate       *float64   `json:"usd_to_rmb_rate"`
	USDToRMBRateSource *string    `json:"usd_to_rmb_rate_source"`
}

type PricingAnchor struct {
	BreakevenAdvertisingRate         *float64           `json:"breakeven_advertising_rate"`
	NonAdFeeUSD                      *float64           `json:"non_ad_fee_usd"`
	MaxAdSpendPerUnitUSD             *float64           `json:"max_ad_spend_per_unit_usd"`
	BreakevenAdvertisingRateAfterVAT *float64           `json:"breakeven_advertising_rate_after_vat"`
	TargetNetMargin                  *float64           `json:"target_net_margin"`
	TargetAdvertisingRate            *float64           `json:"target_advertising_rate"`
	Basis                            PricingAnchorBasis `json:"basis"`
}

type NewProductCalculationItem struct {
	ID                        int64                           `json:"id"`
	ProjectID                 int64                           `json:"project_id"`
	ProjectName               string                          `json:"project_name"`
	SKU                       string                          `json:"sku"`
	ASIN                      *string                         `json:"asin"`
	Country                   *string                         `json:"country"`
	CalculationType           string                          `json:"calculation_type"`
	PackageLengthCM           float64                         `json:"package_length_cm"`
	PackageWidthCM            float64                         `json:"package_width_cm"`
	PackageHeightCM           float64                         `json:"package_height_cm"`
	WeightKG                  float64                         `json:"weight_kg"`
	FOBProductCostRMB         float64                         `json:"fob_product_cost_rmb"`
	FirstLegCostRMB           float64                         `json:"first_leg_cost_rmb"`
	DDPCostRMB                float64                         `json:"ddp_cost_rmb"`
	DDPCostUSD                float64                         `json:"ddp_cost_usd"`
	SalePriceUSD              float64                         `json:"sale_price_usd"`
	TargetProfitRate          *float64                        `json:"target_profit_rate"`
	AdvertisingRate           float64                         `json:"advertising_rate"`
	ReturnLossRate            float64                         `json:"return_loss_rate"`
	StorageMonths             float64                         `json:"storage_months"`
	InboundPlacementMode      string                          `json:"inbound_placement_mode"`
	USDToRMBRate              float64                         `json:"usd_to_rmb_rate"`
	USDToRMBRateSource        string                          `json:"usd_to_rmb_rate_source"`
	SizeTier                  string                          `json:"size_tier"`
	SizeTierLabel             string                          `json:"size_tier_label"`
	PriceBand                 string                          `json:"price_band"`
	PriceBandLabel            string                          `json:"price_band_label"`
	FulfillmentFeeRuleLabel   string                          `json:"fulfillment_fee_rule_label"`
	InboundConfigFeeRuleLabel string                          `json:"inbound_config_fee_rule_label"`
	StorageFeeRuleLabel       string                          `json:"storage_fee_rule_label"`
	Dimensions                NewProductCalculationDimensions `json:"dimensions"`
	Weights                   NewProductCalculationWeight     `json:"weights"`
	Fees                      NewProductCalculationFees       `json:"fees"`
	Profit                    NewProductCalculationProfit     `json:"profit"`
	Anchor                    *PricingAnchor                  `json:"anchor"`
	Warnings                  []string                        `json:"warnings"`
	Notes                     *string                         `json:"notes"`
	Source                    *string                         `json:"source"`
	ObservedAt                *time.Time                      `json:"observed_at"`
	CreatedBy                 *string                         `json:"created_by"`
	CreatedAt                 time.Time                       `json:"created_at"`
	UpdatedAt                 time.Time                       `json:"updated_at"`
}

type CreateRequest struct {
	ProjectID                 int64      `json:"project_id"`
	ProjectName               string     `json:"project_name"`
	SKU                       string     `json:"sku"`
	ASIN                      *string    `json:"asin"`
	Country                   *string    `json:"country"`
	CalculationType           string     `json:"calculation_type"`
	PackageLengthCM           float64    `json:"package_length_cm"`
	PackageWidthCM            float64    `json:"package_width_cm"`
	PackageHeightCM           float64    `json:"package_height_cm"`
	WeightKG                  float64    `json:"weight_kg"`
	FOBProductCostRMB         float64    `json:"fob_product_cost_rmb"`
	FirstLegCostRMB           float64    `json:"first_leg_cost_rmb"`
	DDPCostRMB                float64    `json:"ddp_cost_rmb"`
	DDPCostUSD                float64    `json:"ddp_cost_usd"`
	SalePriceUSD              float64    `json:"sale_price_usd"`
	TargetProfitRate          *float64   `json:"target_profit_rate"`
	AdvertisingRate           float64    `json:"advertising_rate"`
	ReturnLossRate            float64    `json:"return_loss_rate"`
	StorageMonths             float64    `json:"storage_months"`
	InboundPlacementMode      string     `json:"inbound_placement_mode"`
	USDToRMBRate              float64    `json:"usd_to_rmb_rate"`
	USDToRMBRateSource        string     `json:"usd_to_rmb_rate_source"`
	SizeTier                  string     `json:"size_tier"`
	SizeTierLabel             string     `json:"size_tier_label"`
	PriceBand                 string     `json:"price_band"`
	PriceBandLabel            string     `json:"price_band_label"`
	LongestSideIn             float64    `json:"longest_side_in"`
	MiddleSideIn              float64    `json:"middle_side_in"`
	ShortestSideIn            float64    `json:"shortest_side_in"`
	LengthPlusGirthIn         float64    `json:"length_plus_girth_in"`
	VolumeCubicIn             float64    `json:"volume_cubic_in"`
	VolumeCubicFt             float64    `json:"volume_cubic_ft"`
	ProductWeightLB           float64    `json:"product_weight_lb"`
	ProductWeightOZ           float64    `json:"product_weight_oz"`
	DimensionalWeightLB       float64    `json:"dimensional_weight_lb"`
	ChargeableWeightLB        float64    `json:"chargeable_weight_lb"`
	ChargeableWeightOZ        float64    `json:"chargeable_weight_oz"`
	ChargeableWeightRule      string     `json:"chargeable_weight_rule"`
	FulfillmentFeeRuleLabel   string     `json:"fulfillment_fee_rule_label"`
	InboundConfigFeeRuleLabel string     `json:"inbound_config_fee_rule_label"`
	StorageFeeRuleLabel       string     `json:"storage_fee_rule_label"`
	ReferralFeeUSD            float64    `json:"referral_fee_usd"`
	AdvertisingFeeUSD         float64    `json:"advertising_fee_usd"`
	ReturnLossUSD             float64    `json:"return_loss_usd"`
	FBAFulfillmentFeeUSD      float64    `json:"fba_fulfillment_fee_usd"`
	InboundConfigFeeUSD       float64    `json:"inbound_config_fee_usd"`
	StorageFeeUSD             float64    `json:"storage_fee_usd"`
	TotalFeeUSD               float64    `json:"total_fee_usd"`
	DeliveryFeeUSD            float64    `json:"delivery_fee_usd"`
	InboundConfigFeeManualUSD float64    `json:"inbound_config_fee_manual_usd"`
	StorageFeeManualUSD       float64    `json:"storage_fee_manual_usd"`
	PayoutUSD                 float64    `json:"payout_usd"`
	ProfitUSD                 float64    `json:"profit_usd"`
	ProfitRate                float64    `json:"profit_rate"`
	VATUSD                    float64    `json:"vat_usd"`
	ProfitAfterVATUSD         *float64   `json:"profit_after_vat_usd"`
	ProfitAfterVATRate        *float64   `json:"profit_after_vat_rate"`
	Warnings                  []string   `json:"warnings"`
	Notes                     *string    `json:"notes"`
	Source                    *string    `json:"source"`
	ObservedAt                *time.Time `json:"observed_at"`
}

type ListFilter struct {
	ProjectID       *int64
	CalculationType *string
	Country         *string
	Page            int
	PageSize        int
	Operator        string
	IsAdmin         bool
}

type ListResponse struct {
	Items    []NewProductCalculationItem `json:"items"`
	Total    int                         `json:"total"`
	Page     int                         `json:"page"`
	PageSize int                         `json:"page_size"`
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	List(ctx context.Context, filter ListFilter) (ListResponse, error)
	Get(ctx context.Context, projectID int64, sku, calculationType string) (*NewProductCalculationItem, error)
	Upsert(ctx context.Context, input CreateRequest, operator string) (*NewProductCalculationItem, error)
	ProjectID(ctx context.Context, snapshotID int64) (int64, error)
	Delete(ctx context.Context, snapshotID int64) (bool, error)
}
