package pricing

type FBARequest struct {
	Country                   string
	ProductName               string
	PackageLengthCM           float64
	PackageWidthCM            float64
	PackageHeightCM           float64
	WeightKG                  float64
	FOBProductCostRMB         float64
	FirstLegCostRMB           float64
	FirstLegUnitPriceRMBPerKG *float64
	ProjectID                 *int64
	SKU                       *string
	UseHistoricalShippingCost bool
	SalePriceUSD              float64
	CommissionRate            float64
	AdvertisingRate           float64
	ReturnLossRate            float64
	StorageMonths             float64
	InboundPlacementMode      string
	USDToRMBRate              *float64
	CompetitorURL             *string
}

type FBMRequest struct {
	Country                   string
	ProductName               string
	PackageLengthCM           float64
	PackageWidthCM            float64
	PackageHeightCM           float64
	WeightKG                  float64
	FOBProductCostRMB         float64
	FirstLegCostRMB           float64
	FullContainerQuantity     float64
	FullContainerPriceRMB     float64
	DeliveryFeeUSD            float64
	ProjectID                 *int64
	SKU                       *string
	UseHistoricalShippingCost bool
	SalePriceUSD              float64
	CommissionRate            float64
	AdvertisingRate           float64
	ReturnLossRate            float64
	StorageMonths             float64
	InboundPlacementMode      string
	USDToRMBRate              *float64
	CompetitorURL             *string
}

type EURequest struct {
	Country                   string
	ProductName               string
	PackageLengthCM           float64
	PackageWidthCM            float64
	PackageHeightCM           float64
	WeightKG                  float64
	FOBProductCostRMB         float64
	FirstLegCostRMB           float64
	FirstLegUnitPriceRMBPerKG *float64
	ProjectID                 *int64
	SKU                       *string
	SalePriceUSD              float64
	DeliveryFeeUSD            float64
	InboundConfigFeeUSD       float64
	StorageFeeUSD             float64
	CommissionRate            float64
	AdvertisingRate           float64
	ReturnLossRate            float64
	USDToRMBRate              *float64
	CompetitorURL             *string
}

type QuoteData struct {
	ExchangeRateValue         float64
	ExchangeRateYearMonth     string
	ExchangeRateCurrency      string
	HistoricalShippingCostRMB *float64
}

type Dimensions struct {
	LongestSideIn     float64
	MiddleSideIn      float64
	ShortestSideIn    float64
	LengthPlusGirthIn float64
	VolumeCubicIn     float64
	VolumeCubicFt     float64
}

type Weights struct {
	ProductWeightLB      float64
	ProductWeightOZ      float64
	DimensionalWeightLB  float64
	ChargeableWeightLB   float64
	ChargeableWeightOZ   float64
	ChargeableWeightRule string
}

type Fees struct {
	ReferralFeeUSD       float64
	AdvertisingFeeUSD    float64
	ReturnLossUSD        float64
	FBAFulfillmentFeeUSD float64
	InboundConfigFeeUSD  float64
	StorageFeeUSD        float64
	TotalFeeUSD          float64
	PlatformFeeUSD       float64
	DeliveryFeeUSD       float64
	FullContainerFeeRMB  float64
}

type Profit struct {
	DDPCostRMB            float64
	DDPCostUSD            float64
	PayoutUSD             float64
	ProfitUSD             float64
	ProfitRate            float64
	VATUSD                float64
	ProfitAfterVATUSD     *float64
	ProfitAfterVATRate    *float64
	DeliveryFeeUSD        float64
	FullContainerQuantity float64
	FullContainerPriceRMB float64
}

type Result struct {
	Country                   string
	ProductName               string
	CalculationType           string
	ProjectID                 *int64
	SKU                       *string
	PackageLengthCM           float64
	PackageWidthCM            float64
	PackageHeightCM           float64
	WeightKG                  float64
	FOBProductCostRMB         float64
	FirstLegCostRMB           float64
	FirstLegUnitPriceRMBPerKG *float64
	SalePriceUSD              float64
	CommissionRate            float64
	AdvertisingRate           float64
	ReturnLossRate            float64
	StorageMonths             float64
	InboundPlacementMode      string
	SizeTier                  string
	SizeTierLabel             string
	PriceBand                 string
	PriceBandLabel            string
	USDToRMBRate              float64
	USDToRMBRateSource        string
	USDToRMBRateCurrency      string
	FulfillmentFeeRuleLabel   string
	InboundConfigFeeRuleLabel string
	StorageFeeRuleLabel       string
	Dimensions                Dimensions
	Weights                   Weights
	Fees                      Fees
	Profit                    Profit
	Warnings                  []string
	DeliveryFeeUSD            float64
	FullContainerQuantity     float64
	FullContainerPriceRMB     float64
	CompetitorURL             *string
}
