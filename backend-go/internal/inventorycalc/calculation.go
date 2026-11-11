// Package inventorycalc ports the pure calculation core of FastAPI's
// inventory health model: weighted DMS, coverage timeline, risk status,
// replenishment quantity, the v1.2 five-state machine and its signals.
package inventorycalc

import (
	"math"
	"time"
)

const (
	EmergencyOrderBufferDays = 14

	RiskOutOfStock          = "断货风险"
	RiskShortTermOutOfStock = "短期断货"
	RiskLongTermOutOfStock  = "长期断货"
	RiskHealthy             = "健康库存"
	RiskSlowMoving          = "滞销"
	RiskSevereSlowMoving    = "严重滞销"
	RiskPending             = "待补数据"
)

// ItemInput mirrors app.services.inventory.health_score.ItemInput.
type ItemInput struct {
	AvailableQty   int
	SellableDays   *float64
	DMS30          *float64
	DMS14          *float64
	DMS7           *float64
	DMS3           *float64
	Age0To90Qty    int
	Age91To180Qty  int
	Age181To270Qty int
	Age271To365Qty int
	Age365PlusQty  int
	InTransitQty   int
}

// TransitBatch is one in-transit shipment batch used by the coverage timeline.
type TransitBatch struct {
	Quantity    int
	ETADate     *time.Time
	ETDDate     *time.Time
	CreatedDate *time.Time
}

func normalizeWeightedDMS(dms30, dms14, dms7, dms3 *float64) *float64 {
	type window struct {
		value  *float64
		weight float64
	}
	windows := []window{
		{dms30, 0.10},
		{dms14, 0.30},
	}
	if dms3 == nil {
		windows = append(windows, window{dms7, 0.60})
	} else {
		windows = append(windows, window{dms7, 0.30})
	}
	windows = append(windows, window{dms3, 0.30})

	totalWeight := 0.0
	weightedSum := 0.0
	for _, item := range windows {
		if item.value == nil {
			continue
		}
		totalWeight += item.weight
		weightedSum += *item.value * item.weight
	}
	if totalWeight <= 0 {
		return nil
	}
	result := weightedSum / totalWeight
	return &result
}

// NormalizeWeightedDMS is the exported form used by the store layer.
func NormalizeWeightedDMS(dms30, dms14, dms7, dms3 *float64) *float64 {
	return normalizeWeightedDMS(dms30, dms14, dms7, dms3)
}

func round4(value float64) float64 {
	return math.Round(value*10000) / 10000
}

// AddDays mirrors Python _add_days: base + fractional days, then date only.
func AddDays(base time.Time, days *float64) *string {
	if days == nil {
		return nil
	}
	dt := base.Add(time.Duration(*days * float64(24*time.Hour)))
	formatted := dt.Format("2006-01-02")
	return &formatted
}

// ComputeCoverageTimeline mirrors _compute_coverage_timeline (BLF-630).
func ComputeCoverageTimeline(
	today time.Time,
	availableInventory int,
	weightedDMS *float64,
	transitBatches []TransitBatch,
	shippingDays int,
) (continuousEnd *time.Time, gapStart *time.Time, gapDays int, nextTransitETA *time.Time) {
	if weightedDMS == nil || *weightedDMS <= 0 {
		return nil, nil, 0, nil
	}
	coverageDays := float64(availableInventory) / *weightedDMS
	continuous := addDaysTime(today, coverageDays)
	extended := continuous
	var gap *time.Time
	gapLength := 0

	batches := make([]batchETA, 0, len(transitBatches))
	for _, batch := range transitBatches {
		eta := batch.ETADate
		if eta == nil && batch.ETDDate != nil {
			value := addDaysTime(*batch.ETDDate, float64(shippingDays))
			eta = &value
		}
		if eta == nil && batch.CreatedDate != nil {
			value := addDaysTime(*batch.CreatedDate, float64(shippingDays))
			eta = &value
		}
		if eta == nil {
			continue
		}
		batches = append(batches, batchETA{quantity: batch.Quantity, eta: *eta})
	}
	if len(batches) == 0 {
		return &continuous, nil, 0, nil
	}
	sortBatchesByETA(batches)
	firstETA := batches[0].eta
	for _, batch := range batches {
		if !batch.eta.After(extended) {
			extended = addDaysTime(extended, float64(batch.quantity) / *weightedDMS)
			continue
		}
		if gap == nil {
			gapValue := extended
			gap = &gapValue
			gapLength = int(batch.eta.Sub(extended).Hours() / 24)
		}
		extended = addDaysTime(batch.eta, float64(batch.quantity) / *weightedDMS)
	}
	if gap != nil {
		continuous = *gap
	} else {
		continuous = extended
	}
	return &continuous, gap, gapLength, &firstETA
}

func addDaysTime(base time.Time, days float64) time.Time {
	return base.Add(time.Duration(days * float64(24*time.Hour)))
}

type batchETA struct {
	quantity int
	eta      time.Time
}

func sortBatchesByETA(batches []batchETA) {
	for i := 1; i < len(batches); i++ {
		for j := i; j > 0 && batches[j].eta.Before(batches[j-1].eta); j-- {
			batches[j], batches[j-1] = batches[j-1], batches[j]
		}
	}
}

// ClassifyRisk mirrors _classify_risk (BLF-630 §4.5).
func ClassifyRisk(today time.Time, coverageEndDateText *string, orderBufferDays *int, weightedDMS *float64) string {
	if weightedDMS == nil || *weightedDMS <= 0 || coverageEndDateText == nil || orderBufferDays == nil {
		return RiskPending
	}
	coverageEnd, err := time.Parse("2006-01-02", *coverageEndDateText)
	if err != nil {
		return RiskPending
	}
	daysDiff := int(coverageEnd.Sub(today).Hours() / 24)
	if daysDiff < 0 {
		return RiskLongTermOutOfStock
	}
	if *orderBufferDays < 0 {
		return RiskShortTermOutOfStock
	}
	if *orderBufferDays <= EmergencyOrderBufferDays {
		return RiskOutOfStock
	}
	if daysDiff <= 90 {
		return RiskHealthy
	}
	if daysDiff <= 120 {
		return RiskSlowMoving
	}
	return RiskSevereSlowMoving
}

// EstimateReplenishmentQuantity mirrors _estimate_replenishment_quantity.
func EstimateReplenishmentQuantity(targetDays int, coverageDaysTotal *int, productionPlusShippingDays int, weightedDMS *float64) *int {
	if weightedDMS == nil || *weightedDMS <= 0 || coverageDaysTotal == nil {
		return nil
	}
	remainingAtArrival := float64(*coverageDaysTotal - productionPlusShippingDays)
	estDays := float64(targetDays) - remainingAtArrival
	if estDays <= 0 {
		return nil
	}
	value := int(math.Round(estDays * *weightedDMS))
	return &value
}

// Round4 exposes the 4-decimal rounding used by FastAPI decimal_to_float.
func Round4(value float64) float64 {
	return round4(value)
}
