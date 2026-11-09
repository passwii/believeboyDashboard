package pricing

import (
	"fmt"
	"math"
)

// SolveSalePriceForProfitRate mirrors the FastAPI reverse solver: find the
// lowest cent-denominated price whose computed net margin reaches the target.
func SolveSalePriceForProfitRate(
	request FBARequest,
	data QuoteData,
	targetProfitRate float64,
) (float64, Result, error) {
	if targetProfitRate < 0 || targetProfitRate >= 1 {
		return 0, Result{}, fmt.Errorf("target_profit_rate must be >= 0 and < 1")
	}
	low := 0.01
	high := 10.0
	computed, err := QuoteFBA(withSalePrice(request, high), data)
	if err != nil {
		return 0, Result{}, err
	}
	for computed.Profit.ProfitRate < targetProfitRate {
		high *= 2
		if high > 1_000_000 {
			return 0, Result{}, fmt.Errorf("目标利润率过高，当前参数下无法倒算出合理售价")
		}
		computed, err = QuoteFBA(withSalePrice(request, high), data)
		if err != nil {
			return 0, Result{}, err
		}
	}

	for range 40 {
		mid := roundToCents((low + high) / 2)
		computed, err = QuoteFBA(withSalePrice(request, mid), data)
		if err != nil {
			return 0, Result{}, err
		}
		if computed.Profit.ProfitRate >= targetProfitRate {
			high = mid
		} else {
			low = mid
		}
	}

	price := roundToCents(high)
	computed, err = QuoteFBA(withSalePrice(request, price), data)
	if err != nil {
		return 0, Result{}, err
	}
	if computed.Profit.ProfitRate < targetProfitRate {
		price = roundToCents(price + 0.01)
		computed, err = QuoteFBA(withSalePrice(request, price), data)
		if err != nil {
			return 0, Result{}, err
		}
	}
	if computed.Profit.ProfitRate < targetProfitRate {
		return 0, Result{}, fmt.Errorf("目标利润率过高，当前参数下无法倒算出合理售价")
	}
	return price, computed, nil
}

// SolveFOBForProfitRate finds the highest cent-denominated FOB cost that still
// satisfies the target net margin.
func SolveFOBForProfitRate(
	request FBARequest,
	data QuoteData,
	targetProfitRate float64,
) (float64, Result, error) {
	if targetProfitRate < 0 || targetProfitRate >= 1 {
		return 0, Result{}, fmt.Errorf("target_profit_rate must be >= 0 and < 1")
	}
	low := 0.01
	high := 100_000.0
	bestCost := low
	var bestResult Result

	for range 40 {
		mid := roundToCents((low + high) / 2)
		computed, err := QuoteFBA(withFOBProductCost(request, mid), data)
		if err != nil {
			return 0, Result{}, err
		}
		bestCost = mid
		bestResult = computed
		if math.Abs(computed.Profit.ProfitRate-targetProfitRate) < 0.0001 {
			return bestCost, bestResult, nil
		}
		if computed.Profit.ProfitRate > targetProfitRate {
			low = mid
		} else {
			high = mid
		}
	}
	if bestResult.CalculationType == "" {
		return 0, Result{}, fmt.Errorf("无法找到满足目标利润率的 FOB 成本")
	}
	if math.Abs(bestResult.Profit.ProfitRate-targetProfitRate) >= 0.0001 {
		return 0, Result{}, fmt.Errorf("无法找到满足目标利润率的 FOB 成本")
	}
	return bestCost, bestResult, nil
}

func withSalePrice(request FBARequest, price float64) FBARequest {
	request.SalePriceUSD = price
	return request
}

func withFOBProductCost(request FBARequest, cost float64) FBARequest {
	request.FOBProductCostRMB = cost
	return request
}

func roundToCents(value float64) float64 {
	rounded, err := quantized(value, 2)
	if err != nil {
		return value
	}
	return float64Value(rounded)
}
