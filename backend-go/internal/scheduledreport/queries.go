package scheduledreport

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func toFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	default:
		return 0
	}
}

func intValue(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

func sumTrendAmount(trend []map[string]any) float64 {
	total := 0.0
	for _, point := range trend {
		total += toFloat(point["sales_amount"])
	}
	return total
}

func queryProjectNames(ctx context.Context, db store.DB, projectIDs []int64) []string {
	if len(projectIDs) == 0 {
		return nil
	}
	rows, err := db.Query(ctx, "select project_name from public.projects where id = any($1) order by id", projectIDs)
	if err != nil {
		return nil
	}
	defer rows.Close()
	names := make([]string, 0, len(projectIDs))
	for rows.Next() {
		var name *string
		if err := rows.Scan(&name); err != nil {
			continue
		}
		if name != nil && strings.TrimSpace(*name) != "" {
			names = append(names, *name)
		}
	}
	return names
}

func querySalesSnapshot(
	ctx context.Context,
	db store.DB,
	projectIDs []int64,
	country string,
	startDate, endDate time.Time,
) (map[string]any, []map[string]any, int) {
	trendMap := make(map[string]map[string]any)
	for current := startDate; !current.After(endDate); current = current.AddDate(0, 0, 1) {
		trendMap[current.Format("2006-01-02")] = map[string]any{"order_qty": 0, "sales_amount": 0.0}
	}
	amount := salesAmountExpr(country)
	query := "select purchase_date_pt, coalesce(sum(quantity), 0), coalesce(sum(" + amount + "), 0) " +
		"from public.analysis_sales_order_rows " +
		"where country = $1 and is_counted_sales = true and purchase_date_pt >= $2::date and purchase_date_pt <= $3::date"
	args := []any{country, startDate.Format("2006-01-02"), endDate.Format("2006-01-02")}
	if len(projectIDs) > 0 {
		query += " and project_id = any($4)"
		args = append(args, projectIDs)
	}
	query += " group by purchase_date_pt"
	rows, err := db.Query(ctx, query, args...)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var date time.Time
			var quantity int64
			var amountValue float64
			if err := rows.Scan(&date, &quantity, &amountValue); err != nil {
				continue
			}
			key := date.Format("2006-01-02")
			if _, ok := trendMap[key]; ok {
				trendMap[key] = map[string]any{"order_qty": int(quantity), "sales_amount": amountValue}
			}
		}
	}

	trend := make([]map[string]any, 0, len(trendMap))
	for current := startDate; !current.After(endDate); current = current.AddDate(0, 0, 1) {
		key := current.Format("2006-01-02")
		trend = append(trend, map[string]any{
			"date": key, "order_qty": trendMap[key]["order_qty"], "sales_amount": trendMap[key]["sales_amount"],
		})
	}
	totalQty := 0
	for _, point := range trend {
		totalQty += intValue(point["order_qty"])
	}

	endKey := endDate.Format("2006-01-02")
	yesterdayKey := endDate.AddDate(0, 0, -1).Format("2006-01-02")
	todayQty := intValue(trendMap[endKey]["order_qty"])
	todayAmount := toFloat(trendMap[endKey]["sales_amount"])
	yesterdayQty := intValue(trendMap[yesterdayKey]["order_qty"])
	yesterdayAmount := toFloat(trendMap[yesterdayKey]["sales_amount"])
	qtyChange, qtyType := safePctChange(float64(todayQty), float64(yesterdayQty))
	amountChange, amountType := safePctChange(todayAmount, yesterdayAmount)

	prevSales := queryPeriodSales(ctx, db, projectIDs, country, endDate.AddDate(0, 0, -7), endDate.AddDate(0, 0, -1))
	return map[string]any{
		"today_order_qty":        todayQty,
		"today_sales_amount":     todayAmount,
		"yesterday_order_qty":    yesterdayQty,
		"yesterday_sales_amount": yesterdayAmount,
		"prev_order_qty":         prevSales["week_qty"],
		"prev_sales_amount":      prevSales["week_amount"],
		"order_qty_change_pct":   qtyChange,
		"sales_change_pct":       amountChange,
		"change_type_order_qty":  qtyType,
		"change_type_sales":      amountType,
	}, trend, totalQty
}

func queryPeriodSales(ctx context.Context, db store.DB, projectIDs []int64, country string, startDate, endDate time.Time) map[string]any {
	amount := salesAmountExpr(country)
	query := "select coalesce(sum(quantity), 0), coalesce(sum(" + amount + "), 0) " +
		"from public.analysis_sales_order_rows " +
		"where country = $1 and purchase_date_pt >= $2::date and purchase_date_pt <= $3::date"
	args := []any{country, startDate.Format("2006-01-02"), endDate.Format("2006-01-02")}
	if len(projectIDs) > 0 {
		query += " and project_id = any($4)"
		args = append(args, projectIDs)
	}
	var quantity int64
	var amountValue float64
	if err := db.QueryRow(ctx, query, args...).Scan(&quantity, &amountValue); err != nil {
		return map[string]any{"week_qty": 0, "week_amount": 0.0}
	}
	return map[string]any{"week_qty": int(quantity), "week_amount": amountValue}
}

func queryInventorySummary(ctx context.Context, db store.DB, projectIDs []int64, country string) map[string]any {
	query := "select r.available_qty, r.stock_status from public.inventory_snapshot_rows r " +
		"join public.analysis_source_files f on f.id = r.source_file_id " +
		"where f.country = $1 and f.report_type = 'inventory_report' and f.is_current = true"
	args := []any{country}
	if len(projectIDs) > 0 {
		query += " and f.project_id = any($2)"
		args = append(args, projectIDs)
	}
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return map[string]any{"sku_count": 0, "out_of_stock_count": 0, "available_qty": 0}
	}
	defer rows.Close()
	count := 0
	outOfStock := 0
	available := 0
	for rows.Next() {
		var qty *int64
		var status *string
		if err := rows.Scan(&qty, &status); err != nil {
			continue
		}
		count++
		quantity := 0
		if qty != nil {
			quantity = int(*qty)
		}
		available += quantity
		if quantity <= 0 || (status != nil && *status == "out_of_stock") {
			outOfStock++
		}
	}
	return map[string]any{"sku_count": count, "out_of_stock_count": outOfStock, "available_qty": available}
}

func queryShipmentSnapshot(ctx context.Context, db store.DB, projectIDs []int64, country string) map[string]any {
	query := "select count(distinct s.id), coalesce(sum(i.quantity), 0) " +
		"from public.shipment_schedules s left join public.shipment_schedule_items i on i.shipment_schedule_id = s.id " +
		"where s.country = $1 and s.shipment_status = 'in_transit'"
	args := []any{country}
	if len(projectIDs) > 0 {
		query += " and s.project_id = any($2)"
		args = append(args, projectIDs)
	}
	var count, quantity int64
	if err := db.QueryRow(ctx, query, args...).Scan(&count, &quantity); err != nil {
		return map[string]any{"in_transit_count": 0, "in_transit_qty": 0}
	}
	return map[string]any{"in_transit_count": int(count), "in_transit_qty": int(quantity)}
}

func queryTopSKUs(ctx context.Context, db store.DB, projectIDs []int64, country string, startDate, endDate time.Time, limit int) []map[string]any {
	amount := salesAmountExpr(country)
	query := "select sku, coalesce(sum(quantity), 0), coalesce(sum(" + amount + "), 0) " +
		"from public.analysis_sales_order_rows " +
		"where country = $1 and purchase_date_pt >= $2::date and purchase_date_pt <= $3::date"
	args := []any{country, startDate.Format("2006-01-02"), endDate.Format("2006-01-02")}
	if len(projectIDs) > 0 {
		query += " and project_id = any($4)"
		args = append(args, projectIDs)
	}
	query += fmt.Sprintf(" group by sku order by coalesce(sum(quantity), 0) desc limit %d", limit)
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var sku *string
		var quantity int64
		var amountValue float64
		if err := rows.Scan(&sku, &quantity, &amountValue); err != nil {
			continue
		}
		name := "Unknown"
		if sku != nil && *sku != "" {
			name = *sku
		}
		result = append(result, map[string]any{"sku": name, "qty": int(quantity), "amount": amountValue})
	}
	return result
}

func queryInventoryAlerts(ctx context.Context, db store.DB, projectIDs []int64, country string) ([]map[string]any, []map[string]any) {
	query := "select r.sku, r.available_qty, r.stock_status from public.inventory_snapshot_rows r " +
		"join public.analysis_source_files f on f.id = r.source_file_id " +
		"where f.country = $1 and f.report_type = 'inventory_report' and f.is_current = true " +
		"and r.available_qty <= 10"
	args := []any{country}
	if len(projectIDs) > 0 {
		query += " and f.project_id = any($2)"
		args = append(args, projectIDs)
	}
	query += " order by r.available_qty asc limit 20"
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return []map[string]any{}, []map[string]any{}
	}
	defer rows.Close()
	oos := make([]map[string]any, 0)
	low := make([]map[string]any, 0)
	for rows.Next() {
		var sku, status *string
		var quantity *int64
		if err := rows.Scan(&sku, &quantity, &status); err != nil {
			continue
		}
		name := "Unknown"
		if sku != nil && *sku != "" {
			name = *sku
		}
		value := 0
		if quantity != nil {
			value = int(*quantity)
		}
		item := map[string]any{"sku": name, "available_qty": value}
		if value <= 0 || (status != nil && *status == "out_of_stock") {
			oos = append(oos, item)
		} else {
			low = append(low, item)
		}
	}
	return oos, low
}

func queryAds(ctx context.Context, db store.DB, projectIDs []int64, country string, startDate, endDate time.Time, singleDay bool) map[string]any {
	query := "select coalesce(sum(r.spend), 0), coalesce(sum(r.sales_7d), 0), coalesce(sum(r.clicks), 0), " +
		"coalesce(sum(r.impressions), 0), coalesce(sum(r.orders_7d), 0) " +
		"from public.ad_upload_promoted_product_rows r " +
		"join public.ad_upload_files f on f.id = r.source_file_id " +
		"where f.country = $1 and f.report_type = 'ad_promoted_product_report' and f.is_current = true " +
		"and r.scope_status = 'included_product'"
	args := []any{country}
	if singleDay {
		query += " and f.period_end_date = $2::date"
		args = append(args, startDate.Format("2006-01-02"))
	} else {
		query += " and f.period_end_date >= $2::date and f.period_end_date <= $3::date"
		args = append(args, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))
	}
	if len(projectIDs) > 0 {
		query += fmt.Sprintf(" and f.project_id = any($%d)", len(args)+1)
		args = append(args, projectIDs)
	}
	var spend, sales float64
	var clicks, impressions, orders int64
	if err := db.QueryRow(ctx, query, args...).Scan(&spend, &sales, &clicks, &impressions, &orders); err != nil {
		return map[string]any{"spend": 0.0, "sales": 0.0, "roas": 0.0, "acos": 0.0, "ctr": 0.0, "orders": 0}
	}
	roas := 0.0
	if spend > 0 {
		roas = round2(sales / spend)
	}
	acos := 0.0
	if sales > 0 {
		acos = round2(spend / sales * 100)
	}
	ctr := 0.0
	if impressions > 0 {
		ctr = round2(float64(clicks) / float64(impressions) * 100)
	}
	return map[string]any{
		"spend": round2(spend), "sales": round2(sales), "roas": roas,
		"acos": acos, "ctr": ctr, "orders": int(orders),
	}
}

func queryReturns(ctx context.Context, db store.DB, projectIDs []int64, country string, startDate, endDate time.Time) (int, []map[string]any) {
	query := "select r.reason, coalesce(sum(r.quantity), 0) from public.analysis_return_rows r " +
		"join public.analysis_source_files f on f.id = r.source_file_id " +
		"where f.country = $1 and f.report_type = 'return_report' and f.is_current = true " +
		"and r.return_date >= $2::date and r.return_date <= $3::date"
	args := []any{country, startDate.Format("2006-01-02"), endDate.Format("2006-01-02")}
	if len(projectIDs) > 0 {
		query += " and f.project_id = any($4)"
		args = append(args, projectIDs)
	}
	query += " group by r.reason"
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return 0, []map[string]any{}
	}
	defer rows.Close()
	type reasonRow struct {
		reason string
		qty    int
	}
	total := 0
	all := make([]reasonRow, 0)
	for rows.Next() {
		var reason *string
		var quantity int64
		if err := rows.Scan(&reason, &quantity); err != nil {
			continue
		}
		total += int(quantity)
		if reason != nil && *reason != "" {
			all = append(all, reasonRow{reason: *reason, qty: int(quantity)})
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].qty == all[j].qty {
			return all[i].reason < all[j].reason
		}
		return all[i].qty > all[j].qty
	})
	top := make([]map[string]any, 0, 3)
	for index, item := range all {
		if index >= 3 {
			break
		}
		top = append(top, map[string]any{
			"reason": item.reason, "reason_display": translateReturnReason(item.reason), "qty": item.qty,
		})
	}
	return total, top
}

func querySkuSalesDetail(ctx context.Context, db store.DB, projectIDs []int64, country string, startDate, endDate time.Time) []map[string]any {
	amount := salesAmountExpr(country)
	query := "select sku, coalesce(sum(quantity), 0), coalesce(sum(" + amount + "), 0) " +
		"from public.analysis_sales_order_rows " +
		"where country = $1 and purchase_date_pt >= $2::date and purchase_date_pt <= $3::date"
	args := []any{country, startDate.Format("2006-01-02"), endDate.Format("2006-01-02")}
	if len(projectIDs) > 0 {
		query += " and project_id = any($4)"
		args = append(args, projectIDs)
	}
	query += " group by sku order by coalesce(sum(quantity), 0) desc"
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	type detailRow struct {
		sku    string
		qty    int
		amount float64
	}
	details := make([]detailRow, 0)
	skus := make([]string, 0)
	for rows.Next() {
		var sku *string
		var quantity int64
		var amountValue float64
		if err := rows.Scan(&sku, &quantity, &amountValue); err != nil {
			continue
		}
		name := "Unknown"
		if sku != nil && *sku != "" {
			name = *sku
		}
		if int(quantity) == 0 && amountValue == 0 {
			continue
		}
		details = append(details, detailRow{sku: name, qty: int(quantity), amount: amountValue})
		if name != "Unknown" {
			skus = append(skus, name)
		}
	}
	names := queryProductNames(ctx, db, projectIDs, country, skus)
	result := make([]map[string]any, 0, len(details))
	for _, item := range details {
		name := "—"
		if mapped, ok := names[item.sku]; ok && mapped != "" {
			name = mapped
		}
		result = append(result, map[string]any{
			"sku": item.sku, "product_name": name, "qty": item.qty, "amount": item.amount,
		})
	}
	return result
}

func queryProductNames(ctx context.Context, db store.DB, projectIDs []int64, country string, skus []string) map[string]string {
	result := make(map[string]string)
	if len(skus) == 0 {
		return result
	}
	query := "select sku, product_name from public.product_costs " +
		"where sku = any($1) and country = $2 and is_active = true"
	args := []any{skus, country}
	if len(projectIDs) > 0 {
		query += " and project_id = any($3)"
		args = append(args, projectIDs)
	}
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var sku, name *string
		if err := rows.Scan(&sku, &name); err != nil {
			continue
		}
		if sku != nil && name != nil && strings.TrimSpace(*name) != "" {
			result[*sku] = *name
		}
	}
	return result
}

func buildSKUComparison(topSKUs, prevTopSKUs []map[string]any) []map[string]any {
	prevMap := make(map[string]int)
	for _, item := range prevTopSKUs {
		prevMap[item["sku"].(string)] = intValue(item["qty"])
	}
	limit := len(topSKUs)
	if limit > 8 {
		limit = 8
	}
	comparison := make([]map[string]any, 0, limit)
	for _, item := range topSKUs[:limit] {
		sku := item["sku"].(string)
		curr := intValue(item["qty"])
		prev := prevMap[sku]
		change := 0.0
		if prev > 0 {
			change = float64(curr-prev) / float64(prev) * 100
		} else if curr > 0 {
			change = 100
		}
		comparison = append(comparison, map[string]any{
			"sku": sku, "current": curr, "prev": prev, "change": change, "new": prev == 0 && curr > 0,
		})
	}
	return comparison
}
