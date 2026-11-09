package pricing

import (
	"math"
	"strings"
	"testing"
)

func TestQuoteFBAMatchesSmallStandardPythonCalculation(t *testing.T) {
	result, err := QuoteFBA(FBARequest{
		Country:              "US",
		ProductName:          "Small parcel",
		PackageLengthCM:      10,
		PackageWidthCM:       8,
		PackageHeightCM:      1,
		WeightKG:             0.05,
		FOBProductCostRMB:    10.005,
		FirstLegCostRMB:      1.005,
		SalePriceUSD:         9.99,
		CommissionRate:       0.15,
		AdvertisingRate:      0.1,
		ReturnLossRate:       0.04,
		StorageMonths:        1,
		InboundPlacementMode: "single_destination",
		USDToRMBRate:         floatPointer(7.2),
	}, QuoteData{})
	if err != nil {
		t.Fatalf("QuoteFBA() error = %v", err)
	}

	if result.SizeTier != "small_standard" || result.PriceBand != "lt_10" {
		t.Fatalf("tier/band = %q/%q, want small_standard/lt_10", result.SizeTier, result.PriceBand)
	}
	assertClose(t, result.FOBProductCostRMB, 10.01)
	assertClose(t, result.FirstLegCostRMB, 1.01)
	assertClose(t, result.Weights.ChargeableWeightOZ, 1.7637)
	assertClose(t, result.Fees.ReferralFeeUSD, 1.49)
	assertClose(t, result.Fees.AdvertisingFeeUSD, 1.00)
	assertClose(t, result.Fees.FBAFulfillmentFeeUSD, 2.43)
	assertClose(t, result.Fees.InboundConfigFeeUSD, 0.32)
	assertClose(t, result.Fees.TotalFeeUSD, 5.64)
	assertClose(t, result.Profit.DDPCostRMB, 11.02)
	assertClose(t, result.Profit.DDPCostUSD, 1.53)
	assertClose(t, result.Profit.PayoutUSD, 4.35)
	assertClose(t, result.Profit.ProfitUSD, 2.82)
	assertClose(t, result.Profit.ProfitRate, 0.2823)
}

func TestQuoteFBAUsesAmazonPriceBandAndWeightFeeSteps(t *testing.T) {
	tests := []struct {
		name            string
		salePriceUSD    float64
		wantBand        string
		wantFulfillment float64
	}{
		{name: "exact fifty stays in middle band", salePriceUSD: 50, wantBand: "between_10_50", wantFulfillment: 5.04},
		{name: "above fifty uses high band", salePriceUSD: 50.01, wantBand: "gt_50", wantFulfillment: 5.30},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := QuoteFBA(FBARequest{
				Country:              "US",
				ProductName:          "Large standard",
				PackageLengthCM:      10,
				PackageWidthCM:       10,
				PackageHeightCM:      10,
				WeightKG:             0.5,
				FOBProductCostRMB:    20,
				FirstLegCostRMB:      5,
				SalePriceUSD:         tt.salePriceUSD,
				CommissionRate:       0.15,
				AdvertisingRate:      0.12,
				ReturnLossRate:       0.04,
				StorageMonths:        1,
				InboundPlacementMode: "single_destination",
				USDToRMBRate:         floatPointer(7.2),
			}, QuoteData{})
			if err != nil {
				t.Fatalf("QuoteFBA() error = %v", err)
			}
			if result.SizeTier != "large_standard" || result.PriceBand != tt.wantBand {
				t.Fatalf("tier/band = %q/%q, want large_standard/%s", result.SizeTier, result.PriceBand, tt.wantBand)
			}
			assertClose(t, result.Fees.FBAFulfillmentFeeUSD, tt.wantFulfillment)
			assertClose(t, result.Fees.InboundConfigFeeUSD, 0.50)
		})
	}
}

func TestQuoteFBAUsesHistoricalShippingCostAndWarnsOnMiss(t *testing.T) {
	request := FBARequest{
		Country:                   "US",
		ProductName:               "Historical shipping",
		PackageLengthCM:           10,
		PackageWidthCM:            10,
		PackageHeightCM:           10,
		WeightKG:                  0.5,
		FOBProductCostRMB:         20,
		FirstLegCostRMB:           5,
		UseHistoricalShippingCost: true,
		SalePriceUSD:              20,
		CommissionRate:            0.15,
		AdvertisingRate:           0.12,
		ReturnLossRate:            0.04,
		StorageMonths:             1,
		InboundPlacementMode:      "single_destination",
		USDToRMBRate:              floatPointer(7.2),
	}

	miss, err := QuoteFBA(request, QuoteData{})
	if err != nil {
		t.Fatalf("QuoteFBA() error = %v", err)
	}
	assertClose(t, miss.FirstLegCostRMB, 5)
	if len(miss.Warnings) != 1 || miss.Warnings[0] != "历史头程成本未命中项目或 SKU，已回退到手动头程成本" {
		t.Fatalf("warnings = %#v, want historical-cost fallback warning", miss.Warnings)
	}

	projectID := int64(7)
	sku := "SKU-7"
	request.ProjectID = &projectID
	request.SKU = &sku
	historicalCost := 8.125
	hit, err := QuoteFBA(request, QuoteData{HistoricalShippingCostRMB: &historicalCost})
	if err != nil {
		t.Fatalf("QuoteFBA() with historical cost error = %v", err)
	}
	assertClose(t, hit.FirstLegCostRMB, 8.13)
	if len(hit.Warnings) != 0 {
		t.Fatalf("warnings = %#v, want none on historical hit", hit.Warnings)
	}
}

func TestQuoteFBMUsesDeliveryAsOnlyFulfillmentFee(t *testing.T) {
	result, err := QuoteFBM(FBMRequest{
		Country:               "US",
		ProductName:           "FBM item",
		PackageLengthCM:       10,
		PackageWidthCM:        10,
		PackageHeightCM:       10,
		WeightKG:              0.5,
		FOBProductCostRMB:     20,
		FirstLegCostRMB:       5,
		FullContainerQuantity: 100,
		FullContainerPriceRMB: 10000,
		DeliveryFeeUSD:        5.5,
		SalePriceUSD:          20,
		CommissionRate:        0.15,
		AdvertisingRate:       0.12,
		ReturnLossRate:        0.04,
		StorageMonths:         1,
		InboundPlacementMode:  "single_destination",
		USDToRMBRate:          floatPointer(7.2),
	}, QuoteData{})
	if err != nil {
		t.Fatalf("QuoteFBM() error = %v", err)
	}

	if result.CalculationType != "fbm_calc" {
		t.Fatalf("calculation_type = %q, want fbm_calc", result.CalculationType)
	}
	assertClose(t, result.Fees.ReferralFeeUSD, 2.98)
	assertClose(t, result.Fees.DeliveryFeeUSD, 5.5)
	assertClose(t, result.Fees.FBAFulfillmentFeeUSD, 0)
	assertClose(t, result.Fees.InboundConfigFeeUSD, 0)
	assertClose(t, result.Fees.StorageFeeUSD, 0)
	assertClose(t, result.Fees.TotalFeeUSD, 11.68)
	assertClose(t, result.Profit.PayoutUSD, 8.32)
	assertClose(t, result.Profit.ProfitUSD, 4.85)
	assertClose(t, result.Profit.ProfitRate, 0.2425)
}

func TestQuoteEUCalculatesVATInclusiveSaleForGermanyAndUK(t *testing.T) {
	tests := []struct {
		country                string
		wantVAT                float64
		wantProfitAfterVAT     float64
		wantProfitAfterVATRate float64
		wantPayoutAfterVAT     float64
		wantCurrency           string
	}{
		{country: "DE", wantVAT: 15.97, wantProfitAfterVAT: 43.98, wantProfitAfterVATRate: 0.4398, wantPayoutAfterVAT: 47.45, wantCurrency: "EUR"},
		{country: "UK", wantVAT: 16.67, wantProfitAfterVAT: 43.28, wantProfitAfterVATRate: 0.4328, wantPayoutAfterVAT: 46.75, wantCurrency: "GBP"},
	}
	for _, tt := range tests {
		t.Run(tt.country, func(t *testing.T) {
			result, err := QuoteEU(EURequest{
				Country:             tt.country,
				ProductName:         "EU item",
				PackageLengthCM:     10,
				PackageWidthCM:      10,
				PackageHeightCM:     10,
				WeightKG:            0.5,
				FOBProductCostRMB:   20,
				FirstLegCostRMB:     5,
				SalePriceUSD:        100,
				DeliveryFeeUSD:      5,
				InboundConfigFeeUSD: 0.5,
				StorageFeeUSD:       0.2,
				CommissionRate:      0.15,
				AdvertisingRate:     0.12,
				ReturnLossRate:      0.04,
				USDToRMBRate:        floatPointer(7.2),
			}, QuoteData{})
			if err != nil {
				t.Fatalf("QuoteEU() error = %v", err)
			}
			if result.USDToRMBRateCurrency != tt.wantCurrency {
				t.Fatalf("exchange-rate currency = %q, want %s", result.USDToRMBRateCurrency, tt.wantCurrency)
			}
			assertClose(t, result.Profit.VATUSD, tt.wantVAT)
			if result.Profit.ProfitAfterVATUSD == nil || result.Profit.ProfitAfterVATRate == nil {
				t.Fatal("EU quote must return post-VAT profit and rate")
			}
			assertClose(t, *result.Profit.ProfitAfterVATUSD, tt.wantProfitAfterVAT)
			assertClose(t, *result.Profit.ProfitAfterVATRate, tt.wantProfitAfterVATRate)
			assertClose(t, result.Profit.PayoutUSD-result.Profit.VATUSD, tt.wantPayoutAfterVAT)
			if len(result.Warnings) != 1 {
				t.Fatalf("warnings = %#v, want VAT note", result.Warnings)
			}
		})
	}
}

func TestQuoteUsesSystemExchangeRateWhenManualRateIsAbsent(t *testing.T) {
	result, err := QuoteFBA(FBARequest{
		Country:              "US",
		ProductName:          "System rate",
		PackageLengthCM:      10,
		PackageWidthCM:       10,
		PackageHeightCM:      10,
		WeightKG:             0.5,
		FOBProductCostRMB:    20,
		FirstLegCostRMB:      5,
		SalePriceUSD:         20,
		CommissionRate:       0.15,
		AdvertisingRate:      0.12,
		ReturnLossRate:       0.04,
		StorageMonths:        1,
		InboundPlacementMode: "single_destination",
	}, QuoteData{ExchangeRateValue: 7.12345678, ExchangeRateYearMonth: "2026-10"})
	if err != nil {
		t.Fatalf("QuoteFBA() error = %v", err)
	}
	assertClose(t, result.USDToRMBRate, 7.123457)
	if result.USDToRMBRateSource != "system:2026-10" {
		t.Fatalf("exchange_rate_source = %q, want system:2026-10", result.USDToRMBRateSource)
	}
	assertClose(t, result.Profit.DDPCostUSD, 3.51)
}

func TestQuoteMissingExchangeRateNamesRequestedCurrency(t *testing.T) {
	_, err := QuoteEU(EURequest{
		Country:           "DE",
		ProductName:       "Missing rate",
		PackageLengthCM:   10,
		PackageWidthCM:    10,
		PackageHeightCM:   10,
		WeightKG:          0.5,
		FOBProductCostRMB: 20,
		FirstLegCostRMB:   5,
		SalePriceUSD:      20,
		CommissionRate:    0.15,
		AdvertisingRate:   0.12,
		ReturnLossRate:    0.04,
	}, QuoteData{})
	if err == nil || !strings.Contains(err.Error(), "缺少 EUR 汇率") {
		t.Fatalf("QuoteEU() error = %v, want missing EUR rate detail", err)
	}
}

func TestSolveSalePriceForProfitRateReturnsAchievableSuggestedPrice(t *testing.T) {
	request := FBARequest{
		Country:           "US",
		ProductName:       "reverse",
		PackageLengthCM:   10,
		PackageWidthCM:    8,
		PackageHeightCM:   5,
		WeightKG:          0.5,
		FOBProductCostRMB: 20,
		FirstLegCostRMB:   5,
		CommissionRate:    0.15,
		AdvertisingRate:   0.12,
		ReturnLossRate:    0.04,
		StorageMonths:     1,
		USDToRMBRate:      floatPointer(7.2),
	}
	price, result, err := SolveSalePriceForProfitRate(request, QuoteData{}, 0.25)
	if err != nil {
		t.Fatalf("SolveSalePriceForProfitRate() error = %v", err)
	}
	if price <= 0 || result.SalePriceUSD != price {
		t.Fatalf("suggested price = %v, result sale price = %v", price, result.SalePriceUSD)
	}
	if result.Profit.ProfitRate < 0.25 {
		t.Fatalf("profit rate = %v, want >= 0.25", result.Profit.ProfitRate)
	}
}

func TestSolveFOBForProfitRateReturnsAchievableCost(t *testing.T) {
	request := FBARequest{
		Country:         "US",
		ProductName:     "cost reverse",
		PackageLengthCM: 10,
		PackageWidthCM:  8,
		PackageHeightCM: 5,
		WeightKG:        0.5,
		FirstLegCostRMB: 5,
		SalePriceUSD:    30,
		CommissionRate:  0.15,
		AdvertisingRate: 0.12,
		ReturnLossRate:  0.04,
		StorageMonths:   1,
		USDToRMBRate:    floatPointer(7.2),
	}
	cost, result, err := SolveFOBForProfitRate(request, QuoteData{}, 0.2)
	if err != nil {
		t.Fatalf("SolveFOBForProfitRate() error = %v", err)
	}
	if cost <= 0 || result.FOBProductCostRMB != cost {
		t.Fatalf("solved FOB = %v, result FOB = %v", cost, result.FOBProductCostRMB)
	}
	if math.Abs(result.Profit.ProfitRate-0.2) >= 0.0001 {
		t.Fatalf("profit rate = %v, want within 0.0001 of 0.2", result.Profit.ProfitRate)
	}
}

func TestReverseSolversRejectUnachievableTargets(t *testing.T) {
	request := FBARequest{
		Country:           "US",
		ProductName:       "impossible",
		PackageLengthCM:   10,
		PackageWidthCM:    8,
		PackageHeightCM:   5,
		WeightKG:          0.5,
		FOBProductCostRMB: 20,
		FirstLegCostRMB:   5,
		SalePriceUSD:      30,
		CommissionRate:    0.15,
		AdvertisingRate:   0.12,
		ReturnLossRate:    0.04,
		StorageMonths:     1,
		USDToRMBRate:      floatPointer(7.2),
	}
	if _, _, err := SolveSalePriceForProfitRate(request, QuoteData{}, 0.99); err == nil {
		t.Fatal("SolveSalePriceForProfitRate() accepted impossible target")
	}
	if _, _, err := SolveFOBForProfitRate(request, QuoteData{}, 0.99); err == nil {
		t.Fatal("SolveFOBForProfitRate() accepted impossible target")
	}
}

func floatPointer(value float64) *float64 {
	return &value
}

func assertClose(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.0000001 {
		t.Errorf("value = %.8f, want %.8f", got, want)
	}
}
