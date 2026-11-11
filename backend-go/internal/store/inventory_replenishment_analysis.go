package store

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
	"github.com/passwii/believeboyDashboard/backend-go/internal/inventorycalc"
)

const (
	replenishmentDefaultSafetyFactor   = 0.20
	replenishmentDefaultProductionLead = 20
	replenishmentDefaultShippingDays   = 25
	replenishmentDefaultTargetDays     = 90
	replenishmentRecentSalesWindowDays = 3
	replenishmentRecentSalesLagDays    = 2
)

var (
	replenishmentStateValues   = []string{"critical", "deteriorating", "watch", "healthy", "unknown"}
	replenishmentActionValues  = []string{"REPLENISH_NOW", "REPLENISH_NORMAL", "HOLD", "REDUCE_PRICE", "REMOVE", "NO_ACTION"}
	replenishmentOrderByFields = map[string]bool{
		"sku": true, "available_inventory": true, "in_transit_quantity": true,
		"weighted_dms": true, "sellable_days": true,
		"estimated_replenishment_quantity": true, "risk_status": true,
		"inventory_state": true, "replenishment_action": true,
		"order_buffer_days": true, "coverage_end_date": true,
	}
)

type replenishmentBaseRow struct {
	SKU     string
	ASIN    *string
	Country string
}

type replenishmentSetting struct {
	ASIN               *string
	SafetyFactor       float64
	ProductionLeadDays int
	ShippingDays       int
	TargetDays         int
}

type replenishmentSnapshot struct {
	AvailableQty      int
	Age0To90Qty       int
	Age91To180Qty     int
	Age181To270Qty    int
	Age271To365Qty    int
	Age365PlusQty     int
	RecommendedAction *string
}

func (s *InventoryReplenishmentStore) ListAnalysis(ctx context.Context, filter inventory_replenishment.ReplenishmentFilter) (inventory_replenishment.InventoryReplenishmentListResponse, error) {
	if filter.ProjectID == nil || *filter.ProjectID <= 0 {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, inventory_replenishment.ErrProjectNotFound
	}
	projectID := *filter.ProjectID
	country := "US"
	if filter.Country != nil && strings.TrimSpace(*filter.Country) != "" {
		country = normalizeCountry(*filter.Country)
	}

	var projectName string
	if err := s.db.QueryRow(ctx, "select project_name from public.projects where id = $1", projectID).Scan(&projectName); err != nil {
		if err == pgx.ErrNoRows {
			return inventory_replenishment.InventoryReplenishmentListResponse{}, inventory_replenishment.ErrProjectNotFound
		}
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}

	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if filter.ReportDate != nil && strings.TrimSpace(*filter.ReportDate) != "" {
		parsed, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(*filter.ReportDate), time.Local)
		if err == nil {
			today = parsed
		}
	} else if filter.SnapshotDate != nil && strings.TrimSpace(*filter.SnapshotDate) != "" {
		parsed, err := time.Parse("2006-01-02", strings.TrimSpace(*filter.SnapshotDate))
		if err == nil {
			today = parsed
		}
	}

	baseRows, err := s.loadReplenishmentBaseRows(ctx, projectID, projectName, country)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	settings, err := s.loadReplenishmentSettings(ctx, projectID, country)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}

	sourceID, sourceDate, err := s.loadInventoryAnalysisSource(ctx, projectID, country, filter.ReportDate)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	snapshotAgeDays := 0
	if sourceDate != nil {
		if parsed, parseErr := time.ParseInLocation("2006-01-02", *sourceDate, today.Location()); parseErr == nil {
			days := int(today.Sub(parsed).Hours() / 24)
			if days > 0 {
				snapshotAgeDays = days
			}
		}
	}
	snapshotBySKU := make(map[string]replenishmentSnapshot)
	if sourceID != nil {
		snapshotBySKU, err = s.loadReplenishmentSnapshot(ctx, *sourceID)
		if err != nil {
			return inventory_replenishment.InventoryReplenishmentListResponse{}, err
		}
	}

	reportDate := filter.ReportDate
	inTransitMap, err := s.loadReplenishmentInTransitMap(ctx, projectID, country, reportDate)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	transitBatches := make(map[string][]inventorycalc.TransitBatch)
	if reportDate == nil || strings.TrimSpace(*reportDate) == "" {
		transitBatches, err = s.loadReplenishmentTransitBatches(ctx, projectID, country)
		if err != nil {
			return inventory_replenishment.InventoryReplenishmentListResponse{}, err
		}
	}

	productNames, err := s.loadReplenishmentProductNames(ctx, projectID, baseRows)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}

	dms30, err := s.loadReplenishmentDMSMap(ctx, projectID, country, today, 30, 0)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	dms14, err := s.loadReplenishmentDMSMap(ctx, projectID, country, today, 14, 0)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	dms7, err := s.loadReplenishmentDMSMap(ctx, projectID, country, today, 7, 0)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	dms3, err := s.loadReplenishmentDMSMap(ctx, projectID, country, today, replenishmentRecentSalesWindowDays, replenishmentRecentSalesLagDays)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}

	keyword := ""
	if filter.Keyword != nil {
		keyword = strings.ToLower(strings.TrimSpace(*filter.Keyword))
	}
	riskFilter := ""
	if filter.RiskStatus != nil {
		riskFilter = strings.TrimSpace(*filter.RiskStatus)
	}
	stateFilter := parseFilterSet(filter.InventoryState)
	actionFilter := parseFilterSet(filter.ReplenishmentAction)

	items := make([]inventory_replenishment.InventoryReplenishmentListItem, 0, len(baseRows))
	for _, base := range baseRows {
		setting := settings[base.SKU]
		asin := base.ASIN
		if setting != nil && setting.ASIN != nil && strings.TrimSpace(*setting.ASIN) != "" {
			asin = setting.ASIN
		}
		snap := snapshotBySKU[base.SKU]
		available := snap.AvailableQty
		inTransit := inTransitMap[base.SKU]

		historical := filter.ReportDate != nil && strings.TrimSpace(*filter.ReportDate) != ""
		item := buildReplenishmentItem(
			projectID, projectName, base, setting, snap, available, inTransit,
			dms30[base.SKU], dms14[base.SKU], dms7[base.SKU], dms3[base.SKU],
			transitBatches[base.SKU], today, snapshotAgeDays, productNames[base.SKU], historical,
		)
		item.ASIN = asin

		if keyword != "" && !strings.Contains(strings.ToLower(item.SKU), keyword) &&
			(item.ASIN == nil || !strings.Contains(strings.ToLower(*item.ASIN), keyword)) {
			continue
		}
		if riskFilter != "" && riskFilter != "all" && item.RiskStatus != riskFilter {
			continue
		}
		if filter.InTransitOnly && item.InTransitQuantity <= 0 {
			continue
		}
		if len(stateFilter) > 0 && !stateFilter[item.InventoryState] {
			continue
		}
		if len(actionFilter) > 0 && !actionFilter[item.ReplenishmentAction] {
			continue
		}
		items = append(items, item)
	}

	summary := buildReplenishmentSummary(items)
	if filter.OrderBy != nil && replenishmentOrderByFields[*filter.OrderBy] && len(items) > 1 {
		sortReplenishmentItems(items, *filter.OrderBy, filter.OrderDir)
	}

	total := len(items)
	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 50
	}
	start := (page - 1) * pageSize
	if start > total {
		start = total
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	paged := items[start:end]
	hasNext := start+pageSize < total

	return inventory_replenishment.InventoryReplenishmentListResponse{
		Items:    paged,
		Summary:  summary,
		Page:     page,
		PageSize: pageSize,
		Total:    total,
		HasNext:  hasNext,
	}, nil
}

func buildReplenishmentItem(
	projectID int64,
	projectName string,
	base replenishmentBaseRow,
	setting *replenishmentSetting,
	snap replenishmentSnapshot,
	available int,
	inTransit int,
	dms30, dms14, dms7, dms3 *float64,
	batches []inventorycalc.TransitBatch,
	today time.Time,
	snapshotAgeDays int,
	productName *string,
	historical bool,
) inventory_replenishment.InventoryReplenishmentListItem {
	safetyFactor := replenishmentDefaultSafetyFactor
	productionLead := replenishmentDefaultProductionLead
	shippingDays := replenishmentDefaultShippingDays
	targetDays := replenishmentDefaultTargetDays
	if setting != nil {
		safetyFactor = setting.SafetyFactor
		productionLead = setting.ProductionLeadDays
		shippingDays = setting.ShippingDays
		if setting.TargetDays > 0 {
			targetDays = setting.TargetDays
		}
	}

	var weightedDMS *float64
	if baseDMS := inventorycalc.NormalizeWeightedDMS(dms30, dms14, dms7, dms3); baseDMS != nil {
		value := *baseDMS * (1 + safetyFactor)
		if value > 0 {
			weightedDMS = &value
		}
	}
	var sellableDays *float64
	var rawSellableDays *float64
	if weightedDMS != nil {
		raw := float64(available) / *weightedDMS
		rawSellableDays = &raw
		rounded := math.Round(raw*100) / 100
		sellableDays = &rounded
	}
	var selloutDate, selloutDateWithTransit *string
	if rawSellableDays != nil {
		selloutDate = inventorycalc.AddDays(today, rawSellableDays)
		totalValue := (float64(available) + float64(inTransit)) / *weightedDMS
		selloutDateWithTransit = inventorycalc.AddDays(today, &totalValue)
	}

	productionPlusShipping := productionLead + shippingDays
	var coverageEnd, latestOrderDate, warehouseEntryDate, shipmentOrderDate, riskAnchorDate *string
	var orderBufferDays *int
	var gapStartDate, nextTransitETA *string
	gapDays := 0
	if weightedDMS != nil && *weightedDMS > 0 {
		var continuousEnd *time.Time
		if !historical {
			var gapStart *time.Time
			var nextETA *time.Time
			var gapDaysValue int
			normalizedBatches := make([]inventorycalc.TransitBatch, 0, len(batches))
			for _, batch := range batches {
				normalizedBatches = append(normalizedBatches, inventorycalc.TransitBatch{
					Quantity:    batch.Quantity,
					ETADate:     normalizeDatePointer(batch.ETADate, today.Location()),
					ETDDate:     normalizeDatePointer(batch.ETDDate, today.Location()),
					CreatedDate: normalizeDatePointer(batch.CreatedDate, today.Location()),
				})
			}
			continuousEnd, gapStart, gapDaysValue, nextETA = inventorycalc.ComputeCoverageTimeline(today, available, weightedDMS, normalizedBatches, shippingDays)
			gapDays = gapDaysValue
			if gapStart != nil {
				value := gapStart.Format("2006-01-02")
				gapStartDate = &value
			}
			if nextETA != nil {
				value := nextETA.Format("2006-01-02")
				nextTransitETA = &value
			}
		} else {
			coverageDays := (float64(available) + float64(inTransit)) / *weightedDMS
			value := addDaysDate(today, coverageDays)
			continuousEnd = &value
		}
		if continuousEnd != nil {
			value := continuousEnd.Format("2006-01-02")
			coverageEnd = &value
			latest := addDaysDate(*continuousEnd, -float64(productionPlusShipping))
			latestText := latest.Format("2006-01-02")
			latestOrderDate = &latestText
			buffer := int(continuousEnd.Sub(today).Hours()/24) - productionPlusShipping
			orderBufferDays = &buffer
			warehouse := addDaysDate(latest, 7)
			warehouseText := warehouse.Format("2006-01-02")
			warehouseEntryDate = &warehouseText
			shipment := addDaysDate(latest, float64(productionLead))
			shipmentText := shipment.Format("2006-01-02")
			shipmentOrderDate = &shipmentText
			riskAnchorDate = coverageEnd
		}
	}

	risk := inventorycalc.ClassifyRisk(today, coverageEnd, orderBufferDays, weightedDMS)
	var estimatedQuantity *int
	if risk != inventorycalc.RiskSlowMoving && risk != inventorycalc.RiskSevereSlowMoving && coverageEnd != nil && orderBufferDays != nil {
		coverageDaysTotal := int(timeFromDateText(*coverageEnd).Sub(today).Hours() / 24)
		estimatedQuantity = inventorycalc.EstimateReplenishmentQuantity(targetDays, &coverageDaysTotal, productionPlusShipping, weightedDMS)
	}

	dms30Rounded := roundOptional(dms30)
	dms14Rounded := roundOptional(dms14)
	dms7Rounded := roundOptional(dms7)
	dms3Rounded := roundOptional(dms3)
	itemInput := inventorycalc.ItemInput{
		AvailableQty: available, SellableDays: sellableDays,
		DMS30: dms30Rounded, DMS14: dms14Rounded, DMS7: dms7Rounded, DMS3: dms3Rounded,
		Age0To90Qty: snap.Age0To90Qty, Age91To180Qty: snap.Age91To180Qty,
		Age181To270Qty: snap.Age181To270Qty, Age271To365Qty: snap.Age271To365Qty,
		Age365PlusQty: snap.Age365PlusQty, InTransitQty: inTransit,
	}
	trendLabel := inventorycalc.ComputeTrendLabel(dms7Rounded, dms30Rounded)
	trendMomentum := inventorycalc.ComputeTrendMomentum(dms7Rounded, dms14Rounded, dms30Rounded)
	state, criticalSubtype, stateRule := inventorycalc.ComputeInventoryState(itemInput, trendLabel, sellableDays, orderBufferDays)
	transitRatio := 0.0
	if available > 0 {
		transitRatio = float64(inTransit) / float64(available)
	}
	action, actionRule, seasonalOverride := inventorycalc.ComputeReplenishmentAction(state, criticalSubtype, trendLabel, transitRatio, "unknown", sellableDays, orderBufferDays)
	seasonalFactor, seasonalPhase, seasonalSource := inventorycalc.ComputeSeasonalFactor(nil, nil, nil, nil)
	signals := inventorycalc.ComputeSignals(itemInput, trendLabel, trendMomentum, snapshotAgeDays, seasonalFactor, seasonalPhase, seasonalSource)

	item := inventory_replenishment.InventoryReplenishmentListItem{
		ProjectID: projectID, ProjectName: projectName, SKU: base.SKU, Country: base.Country,
		ProductName: productName, AvailableInventory: available, InTransitQuantity: inTransit,
		DMS30: roundOptional(dms30), DMS14: roundOptional(dms14), DMS7: roundOptional(dms7), DMS3: roundOptional(dms3),
		BaseDMS:      roundOptional(inventorycalc.NormalizeWeightedDMS(dms30, dms14, dms7, dms3)),
		SafetyFactor: safetyFactor, WeightedDMS: roundOptional(weightedDMS),
		SellableDays: roundOptional2(sellableDays), SelloutDate: selloutDate, SelloutDateWithTransit: selloutDateWithTransit,
		ProductionLeadDays: productionLead, ShippingDays: shippingDays,
		ReplenishmentOrderDate: latestOrderDate, WarehouseEntryDate: warehouseEntryDate,
		ShipmentOrderDate: shipmentOrderDate, EstimatedReplenishmentQuantity: estimatedQuantity,
		RiskStatus: risk, RiskAnchorDate: riskAnchorDate,
		ProductionPlusShippingDays: productionPlusShipping, LatestOrderDate: latestOrderDate,
		OrderBufferDays: orderBufferDays, CoverageEndDate: coverageEnd,
		GapDays: gapDays, GapStartDate: gapStartDate, NextTransitETA: nextTransitETA,
		TargetDays:  targetDays,
		Age0To90Qty: snap.Age0To90Qty, Age91To180Qty: snap.Age91To180Qty,
		Age181To270Qty: snap.Age181To270Qty, Age271To365Qty: snap.Age271To365Qty,
		Age365PlusQty: snap.Age365PlusQty, RecommendedAction: snap.RecommendedAction,
		InventoryState: state, ReplenishmentAction: action,
		Signals: &inventory_replenishment.InventorySignals{
			SellableDays: signals.SellableDays, DMS3: signals.DMS3, DMS7: signals.DMS7,
			DMS14: signals.DMS14, DMS30: signals.DMS30,
			TrendRatio730: signals.TrendRatio730, TrendRatio37: signals.TrendRatio37,
			TrendLabel: &signals.TrendLabel, TrendMomentum: &signals.TrendMomentum,
			AgingShare: signals.AgingShare, TransitRatio: signals.TransitRatio,
			DataFreshnessDays: signals.DataFreshnessDays, Confidence: signals.Confidence,
			SeasonalFactor: signals.SeasonalFactor, SeasonalPhase: &signals.SeasonalPhase,
			SeasonalSource: &signals.SeasonalSource,
		},
		DecisionPath: &inventory_replenishment.InventoryDecisionPath{
			StateRule: &stateRule, CriticalSubtype: criticalSubtype,
			ActionRule: &actionRule, SeasonalOverride: seasonalOverride,
			SeasonalPhaseUsed: &seasonalPhase,
		},
	}
	return item
}

func buildReplenishmentSummary(items []inventory_replenishment.InventoryReplenishmentListItem) inventory_replenishment.InventoryReplenishmentSummary {
	summary := inventory_replenishment.InventoryReplenishmentSummary{
		StateDistribution:  make(map[string]int),
		ActionDistribution: make(map[string]int),
		StateActionMatrix:  make(map[string]map[string]int),
	}
	for _, state := range replenishmentStateValues {
		summary.StateDistribution[state] = 0
		summary.StateActionMatrix[state] = make(map[string]int)
		for _, action := range replenishmentActionValues {
			summary.StateActionMatrix[state][action] = 0
		}
	}
	for _, action := range replenishmentActionValues {
		summary.ActionDistribution[action] = 0
	}
	for _, item := range items {
		summary.SKUCount++
		switch item.RiskStatus {
		case inventorycalc.RiskOutOfStock, inventorycalc.RiskShortTermOutOfStock, inventorycalc.RiskLongTermOutOfStock:
			summary.OutOfStockRiskCount++
		case inventorycalc.RiskHealthy:
			summary.HealthyCount++
		case inventorycalc.RiskSlowMoving, inventorycalc.RiskSevereSlowMoving:
			summary.SlowMovingCount++
		case inventorycalc.RiskPending:
			summary.PendingDataCount++
		}
		summary.TotalAvailableInventory += item.AvailableInventory
		summary.TotalInTransitQuantity += item.InTransitQuantity
		switch item.InventoryState {
		case "critical":
			summary.CriticalCount++
		case "deteriorating":
			summary.DeterioratingCount++
		case "watch":
			summary.WatchCount++
		case "healthy":
			summary.HealthyCountV2++
		case "unknown":
			summary.UnknownCount++
		}
		if _, ok := summary.StateDistribution[item.InventoryState]; ok {
			summary.StateDistribution[item.InventoryState]++
		}
		if _, ok := summary.ActionDistribution[item.ReplenishmentAction]; ok {
			summary.ActionDistribution[item.ReplenishmentAction]++
		}
		if row, ok := summary.StateActionMatrix[item.InventoryState]; ok {
			if _, ok := row[item.ReplenishmentAction]; ok {
				row[item.ReplenishmentAction]++
			}
		}
	}
	return summary
}

func (s *InventoryReplenishmentStore) loadReplenishmentBaseRows(ctx context.Context, projectID int64, projectName, country string) ([]replenishmentBaseRow, error) {
	rows, err := s.db.Query(ctx,
		"select sku, asin, country from public.product_costs "+
			"where lower(trim(project_name)) = lower(trim($1)) and is_active = true and country = $2 "+
			"order by sort_order asc, id asc",
		projectName, country)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	merged := make([]replenishmentBaseRow, 0)
	index := make(map[string]int)
	for rows.Next() {
		var sku string
		var asin *string
		var rowCountry string
		if err := rows.Scan(&sku, &asin, &rowCountry); err != nil {
			return nil, err
		}
		normalized := strings.TrimSpace(sku)
		if normalized == "" {
			continue
		}
		key := normalized + "|" + normalizeCountry(rowCountry)
		if _, ok := index[key]; ok {
			continue
		}
		index[key] = len(merged)
		merged = append(merged, replenishmentBaseRow{SKU: normalized, ASIN: asin, Country: normalizeCountry(rowCountry)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	settings, err := s.db.Query(ctx,
		"select sku, asin, country from public.inventory_replenishment_settings "+
			"where project_id = $1 and country = $2 order by id asc",
		projectID, country)
	if err != nil {
		return nil, err
	}
	defer settings.Close()
	for settings.Next() {
		var sku string
		var asin *string
		var rowCountry string
		if err := settings.Scan(&sku, &asin, &rowCountry); err != nil {
			return nil, err
		}
		normalized := strings.TrimSpace(sku)
		if normalized == "" {
			continue
		}
		key := normalized + "|" + normalizeCountry(rowCountry)
		if idx, ok := index[key]; ok {
			if merged[idx].ASIN == nil && asin != nil && strings.TrimSpace(*asin) != "" {
				merged[idx].ASIN = asin
			}
			continue
		}
		index[key] = len(merged)
		merged = append(merged, replenishmentBaseRow{SKU: normalized, ASIN: asin, Country: normalizeCountry(rowCountry)})
	}
	return merged, settings.Err()
}

func (s *InventoryReplenishmentStore) loadReplenishmentSettings(ctx context.Context, projectID int64, country string) (map[string]*replenishmentSetting, error) {
	rows, err := s.db.Query(ctx,
		"select sku, asin, coalesce(safety_factor, 0.20), coalesce(production_lead_days, 20), coalesce(shipping_days, 25), coalesce(target_days, 90) "+
			"from public.inventory_replenishment_settings where project_id = $1 and country = $2",
		projectID, country)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	settings := make(map[string]*replenishmentSetting)
	for rows.Next() {
		var sku string
		var asin *string
		var safetyFactor float64
		var lead, shipping, target int
		if err := rows.Scan(&sku, &asin, &safetyFactor, &lead, &shipping, &target); err != nil {
			return nil, err
		}
		settings[strings.TrimSpace(sku)] = &replenishmentSetting{
			ASIN: asin, SafetyFactor: safetyFactor, ProductionLeadDays: lead,
			ShippingDays: shipping, TargetDays: target,
		}
	}
	return settings, rows.Err()
}

func (s *InventoryReplenishmentStore) loadReplenishmentSnapshot(ctx context.Context, sourceFileID int64) (map[string]replenishmentSnapshot, error) {
	rows, err := s.db.Query(ctx,
		"select sku, coalesce(sum(available_qty),0), coalesce(sum(age_0_90_qty),0), "+
			"coalesce(sum(age_91_180_qty),0), coalesce(sum(age_181_270_qty),0), "+
			"coalesce(sum(age_271_365_qty),0), coalesce(sum(age_365_plus_qty),0), max(recommended_action) "+
			"from public.inventory_snapshot_rows where source_file_id = $1 group by sku",
		sourceFileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]replenishmentSnapshot)
	for rows.Next() {
		var sku *string
		var available, age0, age91, age181, age271, age365 int64
		var action *string
		if err := rows.Scan(&sku, &available, &age0, &age91, &age181, &age271, &age365, &action); err != nil {
			return nil, err
		}
		normalized := strings.TrimSpace(valueOrEmpty(sku))
		if normalized == "" {
			continue
		}
		result[normalized] = replenishmentSnapshot{
			AvailableQty: int(available), Age0To90Qty: int(age0),
			Age91To180Qty: int(age91), Age181To270Qty: int(age181),
			Age271To365Qty: int(age271), Age365PlusQty: int(age365),
			RecommendedAction: trimOptional(action),
		}
	}
	return result, rows.Err()
}

func (s *InventoryReplenishmentStore) loadReplenishmentInTransitMap(ctx context.Context, projectID int64, country string, reportDate *string) (map[string]int, error) {
	query := "select i.sku, coalesce(sum(i.quantity),0) from public.shipment_schedule_items i " +
		"join public.shipment_schedules s on s.id = i.shipment_schedule_id " +
		"where s.project_id = $1 and s.country = $2"
	args := []any{projectID, country}
	if reportDate != nil && strings.TrimSpace(*reportDate) != "" {
		query += " and s.created_at::date <= $3::date and s.shipment_status <> 'cancelled' and (s.shipment_status <> 'completed' or s.actual_inbound_date > $3::date)"
		args = append(args, strings.TrimSpace(*reportDate))
	} else {
		query += " and s.shipment_status in ('in_transit', 'draft')"
	}
	query += " group by i.sku"
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]int)
	for rows.Next() {
		var sku *string
		var quantity int64
		if err := rows.Scan(&sku, &quantity); err != nil {
			return nil, err
		}
		normalized := strings.TrimSpace(valueOrEmpty(sku))
		if normalized == "" {
			continue
		}
		result[normalized] = int(quantity)
	}
	return result, rows.Err()
}

func (s *InventoryReplenishmentStore) loadReplenishmentTransitBatches(ctx context.Context, projectID int64, country string) (map[string][]inventorycalc.TransitBatch, error) {
	rows, err := s.db.Query(ctx,
		"select i.sku, i.quantity, s.eta_date, s.etd_date, s.created_date "+
			"from public.shipment_schedule_items i "+
			"join public.shipment_schedules s on s.id = i.shipment_schedule_id "+
			"where s.project_id = $1 and s.country = $2 and s.shipment_status in ('in_transit', 'draft')",
		projectID, country)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string][]inventorycalc.TransitBatch)
	for rows.Next() {
		var sku *string
		var quantity int64
		var eta, etd, created *time.Time
		if err := rows.Scan(&sku, &quantity, &eta, &etd, &created); err != nil {
			return nil, err
		}
		normalized := strings.TrimSpace(valueOrEmpty(sku))
		if normalized == "" {
			continue
		}
		result[normalized] = append(result[normalized], inventorycalc.TransitBatch{
			Quantity: int(quantity), ETADate: eta, ETDDate: etd, CreatedDate: created,
		})
	}
	return result, rows.Err()
}

func (s *InventoryReplenishmentStore) loadReplenishmentProductNames(ctx context.Context, projectID int64, baseRows []replenishmentBaseRow) (map[string]*string, error) {
	if len(baseRows) == 0 {
		return map[string]*string{}, nil
	}
	skus := make([]string, 0, len(baseRows))
	for _, row := range baseRows {
		skus = append(skus, row.SKU)
	}
	rows, err := s.db.Query(ctx,
		"select sku, product_name from public.product_costs "+
			"where project_id = $1 and sku = any($2) and is_active = true order by sku asc, id desc",
		projectID, skus)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]*string)
	for rows.Next() {
		var sku string
		var name *string
		if err := rows.Scan(&sku, &name); err != nil {
			return nil, err
		}
		if _, exists := result[sku]; exists {
			continue
		}
		if name != nil && strings.TrimSpace(*name) != "" {
			trimmed := strings.TrimSpace(*name)
			result[sku] = &trimmed
		}
	}
	return result, rows.Err()
}

func (s *InventoryReplenishmentStore) loadReplenishmentDMSMap(ctx context.Context, projectID int64, country string, today time.Time, windowDays, lagDays int) (map[string]*float64, error) {
	windowEnd := today.AddDate(0, 0, -lagDays)
	since := windowEnd.AddDate(0, 0, -(windowDays - 1))
	rows, err := s.db.Query(ctx,
		"select sku, coalesce(sum(quantity),0) from public.analysis_sales_order_rows "+
			"where project_id = $1 and country = $2 and purchase_date_pt >= $3::date and purchase_date_pt <= $4::date "+
			"and is_counted_sales = true and order_status <> 'Cancelled' group by sku",
		projectID, country, since.Format("2006-01-02"), windowEnd.Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]*float64)
	for rows.Next() {
		var sku *string
		var quantity int64
		if err := rows.Scan(&sku, &quantity); err != nil {
			return nil, err
		}
		normalized := strings.TrimSpace(valueOrEmpty(sku))
		if normalized == "" {
			continue
		}
		value := float64(quantity) / float64(windowDays)
		result[normalized] = &value
	}
	return result, rows.Err()
}

func parseFilterSet(value *string) map[string]bool {
	if value == nil {
		return nil
	}
	result := make(map[string]bool)
	for _, part := range strings.Split(*value, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			result[part] = true
		}
	}
	return result
}

func roundOptional(value *float64) *float64 {
	if value == nil {
		return nil
	}
	rounded := math.Round(*value*10000) / 10000
	return &rounded
}

func roundOptional2(value *float64) *float64 {
	if value == nil {
		return nil
	}
	rounded := math.Round(*value*100) / 100
	return &rounded
}

func addDaysDate(base time.Time, days float64) time.Time {
	return base.Add(time.Duration(days * float64(24*time.Hour)))
}

func timeFromDateText(value string) time.Time {
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func sortReplenishmentItems(items []inventory_replenishment.InventoryReplenishmentListItem, field, direction string) {
	desc := strings.EqualFold(direction, "desc")
	sort.SliceStable(items, func(i, j int) bool {
		if desc {
			return replenishmentItemLess(items[j], items[i], field)
		}
		return replenishmentItemLess(items[i], items[j], field)
	})
}

func replenishmentItemLess(a, b inventory_replenishment.InventoryReplenishmentListItem, field string) bool {
	switch field {
	case "sku":
		return a.SKU < b.SKU
	case "available_inventory":
		return a.AvailableInventory < b.AvailableInventory
	case "in_transit_quantity":
		return a.InTransitQuantity < b.InTransitQuantity
	case "weighted_dms":
		return floatLess(a.WeightedDMS, b.WeightedDMS)
	case "sellable_days":
		return floatLess(a.SellableDays, b.SellableDays)
	case "estimated_replenishment_quantity":
		return intPtrLess(a.EstimatedReplenishmentQuantity, b.EstimatedReplenishmentQuantity)
	case "risk_status":
		return a.RiskStatus < b.RiskStatus
	case "inventory_state":
		return a.InventoryState < b.InventoryState
	case "replenishment_action":
		return a.ReplenishmentAction < b.ReplenishmentAction
	case "order_buffer_days":
		return intPtrLess(a.OrderBufferDays, b.OrderBufferDays)
	case "coverage_end_date":
		return stringPtrLess(a.CoverageEndDate, b.CoverageEndDate)
	default:
		return false
	}
}

func floatLess(a, b *float64) bool {
	if a == nil {
		return false
	}
	if b == nil {
		return true
	}
	return *a < *b
}

func intPtrLess(a, b *int) bool {
	if a == nil {
		return false
	}
	if b == nil {
		return true
	}
	return *a < *b
}

func stringPtrLess(a, b *string) bool {
	if a == nil {
		return false
	}
	if b == nil {
		return true
	}
	return *a < *b
}

func normalizeDatePointer(value *time.Time, location *time.Location) *time.Time {
	if value == nil {
		return nil
	}
	year, month, day := value.Date()
	normalized := time.Date(year, month, day, 0, 0, 0, 0, location)
	return &normalized
}
