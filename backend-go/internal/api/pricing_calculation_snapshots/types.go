package pricing_calculation_snapshots

import (
	"context"
	"errors"
)

var (
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限访问该项目")
	ErrNotFound         = errors.New("快照不存在")
	ErrSourceEmpty      = errors.New("没有可快照的核算记录")
)

type SnapshotSummary struct {
	Total      int     `json:"total"`
	Calculated int     `json:"calculated"`
	Profitable int     `json:"profitable"`
	PassRate   float64 `json:"passRate"`
}

type SnapshotDimensions struct {
	LongestSideIn     float64 `json:"longest_side_in"`
	MiddleSideIn      float64 `json:"middle_side_in"`
	ShortestSideIn    float64 `json:"shortest_side_in"`
	LengthPlusGirthIn float64 `json:"length_plus_girth_in"`
	VolumeCubicIn     float64 `json:"volume_cubic_in"`
	VolumeCubicFt     float64 `json:"volume_cubic_ft"`
}

type SnapshotWeights struct {
	ProductWeightLb      float64 `json:"product_weight_lb"`
	ProductWeightOz      float64 `json:"product_weight_oz"`
	DimensionalWeightLb  float64 `json:"dimensional_weight_lb"`
	ChargeableWeightLb   float64 `json:"chargeable_weight_lb"`
	ChargeableWeightOz   float64 `json:"chargeable_weight_oz"`
	ChargeableWeightRule string  `json:"chargeable_weight_rule"`
}

type SnapshotFees struct {
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
	PlatformFeeUSD            float64 `json:"platform_fee_usd"`
}

type SnapshotProfit struct {
	DDPCostRMB         float64  `json:"ddp_cost_rmb"`
	DDPCostUSD         float64  `json:"ddp_cost_usd"`
	PayoutUSD          float64  `json:"payout_usd"`
	ProfitUSD          float64  `json:"profit_usd"`
	ProfitRate         float64  `json:"profit_rate"`
	VATUSD             float64  `json:"vat_usd"`
	ProfitAfterVATUSD  *float64 `json:"profit_after_vat_usd"`
	ProfitAfterVATRate *float64 `json:"profit_after_vat_rate"`
}

type SnapshotAnchorBasis struct {
	ObservedAt         *string  `json:"observed_at"`
	USDToRMBRate       *float64 `json:"usd_to_rmb_rate"`
	USDToRMBRateSource *string  `json:"usd_to_rmb_rate_source"`
}

type SnapshotAnchor struct {
	BreakevenAdvertisingRate         *float64            `json:"breakeven_advertising_rate"`
	NonAdFeeUSD                      *float64            `json:"non_ad_fee_usd"`
	MaxAdSpendPerUnitUSD             *float64            `json:"max_ad_spend_per_unit_usd"`
	BreakevenAdvertisingRateAfterVAT *float64            `json:"breakeven_advertising_rate_after_vat"`
	TargetNetMargin                  *float64            `json:"target_net_margin"`
	TargetAdvertisingRate            *float64            `json:"target_advertising_rate"`
	Basis                            SnapshotAnchorBasis `json:"basis"`
}

type SnapshotItem struct {
	ID                        int64              `json:"id"`
	ProjectID                 int64              `json:"project_id"`
	ProjectName               string             `json:"project_name"`
	SKU                       string             `json:"sku"`
	ASIN                      *string            `json:"asin"`
	Country                   string             `json:"country"`
	AccountingType            string             `json:"accounting_type"`
	PackageLengthCM           float64            `json:"package_length_cm"`
	PackageWidthCM            float64            `json:"package_width_cm"`
	PackageHeightCM           float64            `json:"package_height_cm"`
	WeightKG                  float64            `json:"weight_kg"`
	FOBProductCostRMB         float64            `json:"fob_product_cost_rmb"`
	FirstLegCostRMB           float64            `json:"first_leg_cost_rmb"`
	DDPCostRMB                float64            `json:"ddp_cost_rmb"`
	DDPCostUSD                float64            `json:"ddp_cost_usd"`
	SalePriceUSD              float64            `json:"sale_price_usd"`
	AdvertisingRate           float64            `json:"advertising_rate"`
	ReturnLossRate            float64            `json:"return_loss_rate"`
	StorageMonths             float64            `json:"storage_months"`
	InboundPlacementMode      string             `json:"inbound_placement_mode"`
	USDToRMBRate              float64            `json:"usd_to_rmb_rate"`
	USDToRMBRateSource        string             `json:"usd_to_rmb_rate_source"`
	SizeTier                  string             `json:"size_tier"`
	SizeTierLabel             string             `json:"size_tier_label"`
	PriceBand                 string             `json:"price_band"`
	PriceBandLabel            string             `json:"price_band_label"`
	FulfillmentFeeRuleLabel   string             `json:"fulfillment_fee_rule_label"`
	InboundConfigFeeRuleLabel string             `json:"inbound_config_fee_rule_label"`
	StorageFeeRuleLabel       string             `json:"storage_fee_rule_label"`
	Dimensions                SnapshotDimensions `json:"dimensions"`
	Weights                   SnapshotWeights    `json:"weights"`
	Fees                      SnapshotFees       `json:"fees"`
	Profit                    SnapshotProfit     `json:"profit"`
	Anchor                    *SnapshotAnchor    `json:"anchor"`
	Warnings                  []string           `json:"warnings"`
	Notes                     *string            `json:"notes"`
	CreatedBy                 *string            `json:"created_by"`
	ObservedAt                string             `json:"observed_at"`
	Source                    string             `json:"source"`
	CreatedAt                 string             `json:"created_at"`
	UpdatedAt                 string             `json:"updated_at"`
}

type SnapshotListItem struct {
	ID           int64           `json:"id"`
	ProjectID    int64           `json:"project_id"`
	ProjectName  string          `json:"project_name"`
	Country      string          `json:"country"`
	SnapshotDate string          `json:"snapshot_date"`
	Name         *string         `json:"name"`
	Description  *string         `json:"description"`
	RowCount     int             `json:"row_count"`
	CreatedBy    *string         `json:"created_by"`
	CreatedAt    string          `json:"created_at"`
	Summary      SnapshotSummary `json:"summary"`
}

type SnapshotDetail struct {
	SnapshotListItem
	Items []SnapshotItem `json:"items"`
}

type SnapshotItemsResponse struct {
	Items               []SnapshotItem  `json:"items"`
	Summary             SnapshotSummary `json:"summary"`
	RowCount            int             `json:"row_count"`
	Total               int             `json:"total"`
	Page                int             `json:"page"`
	PageSize            int             `json:"page_size"`
	HasNext             bool            `json:"has_next"`
	SnapshotID          int64           `json:"snapshot_id"`
	SnapshotDate        string          `json:"snapshot_date"`
	SnapshotName        *string         `json:"snapshot_name"`
	SnapshotDescription *string         `json:"snapshot_description"`
}

type CreateSnapshotRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

type UpdateSnapshotRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	List(ctx context.Context, projectID int64, country string, page, pageSize int) ([]SnapshotListItem, error)
	Get(ctx context.Context, snapshotID int64) (*SnapshotDetail, error)
	GetItems(ctx context.Context, snapshotID int64) (*SnapshotItemsResponse, error)
	Create(ctx context.Context, projectID int64, country string, name, description *string, operator string) (int64, error)
	Update(ctx context.Context, snapshotID int64, name, description *string, operator string) (*SnapshotListItem, error)
	Delete(ctx context.Context, snapshotID int64) (bool, error)
	ProjectID(ctx context.Context, snapshotID int64) (int64, error)
}
