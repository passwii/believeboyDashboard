package new_product_calculations

import (
	"math/big"
	"strconv"
)

func deriveAnchor(item *NewProductCalculationItem) *PricingAnchor {
	totalFee := anchorRound(anchorDecimal(item.Fees.TotalFeeUSD), 2)
	advertisingFee := anchorRound(anchorDecimal(item.Fees.AdvertisingFeeUSD), 2)
	nonAdFee := anchorRound(new(big.Rat).Sub(totalFee, advertisingFee), 2)
	ddpCost := anchorRound(anchorDecimal(item.Profit.DDPCostUSD), 2)
	salePrice := anchorRound(anchorDecimal(item.SalePriceUSD), 2)

	anchor := &PricingAnchor{
		NonAdFeeUSD: floatPointer(anchorFloat(nonAdFee)),
		Basis: PricingAnchorBasis{
			ObservedAt:         item.ObservedAt,
			USDToRMBRate:       floatPointer(item.USDToRMBRate),
			USDToRMBRateSource: stringPointer(item.USDToRMBRateSource),
		},
	}
	if item.TargetProfitRate != nil {
		target := anchorRound(anchorDecimal(*item.TargetProfitRate), 4)
		anchor.TargetNetMargin = floatPointer(anchorFloat(target))
	}
	if salePrice.Sign() <= 0 {
		return anchor
	}

	breakeven := anchorBreakeven(nonAdFee, ddpCost, salePrice, nil)
	anchor.BreakevenAdvertisingRate = floatPointer(anchorFloat(breakeven))
	maxAdSpend := anchorRound(new(big.Rat).Mul(salePrice, breakeven), 2)
	anchor.MaxAdSpendPerUnitUSD = floatPointer(anchorFloat(maxAdSpend))
	if item.TargetProfitRate != nil {
		target := anchorRound(new(big.Rat).Sub(
			breakeven,
			anchorDecimal(*item.TargetProfitRate),
		), 4)
		anchor.TargetAdvertisingRate = floatPointer(anchorFloat(target))
	}
	if item.Profit.ProfitAfterVATRate != nil {
		vat := anchorRound(anchorDecimal(item.Profit.VATUSD), 2)
		afterVAT := anchorBreakeven(nonAdFee, ddpCost, salePrice, vat)
		anchor.BreakevenAdvertisingRateAfterVAT = floatPointer(anchorFloat(afterVAT))
	}
	return anchor
}

func anchorBreakeven(nonAdFee, ddpCost, salePrice, vat *big.Rat) *big.Rat {
	totalCost := new(big.Rat).Add(new(big.Rat).Set(nonAdFee), ddpCost)
	if vat != nil {
		totalCost.Add(totalCost, vat)
	}
	rate := new(big.Rat).Sub(big.NewRat(1, 1), new(big.Rat).Quo(totalCost, salePrice))
	return anchorRound(rate, 4)
}

func anchorDecimal(value float64) *big.Rat {
	decimal, ok := new(big.Rat).SetString(strconv.FormatFloat(value, 'f', -1, 64))
	if !ok {
		return new(big.Rat)
	}
	return decimal
}

func anchorRound(value *big.Rat, decimalPlaces int) *big.Rat {
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

func anchorFloat(value *big.Rat) float64 {
	result, _ := value.Float64()
	return result
}
