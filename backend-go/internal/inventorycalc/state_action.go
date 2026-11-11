package inventorycalc

import "math"

const (
	TrendRatioUp       = 1.5
	TrendRatioStable   = 0.9
	TrendRatioDownMild = 0.7
	MomentumDelta      = 0.1

	StateCriticalDOH             = 14
	StateCriticalShortageDOH     = 30
	StateOverstockCriticalDOH    = 180
	StateOverstockDeteriorateDOH = 120
	StateWatchDOHMin             = 30
	StateWatchDOHMax             = 90
	Aging271Ratio                = 0.50
	Aging181Ratio                = 0.50
	Aging91DeteriorateRatio      = 0.30
	TransitRatioDeteriorate      = 3.0
	VelocityMid                  = 0.7
)

const (
	ActionReplenishNow    = "REPLENISH_NOW"
	ActionReplenishNormal = "REPLENISH_NORMAL"
	ActionHold            = "HOLD"
	ActionReducePrice     = "REDUCE_PRICE"
	ActionRemove          = "REMOVE"
	ActionNoAction        = "NO_ACTION"
)

// Signals mirrors the FastAPI InventorySignals JSON schema.
type Signals struct {
	SellableDays      *float64           `json:"sellable_days"`
	DMS3              *float64           `json:"dms_3"`
	DMS7              *float64           `json:"dms_7"`
	DMS14             *float64           `json:"dms_14"`
	DMS30             *float64           `json:"dms_30"`
	TrendRatio730     *float64           `json:"trend_ratio_7_30"`
	TrendRatio37      *float64           `json:"trend_ratio_3_7"`
	TrendLabel        string             `json:"trend_label"`
	TrendMomentum     string             `json:"trend_momentum"`
	AgingShare        map[string]float64 `json:"aging_share"`
	TransitRatio      *float64           `json:"transit_ratio"`
	DataFreshnessDays int                `json:"data_freshness_days"`
	Confidence        string             `json:"confidence"`
	SeasonalFactor    *float64           `json:"seasonal_factor"`
	SeasonalPhase     string             `json:"seasonal_phase"`
	SeasonalSource    string             `json:"seasonal_source"`
}

// ComputeTrendLabel mirrors compute_trend_label.
func ComputeTrendLabel(dms7, dms30 *float64) string {
	if dms7 == nil || dms30 == nil || *dms30 <= 0 {
		return "稳定"
	}
	ratio := *dms7 / *dms30
	if ratio > TrendRatioUp {
		return "上升"
	}
	if ratio >= TrendRatioStable {
		return "稳定"
	}
	if ratio >= TrendRatioDownMild {
		return "轻微下降"
	}
	return "下降明显"
}

// ComputeTrendMomentum mirrors compute_trend_momentum.
func ComputeTrendMomentum(dms7, dms14, dms30 *float64) string {
	if dms7 == nil || dms14 == nil || dms30 == nil || *dms30 <= 0 {
		return "stable"
	}
	delta := (*dms7 - *dms14) / *dms30
	if delta < -MomentumDelta {
		return "accelerating"
	}
	if delta > MomentumDelta {
		return "decelerating"
	}
	return "stable"
}

// ComputeSeasonalAdjustedSellableDays mirrors compute_seasonal_adjusted_sellable_days.
func ComputeSeasonalAdjustedSellableDays(sellableDays, seasonalFactor *float64) *float64 {
	if sellableDays == nil {
		return nil
	}
	if seasonalFactor == nil || *seasonalFactor <= 0 {
		return sellableDays
	}
	value := *sellableDays / *seasonalFactor
	return &value
}

// ComputeInventoryState mirrors compute_inventory_state (spec §2.1).
func ComputeInventoryState(item ItemInput, trendLabel string, adjustedSellableDays *float64, orderBufferDays *int) (string, *string, string) {
	doh := adjustedSellableDays
	if item.DMS30 == nil {
		return "unknown", nil, "P0"
	}
	if doh != nil && *doh < StateCriticalDOH {
		subtype := "shortage"
		return "critical", &subtype, "P1"
	}
	if doh != nil && *doh < StateCriticalShortageDOH && *item.DMS30 > 0 {
		subtype := "shortage"
		return "critical", &subtype, "P2"
	}
	totalAge := item.Age0To90Qty + item.Age91To180Qty + item.Age181To270Qty + item.Age271To365Qty + item.Age365PlusQty
	if item.Age365PlusQty > 0 {
		subtype := "aging"
		return "critical", &subtype, "P3"
	}
	if totalAge > 0 && float64(item.Age271To365Qty)/float64(totalAge) >= Aging271Ratio {
		subtype := "aging"
		return "critical", &subtype, "P4"
	}
	if totalAge > 0 && float64(item.Age181To270Qty)/float64(totalAge) >= Aging181Ratio {
		subtype := "aging"
		return "critical", &subtype, "P5"
	}
	if doh != nil && *doh > StateOverstockCriticalDOH && *item.DMS30 < VelocityMid {
		subtype := "overstock"
		return "critical", &subtype, "P6"
	}
	if orderBufferDays != nil && *orderBufferDays < 0 {
		if trendLabel == "下降明显" || trendLabel == "轻微下降" {
			return "deteriorating", nil, "P0b"
		}
		return "watch", nil, "P0a"
	}
	if doh != nil && *doh > StateOverstockDeteriorateDOH && *doh <= StateOverstockCriticalDOH && *item.DMS30 < VelocityMid {
		return "deteriorating", nil, "P7"
	}
	if trendLabel == "下降明显" {
		aging91PlusRatio := 0.0
		if totalAge > 0 {
			aging91PlusRatio = float64(item.Age91To180Qty+item.Age181To270Qty+item.Age271To365Qty+item.Age365PlusQty) / float64(totalAge)
		}
		transitRatio := 0.0
		if item.AvailableQty > 0 {
			transitRatio = float64(item.InTransitQty) / float64(item.AvailableQty)
		}
		if aging91PlusRatio >= Aging91DeteriorateRatio || transitRatio > TransitRatioDeteriorate {
			return "deteriorating", nil, "P8"
		}
	}
	if doh != nil && *doh >= 45 && *doh <= StateWatchDOHMax && trendLabel == "下降明显" {
		return "deteriorating", nil, "P9"
	}
	if doh != nil && *doh >= StateWatchDOHMin && *doh < 45 && trendLabel == "下降明显" {
		return "watch", nil, "P10"
	}
	if doh != nil && *doh > StateWatchDOHMax && *doh <= StateOverstockCriticalDOH {
		return "watch", nil, "P11"
	}
	return "healthy", nil, "P12"
}

// ComputeReplenishmentAction mirrors compute_replenishment_action (spec §2.2).
func ComputeReplenishmentAction(state string, criticalSubtype *string, trendLabel string, transitRatio float64, seasonalPhase string, adjustedSellableDays *float64, orderBufferDays *int) (string, string, bool) {
	trendIsDecline := trendLabel == "轻微下降" || trendLabel == "下降明显"
	trendIsUp := trendLabel == "上升" || trendLabel == "稳定"
	urgentShortage := adjustedSellableDays != nil && *adjustedSellableDays < StateCriticalDOH
	isTrough := seasonalPhase == "falling" || seasonalPhase == "trough"
	isPeak := seasonalPhase == "peak" || seasonalPhase == "rising"

	if state == "critical" && criticalSubtype != nil && *criticalSubtype == "aging" {
		return ActionRemove, "aging-remove", false
	}
	if state == "critical" && criticalSubtype != nil && *criticalSubtype == "overstock" {
		if trendIsDecline {
			return ActionReducePrice, "overstock-reduce-decline", false
		}
		if transitRatio > 3.0 {
			return ActionReducePrice, "overstock-reduce-transit", false
		}
		if isTrough {
			return ActionHold, "overstock-hold-trough", true
		}
		return ActionHold, "overstock-hold-stable", false
	}
	if orderBufferDays != nil {
		if *orderBufferDays < 0 {
			return ActionReplenishNow, "buffer-negative-urgent", false
		}
		if *orderBufferDays <= EmergencyOrderBufferDays {
			return ActionReplenishNow, "buffer-urgent", false
		}
	}
	if state == "critical" && criticalSubtype != nil && *criticalSubtype == "shortage" {
		if urgentShortage {
			return ActionReplenishNow, "shortage-urgent", false
		}
		if trendIsUp {
			return ActionReplenishNormal, "shortage-normal-up", false
		}
		if isPeak {
			return ActionReplenishNormal, "shortage-normal-peak", true
		}
		return ActionHold, "shortage-hold-down", false
	}
	if state == "deteriorating" {
		if trendIsDecline {
			if isTrough {
				return ActionHold, "deteriorating-hold-trough", true
			}
			return ActionReducePrice, "deteriorating-reduce", false
		}
		return ActionHold, "deteriorating-hold-stable", false
	}
	return ActionNoAction, "no-action", false
}

// ComputeSeasonalFactor mirrors compute_seasonal_factor.
func ComputeSeasonalFactor(dms30, dms7, dms30YoY, dms7YoY *float64) (*float64, string, string) {
	ratios := make([]float64, 0, 2)
	if dms30 != nil && *dms30 > 0 && dms30YoY != nil && *dms30YoY > 0 {
		ratios = append(ratios, *dms30 / *dms30YoY)
	}
	if dms7 != nil && *dms7 > 0 && dms7YoY != nil && *dms7YoY > 0 {
		ratios = append(ratios, *dms7 / *dms7YoY)
	}
	if len(ratios) == 0 {
		return nil, "unknown", "neutral"
	}
	sum := 0.0
	for _, ratio := range ratios {
		sum += ratio
	}
	raw := sum / float64(len(ratios))
	factor := math.Max(0.3, math.Min(3.0, raw))
	phase := ComputeSeasonalPhase(&factor)
	return &factor, phase, "sku_yoy"
}

// ComputeSeasonalPhase mirrors compute_seasonal_phase.
func ComputeSeasonalPhase(factor *float64) string {
	if factor == nil {
		return "unknown"
	}
	if *factor > 1.3 {
		return "peak"
	}
	if *factor > 1.1 {
		return "rising"
	}
	if *factor >= 0.9 {
		return "neutral"
	}
	if *factor >= 0.7 {
		return "falling"
	}
	return "trough"
}

// ComputeSignals mirrors compute_signals (spec §2.3).
func ComputeSignals(item ItemInput, trendLabel, trendMomentum string, snapshotAgeDays int, seasonalFactor *float64, seasonalPhase, seasonalSource string) Signals {
	var trendRatio730 *float64
	if item.DMS7 != nil && item.DMS30 != nil && *item.DMS30 > 0 {
		value := *item.DMS7 / *item.DMS30
		trendRatio730 = &value
	}
	var trendRatio37 *float64
	if item.DMS3 != nil && item.DMS7 != nil && *item.DMS7 > 0 {
		value := *item.DMS3 / *item.DMS7
		trendRatio37 = &value
	}

	totalAge := item.Age0To90Qty + item.Age91To180Qty + item.Age181To270Qty + item.Age271To365Qty + item.Age365PlusQty
	agingShare := map[string]float64{
		"0_90": 0, "91_180": 0, "181_270": 0, "271_365": 0, "365_plus": 0,
	}
	if totalAge > 0 {
		agingShare["0_90"] = float64(item.Age0To90Qty) / float64(totalAge)
		agingShare["91_180"] = float64(item.Age91To180Qty) / float64(totalAge)
		agingShare["181_270"] = float64(item.Age181To270Qty) / float64(totalAge)
		agingShare["271_365"] = float64(item.Age271To365Qty) / float64(totalAge)
		agingShare["365_plus"] = float64(item.Age365PlusQty) / float64(totalAge)
	}

	var transitRatio *float64
	if item.AvailableQty > 0 {
		value := float64(item.InTransitQty) / float64(item.AvailableQty)
		transitRatio = &value
	}

	hasDMS30 := item.DMS30 != nil
	hasDMS7 := item.DMS7 != nil
	hasFullAging := totalAge > 0
	confidence := "high"
	if !hasDMS30 || snapshotAgeDays > 3 {
		confidence = "low"
	} else if !hasDMS7 || !hasFullAging || snapshotAgeDays > 1 {
		confidence = "medium"
	}

	return Signals{
		SellableDays:      item.SellableDays,
		DMS3:              item.DMS3,
		DMS7:              item.DMS7,
		DMS14:             item.DMS14,
		DMS30:             item.DMS30,
		TrendRatio730:     trendRatio730,
		TrendRatio37:      trendRatio37,
		TrendLabel:        trendLabel,
		TrendMomentum:     trendMomentum,
		AgingShare:        agingShare,
		TransitRatio:      transitRatio,
		DataFreshnessDays: snapshotAgeDays,
		Confidence:        confidence,
		SeasonalFactor:    seasonalFactor,
		SeasonalPhase:     seasonalPhase,
		SeasonalSource:    seasonalSource,
	}
}
