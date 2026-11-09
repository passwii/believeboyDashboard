package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
	"github.com/passwii/believeboyDashboard/backend-go/internal/pricing"
)

type newProductProjectConfig struct {
	Name           string
	CommissionRate *float64
}

type newProductMasterDefaults struct {
	ASIN              string
	Country           string
	FOBProductCostRMB float64
	FirstLegCostRMB   float64
	PackageLengthCM   float64
	PackageWidthCM    float64
	PackageHeightCM   float64
	WeightKG          float64
}

func (s *ProductCalculationStore) calculateAuthoritativeRequest(
	ctx context.Context,
	input new_product_calculations.CreateRequest,
) (new_product_calculations.CreateRequest, error) {
	project, err := s.loadNewProductProject(ctx, input.ProjectID)
	if err != nil {
		return new_product_calculations.CreateRequest{}, err
	}
	master, err := s.loadNewProductMaster(ctx, input.ProjectID, input.SKU, pointerText(input.Country))
	if err != nil && !errors.Is(err, new_product_calculations.ErrProductNotFound) {
		return new_product_calculations.CreateRequest{}, err
	}

	input.ProjectName = project.Name
	input.SKU = strings.TrimSpace(input.SKU)
	input.CalculationType = strings.TrimSpace(input.CalculationType)
	if input.CalculationType == "" {
		input.CalculationType = "profit_calc"
	}
	if input.CalculationType != "profit_calc" &&
		input.CalculationType != "profit_reverse" &&
		input.CalculationType != "cost_reverse" &&
		input.CalculationType != "fbm_calc" &&
		input.CalculationType != "eu_accounting" {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"invalid calculation_type",
		)
	}
	if input.ASIN == nil || strings.TrimSpace(*input.ASIN) == "" {
		asin := master.ASIN
		input.ASIN = nullableTrimmedString(asin)
	}
	if input.Country == nil || strings.TrimSpace(*input.Country) == "" {
		country := master.Country
		input.Country = nullableTrimmedString(country)
	}
	if input.Country != nil {
		country := strings.ToUpper(strings.TrimSpace(*input.Country))
		input.Country = &country
	}
	if input.CalculationType == "fbm_calc" && input.DeliveryFeeUSD == 0 {
		// Legacy snapshot builders stored FBM delivery cost in the flattened
		// fba_fulfillment_fee_usd field rather than delivery_fee_usd.
		input.DeliveryFeeUSD = input.FBAFulfillmentFeeUSD
	}
	if input.CalculationType == "fbm_calc" && input.DeliveryFeeUSD <= 0 {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"fbm_calc requires delivery_fee_usd",
		)
	}
	if input.FOBProductCostRMB < 0 || input.FirstLegCostRMB < 0 {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"product and first-leg costs must be non-negative",
		)
	}
	input.PackageLengthCM = positiveOrDefault(input.PackageLengthCM, master.PackageLengthCM)
	input.PackageWidthCM = positiveOrDefault(input.PackageWidthCM, master.PackageWidthCM)
	input.PackageHeightCM = positiveOrDefault(input.PackageHeightCM, master.PackageHeightCM)
	input.WeightKG = positiveOrDefault(input.WeightKG, master.WeightKG)
	input.FOBProductCostRMB = nonNegativeOrDefault(input.FOBProductCostRMB, master.FOBProductCostRMB)
	input.FirstLegCostRMB = nonNegativeOrDefault(input.FirstLegCostRMB, master.FirstLegCostRMB)

	commissionRate := 0.15
	if project.CommissionRate != nil {
		commissionRate = *project.CommissionRate
	}
	if commissionRate < 0 || commissionRate > 1 {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"project commission_rate must be between 0 and 1",
		)
	}
	if input.PackageLengthCM <= 0 || input.PackageWidthCM <= 0 ||
		input.PackageHeightCM <= 0 || input.WeightKG <= 0 {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"package dimensions and weight_kg must be greater than zero",
		)
	}
	if input.AdvertisingRate < 0 || input.AdvertisingRate > 1 {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"advertising_rate must be between 0 and 1",
		)
	}
	if input.ReturnLossRate < 0 || input.ReturnLossRate > 1 {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"return_loss_rate must be between 0 and 1",
		)
	}
	if input.StorageMonths <= 0 {
		input.StorageMonths = 1
	}
	if input.FOBProductCostRMB < 0 || input.FirstLegCostRMB < 0 ||
		input.USDToRMBRate < 0 || input.DeliveryFeeUSD < 0 ||
		input.InboundConfigFeeUSD < 0 || input.StorageFeeUSD < 0 ||
		input.InboundConfigFeeManualUSD < 0 || input.StorageFeeManualUSD < 0 {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"costs and exchange rate must be non-negative",
		)
	}
	if input.InboundPlacementMode == "" {
		input.InboundPlacementMode = "single_destination"
	}
	if input.InboundPlacementMode != "single_destination" &&
		input.InboundPlacementMode != "amazon_optimized_split" {
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(
			"invalid inbound_placement_mode",
		)
	}

	// When client already provides calculated metrics (matching FastAPI upsert_snapshot wire contract),
	// directly persist them without overwriting with server-recalculated values.
	isPrecalculated := input.TotalFeeUSD > 0 || input.ProfitUSD != 0 || input.PayoutUSD != 0 || input.FBAFulfillmentFeeUSD > 0
	if isPrecalculated {
		if input.DDPCostRMB == 0 && (input.FOBProductCostRMB > 0 || input.FirstLegCostRMB > 0) {
			input.DDPCostRMB = input.FOBProductCostRMB + input.FirstLegCostRMB
		}
		if input.DDPCostUSD == 0 && input.USDToRMBRate > 0 && input.DDPCostRMB > 0 {
			input.DDPCostUSD = input.DDPCostRMB / input.USDToRMBRate
		}
		if input.USDToRMBRateSource == "" {
			input.USDToRMBRateSource = "manual"
		}
		if input.InboundPlacementMode == "" {
			input.InboundPlacementMode = "single_destination"
		}
		return input, nil
	}

	result, err := s.calculateNewProductResult(ctx, input, commissionRate)
	if err != nil {
		if errors.Is(err, pricing.ErrMissingExchangeRate) {
			return new_product_calculations.CreateRequest{}, err
		}
		return new_product_calculations.CreateRequest{}, invalidNewProductCalculation(err.Error())
	}
	return newProductCreateRequestFromResult(input, result), nil
}

func (s *ProductCalculationStore) loadNewProductProject(
	ctx context.Context,
	projectID int64,
) (newProductProjectConfig, error) {
	var name string
	var commission pgtype.Float8
	err := s.db.QueryRow(
		ctx,
		`select project_name, commission_rate::float8
		 from public.projects
		 where id = $1`,
		projectID,
	).Scan(&name, &commission)
	if errors.Is(err, pgx.ErrNoRows) {
		return newProductProjectConfig{}, new_product_calculations.ErrProjectNotFound
	}
	if err != nil {
		return newProductProjectConfig{}, err
	}
	config := newProductProjectConfig{Name: name}
	if commission.Valid {
		value := commission.Float64
		config.CommissionRate = &value
	}
	return config, nil
}

func (s *ProductCalculationStore) loadNewProductMaster(
	ctx context.Context,
	projectID int64,
	sku string,
	country *string,
) (newProductMasterDefaults, error) {
	countryFilter := ""
	if country != nil {
		countryFilter = strings.ToUpper(strings.TrimSpace(*country))
	}
	var defaults newProductMasterDefaults
	err := s.db.QueryRow(
		ctx,
		`select coalesce(asin, ''), coalesce(country, 'US'),
		        fob_unit_cost::float8, first_leg_cost_rmb::float8,
		        package_length_cm::float8, package_width_cm::float8,
		        package_height_cm::float8, weight_kg::float8
		 from public.product_costs
		 where project_id = $1 and sku = $2
		   and ($3::text = '' or country = $3)
		 order by is_active desc, sort_order asc, id asc
		 limit 1`,
		projectID,
		strings.TrimSpace(sku),
		countryFilter,
	).Scan(
		&defaults.ASIN,
		&defaults.Country,
		&defaults.FOBProductCostRMB,
		&defaults.FirstLegCostRMB,
		&defaults.PackageLengthCM,
		&defaults.PackageWidthCM,
		&defaults.PackageHeightCM,
		&defaults.WeightKG,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return newProductMasterDefaults{}, new_product_calculations.ErrProductNotFound
	}
	if err != nil {
		return newProductMasterDefaults{}, err
	}
	defaults.Country = strings.ToUpper(strings.TrimSpace(defaults.Country))
	return defaults, nil
}

func (s *ProductCalculationStore) calculateNewProductResult(
	ctx context.Context,
	input new_product_calculations.CreateRequest,
	commissionRate float64,
) (pricing.Result, error) {
	country := ""
	if input.Country != nil {
		country = strings.ToUpper(strings.TrimSpace(*input.Country))
	}
	currency := "USD"
	if input.CalculationType == "eu_accounting" {
		switch country {
		case "DE":
			currency = "EUR"
		case "UK":
			currency = "GBP"
		default:
			return pricing.Result{}, fmt.Errorf("eu_accounting country must be DE or UK")
		}
	}

	data := pricing.QuoteData{ExchangeRateCurrency: currency}
	var manualRate *float64
	if input.USDToRMBRate > 0 {
		rate := input.USDToRMBRate
		manualRate = &rate
	} else {
		rate, yearMonth, err := NewPricingCalculationStore(s.db).GetLatestExchangeRate(ctx, currency)
		if err != nil {
			return pricing.Result{}, err
		}
		data.ExchangeRateValue = rate
		data.ExchangeRateYearMonth = yearMonth
	}

	base := pricing.FBARequest{
		Country:              country,
		ProductName:          strings.TrimSpace(input.ProjectName + " / " + input.SKU),
		PackageLengthCM:      input.PackageLengthCM,
		PackageWidthCM:       input.PackageWidthCM,
		PackageHeightCM:      input.PackageHeightCM,
		WeightKG:             input.WeightKG,
		FOBProductCostRMB:    input.FOBProductCostRMB,
		FirstLegCostRMB:      input.FirstLegCostRMB,
		ProjectID:            &input.ProjectID,
		SKU:                  &input.SKU,
		SalePriceUSD:         input.SalePriceUSD,
		CommissionRate:       commissionRate,
		AdvertisingRate:      input.AdvertisingRate,
		ReturnLossRate:       input.ReturnLossRate,
		StorageMonths:        input.StorageMonths,
		InboundPlacementMode: input.InboundPlacementMode,
		USDToRMBRate:         manualRate,
	}

	switch input.CalculationType {
	case "profit_reverse":
		if input.TargetProfitRate == nil {
			if base.SalePriceUSD <= 0 {
				return pricing.Result{}, fmt.Errorf(
					"profit_reverse requires target_profit_rate or a previously calculated sale_price_usd",
				)
			}
			result, err := pricing.QuoteFBA(base, data)
			return withCalculationType(result, "profit_reverse"), err
		}
		_, result, err := pricing.SolveSalePriceForProfitRate(base, data, *input.TargetProfitRate)
		return withCalculationType(result, "profit_reverse"), err
	case "cost_reverse":
		if input.TargetProfitRate == nil {
			if base.FOBProductCostRMB <= 0 {
				return pricing.Result{}, fmt.Errorf(
					"cost_reverse requires target_profit_rate or a previously calculated fob_product_cost_rmb",
				)
			}
			result, err := pricing.QuoteFBA(base, data)
			return withCalculationType(result, "cost_reverse"), err
		}
		_, result, err := pricing.SolveFOBForProfitRate(base, data, *input.TargetProfitRate)
		return withCalculationType(result, "cost_reverse"), err
	case "fbm_calc":
		result, err := pricing.QuoteFBM(pricing.FBMRequest{
			Country:              country,
			ProductName:          base.ProductName,
			PackageLengthCM:      base.PackageLengthCM,
			PackageWidthCM:       base.PackageWidthCM,
			PackageHeightCM:      base.PackageHeightCM,
			WeightKG:             base.WeightKG,
			FOBProductCostRMB:    base.FOBProductCostRMB,
			FirstLegCostRMB:      base.FirstLegCostRMB,
			DeliveryFeeUSD:       input.DeliveryFeeUSD,
			ProjectID:            base.ProjectID,
			SKU:                  base.SKU,
			SalePriceUSD:         base.SalePriceUSD,
			CommissionRate:       base.CommissionRate,
			AdvertisingRate:      base.AdvertisingRate,
			ReturnLossRate:       base.ReturnLossRate,
			StorageMonths:        base.StorageMonths,
			InboundPlacementMode: base.InboundPlacementMode,
			USDToRMBRate:         base.USDToRMBRate,
		}, data)
		return result, err
	case "eu_accounting":
		result, err := pricing.QuoteEU(pricing.EURequest{
			Country:             country,
			ProductName:         base.ProductName,
			PackageLengthCM:     base.PackageLengthCM,
			PackageWidthCM:      base.PackageWidthCM,
			PackageHeightCM:     base.PackageHeightCM,
			WeightKG:            base.WeightKG,
			FOBProductCostRMB:   base.FOBProductCostRMB,
			FirstLegCostRMB:     base.FirstLegCostRMB,
			ProjectID:           base.ProjectID,
			SKU:                 base.SKU,
			SalePriceUSD:        base.SalePriceUSD,
			DeliveryFeeUSD:      input.DeliveryFeeUSD,
			InboundConfigFeeUSD: input.InboundConfigFeeUSD,
			StorageFeeUSD:       input.StorageFeeUSD,
			CommissionRate:      base.CommissionRate,
			AdvertisingRate:     base.AdvertisingRate,
			ReturnLossRate:      base.ReturnLossRate,
			USDToRMBRate:        base.USDToRMBRate,
		}, data)
		return result, err
	default:
		return pricing.QuoteFBA(base, data)
	}
}

func newProductCreateRequestFromResult(
	source new_product_calculations.CreateRequest,
	result pricing.Result,
) new_product_calculations.CreateRequest {
	source.Country = nullableTrimmedString(result.Country)
	source.PackageLengthCM = result.PackageLengthCM
	source.PackageWidthCM = result.PackageWidthCM
	source.PackageHeightCM = result.PackageHeightCM
	source.WeightKG = result.WeightKG
	source.FOBProductCostRMB = result.FOBProductCostRMB
	source.FirstLegCostRMB = result.FirstLegCostRMB
	source.DDPCostRMB = result.Profit.DDPCostRMB
	source.DDPCostUSD = result.Profit.DDPCostUSD
	source.SalePriceUSD = result.SalePriceUSD
	source.AdvertisingRate = result.AdvertisingRate
	source.ReturnLossRate = result.ReturnLossRate
	source.StorageMonths = result.StorageMonths
	source.InboundPlacementMode = result.InboundPlacementMode
	source.USDToRMBRate = result.USDToRMBRate
	source.USDToRMBRateSource = result.USDToRMBRateSource
	source.SizeTier = result.SizeTier
	source.SizeTierLabel = result.SizeTierLabel
	source.PriceBand = result.PriceBand
	source.PriceBandLabel = result.PriceBandLabel
	source.LongestSideIn = result.Dimensions.LongestSideIn
	source.MiddleSideIn = result.Dimensions.MiddleSideIn
	source.ShortestSideIn = result.Dimensions.ShortestSideIn
	source.LengthPlusGirthIn = result.Dimensions.LengthPlusGirthIn
	source.VolumeCubicIn = result.Dimensions.VolumeCubicIn
	source.VolumeCubicFt = result.Dimensions.VolumeCubicFt
	source.ProductWeightLB = result.Weights.ProductWeightLB
	source.ProductWeightOZ = result.Weights.ProductWeightOZ
	source.DimensionalWeightLB = result.Weights.DimensionalWeightLB
	source.ChargeableWeightLB = result.Weights.ChargeableWeightLB
	source.ChargeableWeightOZ = result.Weights.ChargeableWeightOZ
	source.ChargeableWeightRule = result.Weights.ChargeableWeightRule
	source.FulfillmentFeeRuleLabel = result.FulfillmentFeeRuleLabel
	source.InboundConfigFeeRuleLabel = result.InboundConfigFeeRuleLabel
	source.StorageFeeRuleLabel = result.StorageFeeRuleLabel
	source.ReferralFeeUSD = result.Fees.ReferralFeeUSD
	source.AdvertisingFeeUSD = result.Fees.AdvertisingFeeUSD
	source.ReturnLossUSD = result.Fees.ReturnLossUSD
	source.FBAFulfillmentFeeUSD = result.Fees.FBAFulfillmentFeeUSD
	source.InboundConfigFeeUSD = result.Fees.InboundConfigFeeUSD
	source.StorageFeeUSD = result.Fees.StorageFeeUSD
	source.TotalFeeUSD = result.Fees.TotalFeeUSD
	source.DeliveryFeeUSD = result.Fees.DeliveryFeeUSD
	if source.CalculationType == "eu_accounting" {
		source.InboundConfigFeeManualUSD = result.Fees.InboundConfigFeeUSD
		source.StorageFeeManualUSD = result.Fees.StorageFeeUSD
	}
	source.PayoutUSD = result.Profit.PayoutUSD
	source.ProfitUSD = result.Profit.ProfitUSD
	source.ProfitRate = result.Profit.ProfitRate
	source.VATUSD = result.Profit.VATUSD
	source.ProfitAfterVATUSD = result.Profit.ProfitAfterVATUSD
	source.ProfitAfterVATRate = result.Profit.ProfitAfterVATRate
	seenWarnings := make(map[string]bool, len(source.Warnings)+len(result.Warnings))
	warnings := make([]string, 0, len(source.Warnings)+len(result.Warnings))
	for _, warning := range append(append([]string(nil), source.Warnings...), result.Warnings...) {
		if warning == "" || seenWarnings[warning] {
			continue
		}
		seenWarnings[warning] = true
		warnings = append(warnings, warning)
	}
	source.Warnings = warnings
	return source
}

func withCalculationType(result pricing.Result, calculationType string) pricing.Result {
	result.CalculationType = calculationType
	return result
}

func invalidNewProductCalculation(message string) error {
	return fmt.Errorf("%w: %s", new_product_calculations.ErrInvalidCalculation, message)
}

func positiveOrDefault(value, fallback float64) float64 {
	if value > 0 {
		return value
	}
	return fallback
}

func nonNegativeOrDefault(value, fallback float64) float64 {
	if value >= 0 && value != 0 {
		return value
	}
	return fallback
}

func pointerText(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
