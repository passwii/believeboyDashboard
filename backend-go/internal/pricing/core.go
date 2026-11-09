package pricing

import (
	"fmt"
	"math/big"
)

func resolvePriceBand(salePrice *big.Rat) (string, string, int) {
	if salePrice.Cmp(mustDecimal("10")) < 0 {
		return "lt_10", "售价 < $10", 0
	}
	if salePrice.Cmp(mustDecimal("50")) <= 0 {
		return "between_10_50", "售价 $10 ~ $50", 1
	}
	return "gt_50", "售价 > $50", 2
}

func resolveSizeTier(
	longestSide, middleSide, shortestSide, lengthPlusGirth *big.Rat,
	productWeight, dimensionalWeight *big.Rat,
) (string, string, *big.Rat) {
	if longestSide.Cmp(mustDecimal("15")) <= 0 &&
		middleSide.Cmp(mustDecimal("12")) <= 0 &&
		shortestSide.Cmp(mustDecimal("0.75")) <= 0 &&
		productWeight.Cmp(mustDecimal("1")) <= 0 {
		return "small_standard", "商品重量", new(big.Rat).Set(productWeight)
	}

	chargeableWeight := maxRat(productWeight, dimensionalWeight)
	if longestSide.Cmp(mustDecimal("18")) <= 0 &&
		middleSide.Cmp(mustDecimal("14")) <= 0 &&
		shortestSide.Cmp(mustDecimal("8")) <= 0 &&
		chargeableWeight.Cmp(mustDecimal("20")) <= 0 {
		return "large_standard", "商品重量与体积重量取大值", chargeableWeight
	}
	if longestSide.Cmp(mustDecimal("37")) <= 0 &&
		middleSide.Cmp(mustDecimal("28")) <= 0 &&
		shortestSide.Cmp(mustDecimal("20")) <= 0 &&
		lengthPlusGirth.Cmp(mustDecimal("130")) <= 0 &&
		chargeableWeight.Cmp(mustDecimal("50")) <= 0 {
		return "small_oversize", "商品重量与体积重量取大值", chargeableWeight
	}
	if longestSide.Cmp(mustDecimal("59")) <= 0 &&
		middleSide.Cmp(mustDecimal("33")) <= 0 &&
		shortestSide.Cmp(mustDecimal("33")) <= 0 &&
		lengthPlusGirth.Cmp(mustDecimal("130")) <= 0 &&
		chargeableWeight.Cmp(mustDecimal("50")) <= 0 {
		return "large_oversize", "商品重量与体积重量取大值", chargeableWeight
	}
	if productWeight.Cmp(mustDecimal("150")) > 0 {
		return "oversize_150_plus", "商品重量", new(big.Rat).Set(productWeight)
	}
	if chargeableWeight.Cmp(mustDecimal("50")) <= 0 {
		return "oversize_0_50", "商品重量与体积重量取大值", chargeableWeight
	}
	if chargeableWeight.Cmp(mustDecimal("70")) <= 0 {
		return "oversize_50_70", "商品重量与体积重量取大值", chargeableWeight
	}
	return "oversize_70_150", "商品重量与体积重量取大值", chargeableWeight
}

func resolveFBAFee(
	sizeTier string,
	chargeableWeightLB, chargeableWeightOZ *big.Rat,
	priceBandIndex int,
) (*big.Rat, string) {
	switch sizeTier {
	case "small_standard":
		for _, row := range smallStandardFees {
			if chargeableWeightOZ.Cmp(row.upper) <= 0 {
				return new(big.Rat).Set(row.fees[priceBandIndex]), fmt.Sprintf("%s / %s", tierLabels[sizeTier], row.label)
			}
		}
	case "large_standard":
		for _, row := range largeStandardFees {
			if chargeableWeightLB.Cmp(row.upper) <= 0 {
				return new(big.Rat).Set(row.fees[priceBandIndex]), fmt.Sprintf("%s / %s", tierLabels[sizeTier], row.label)
			}
		}
		base := [3]*big.Rat{mustDecimal("6.15"), mustDecimal("6.97"), mustDecimal("7.23")}[priceBandIndex]
		increments := ceilPositive(div(sub(chargeableWeightOZ, mustDecimal("48")), mustDecimal("4")))
		fee := add(base, mul(big.NewRat(increments, 1), mustDecimal("0.08")))
		return quantize(fee, 2), fmt.Sprintf("%s / 3 至 20 磅", tierLabels[sizeTier])
	case "small_oversize":
		base := [3]*big.Rat{mustDecimal("6.78"), mustDecimal("7.55"), mustDecimal("7.55")}[priceBandIndex]
		return tierFeeWithFirstPound(base, chargeableWeightLB, "0.38", tierLabels[sizeTier])
	case "large_oversize":
		base := [3]*big.Rat{mustDecimal("8.58"), mustDecimal("9.35"), mustDecimal("9.35")}[priceBandIndex]
		return tierFeeWithFirstPound(base, chargeableWeightLB, "0.38", tierLabels[sizeTier])
	case "oversize_0_50":
		base := [3]*big.Rat{mustDecimal("25.56"), mustDecimal("26.33"), mustDecimal("26.33")}[priceBandIndex]
		return tierFeeWithFirstPound(base, chargeableWeightLB, "0.38", tierLabels[sizeTier])
	case "oversize_50_70":
		base := [3]*big.Rat{mustDecimal("36.55"), mustDecimal("37.32"), mustDecimal("37.32")}[priceBandIndex]
		return tierFeeWithThreshold(base, chargeableWeightLB, "51", "0.75", tierLabels[sizeTier])
	case "oversize_70_150":
		base := [3]*big.Rat{mustDecimal("50.55"), mustDecimal("51.32"), mustDecimal("51.32")}[priceBandIndex]
		return tierFeeWithThreshold(base, chargeableWeightLB, "71", "0.75", tierLabels[sizeTier])
	default:
		base := [3]*big.Rat{mustDecimal("194.18"), mustDecimal("194.95"), mustDecimal("194.95")}[priceBandIndex]
		return tierFeeWithThreshold(base, chargeableWeightLB, "151", "0.19", tierLabels["oversize_150_plus"])
	}
	return new(big.Rat), ""
}

func resolveInboundFee(
	sizeTier string,
	chargeableWeightLB, chargeableWeightOZ *big.Rat,
	inboundPlacementMode string,
) (*big.Rat, string, []string) {
	if inboundPlacementMode == "amazon_optimized_split" {
		return new(big.Rat), "亚马逊优化的货件拆分 / 发往五个或更多地点 / 无费用", []string{}
	}
	switch sizeTier {
	case "small_standard":
		return findInboundFee(smallStandardInboundFees, chargeableWeightOZ, tierLabels[sizeTier], "单点入仓")
	case "large_standard":
		return findInboundFee(largeStandardInboundFees, chargeableWeightLB, tierLabels[sizeTier], "单点入仓")
	case "small_oversize":
		return findInboundFee(smallOversizeInboundFees, chargeableWeightLB, tierLabels[sizeTier], "单点入仓")
	case "large_oversize":
		return findInboundFee(largeOversizeInboundFees, chargeableWeightLB, tierLabels[sizeTier], "单点入仓")
	case "oversize_0_50", "oversize_50_70", "oversize_70_150", "oversize_150_plus":
		return new(big.Rat), fmt.Sprintf("%s / 超大件无入库配置费", tierLabels[sizeTier]), []string{}
	default:
		return new(big.Rat), fmt.Sprintf("%s / 当前未提供入库配置费规则，暂按 $0 计", tierLabels[sizeTier]),
			[]string{fmt.Sprintf("%s 当前未提供入库配置费阶梯，系统暂按 $0 计算。", tierLabels[sizeTier])}
	}
}

func findInboundFee(rows []inboundFee, weight *big.Rat, tier, mode string) (*big.Rat, string, []string) {
	for _, row := range rows {
		if weight.Cmp(row.upper) <= 0 {
			return new(big.Rat).Set(row.fee),
				fmt.Sprintf("%s / %s / %s", tier, mode, row.label),
				[]string{}
		}
	}
	return new(big.Rat), fmt.Sprintf("%s / 当前未提供入库配置费规则，暂按 $0 计", tier),
		[]string{fmt.Sprintf("%s 当前未提供入库配置费阶梯，系统暂按 $0 计算。", tier)}
}

func resolveStorageFee(sizeTier string, volumeCubicFt, storageMonths *big.Rat) (*big.Rat, string) {
	isStandard := sizeTier == "small_standard" || sizeTier == "large_standard"
	rate := oversizeStorage
	label := "大件商品 / 非危险品 / 非旺季"
	if isStandard {
		rate = standardStorage
		label = "标准尺寸 / 非危险品 / 非旺季"
	}
	fee := quantize(mul(mul(volumeCubicFt, rate), storageMonths), 2)
	return fee, fmt.Sprintf("%s / $%s / 立方英尺 / 月", label, rate.FloatString(2))
}

func tierFeeWithFirstPound(base, weight *big.Rat, increment, tierLabel string) (*big.Rat, string) {
	increments := ceilPositive(sub(weight, mustDecimal("1")))
	fee := add(base, mul(big.NewRat(increments, 1), mustDecimal(increment)))
	return quantize(fee, 2), fmt.Sprintf("%s / 0 至 50 磅", tierLabel)
}

func tierFeeWithThreshold(base, weight *big.Rat, threshold, increment, tierLabel string) (*big.Rat, string) {
	increments := ceilPositive(sub(weight, mustDecimal(threshold)))
	fee := add(base, mul(big.NewRat(increments, 1), mustDecimal(increment)))
	return quantize(fee, 2), tierLabel
}
