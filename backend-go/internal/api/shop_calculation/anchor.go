package shop_calculation

import (
	"math/big"
	"strconv"
	"time"
)

// DeriveAnchor mirrors the read-time pricing anchor derived from stored amounts.
func DeriveAnchor(item ShopCalculationItem) *PricingAnchor {
	totalFees := roundDecimal(decimalValue(item.Fees.TotalFeeUSD), 2)
	advertisingFee := roundDecimal(decimalValue(item.Fees.AdvertisingFeeUSD), 2)
	nonAdFee := roundDecimal(new(big.Rat).Sub(totalFees, advertisingFee), 2)
	price := roundDecimal(decimalValue(item.SalePriceUSD), 2)
	ddpUSD := roundDecimal(decimalValue(item.Profit.DDPCostUSD), 2)

	anchor := &PricingAnchor{
		NonAdFeeUSD: floatValue(nonAdFee),
		Basis: AnchorBasis{
			ObservedAt:         anchorTimePointer(item.ObservedAt),
			USDToRMBRate:       anchorFloatPointer(item.USDToRMBRate),
			USDToRMBRateSource: anchorStringPointer(item.USDToRMBRateSource),
		},
	}
	if price.Sign() <= 0 {
		return anchor
	}

	breakeven := breakevenAdvertisingRate(nonAdFee, ddpUSD, price, nil)
	maxAdSpend := roundDecimal(new(big.Rat).Mul(price, breakeven), 2)
	anchor.BreakevenAdvertisingRate = floatValue(breakeven)
	anchor.MaxAdSpendPerUnitUSD = floatValue(maxAdSpend)

	if item.Profit.ProfitAfterVATRate != nil {
		vat := roundDecimal(decimalValue(item.Profit.VATUSD), 2)
		afterVAT := breakevenAdvertisingRate(nonAdFee, ddpUSD, price, vat)
		anchor.BreakevenAdvertisingRateAfterVAT = floatValue(afterVAT)
	}
	return anchor
}

func breakevenAdvertisingRate(nonAdFee, ddpCost, salePrice, vat *big.Rat) *big.Rat {
	totalCost := new(big.Rat).Add(new(big.Rat).Set(nonAdFee), ddpCost)
	if vat != nil {
		totalCost.Add(totalCost, vat)
	}
	rate := new(big.Rat).Sub(big.NewRat(1, 1), new(big.Rat).Quo(totalCost, salePrice))
	return roundDecimal(rate, 4)
}

func decimalValue(value float64) *big.Rat {
	decimal, ok := new(big.Rat).SetString(strconv.FormatFloat(value, 'f', -1, 64))
	if !ok {
		return new(big.Rat)
	}
	return decimal
}

func roundDecimal(value *big.Rat, decimalPlaces int) *big.Rat {
	factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimalPlaces)), nil)
	scaledNumerator := new(big.Int).Mul(value.Num(), factor)
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(scaledNumerator, value.Denom(), remainder)
	absRemainder := new(big.Int).Abs(remainder)
	twiceRemainder := new(big.Int).Lsh(absRemainder, 1)
	if twiceRemainder.Cmp(value.Denom()) >= 0 {
		if scaledNumerator.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	return new(big.Rat).SetFrac(quotient, factor)
}

func floatValue(value *big.Rat) *float64 {
	result, _ := value.Float64()
	return &result
}

func anchorFloatPointer(value float64) *float64    { return &value }
func anchorStringPointer(value string) *string     { return &value }
func anchorTimePointer(value time.Time) *time.Time { return &value }
