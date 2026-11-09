package pricing

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

type calculationInput struct {
	country                   string
	productName               string
	lengthCM                  float64
	widthCM                   float64
	heightCM                  float64
	weightKG                  float64
	fobCostRMB                float64
	firstLegCostRMB           float64
	firstLegUnitPriceRMBPerKG *float64
	projectID                 *int64
	sku                       *string
	useHistoricalShippingCost bool
	salePriceUSD              float64
	commissionRate            float64
	advertisingRate           float64
	returnLossRate            float64
	storageMonths             float64
	inboundPlacementMode      string
	usdToRMBRate              *float64
	competitorURL             *string
}

type rationalGeometry struct {
	lengthCM           *big.Rat
	widthCM            *big.Rat
	heightCM           *big.Rat
	weightKG           *big.Rat
	longestSideIn      *big.Rat
	middleSideIn       *big.Rat
	shortestSideIn     *big.Rat
	lengthPlusGirthIn  *big.Rat
	volumeCubicIn      *big.Rat
	volumeCubicFt      *big.Rat
	productWeightLB    *big.Rat
	productWeightOZ    *big.Rat
	dimensionalWeight  *big.Rat
	sizeTier           string
	sizeRule           string
	chargeableWeightLB *big.Rat
}

var (
	ErrMissingExchangeRate = fmt.Errorf("缺少汇率，请先维护汇率信息或在请求中传入 usd_to_rmb_rate")
	ErrUnsupportedCountry  = fmt.Errorf("不支持的欧洲站点国家")
)

func QuoteFBA(request FBARequest, data QuoteData) (Result, error) {
	input := calculationInput{
		country:                   request.Country,
		productName:               request.ProductName,
		lengthCM:                  request.PackageLengthCM,
		widthCM:                   request.PackageWidthCM,
		heightCM:                  request.PackageHeightCM,
		weightKG:                  request.WeightKG,
		fobCostRMB:                request.FOBProductCostRMB,
		firstLegCostRMB:           request.FirstLegCostRMB,
		firstLegUnitPriceRMBPerKG: request.FirstLegUnitPriceRMBPerKG,
		projectID:                 request.ProjectID,
		sku:                       request.SKU,
		useHistoricalShippingCost: request.UseHistoricalShippingCost,
		salePriceUSD:              request.SalePriceUSD,
		commissionRate:            request.CommissionRate,
		advertisingRate:           request.AdvertisingRate,
		returnLossRate:            request.ReturnLossRate,
		storageMonths:             request.StorageMonths,
		inboundPlacementMode:      request.InboundPlacementMode,
		usdToRMBRate:              request.USDToRMBRate,
		competitorURL:             request.CompetitorURL,
	}
	firstLegCost, shippingWarning, err := resolveFirstLegCost(input, data)
	if err != nil {
		return Result{}, err
	}
	input.firstLegCostRMB = float64Value(firstLegCost)
	state, err := prepare(input, data, "USD")
	if err != nil {
		return Result{}, err
	}

	fulfillmentFee, fulfillmentRule := resolveFBAFee(
		state.geometry.sizeTier,
		state.geometry.chargeableWeightLB,
		mul(state.geometry.chargeableWeightLB, ouncesPerPound),
		state.priceBandIndex,
	)
	inboundFee, inboundRule, inboundWarnings := resolveInboundFee(
		state.geometry.sizeTier,
		state.geometry.chargeableWeightLB,
		mul(state.geometry.chargeableWeightLB, ouncesPerPound),
		input.inboundPlacementMode,
	)
	storageMonths := state.storageMonths
	storageFee, storageRule := resolveStorageFee(
		state.geometry.sizeTier,
		state.geometry.volumeCubicFt,
		storageMonths,
	)
	fees := calculateFees(
		state.salePrice,
		state.commissionRate,
		state.advertisingRate,
		state.returnLossRate,
		fulfillmentFee,
		inboundFee,
		storageFee,
		new(big.Rat),
	)
	profit := calculateProfit(state, fees, input.country)
	result := resultFromState(input, state, fees, profit)
	result.CalculationType = "profit_calc"
	result.InboundPlacementMode = input.inboundPlacementMode
	result.FulfillmentFeeRuleLabel = fulfillmentRule
	result.InboundConfigFeeRuleLabel = inboundRule
	result.StorageFeeRuleLabel = storageRule
	result.StorageMonths = quantizedFloat(storageMonths, 2)
	result.Warnings = append(result.Warnings, inboundWarnings...)
	if shippingWarning != "" {
		result.Warnings = append(result.Warnings, shippingWarning)
	}
	return result, nil
}

func QuoteFBM(request FBMRequest, data QuoteData) (Result, error) {
	input := calculationInput{
		country:                   request.Country,
		productName:               request.ProductName,
		lengthCM:                  request.PackageLengthCM,
		widthCM:                   request.PackageWidthCM,
		heightCM:                  request.PackageHeightCM,
		weightKG:                  request.WeightKG,
		fobCostRMB:                request.FOBProductCostRMB,
		firstLegCostRMB:           request.FirstLegCostRMB,
		projectID:                 request.ProjectID,
		sku:                       request.SKU,
		useHistoricalShippingCost: request.UseHistoricalShippingCost,
		salePriceUSD:              request.SalePriceUSD,
		commissionRate:            request.CommissionRate,
		advertisingRate:           request.AdvertisingRate,
		returnLossRate:            request.ReturnLossRate,
		storageMonths:             request.StorageMonths,
		inboundPlacementMode:      request.InboundPlacementMode,
		usdToRMBRate:              request.USDToRMBRate,
		competitorURL:             request.CompetitorURL,
	}
	firstLegCost, _, err := resolveFirstLegCost(input, data)
	if err != nil {
		return Result{}, err
	}
	input.firstLegCostRMB = float64Value(firstLegCost)
	state, err := prepare(input, data, "USD")
	if err != nil {
		return Result{}, err
	}
	deliveryFee, err := money(request.DeliveryFeeUSD)
	if err != nil {
		return Result{}, fmt.Errorf("delivery_fee_usd: %w", err)
	}
	fees := calculateFees(
		state.salePrice,
		state.commissionRate,
		state.advertisingRate,
		state.returnLossRate,
		new(big.Rat),
		new(big.Rat),
		new(big.Rat),
		deliveryFee,
	)
	profit := calculateProfit(state, fees, input.country)
	result := resultFromState(input, state, fees, profit)
	result.CalculationType = "fbm_calc"
	result.InboundPlacementMode = input.inboundPlacementMode
	result.FulfillmentFeeRuleLabel = "FBM / 无FBA履约费"
	result.InboundConfigFeeRuleLabel = "FBM / 无入库配置费"
	result.StorageFeeRuleLabel = "FBM / 无仓储费"
	result.StorageMonths = quantizedFloat(state.storageMonths, 2)
	result.DeliveryFeeUSD = float64Value(deliveryFee)
	fullContainerQuantity, err := money(request.FullContainerQuantity)
	if err != nil {
		return Result{}, fmt.Errorf("full_container_quantity: %w", err)
	}
	fullContainerPrice, err := money(request.FullContainerPriceRMB)
	if err != nil {
		return Result{}, fmt.Errorf("full_container_price_rmb: %w", err)
	}
	result.FullContainerQuantity = float64Value(fullContainerQuantity)
	result.FullContainerPriceRMB = float64Value(fullContainerPrice)
	result.Profit.DeliveryFeeUSD = float64Value(new(big.Rat))
	result.Profit.FullContainerQuantity = float64Value(new(big.Rat))
	result.Profit.FullContainerPriceRMB = float64Value(new(big.Rat))
	if fullContainerQuantity.Sign() > 0 {
		result.Fees.FullContainerFeeRMB = quantizedFloat(div(fullContainerPrice, fullContainerQuantity), 2)
	}
	return result, nil
}

func QuoteEU(request EURequest, data QuoteData) (Result, error) {
	country := strings.ToUpper(request.Country)
	currency := ""
	switch country {
	case "DE":
		currency = "EUR"
	case "UK":
		currency = "GBP"
	default:
		return Result{}, fmt.Errorf("%w: %s", ErrUnsupportedCountry, request.Country)
	}
	input := calculationInput{
		country:                   request.Country,
		productName:               request.ProductName,
		lengthCM:                  request.PackageLengthCM,
		widthCM:                   request.PackageWidthCM,
		heightCM:                  request.PackageHeightCM,
		weightKG:                  request.WeightKG,
		fobCostRMB:                request.FOBProductCostRMB,
		firstLegCostRMB:           request.FirstLegCostRMB,
		firstLegUnitPriceRMBPerKG: request.FirstLegUnitPriceRMBPerKG,
		projectID:                 request.ProjectID,
		sku:                       request.SKU,
		salePriceUSD:              request.SalePriceUSD,
		commissionRate:            request.CommissionRate,
		advertisingRate:           request.AdvertisingRate,
		returnLossRate:            request.ReturnLossRate,
		storageMonths:             1,
		inboundPlacementMode:      "single_destination",
		usdToRMBRate:              request.USDToRMBRate,
		competitorURL:             request.CompetitorURL,
	}
	state, err := prepare(input, data, currency)
	if err != nil {
		return Result{}, err
	}
	deliveryFee, err := money(request.DeliveryFeeUSD)
	if err != nil {
		return Result{}, fmt.Errorf("delivery_fee_usd: %w", err)
	}
	inboundFee, err := money(request.InboundConfigFeeUSD)
	if err != nil {
		return Result{}, fmt.Errorf("inbound_config_fee_usd: %w", err)
	}
	storageFee, err := money(request.StorageFeeUSD)
	if err != nil {
		return Result{}, fmt.Errorf("storage_fee_usd: %w", err)
	}
	fees := calculateFees(
		state.salePrice,
		state.commissionRate,
		state.advertisingRate,
		state.returnLossRate,
		deliveryFee,
		inboundFee,
		storageFee,
		new(big.Rat),
	)
	fees.DeliveryFeeUSD = float64Value(deliveryFee)
	fees.PlatformFeeUSD = fees.ReferralFeeUSD
	profit := calculateProfit(state, fees, country)
	result := resultFromState(input, state, fees, profit)
	result.CalculationType = "eu_accounting"
	result.InboundPlacementMode = "single_destination"
	result.FulfillmentFeeRuleLabel = "手动填写"
	result.InboundConfigFeeRuleLabel = "手动填写"
	result.StorageFeeRuleLabel = "手动填写"
	result.StorageMonths = 1
	result.DeliveryFeeUSD = float64Value(deliveryFee)
	result.USDToRMBRateCurrency = currency
	result.Warnings = []string{fmt.Sprintf("含%s VAT %d%%", country, int(vatRates[country].Num().Int64()*100/vatRates[country].Denom().Int64()))}
	return result, nil
}

type preparedState struct {
	geometry        rationalGeometry
	salePrice       *big.Rat
	fobCost         *big.Rat
	firstLegCost    *big.Rat
	commissionRate  *big.Rat
	advertisingRate *big.Rat
	returnLossRate  *big.Rat
	storageMonths   *big.Rat
	exchangeRate    *big.Rat
	exchangeSource  string
	rateCurrency    string
	priceBand       string
	priceBandLabel  string
	priceBandIndex  int
}

func prepare(input calculationInput, data QuoteData, currency string) (preparedState, error) {
	geometry, err := prepareGeometry(input)
	if err != nil {
		return preparedState{}, err
	}
	salePrice, err := money(input.salePriceUSD)
	if err != nil || salePrice.Sign() <= 0 {
		return preparedState{}, fmt.Errorf("sale_price_usd must be greater than zero")
	}
	fobCost, err := money(input.fobCostRMB)
	if err != nil {
		return preparedState{}, fmt.Errorf("fob_product_cost_rmb: %w", err)
	}
	firstLegCost, err := money(input.firstLegCostRMB)
	if err != nil {
		return preparedState{}, fmt.Errorf("first_leg_cost_rmb: %w", err)
	}
	commissionRate, err := ratio(input.commissionRate)
	if err != nil {
		return preparedState{}, fmt.Errorf("commission_rate: %w", err)
	}
	advertisingRate, err := ratio(input.advertisingRate)
	if err != nil {
		return preparedState{}, fmt.Errorf("advertising_rate: %w", err)
	}
	returnLossRate, err := ratio(input.returnLossRate)
	if err != nil {
		return preparedState{}, fmt.Errorf("return_loss_rate: %w", err)
	}
	storageMonths, err := quantized(input.storageMonths, 2)
	if err != nil || storageMonths.Sign() <= 0 {
		return preparedState{}, fmt.Errorf("storage_months must be greater than zero")
	}
	exchangeRate, source, err := resolveExchangeRate(input.usdToRMBRate, data, currency)
	if err != nil {
		return preparedState{}, err
	}
	priceBand, priceBandLabel, priceBandIndex := resolvePriceBand(salePrice)
	return preparedState{
		geometry:        geometry,
		salePrice:       salePrice,
		fobCost:         fobCost,
		firstLegCost:    firstLegCost,
		commissionRate:  commissionRate,
		advertisingRate: advertisingRate,
		returnLossRate:  returnLossRate,
		storageMonths:   storageMonths,
		exchangeRate:    exchangeRate,
		exchangeSource:  source,
		rateCurrency:    currency,
		priceBand:       priceBand,
		priceBandLabel:  priceBandLabel,
		priceBandIndex:  priceBandIndex,
	}, nil
}

func prepareGeometry(input calculationInput) (rationalGeometry, error) {
	length, err := decimal(input.lengthCM)
	if err != nil || length.Sign() <= 0 {
		return rationalGeometry{}, fmt.Errorf("package_length_cm must be greater than zero")
	}
	width, err := decimal(input.widthCM)
	if err != nil || width.Sign() <= 0 {
		return rationalGeometry{}, fmt.Errorf("package_width_cm must be greater than zero")
	}
	height, err := decimal(input.heightCM)
	if err != nil || height.Sign() <= 0 {
		return rationalGeometry{}, fmt.Errorf("package_height_cm must be greater than zero")
	}
	weight, err := decimal(input.weightKG)
	if err != nil || weight.Sign() <= 0 {
		return rationalGeometry{}, fmt.Errorf("weight_kg must be greater than zero")
	}
	sides := []*big.Rat{
		div(length, cmPerInch),
		div(width, cmPerInch),
		div(height, cmPerInch),
	}
	sort.Slice(sides, func(i, j int) bool { return sides[i].Cmp(sides[j]) > 0 })
	longest, middle, shortest := sides[0], sides[1], sides[2]
	lengthPlusGirth := add(longest, mul(add(middle, shortest), mustDecimal("2")))
	volumeCubicIn := mul(mul(longest, middle), shortest)
	volumeCubicFt := div(volumeCubicIn, cubicInPerCubic)
	productWeightLB := div(weight, kgPerPound)
	productWeightOZ := mul(productWeightLB, ouncesPerPound)
	dimensionalWeight := div(volumeCubicIn, dimensionalDiv)
	sizeTier, sizeRule, chargeableWeight := resolveSizeTier(
		longest, middle, shortest, lengthPlusGirth, productWeightLB, dimensionalWeight,
	)
	return rationalGeometry{
		lengthCM:           length,
		widthCM:            width,
		heightCM:           height,
		weightKG:           weight,
		longestSideIn:      longest,
		middleSideIn:       middle,
		shortestSideIn:     shortest,
		lengthPlusGirthIn:  lengthPlusGirth,
		volumeCubicIn:      volumeCubicIn,
		volumeCubicFt:      volumeCubicFt,
		productWeightLB:    productWeightLB,
		productWeightOZ:    productWeightOZ,
		dimensionalWeight:  dimensionalWeight,
		sizeTier:           sizeTier,
		sizeRule:           sizeRule,
		chargeableWeightLB: chargeableWeight,
	}, nil
}

func resolveExchangeRate(manual *float64, data QuoteData, currency string) (*big.Rat, string, error) {
	if manual != nil {
		rate, err := decimal(*manual)
		if err != nil || rate.Sign() <= 0 {
			return nil, "", fmt.Errorf("usd_to_rmb_rate must be greater than zero")
		}
		return rate, "manual", nil
	}
	if data.ExchangeRateValue <= 0 || strings.TrimSpace(data.ExchangeRateYearMonth) == "" {
		return nil, "", exchangeRateError(currency)
	}
	rate, err := decimal(data.ExchangeRateValue)
	if err != nil || rate.Sign() <= 0 {
		return nil, "", exchangeRateError(currency)
	}
	return rate, "system:" + data.ExchangeRateYearMonth, nil
}

func exchangeRateError(currency string) error {
	return fmt.Errorf(
		"缺少 %s 汇率，请先维护汇率信息或在请求中传入 usd_to_rmb_rate: %w",
		currency,
		ErrMissingExchangeRate,
	)
}

func resolveFirstLegCost(input calculationInput, data QuoteData) (*big.Rat, string, error) {
	manual, err := money(input.firstLegCostRMB)
	if err != nil {
		return nil, "", fmt.Errorf("first_leg_cost_rmb: %w", err)
	}
	if !input.useHistoricalShippingCost {
		return manual, "", nil
	}
	if input.projectID == nil || strings.TrimSpace(valueOrEmpty(input.sku)) == "" {
		return manual, "历史头程成本未命中项目或 SKU，已回退到手动头程成本", nil
	}
	if data.HistoricalShippingCostRMB == nil {
		return manual, "未找到该 SKU 的头程历史加权成本，已回退到手动头程成本", nil
	}
	historical, err := money(*data.HistoricalShippingCostRMB)
	if err != nil {
		return nil, "", fmt.Errorf("historical_shipping_cost: %w", err)
	}
	if historical.Sign() <= 0 {
		return manual, "该 SKU 的头程历史加权成本为 0，已回退到手动头程成本", nil
	}
	return historical, "", nil
}

func calculateFees(
	salePrice, commissionRate, advertisingRate, returnLossRate *big.Rat,
	fulfillmentFee, inboundFee, storageFee, deliveryFee *big.Rat,
) Fees {
	referral := quantize(mul(
		mul(salePrice, commissionRate),
		sub(mustDecimal("1"), mul(returnLossRate, returnRelief)),
	), 2)
	advertising := quantize(mul(salePrice, advertisingRate), 2)
	returnLoss := quantize(mul(salePrice, returnLossRate), 2)
	fulfillment := quantize(fulfillmentFee, 2)
	inbound := quantize(inboundFee, 2)
	storage := quantize(storageFee, 2)
	delivery := quantize(deliveryFee, 2)
	total := add(referral, advertising)
	total = add(total, returnLoss)
	total = add(total, fulfillment)
	total = add(total, inbound)
	total = add(total, storage)
	total = add(total, delivery)
	total = quantize(total, 2)
	return Fees{
		ReferralFeeUSD:       float64Value(referral),
		AdvertisingFeeUSD:    float64Value(advertising),
		ReturnLossUSD:        float64Value(returnLoss),
		FBAFulfillmentFeeUSD: float64Value(fulfillment),
		InboundConfigFeeUSD:  float64Value(inbound),
		StorageFeeUSD:        float64Value(storage),
		TotalFeeUSD:          float64Value(total),
		DeliveryFeeUSD:       float64Value(delivery),
	}
}

func calculateProfit(state preparedState, fees Fees, country string) Profit {
	ddpCostRMB := quantize(add(state.fobCost, state.firstLegCost), 2)
	ddpCostUSD := quantize(div(ddpCostRMB, state.exchangeRate), 2)
	totalFees := decimalMust(fees.TotalFeeUSD)
	payout := quantize(sub(state.salePrice, totalFees), 2)
	profit := quantize(sub(payout, ddpCostUSD), 2)
	profitRate := new(big.Rat)
	if state.salePrice.Sign() > 0 {
		profitRate = quantize(div(profit, state.salePrice), 4)
	}
	result := Profit{
		DDPCostRMB: float64Value(ddpCostRMB),
		DDPCostUSD: float64Value(ddpCostUSD),
		PayoutUSD:  float64Value(payout),
		ProfitUSD:  float64Value(profit),
		ProfitRate: float64Value(profitRate),
	}
	if vatRate, ok := vatRates[strings.ToUpper(country)]; ok {
		vat := quantize(div(mul(state.salePrice, vatRate), add(mustDecimal("1"), vatRate)), 2)
		profitAfterVAT := quantize(sub(sub(payout, vat), ddpCostUSD), 2)
		profitAfterVATRate := new(big.Rat)
		if state.salePrice.Sign() > 0 {
			profitAfterVATRate = quantize(div(profitAfterVAT, state.salePrice), 4)
		}
		vatFloat := float64Value(vat)
		afterFloat := float64Value(profitAfterVAT)
		rateFloat := float64Value(profitAfterVATRate)
		result.VATUSD = vatFloat
		result.ProfitAfterVATUSD = &afterFloat
		result.ProfitAfterVATRate = &rateFloat
	}
	return result
}

func resultFromState(input calculationInput, state preparedState, fees Fees, profit Profit) Result {
	geometry := state.geometry
	return Result{
		Country:                   input.country,
		ProductName:               strings.TrimSpace(input.productName),
		ProjectID:                 input.projectID,
		SKU:                       trimPointer(input.sku),
		PackageLengthCM:           quantizedFloat(geometry.lengthCM, 4),
		PackageWidthCM:            quantizedFloat(geometry.widthCM, 4),
		PackageHeightCM:           quantizedFloat(geometry.heightCM, 4),
		WeightKG:                  quantizedFloat(geometry.weightKG, 4),
		FOBProductCostRMB:         float64Value(state.fobCost),
		FirstLegCostRMB:           float64Value(state.firstLegCost),
		FirstLegUnitPriceRMBPerKG: roundOptionalMoney(input.firstLegUnitPriceRMBPerKG),
		SalePriceUSD:              float64Value(state.salePrice),
		CommissionRate:            float64Value(state.commissionRate),
		AdvertisingRate:           float64Value(state.advertisingRate),
		ReturnLossRate:            float64Value(state.returnLossRate),
		SizeTier:                  geometry.sizeTier,
		SizeTierLabel:             tierLabels[geometry.sizeTier],
		PriceBand:                 state.priceBand,
		PriceBandLabel:            state.priceBandLabel,
		USDToRMBRate:              quantizedFloat(state.exchangeRate, 6),
		USDToRMBRateSource:        state.exchangeSource,
		USDToRMBRateCurrency:      state.rateCurrency,
		Dimensions: Dimensions{
			LongestSideIn:     quantizedFloat(geometry.longestSideIn, 4),
			MiddleSideIn:      quantizedFloat(geometry.middleSideIn, 4),
			ShortestSideIn:    quantizedFloat(geometry.shortestSideIn, 4),
			LengthPlusGirthIn: quantizedFloat(geometry.lengthPlusGirthIn, 4),
			VolumeCubicIn:     quantizedFloat(geometry.volumeCubicIn, 4),
			VolumeCubicFt:     quantizedFloat(geometry.volumeCubicFt, 6),
		},
		Weights: Weights{
			ProductWeightLB:      quantizedFloat(geometry.productWeightLB, 4),
			ProductWeightOZ:      quantizedFloat(geometry.productWeightOZ, 4),
			DimensionalWeightLB:  quantizedFloat(geometry.dimensionalWeight, 4),
			ChargeableWeightLB:   quantizedFloat(geometry.chargeableWeightLB, 4),
			ChargeableWeightOZ:   quantizedFloat(mul(geometry.chargeableWeightLB, ouncesPerPound), 4),
			ChargeableWeightRule: geometry.sizeRule,
		},
		Fees:          fees,
		Profit:        profit,
		Warnings:      []string{},
		CompetitorURL: trimPointer(input.competitorURL),
	}
}

func money(value float64) (*big.Rat, error) {
	rat, err := decimal(value)
	if err != nil {
		return nil, err
	}
	return quantize(rat, 2), nil
}

func ratio(value float64) (*big.Rat, error) {
	rat, err := decimal(value)
	if err != nil {
		return nil, err
	}
	return quantize(rat, 6), nil
}

func quantized(value float64, places int) (*big.Rat, error) {
	rat, err := decimal(value)
	if err != nil {
		return nil, err
	}
	return quantize(rat, places), nil
}

func roundOptionalMoney(value *float64) *float64 {
	if value == nil {
		return nil
	}
	rounded, err := money(*value)
	if err != nil {
		return nil
	}
	result := float64Value(rounded)
	return &result
}

func decimalMust(value float64) *big.Rat {
	rat, err := decimal(value)
	if err != nil {
		return new(big.Rat)
	}
	return rat
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func trimPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
