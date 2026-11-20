package store

import (
	"context"
	"strings"
)

// SKUSalesWindow 是按 purchase_date_pt 自然日、含首尾的 SKU 级销量统计区间。
type SKUSalesWindow struct {
	StartDate string
	EndDate   string
}

// loadSKUSalesQtyWindow 汇总区间内各 SKU 的销量（quantity 之和）。
//
// 口径与 daily_analysis 的 DailyAnalysisStore.loadSalesMetrics 保持一致（同一张
// public.analysis_sales_order_rows、同一批过滤条件），避免库存分析与每日分析两个页面
// 的销量数字对不上：
//   - purchase_date_pt 落在 [StartDate, EndDate]（含首尾）
//   - is_counted_sales = true
//   - order_status 不为 Cancelled
//
// 返回 map 的 key 统一为 lower(trim(sku))，与库存分析、在途货件里对 SKU 的归一化一致。
func loadSKUSalesQtyWindow(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	window SKUSalesWindow,
) (map[string]int64, error) {
	rows, err := db.Query(
		ctx,
		`select coalesce(sku, ''), coalesce(sum(quantity), 0)
		   from public.analysis_sales_order_rows
		  where project_id = $1
		    and country = $2
		    and purchase_date_pt >= $3::date
		    and purchase_date_pt <= $4::date
		    and is_counted_sales = true
		    and order_status != 'Cancelled'
		  group by coalesce(sku, '')`,
		projectID,
		country,
		window.StartDate,
		window.EndDate,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var rawSKU string
		var quantity int64
		if err := rows.Scan(&rawSKU, &quantity); err != nil {
			return nil, err
		}
		key := strings.ToLower(strings.TrimSpace(rawSKU))
		if key == "" {
			continue
		}
		result[key] += quantity
	}
	return result, rows.Err()
}
