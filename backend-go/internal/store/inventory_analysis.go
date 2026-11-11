package store

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
)

type inventoryAnalysisRow struct {
	SKU               string
	ASIN              *string
	AvailableQty      int64
	Age0To90Qty       int64
	Age91To180Qty     int64
	Age181To270Qty    int64
	Age271To365Qty    int64
	Age365PlusQty     int64
	RecommendedAction *string
}

type inventoryAnalysisShipmentHeader struct {
	ShipmentNo     string
	ShippingMethod *string
	ForwarderName  *string
	EtdDate        *string
	EtaDate        *string
}

// GetInventoryAnalysis ports FastAPI inventory_analysis_service.list_inventory_analysis:
// base SKUs from product_costs, aggregated aging from the latest inventory_report
// snapshot, in-transit shipment columns and per-SKU shipment quantities.
func (s *InventoryReplenishmentStore) GetInventoryAnalysis(ctx context.Context, filter inventory_replenishment.ReplenishmentFilter) (inventory_replenishment.InventoryAnalysisResponse, error) {
	if filter.ProjectID == nil || *filter.ProjectID <= 0 {
		return inventory_replenishment.InventoryAnalysisResponse{}, inventory_replenishment.ErrProjectNotFound
	}
	projectID := *filter.ProjectID
	country := "US"
	if filter.Country != nil && strings.TrimSpace(*filter.Country) != "" {
		country = normalizeCountry(*filter.Country)
	}

	var projectName string
	if err := s.db.QueryRow(ctx,
		"select project_name from public.projects where id = $1", projectID,
	).Scan(&projectName); err != nil {
		if err == pgx.ErrNoRows {
			return inventory_replenishment.InventoryAnalysisResponse{}, inventory_replenishment.ErrProjectNotFound
		}
		return inventory_replenishment.InventoryAnalysisResponse{}, err
	}

	baseRows, err := s.loadInventoryAnalysisBaseSKUs(ctx, projectName, country)
	if err != nil {
		return inventory_replenishment.InventoryAnalysisResponse{}, err
	}

	sourceID, reportDate, err := s.loadInventoryAnalysisSource(ctx, projectID, country, filter.ReportDate)
	if err != nil {
		return inventory_replenishment.InventoryAnalysisResponse{}, err
	}
	aggregatedRows := make([]inventoryAnalysisRow, 0)
	if sourceID != nil {
		aggregatedRows, err = s.loadInventoryAnalysisAggregates(ctx, *sourceID)
		if err != nil {
			return inventory_replenishment.InventoryAnalysisResponse{}, err
		}
	}

	orderedRows := mergeInventoryAnalysisRows(baseRows, aggregatedRows)

	actionSet := make(map[string]struct{})
	for _, row := range orderedRows {
		if row.RecommendedAction != nil && strings.TrimSpace(*row.RecommendedAction) != "" {
			actionSet[*row.RecommendedAction] = struct{}{}
		}
	}
	actionOptions := make([]string, 0, len(actionSet))
	for action := range actionSet {
		actionOptions = append(actionOptions, action)
	}
	sort.Strings(actionOptions)

	skuNameMap, asinNameMap, err := s.loadInventoryAnalysisProductNames(ctx, projectName, country)
	if err != nil {
		return inventory_replenishment.InventoryAnalysisResponse{}, err
	}

	displayedSKUs := make([]string, 0, len(orderedRows))
	for _, row := range orderedRows {
		if row.SKU != "" {
			displayedSKUs = append(displayedSKUs, strings.ToLower(strings.TrimSpace(row.SKU)))
		}
	}
	headers, qtyRows, err := s.loadInventoryAnalysisInTransit(ctx, projectID, country, displayedSKUs)
	if err != nil {
		return inventory_replenishment.InventoryAnalysisResponse{}, err
	}

	headerOrder := make(map[string]int, len(headers))
	for index, header := range headers {
		headerOrder[header.ShipmentNo] = index
	}
	relevantShipmentNos := make([]string, 0)
	seenShipment := make(map[string]bool)
	for _, qty := range qtyRows {
		if !seenShipment[qty.ShipmentNo] {
			seenShipment[qty.ShipmentNo] = true
			relevantShipmentNos = append(relevantShipmentNos, qty.ShipmentNo)
		}
	}
	sort.SliceStable(relevantShipmentNos, func(i, j int) bool {
		left, leftOK := headerOrder[relevantShipmentNos[i]]
		right, rightOK := headerOrder[relevantShipmentNos[j]]
		if !leftOK {
			left = 1 << 30
		}
		if !rightOK {
			right = 1 << 30
		}
		return left < right
	})

	qtyIndex := make(map[string]map[string]int64)
	for _, qty := range qtyRows {
		if qtyIndex[qty.ShipmentNo] == nil {
			qtyIndex[qty.ShipmentNo] = make(map[string]int64)
		}
		qtyIndex[qty.ShipmentNo][strings.ToLower(strings.TrimSpace(qty.SKU))] = qty.Quantity
	}

	shipmentColumns := make([]inventory_replenishment.ShipmentColumn, 0, len(relevantShipmentNos))
	relevantSet := make(map[string]bool, len(relevantShipmentNos))
	for _, shipmentNo := range relevantShipmentNos {
		relevantSet[shipmentNo] = true
	}
	for _, header := range headers {
		if !relevantSet[header.ShipmentNo] {
			continue
		}
		shipmentColumns = append(shipmentColumns, inventory_replenishment.ShipmentColumn{
			ShipmentNo:     header.ShipmentNo,
			Label:          header.ShipmentNo,
			ShippingMethod: header.ShippingMethod,
			ForwarderName:  header.ForwarderName,
			EtdDate:        header.EtdDate,
			EtaDate:        header.EtaDate,
		})
	}
	shipmentTotals := make(map[string]int64, len(relevantShipmentNos))
	for _, shipmentNo := range relevantShipmentNos {
		var total int64
		for _, qty := range qtyRows {
			if qty.ShipmentNo == shipmentNo {
				total += qty.Quantity
			}
		}
		shipmentTotals[shipmentNo] = total
	}

	summary := inventory_replenishment.InventoryAnalysisSummary{ActionTypeCount: len(actionOptions)}
	items := make([]inventory_replenishment.InventoryAnalysisItem, 0, len(orderedRows))
	for _, row := range orderedRows {
		stockStatus := "in_stock"
		if row.AvailableQty <= 0 {
			stockStatus = "out_of_stock"
		}
		agingStatus := inventoryAgingStatus(row)
		summary.SKUCount++
		if stockStatus == "out_of_stock" {
			summary.OutOfStockCount++
		}
		if agingStatus == "aging" || agingStatus == "over_aged" {
			summary.AgingSKUCount++
		}
		if agingStatus == "over_aged" {
			summary.OverAgedSKUCount++
		}
		summary.TotalAvailableQty += row.AvailableQty
		summary.TotalAge0To90Qty += row.Age0To90Qty
		summary.TotalAge91To180Qty += row.Age91To180Qty
		summary.TotalAge181To270Qty += row.Age181To270Qty
		summary.TotalAge271To365Qty += row.Age271To365Qty
		summary.TotalAge365PlusQty += row.Age365PlusQty

		productName := lookupInventoryProductName(skuNameMap, asinNameMap, row.SKU, row.ASIN)
		shipmentQuantities := make(map[string]int64)
		skuKey := strings.ToLower(strings.TrimSpace(row.SKU))
		for _, shipmentNo := range relevantShipmentNos {
			if qty := qtyIndex[shipmentNo][skuKey]; qty > 0 {
				shipmentQuantities[shipmentNo] = qty
			}
		}
		items = append(items, inventory_replenishment.InventoryAnalysisItem{
			ProjectID:              projectID,
			ProjectName:            projectName,
			Country:                country,
			SKU:                    row.SKU,
			ASIN:                   row.ASIN,
			ProductName:            productName,
			AvailableQty:           row.AvailableQty,
			Age0To90Qty:            row.Age0To90Qty,
			Age91To180Qty:          row.Age91To180Qty,
			Age181To270Qty:         row.Age181To270Qty,
			Age271To365Qty:         row.Age271To365Qty,
			Age365PlusQty:          row.Age365PlusQty,
			RecommendedAction:      row.RecommendedAction,
			RecommendedActionLabel: translateRecommendedAction(row.RecommendedAction),
			StockStatus:            stockStatus,
			AgingStatus:            agingStatus,
			ShipmentQuantities:     shipmentQuantities,
		})
	}

	return inventory_replenishment.InventoryAnalysisResponse{
		ProjectID:            projectID,
		ProjectName:          projectName,
		Country:              country,
		ReportDate:           reportDate,
		Summary:              summary,
		ActionOptions:        actionOptions,
		Items:                items,
		ShipmentColumns:      shipmentColumns,
		ShipmentColumnTotals: shipmentTotals,
	}, nil
}

func (s *InventoryReplenishmentStore) loadInventoryAnalysisBaseSKUs(ctx context.Context, projectName, country string) ([]inventoryAnalysisRow, error) {
	rows, err := s.db.Query(ctx,
		"select sku, asin from public.product_costs "+
			"where lower(trim(project_name)) = lower(trim($1)) and is_active = true and country = $2 "+
			"order by sort_order asc, id asc",
		projectName, country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]inventoryAnalysisRow, 0)
	seen := make(map[string]bool)
	for rows.Next() {
		var sku string
		var asin *string
		if err := rows.Scan(&sku, &asin); err != nil {
			return nil, err
		}
		normalizedSKU := strings.TrimSpace(sku)
		if normalizedSKU == "" || seen[normalizedSKU] {
			continue
		}
		seen[normalizedSKU] = true
		result = append(result, inventoryAnalysisRow{SKU: normalizedSKU, ASIN: asin})
	}
	return result, rows.Err()
}

func (s *InventoryReplenishmentStore) loadInventoryAnalysisSource(ctx context.Context, projectID int64, country string, reportDate *string) (*int64, *string, error) {
	query := "select id, report_date::text from public.analysis_source_files " +
		"where project_id = $1 and report_type = 'inventory_report' and country = $2 and report_date is not null"
	args := []any{projectID, country}
	if reportDate != nil && strings.TrimSpace(*reportDate) != "" {
		query += fmt.Sprintf(" and report_date <= $%d::date", len(args)+1)
		args = append(args, strings.TrimSpace(*reportDate))
	}
	query += " order by report_date desc, version desc, id desc limit 1"
	var id int64
	var date string
	if err := s.db.QueryRow(ctx, query, args...).Scan(&id, &date); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	return &id, &date, nil
}

func (s *InventoryReplenishmentStore) loadInventoryAnalysisAggregates(ctx context.Context, sourceFileID int64) ([]inventoryAnalysisRow, error) {
	rows, err := s.db.Query(ctx,
		"select sku, asin, "+
			"coalesce(sum(available_qty), 0), coalesce(sum(age_0_90_qty), 0), "+
			"coalesce(sum(age_91_180_qty), 0), coalesce(sum(age_181_270_qty), 0), "+
			"coalesce(sum(age_271_365_qty), 0), coalesce(sum(age_365_plus_qty), 0), "+
			"max(recommended_action) "+
			"from public.inventory_snapshot_rows where source_file_id = $1 "+
			"group by sku, asin "+
			"order by lower(coalesce(sku, '')), lower(coalesce(asin, ''))",
		sourceFileID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]inventoryAnalysisRow, 0)
	for rows.Next() {
		var sku *string
		var asin, action *string
		var available, age0, age91, age181, age271, age365 int64
		if err := rows.Scan(&sku, &asin, &available, &age0, &age91, &age181, &age271, &age365, &action); err != nil {
			return nil, err
		}
		trimmed := strings.TrimSpace(valueOrEmpty(sku))
		if trimmed == "" {
			continue
		}
		result = append(result, inventoryAnalysisRow{
			SKU:               trimmed,
			ASIN:              asin,
			AvailableQty:      available,
			Age0To90Qty:       age0,
			Age91To180Qty:     age91,
			Age181To270Qty:    age181,
			Age271To365Qty:    age271,
			Age365PlusQty:     age365,
			RecommendedAction: trimOptional(action),
		})
	}
	return result, rows.Err()
}

func (s *InventoryReplenishmentStore) loadInventoryAnalysisProductNames(ctx context.Context, projectName, country string) (map[string]string, map[string]string, error) {
	rows, err := s.db.Query(ctx,
		"select sku, asin, product_name from public.product_costs "+
			"where lower(trim(project_name)) = lower(trim($1)) and is_active = true and country = $2",
		projectName, country,
	)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	skuNames := make(map[string]string)
	asinNames := make(map[string]string)
	for rows.Next() {
		var sku, asin, name *string
		if err := rows.Scan(&sku, &asin, &name); err != nil {
			return nil, nil, err
		}
		normalizedSKU := strings.ToLower(strings.TrimSpace(valueOrEmpty(sku)))
		normalizedASIN := strings.ToLower(strings.TrimSpace(valueOrEmpty(asin)))
		trimmedName := strings.TrimSpace(valueOrEmpty(name))
		if normalizedSKU != "" && trimmedName != "" && skuNames[normalizedSKU] == "" {
			skuNames[normalizedSKU] = trimmedName
		}
		if normalizedASIN != "" && trimmedName != "" && asinNames[normalizedASIN] == "" {
			asinNames[normalizedASIN] = trimmedName
		}
	}
	return skuNames, asinNames, rows.Err()
}

type inventoryAnalysisShipmentQty struct {
	ShipmentNo string
	SKU        string
	Quantity   int64
}

func (s *InventoryReplenishmentStore) loadInventoryAnalysisInTransit(ctx context.Context, projectID int64, country string, skuKeys []string) ([]inventoryAnalysisShipmentHeader, []inventoryAnalysisShipmentQty, error) {
	headers, err := s.db.Query(ctx,
		"select shipment_no, shipping_method, forwarder_name, etd_date::text, eta_date::text "+
			"from public.shipment_schedules "+
			"where project_id = $1 and country = $2 and shipment_status = 'in_transit' "+
			"order by shipment_no asc",
		projectID, country,
	)
	if err != nil {
		return nil, nil, err
	}
	defer headers.Close()
	headerList := make([]inventoryAnalysisShipmentHeader, 0)
	for headers.Next() {
		var header inventoryAnalysisShipmentHeader
		if err := headers.Scan(&header.ShipmentNo, &header.ShippingMethod, &header.ForwarderName, &header.EtdDate, &header.EtaDate); err != nil {
			return nil, nil, err
		}
		headerList = append(headerList, header)
	}
	if err := headers.Err(); err != nil {
		return nil, nil, err
	}
	if len(skuKeys) == 0 {
		return headerList, nil, nil
	}

	query := "select i.shipment_no, i.sku, coalesce(sum(i.quantity), 0) " +
		"from public.shipment_schedule_items i " +
		"join public.shipment_schedules s on s.id = i.shipment_schedule_id " +
		"where s.project_id = $1 and s.country = $2 and s.shipment_status = 'in_transit' " +
		"and lower(trim(i.sku)) = any($3) " +
		"group by i.shipment_no, i.sku"
	items, err := s.db.Query(ctx, query, projectID, country, skuKeys)
	if err != nil {
		return nil, nil, err
	}
	defer items.Close()
	qtyList := make([]inventoryAnalysisShipmentQty, 0)
	for items.Next() {
		var qty inventoryAnalysisShipmentQty
		if err := items.Scan(&qty.ShipmentNo, &qty.SKU, &qty.Quantity); err != nil {
			return nil, nil, err
		}
		qtyList = append(qtyList, qty)
	}
	return headerList, qtyList, items.Err()
}

func mergeInventoryAnalysisRows(baseRows []inventoryAnalysisRow, aggregated []inventoryAnalysisRow) []inventoryAnalysisRow {
	aggregatedMap := make(map[string]inventoryAnalysisRow, len(aggregated))
	for _, row := range aggregated {
		aggregatedMap[rowKey(row)] = row
	}
	ordered := make([]inventoryAnalysisRow, 0, len(baseRows)+len(aggregated))
	consumed := make(map[string]bool)
	for _, base := range baseRows {
		key := rowKey(base)
		matched, ok := aggregatedMap[key]
		if !ok {
			for _, candidate := range aggregated {
				if candidate.SKU == base.SKU && !consumed[rowKey(candidate)] {
					matched = candidate
					ok = true
					break
				}
			}
		}
		if ok {
			base.ASIN = firstNonNil(base.ASIN, matched.ASIN)
			base.RecommendedAction = matched.RecommendedAction
			base.AvailableQty = matched.AvailableQty
			base.Age0To90Qty = matched.Age0To90Qty
			base.Age91To180Qty = matched.Age91To180Qty
			base.Age181To270Qty = matched.Age181To270Qty
			base.Age271To365Qty = matched.Age271To365Qty
			base.Age365PlusQty = matched.Age365PlusQty
			consumed[rowKey(matched)] = true
		}
		ordered = append(ordered, base)
	}
	for _, row := range aggregated {
		if consumed[rowKey(row)] {
			continue
		}
		ordered = append(ordered, row)
	}
	return ordered
}

func rowKey(row inventoryAnalysisRow) string {
	return row.SKU + "\x00" + valueOrEmpty(row.ASIN)
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func firstNonNil(first, second *string) *string {
	if first != nil && strings.TrimSpace(*first) != "" {
		return first
	}
	return second
}

func lookupInventoryProductName(skuNames, asinNames map[string]string, sku string, asin *string) *string {
	if name, ok := skuNames[strings.ToLower(strings.TrimSpace(sku))]; ok && name != "" {
		return &name
	}
	if asin != nil {
		if name, ok := asinNames[strings.ToLower(strings.TrimSpace(*asin))]; ok && name != "" {
			return &name
		}
	}
	return nil
}

func inventoryAgingStatus(row inventoryAnalysisRow) string {
	if row.Age365PlusQty > 0 {
		return "over_aged"
	}
	if row.Age91To180Qty+row.Age181To270Qty+row.Age271To365Qty > 0 {
		return "aging"
	}
	return "fresh"
}

var recommendedActionLabels = map[string]string{
	"no_action_needed":                  "无需操作",
	"none":                              "无需操作",
	"normal":                            "正常销售",
	"keep_selling":                      "继续销售",
	"monitor":                           "持续观察",
	"replenish":                         "建议补货",
	"restock":                           "建议补货",
	"go_to_restock":                     "前往补货",
	"remove":                            "建议移除",
	"create_removal_order":              "创建移除订单",
	"liquidate":                         "建议清货",
	"clearance":                         "建议清货",
	"discount":                          "建议降价促销",
	"promotion":                         "建议促销",
	"outlet_deal":                       "建议参加奥特莱斯",
	"create_outlet_deal":                "创建奥特莱斯促销",
	"lower_price":                       "降低价格",
	"edit_listing":                      "优化链接",
	"advertise_listing":                 "投放广告",
	"create_shipping_plan":              "创建发货计划",
	"no_excess_inventory":               "无冗余库存",
	"no_restock_excess_action_required": "无需补货/处理冗余",
}

func translateRecommendedAction(raw *string) string {
	value := strings.TrimSpace(valueOrEmpty(raw))
	if value == "" {
		return ""
	}
	normalized := toSnakeCase(value)
	return recommendedActionLabels[normalized]
}

func toSnakeCase(value string) string {
	var builder strings.Builder
	previousLowerOrDigit := false
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
			if previousLowerOrDigit {
				builder.WriteByte('_')
			}
			builder.WriteRune(r - 'A' + 'a')
			previousLowerOrDigit = false
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			builder.WriteRune(r)
			previousLowerOrDigit = true
		default:
			builder.WriteByte('_')
			previousLowerOrDigit = false
		}
	}
	result := builder.String()
	for strings.Contains(result, "__") {
		result = strings.ReplaceAll(result, "__", "_")
	}
	return strings.Trim(result, "_")
}
