package pricing_calculation

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/pricing"
)

func normalizeFBARequest(payload FBAQuoteRequest) (pricing.FBARequest, error) {
	country := "US"
	if payload.Country != nil {
		country = *payload.Country
	}
	if len([]rune(country)) > 10 {
		return pricing.FBARequest{}, fmt.Errorf("country must be at most 10 characters")
	}
	productName, err := validateProductName(payload.ProductName)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	if err := validateDimensions(payload.PackageLengthCM, payload.PackageWidthCM, payload.PackageHeightCM, payload.WeightKG); err != nil {
		return pricing.FBARequest{}, err
	}
	fobCost, err := requiredNumber("fob_product_cost_rmb", payload.FOBProductCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	firstLegCost, err := requiredNumber("first_leg_cost_rmb", payload.FirstLegCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	salePrice, err := requiredNumber("sale_price_usd", payload.SalePriceUSD, 0, 100000000, false)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	firstLegUnitPrice, err := optionalNumber("first_leg_unit_price_rmb", payload.FirstLegUnitPriceRMBPerKG, 0, 10000, true)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	projectID, err := validateProjectID(payload.ProjectID)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	if err := validateSKU(payload.SKU); err != nil {
		return pricing.FBARequest{}, err
	}
	commissionRate, err := defaultedRate("commission_rate", payload.CommissionRate, 0.15)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	advertisingRate, err := defaultedRate("advertising_rate", payload.AdvertisingRate, 0.12)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	returnLossRate, err := defaultedRate("return_loss_rate", payload.ReturnLossRate, 0.04)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	storageMonths, err := defaultedBounded("storage_months", payload.StorageMonths, 1, 0, 120, false)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	inboundMode, err := inboundMode(payload.InboundPlacementMode)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	exchangeRate, err := optionalNumber("usd_to_rmb_rate", payload.USDToRMBRate, 0, 1000, false)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	competitorURL, err := validateCompetitorURL(payload.CompetitorURL)
	if err != nil {
		return pricing.FBARequest{}, err
	}
	return pricing.FBARequest{
		Country: country, ProductName: productName,
		PackageLengthCM: payload.PackageLengthCM, PackageWidthCM: payload.PackageWidthCM,
		PackageHeightCM: payload.PackageHeightCM, WeightKG: payload.WeightKG,
		FOBProductCostRMB: fobCost, FirstLegCostRMB: firstLegCost,
		FirstLegUnitPriceRMBPerKG: firstLegUnitPrice,
		ProjectID:                 projectID, SKU: payload.SKU,
		UseHistoricalShippingCost: payload.UseHistoricalShippingCost,
		SalePriceUSD:              salePrice, CommissionRate: commissionRate,
		AdvertisingRate: advertisingRate, ReturnLossRate: returnLossRate,
		StorageMonths: storageMonths, InboundPlacementMode: inboundMode,
		USDToRMBRate: exchangeRate, CompetitorURL: competitorURL,
	}, nil
}

func normalizeReverseRequest(payload ReverseQuoteRequest) (pricing.FBARequest, float64, error) {
	country := "US"
	if payload.Country != nil {
		country = *payload.Country
	}
	if len([]rune(country)) > 10 {
		return pricing.FBARequest{}, 0, fmt.Errorf("country must be at most 10 characters")
	}
	productName, err := validateProductName(payload.ProductName)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	if err := validateDimensions(payload.PackageLengthCM, payload.PackageWidthCM, payload.PackageHeightCM, payload.WeightKG); err != nil {
		return pricing.FBARequest{}, 0, err
	}
	fobCost, err := requiredNumber("fob_product_cost_rmb", payload.FOBProductCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	firstLegCost, err := requiredNumber("first_leg_cost_rmb", payload.FirstLegCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	firstLegUnitPrice, err := optionalNumber("first_leg_unit_price_rmb", payload.FirstLegUnitPriceRMBPerKG, 0, 10000, true)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	projectID, err := validateProjectID(payload.ProjectID)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	if err := validateSKU(payload.SKU); err != nil {
		return pricing.FBARequest{}, 0, err
	}
	targetRate, err := targetProfitRate(payload.TargetProfitRate)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	commissionRate, err := defaultedRate("commission_rate", payload.CommissionRate, 0.15)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	advertisingRate, err := defaultedRate("advertising_rate", payload.AdvertisingRate, 0.12)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	returnLossRate, err := defaultedRate("return_loss_rate", payload.ReturnLossRate, 0.04)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	storageMonths, err := defaultedBounded("storage_months", payload.StorageMonths, 1, 0, 120, false)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	inboundMode, err := inboundMode(payload.InboundPlacementMode)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	exchangeRate, err := optionalNumber("usd_to_rmb_rate", payload.USDToRMBRate, 0, 1000, false)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	competitorURL, err := validateCompetitorURL(payload.CompetitorURL)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	return pricing.FBARequest{
		Country: country, ProductName: productName,
		PackageLengthCM: payload.PackageLengthCM, PackageWidthCM: payload.PackageWidthCM,
		PackageHeightCM: payload.PackageHeightCM, WeightKG: payload.WeightKG,
		FOBProductCostRMB: fobCost, FirstLegCostRMB: firstLegCost,
		FirstLegUnitPriceRMBPerKG: firstLegUnitPrice,
		ProjectID:                 projectID, SKU: payload.SKU,
		UseHistoricalShippingCost: payload.UseHistoricalShippingCost,
		CommissionRate:            commissionRate, AdvertisingRate: advertisingRate,
		ReturnLossRate: returnLossRate, StorageMonths: storageMonths,
		InboundPlacementMode: inboundMode, USDToRMBRate: exchangeRate,
		CompetitorURL: competitorURL,
	}, targetRate, nil
}

func normalizeCostReverseRequest(payload CostReverseQuoteRequest) (pricing.FBARequest, float64, error) {
	country := "US"
	if payload.Country != nil {
		country = *payload.Country
	}
	if len([]rune(country)) > 10 {
		return pricing.FBARequest{}, 0, fmt.Errorf("country must be at most 10 characters")
	}
	productName, err := validateProductName(payload.ProductName)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	if err := validateDimensions(payload.PackageLengthCM, payload.PackageWidthCM, payload.PackageHeightCM, payload.WeightKG); err != nil {
		return pricing.FBARequest{}, 0, err
	}
	firstLegCost, err := requiredNumber("first_leg_cost_rmb", payload.FirstLegCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	firstLegUnitPrice, err := optionalNumber("first_leg_unit_price_rmb", payload.FirstLegUnitPriceRMBPerKG, 0, 10000, true)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	salePrice, err := requiredNumber("sale_price_usd", payload.SalePriceUSD, 0, 100000000, false)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	projectID, err := validateProjectID(payload.ProjectID)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	if err := validateSKU(payload.SKU); err != nil {
		return pricing.FBARequest{}, 0, err
	}
	targetRate, err := targetProfitRate(payload.TargetProfitRate)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	commissionRate, err := defaultedRate("commission_rate", payload.CommissionRate, 0.15)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	advertisingRate, err := defaultedRate("advertising_rate", payload.AdvertisingRate, 0.12)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	returnLossRate, err := defaultedRate("return_loss_rate", payload.ReturnLossRate, 0.04)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	storageMonths, err := defaultedBounded("storage_months", payload.StorageMonths, 1, 0, 120, false)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	inboundMode, err := inboundMode(payload.InboundPlacementMode)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	exchangeRate, err := optionalNumber("usd_to_rmb_rate", payload.USDToRMBRate, 0, 1000, false)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	competitorURL, err := validateCompetitorURL(payload.CompetitorURL)
	if err != nil {
		return pricing.FBARequest{}, 0, err
	}
	return pricing.FBARequest{
		Country: country, ProductName: productName,
		PackageLengthCM: payload.PackageLengthCM, PackageWidthCM: payload.PackageWidthCM,
		PackageHeightCM: payload.PackageHeightCM, WeightKG: payload.WeightKG,
		FirstLegCostRMB:           firstLegCost,
		FirstLegUnitPriceRMBPerKG: firstLegUnitPrice,
		ProjectID:                 projectID, SKU: payload.SKU,
		UseHistoricalShippingCost: payload.UseHistoricalShippingCost,
		SalePriceUSD:              salePrice, CommissionRate: commissionRate,
		AdvertisingRate: advertisingRate, ReturnLossRate: returnLossRate,
		StorageMonths: storageMonths, InboundPlacementMode: inboundMode,
		USDToRMBRate: exchangeRate, CompetitorURL: competitorURL,
	}, targetRate, nil
}

func normalizeFBMRequest(payload FBMQuoteRequest) (pricing.FBMRequest, error) {
	country := "US"
	if payload.Country != nil {
		country = *payload.Country
	}
	if len([]rune(country)) > 10 {
		return pricing.FBMRequest{}, fmt.Errorf("country must be at most 10 characters")
	}
	productName, err := validateProductName(payload.ProductName)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	if err := validateDimensions(payload.PackageLengthCM, payload.PackageWidthCM, payload.PackageHeightCM, payload.WeightKG); err != nil {
		return pricing.FBMRequest{}, err
	}
	fobCost, err := requiredNumber("fob_product_cost_rmb", payload.FOBProductCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	firstLegCost, err := requiredNumber("first_leg_cost_rmb", payload.FirstLegCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	fullContainerQuantity, err := requiredNumber("full_container_quantity", payload.FullContainerQuantity, 0, 100000, false)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	fullContainerPrice, err := requiredNumber("full_container_price_rmb", payload.FullContainerPriceRMB, 0, 100000000, true)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	deliveryFee, err := requiredNumber("delivery_fee_usd", payload.DeliveryFeeUSD, 0, 100000, true)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	projectID, err := validateProjectID(payload.ProjectID)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	if err := validateSKU(payload.SKU); err != nil {
		return pricing.FBMRequest{}, err
	}
	salePrice, err := requiredNumber("sale_price_usd", payload.SalePriceUSD, 0, 100000000, false)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	commissionRate, err := defaultedRate("commission_rate", payload.CommissionRate, 0.15)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	advertisingRate, err := defaultedRate("advertising_rate", payload.AdvertisingRate, 0.12)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	returnLossRate, err := defaultedRate("return_loss_rate", payload.ReturnLossRate, 0.04)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	storageMonths, err := defaultedBounded("storage_months", payload.StorageMonths, 1, 0, 120, false)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	inboundMode, err := inboundMode(payload.InboundPlacementMode)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	exchangeRate, err := optionalNumber("usd_to_rmb_rate", payload.USDToRMBRate, 0, 1000, false)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	competitorURL, err := validateCompetitorURL(payload.CompetitorURL)
	if err != nil {
		return pricing.FBMRequest{}, err
	}
	return pricing.FBMRequest{
		Country: country, ProductName: productName,
		PackageLengthCM: payload.PackageLengthCM, PackageWidthCM: payload.PackageWidthCM,
		PackageHeightCM: payload.PackageHeightCM, WeightKG: payload.WeightKG,
		FOBProductCostRMB: fobCost, FirstLegCostRMB: firstLegCost,
		FullContainerQuantity: fullContainerQuantity, FullContainerPriceRMB: fullContainerPrice,
		DeliveryFeeUSD: deliveryFee, ProjectID: projectID, SKU: payload.SKU,
		UseHistoricalShippingCost: payload.UseHistoricalShippingCost,
		SalePriceUSD:              salePrice, CommissionRate: commissionRate,
		AdvertisingRate: advertisingRate, ReturnLossRate: returnLossRate,
		StorageMonths: storageMonths, InboundPlacementMode: inboundMode,
		USDToRMBRate: exchangeRate, CompetitorURL: competitorURL,
	}, nil
}

func normalizeEURequest(payload EUQuoteRequest) (pricing.EURequest, error) {
	if payload.Country != "DE" && payload.Country != "UK" {
		return pricing.EURequest{}, fmt.Errorf("country must be DE or UK")
	}
	productName, err := validateProductName(payload.ProductName)
	if err != nil {
		return pricing.EURequest{}, err
	}
	if err := validateDimensions(payload.PackageLengthCM, payload.PackageWidthCM, payload.PackageHeightCM, payload.WeightKG); err != nil {
		return pricing.EURequest{}, err
	}
	fobCost, err := requiredNumber("fob_product_cost_rmb", payload.FOBProductCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.EURequest{}, err
	}
	firstLegCost, err := requiredNumber("first_leg_cost_rmb", payload.FirstLegCostRMB, 0, 100000000, true)
	if err != nil {
		return pricing.EURequest{}, err
	}
	salePrice, err := requiredNumber("sale_price_usd", payload.SalePriceUSD, 0, 100000000, false)
	if err != nil {
		return pricing.EURequest{}, err
	}
	firstLegUnitPrice, err := optionalNumber("first_leg_unit_price_rmb", payload.FirstLegUnitPriceRMBPerKG, 0, 10000, true)
	if err != nil {
		return pricing.EURequest{}, err
	}
	projectID, err := validateProjectID(payload.ProjectID)
	if err != nil {
		return pricing.EURequest{}, err
	}
	if err := validateSKU(payload.SKU); err != nil {
		return pricing.EURequest{}, err
	}
	deliveryFee, err := defaultedBounded("delivery_fee_usd", payload.DeliveryFeeUSD, 0, 0, 100000, true)
	if err != nil {
		return pricing.EURequest{}, err
	}
	inboundFee, err := defaultedBounded("inbound_config_fee_usd", payload.InboundConfigFeeUSD, 0, 0, 100000, true)
	if err != nil {
		return pricing.EURequest{}, err
	}
	storageFee, err := defaultedBounded("storage_fee_usd", payload.StorageFeeUSD, 0, 0, 100000, true)
	if err != nil {
		return pricing.EURequest{}, err
	}
	commissionRate, err := defaultedRate("commission_rate", payload.CommissionRate, 0.15)
	if err != nil {
		return pricing.EURequest{}, err
	}
	advertisingRate, err := defaultedRate("advertising_rate", payload.AdvertisingRate, 0.12)
	if err != nil {
		return pricing.EURequest{}, err
	}
	returnLossRate, err := defaultedRate("return_loss_rate", payload.ReturnLossRate, 0.04)
	if err != nil {
		return pricing.EURequest{}, err
	}
	exchangeRate, err := optionalNumber("usd_to_rmb_rate", payload.USDToRMBRate, 0, 1000, false)
	if err != nil {
		return pricing.EURequest{}, err
	}
	competitorURL, err := validateCompetitorURL(payload.CompetitorURL)
	if err != nil {
		return pricing.EURequest{}, err
	}
	return pricing.EURequest{
		Country: payload.Country, ProductName: productName,
		PackageLengthCM: payload.PackageLengthCM, PackageWidthCM: payload.PackageWidthCM,
		PackageHeightCM: payload.PackageHeightCM, WeightKG: payload.WeightKG,
		FOBProductCostRMB: fobCost, FirstLegCostRMB: firstLegCost,
		FirstLegUnitPriceRMBPerKG: firstLegUnitPrice,
		ProjectID:                 projectID, SKU: payload.SKU, SalePriceUSD: salePrice,
		DeliveryFeeUSD: deliveryFee, InboundConfigFeeUSD: inboundFee,
		StorageFeeUSD: storageFee, CommissionRate: commissionRate,
		AdvertisingRate: advertisingRate, ReturnLossRate: returnLossRate,
		USDToRMBRate: exchangeRate, CompetitorURL: competitorURL,
	}, nil
}

func validateProductName(value string) (string, error) {
	if len([]rune(value)) < 1 || len([]rune(value)) > 255 {
		return "", fmt.Errorf("product_name must contain 1 to 255 characters")
	}
	return strings.TrimSpace(value), nil
}

func validateDimensions(length, width, height, weight float64) error {
	if err := validateRange("package_length_cm", length, 0, 1000, false); err != nil {
		return err
	}
	if err := validateRange("package_width_cm", width, 0, 1000, false); err != nil {
		return err
	}
	if err := validateRange("package_height_cm", height, 0, 1000, false); err != nil {
		return err
	}
	return validateRange("weight_kg", weight, 0, 1000, false)
}

func validateProjectID(projectID *int64) (*int64, error) {
	if projectID != nil && *projectID <= 0 {
		return nil, fmt.Errorf("project_id must be greater than zero")
	}
	return projectID, nil
}

func validateSKU(sku *string) error {
	if sku == nil {
		return nil
	}
	length := len([]rune(*sku))
	if length < 1 || length > 100 {
		return fmt.Errorf("sku must contain 1 to 100 characters")
	}
	return nil
}

func validateCompetitorURL(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	normalized := strings.TrimSpace(*value)
	if normalized == "" {
		return nil, nil
	}
	if len([]rune(normalized)) > 1000 {
		return nil, fmt.Errorf("竞品链接不能超过 1000 字符")
	}
	parsed, err := url.ParseRequestURI(normalized)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("竞品链接必须以 http:// 或 https:// 开头")
	}
	return &normalized, nil
}

func requiredNumber(name string, value *float64, minimum, maximum float64, includeMinimum bool) (float64, error) {
	if value == nil {
		return 0, fmt.Errorf("%s is required", name)
	}
	if err := validateRange(name, *value, minimum, maximum, includeMinimum); err != nil {
		return 0, err
	}
	return *value, nil
}

func optionalNumber(name string, value *float64, minimum, maximum float64, includeMinimum bool) (*float64, error) {
	if value == nil {
		return nil, nil
	}
	if err := validateRange(name, *value, minimum, maximum, includeMinimum); err != nil {
		return nil, err
	}
	return value, nil
}

func defaultedRate(name string, value *float64, fallback float64) (float64, error) {
	if value == nil {
		return fallback, nil
	}
	if err := validateRange(name, *value, 0, 1, true); err != nil {
		return 0, err
	}
	return *value, nil
}

func targetProfitRate(value *float64) (float64, error) {
	if value == nil {
		return 0.25, nil
	}
	if *value < 0 || *value >= 1 {
		return 0, fmt.Errorf("target_profit_rate must be >= 0 and < 1")
	}
	return *value, nil
}

func defaultedBounded(
	name string,
	value *float64,
	fallback, minimum, maximum float64,
	includeMinimum bool,
) (float64, error) {
	if value == nil {
		return fallback, nil
	}
	if err := validateRange(name, *value, minimum, maximum, includeMinimum); err != nil {
		return 0, err
	}
	return *value, nil
}

func inboundMode(value *string) (string, error) {
	if value == nil {
		return "single_destination", nil
	}
	if *value != "single_destination" && *value != "amazon_optimized_split" {
		return "", fmt.Errorf("inbound_placement_mode must be single_destination or amazon_optimized_split")
	}
	return *value, nil
}

func validateRange(name string, value, minimum, maximum float64, includeMinimum bool) error {
	if value > maximum || value < minimum || (!includeMinimum && value == minimum) {
		operator := ">"
		if includeMinimum {
			operator = ">="
		}
		return fmt.Errorf("%s must be %s %v and <= %v", name, operator, minimum, maximum)
	}
	return nil
}
