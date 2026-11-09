package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/return_analysis"
)

type ReturnAnalysisStore struct {
	db FullDB
}

func NewReturnAnalysisStore(db FullDB) *ReturnAnalysisStore {
	return &ReturnAnalysisStore{db: db}
}

func (s *ReturnAnalysisStore) VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	var projOp, asstOp *string
	err := s.db.QueryRow(ctx, "select project_operator, assistant_operator from public.projects where id = $1", projectID).Scan(&projOp, &asstOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return return_analysis.ErrProjectNotFound
		}
		return err
	}
	op = strings.TrimSpace(op)
	if op == "" {
		return return_analysis.ErrProjectForbidden
	}
	if textContainsName(projOp, op) || textContainsName(asstOp, op) {
		return nil
	}
	return return_analysis.ErrProjectForbidden
}

type returnRowData struct {
	id                     int64
	returnDate             string
	orderID                string
	sku                    string
	asin                   *string
	productName            *string
	quantity               int
	fulfillmentCenterID    *string
	detailedDisposition    string
	reason                 string
	status                 string
	licensePlateNumber     *string
	originalReturnDatetime string
	customerComments       *string
}

type returnEventKey struct {
	orderID string
	sku     string
}

type returnCycleStat struct {
	total int
	count int
	min   int
	max   int
}

func returnAnalysisSpanSQL() string {
	return `
		select min(r.return_date), max(r.return_date)
		from public.analysis_return_rows r
		join public.analysis_source_files s on s.id = r.source_file_id
		where s.project_id = $1 and s.country = $2
		  and s.report_type = 'return_report' and s.is_current = true
	`
}

func buildReturnAnalysisRowsSQL(conditions []string) string {
	return fmt.Sprintf(`
		select
			r.id, r.return_date::text, r.order_id, r.sku, r.asin, r.product_name,
			r.quantity, r.fulfillment_center_id, r.detailed_disposition,
			r.reason, r.status, r.license_plate_number, r.original_return_datetime,
			r.customer_comments
		from public.analysis_return_rows r
		join public.analysis_source_files s on s.id = r.source_file_id
		where %s
		order by r.return_date asc, r.id asc
	`, strings.Join(conditions, " and "))
}

func buildReturnAnalysisSalesSQL(conditions []string, country string) string {
	amountExpr := "(coalesce(so.item_price, 0) + coalesce(so.shipping_price, 0))"
	if normalizeCountry(country) == "DE" || normalizeCountry(country) == "UK" {
		amountExpr = "(coalesce(so.item_price, 0) + coalesce(so.shipping_price, 0) + coalesce(so.item_tax, 0) + coalesce(so.shipping_tax, 0))"
	}
	return fmt.Sprintf(`
		select
			coalesce(so.sku, '')::text,
			so.purchase_date_pt::text,
			so.quantity,
			%s
		from public.analysis_sales_order_rows so
		where %s
		order by so.purchase_date_pt asc, so.id asc
	`, amountExpr, strings.Join(conditions, " and "))
}

func returnCycleSalesSQL() string {
	return `
		select so.amazon_order_id, coalesce(so.sku, '')::text, so.purchase_date_pt::text
		from public.analysis_sales_order_rows so
		where so.project_id = $1
		  and so.country = $2
		  and so.is_counted_sales = true
		  and so.order_status <> 'Cancelled'
		  and so.amazon_order_id = any($3::text[])
		order by so.purchase_date_pt asc, so.id asc
	`
}

func returnSKUProductNamesSQL() string {
	return `
		select sku, product_name
		from public.product_costs
		where project_id = $1
		  and country = $2
		  and is_active = true
		  and sku = any($3::text[])
		  and nullif(btrim(product_name), '') is not null
	`
}

func buildReturnRawRowsSQL(conditions []string, limitPlaceholder int) string {
	return fmt.Sprintf(`
		select
			r.return_date::text, r.original_return_datetime, r.order_id, r.sku, r.asin, r.fnsku,
			r.product_name, r.quantity, r.fulfillment_center_id, r.detailed_disposition,
			r.reason, r.status, r.license_plate_number, r.customer_comments
		from public.analysis_return_rows r
		join public.analysis_source_files s on s.id = r.source_file_id
		where %s
		order by r.return_date asc, r.id asc
		limit $%d
	`, strings.Join(conditions, " and "), limitPlaceholder)
}

func (s *ReturnAnalysisStore) GetReturnAnalysis(ctx context.Context, filter return_analysis.ReturnAnalysisFilter) (*return_analysis.ReturnAnalysisResponse, error) {
	var projectName string
	err := s.db.QueryRow(ctx, "select coalesce(project_name, '') from public.projects where id = $1", filter.ProjectID).Scan(&projectName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, return_analysis.ErrProjectNotFound
		}
		return nil, err
	}

	// 1. Data span
	var spanMin, spanMax *time.Time
	if err := s.db.QueryRow(ctx, returnAnalysisSpanSQL(), filter.ProjectID, filter.Country).Scan(&spanMin, &spanMax); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	var dataSpan *return_analysis.ReturnDataSpan
	dataAvailable := false
	if spanMin != nil && spanMax != nil {
		minStr := spanMin.Format("2006-01-02")
		maxStr := spanMax.Format("2006-01-02")
		dataSpan = &return_analysis.ReturnDataSpan{
			MinReturnDate: &minStr,
			MaxReturnDate: &maxStr,
		}
		if filter.StartDate <= maxStr && minStr <= filter.EndDate {
			dataAvailable = true
		}
	}

	// 2. Fetch return rows
	var conditions []string
	var args []any
	conditions = append(conditions,
		"s.project_id = $1",
		"s.country = $2",
		"s.report_type = 'return_report'",
		"s.is_current = true",
		"r.return_date >= $3::date",
		"r.return_date <= $4::date",
	)
	args = append(args, filter.ProjectID, filter.Country, filter.StartDate, filter.EndDate)
	idx := 5

	if filter.SKU != nil && *filter.SKU != "" {
		conditions = append(conditions, fmt.Sprintf("r.sku = $%d", idx))
		args = append(args, *filter.SKU)
		idx++
	}

	querySQL := buildReturnAnalysisRowsSQL(conditions)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var returnRows []returnRowData
	for rows.Next() {
		var rd returnRowData
		if err := rows.Scan(
			&rd.id, &rd.returnDate, &rd.orderID, &rd.sku, &rd.asin, &rd.productName,
			&rd.quantity, &rd.fulfillmentCenterID, &rd.detailedDisposition,
			&rd.reason, &rd.status, &rd.licensePlateNumber, &rd.originalReturnDatetime,
			&rd.customerComments,
		); err != nil {
			return nil, err
		}
		returnRows = append(returnRows, rd)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 3. Sales aggregation. This mirrors Python's counted-sales filter and
	// country-specific gross-sales expression (DE/UK include tax).
	salesBySKU := make(map[string]int)
	salesByDate := make(map[string]int)
	amountByDate := make(map[string]float64)
	totalSalesQty := 0
	totalSalesAmt := 0.0

	var salesConditions []string
	var salesArgs []any
	salesConditions = append(salesConditions,
		"so.project_id = $1",
		"so.country = $2",
		"so.purchase_date_pt >= $3::date",
		"so.purchase_date_pt <= $4::date",
		"so.is_counted_sales = true",
		"so.order_status <> 'Cancelled'",
	)
	salesArgs = append(salesArgs, filter.ProjectID, filter.Country, filter.StartDate, filter.EndDate)
	sIdx := 5
	if filter.SKU != nil && *filter.SKU != "" {
		salesConditions = append(salesConditions, fmt.Sprintf("so.sku = $%d", sIdx))
		salesArgs = append(salesArgs, *filter.SKU)
		sIdx++
	}

	salesSQL := buildReturnAnalysisSalesSQL(salesConditions, filter.Country)

	sRows, err := s.db.Query(ctx, salesSQL, salesArgs...)
	if err != nil {
		return nil, err
	}
	defer sRows.Close()
	for sRows.Next() {
		var skuStr, dStr string
		var q int
		var amt float64
		if err := sRows.Scan(&skuStr, &dStr, &q, &amt); err != nil {
			return nil, err
		}
		salesBySKU[skuStr] += q
		salesByDate[dStr] += q
		amountByDate[dStr] = round2(amountByDate[dStr] + amt)
		totalSalesQty += q
		totalSalesAmt = round2(totalSalesAmt + amt)
	}
	if err := sRows.Err(); err != nil {
		return nil, err
	}

	purchaseDateByOrderSKU := make(map[returnEventKey]string)
	skuProductNames := make(map[string]string)
	if len(returnRows) > 0 {
		orderIDs := make([]string, 0, len(returnRows))
		seenOrders := make(map[string]struct{})
		skuIDs := make([]string, 0, len(returnRows))
		seenSKUs := make(map[string]struct{})
		for _, row := range returnRows {
			if _, ok := seenSKUs[row.sku]; !ok {
				seenSKUs[row.sku] = struct{}{}
				skuIDs = append(skuIDs, row.sku)
			}
			if row.orderID == "" {
				continue
			}
			if _, ok := seenOrders[row.orderID]; ok {
				continue
			}
			seenOrders[row.orderID] = struct{}{}
			orderIDs = append(orderIDs, row.orderID)
		}
		if len(orderIDs) > 0 {
			cycleRows, err := s.db.Query(ctx, returnCycleSalesSQL(), filter.ProjectID, filter.Country, orderIDs)
			if err != nil {
				return nil, err
			}
			defer cycleRows.Close()
			for cycleRows.Next() {
				var orderID, skuStr, purchaseDate string
				if err := cycleRows.Scan(&orderID, &skuStr, &purchaseDate); err != nil {
					return nil, err
				}
				purchaseDateByOrderSKU[returnEventKey{orderID: orderID, sku: skuStr}] = purchaseDate
			}
			if err := cycleRows.Err(); err != nil {
				return nil, err
			}
		}
		if len(skuIDs) > 0 {
			productRows, err := s.db.Query(ctx, returnSKUProductNamesSQL(), filter.ProjectID, filter.Country, skuIDs)
			if err != nil {
				return nil, err
			}
			defer productRows.Close()
			for productRows.Next() {
				var sku, productName string
				if err := productRows.Scan(&sku, &productName); err != nil {
					return nil, err
				}
				skuProductNames[sku] = productName
			}
			if err := productRows.Err(); err != nil {
				return nil, err
			}
		}
	}

	// 4. Aggregations on returnRows
	totalReturns := 0
	totalQuantity := 0
	multiItemCount := 0
	multiItemQty := 0

	type skuStat struct {
		sku         string
		asin        *string
		productName *string
		totalQty    int
		count       int
	}
	skuMap := make(map[string]*skuStat)

	reasonEvents := make(map[string]map[returnEventKey]struct{})
	reasonQty := make(map[string]int)

	dispEvents := make(map[string]map[returnEventKey]struct{})
	dispQty := make(map[string]int)

	statusEvents := make(map[string]map[returnEventKey]struct{})
	statusQty := make(map[string]int)

	fcEvents := make(map[string]map[returnEventKey]struct{})
	fcQty := make(map[string]int)

	weekdayEvents := make(map[int]map[returnEventKey]struct{})

	trendEvents := make(map[string]map[returnEventKey]struct{})
	trendQty := make(map[string]int)

	eventSeen := make(map[returnEventKey]struct{})
	skuEvents := make(map[string]map[returnEventKey]struct{})

	for _, rd := range returnRows {
		key := returnEventKey{orderID: rd.orderID, sku: rd.sku}
		_, seen := eventSeen[key]
		if !seen {
			eventSeen[key] = struct{}{}
			totalReturns++
			addEvent(skuEvents, rd.sku, key)
		}
		totalQuantity += rd.quantity
		if rd.quantity > 1 {
			multiItemCount++
			multiItemQty += rd.quantity
		}

		// SKU stat
		st, ok := skuMap[rd.sku]
		if !ok {
			st = &skuStat{
				sku:         rd.sku,
				asin:        rd.asin,
				productName: rd.productName,
			}
			skuMap[rd.sku] = st
		}
		st.totalQty += rd.quantity
		st.count++
		if st.productName == nil && rd.productName != nil {
			st.productName = rd.productName
		}
		if st.asin == nil && rd.asin != nil {
			st.asin = rd.asin
		}

		// Reason
		addEvent(reasonEvents, rd.reason, key)
		reasonQty[rd.reason] += rd.quantity

		// Disposition
		addEvent(dispEvents, rd.detailedDisposition, key)
		dispQty[rd.detailedDisposition] += rd.quantity

		// Status
		addEvent(statusEvents, rd.status, key)
		statusQty[rd.status] += rd.quantity

		// FC
		fcKey := "未知仓库"
		if rd.fulfillmentCenterID != nil {
			if trimmed := strings.TrimSpace(*rd.fulfillmentCenterID); trimmed != "" {
				fcKey = trimmed
			}
		}
		addEvent(fcEvents, fcKey, key)
		fcQty[fcKey] += rd.quantity

		// Trend & Weekday
		addEvent(trendEvents, rd.returnDate, key)
		trendQty[rd.returnDate] += rd.quantity

		if t, err := time.Parse("2006-01-02", rd.returnDate); err == nil {
			addEvent(weekdayEvents, int(t.Weekday()), key)
		}
	}

	for sku, productName := range skuProductNames {
		if st, ok := skuMap[sku]; ok {
			productName := productName
			st.productName = &productName
		}
	}

	feedbacks := buildReturnFeedbackRows(returnRows)

	cycleStats := buildReturnCycleStats(returnRows, purchaseDateByOrderSKU)

	// 5. Build Rankings
	var rankingRows []return_analysis.ReturnRankingItem
	for _, st := range skuMap {
		sq := salesBySKU[st.sku]
		var rRate *float64
		if sq > 0 {
			rate := round2(float64(st.totalQty) / float64(sq) * 100)
			rRate = &rate
		}
		cycle := cycleStats[st.sku]
		var avgCycle *float64
		var minCycle, maxCycle *int
		if cycle != nil && cycle.count > 0 {
			avg := math.Round(float64(cycle.total)/float64(cycle.count)*10) / 10
			avgCycle = &avg
			minValue := cycle.min
			maxValue := cycle.max
			minCycle = &minValue
			maxCycle = &maxValue
		}
		rankingRows = append(rankingRows, return_analysis.ReturnRankingItem{
			SKU:                st.sku,
			ASIN:               st.asin,
			ProductName:        st.productName,
			TotalQuantity:      st.totalQty,
			ReturnCount:        len(skuEvents[st.sku]),
			SalesQuantity:      sq,
			ReturnRate:         rRate,
			AvgReturnCycleDays: avgCycle,
			MinReturnCycleDays: minCycle,
			MaxReturnCycleDays: maxCycle,
		})
	}
	sort.Slice(rankingRows, func(i, j int) bool {
		if rankingRows[i].TotalQuantity != rankingRows[j].TotalQuantity {
			return rankingRows[i].TotalQuantity > rankingRows[j].TotalQuantity
		}
		if rankingRows[i].ReturnCount != rankingRows[j].ReturnCount {
			return rankingRows[i].ReturnCount > rankingRows[j].ReturnCount
		}
		return rankingRows[i].SKU < rankingRows[j].SKU
	})

	rankingTotalCount := len(rankingRows)
	rankingTruncated := false
	if len(rankingRows) > 20 {
		rankingTruncated = true
		rankingRows = rankingRows[:20]
	}

	// 6. Reasons
	var reasonRows []return_analysis.ReturnReasonItem
	for rk, events := range reasonEvents {
		cnt := len(events)
		pct := 0.0
		if totalReturns > 0 {
			pct = round2(float64(cnt) / float64(totalReturns) * 100)
		}
		reasonRows = append(reasonRows, return_analysis.ReturnReasonItem{
			Reason:        rk,
			ReasonDisplay: return_analysis.TranslateReason(rk),
			TotalQuantity: reasonQty[rk],
			ReturnCount:   cnt,
			Percentage:    pct,
		})
	}
	sort.Slice(reasonRows, func(i, j int) bool {
		if reasonRows[i].ReturnCount != reasonRows[j].ReturnCount {
			return reasonRows[i].ReturnCount > reasonRows[j].ReturnCount
		}
		return reasonRows[i].Reason < reasonRows[j].Reason
	})

	// 7. Dispositions
	var dispRows []return_analysis.DispositionItem
	for dk, events := range dispEvents {
		cnt := len(events)
		pct := 0.0
		if totalReturns > 0 {
			pct = round2(float64(cnt) / float64(totalReturns) * 100)
		}
		dispRows = append(dispRows, return_analysis.DispositionItem{
			DetailedDisposition: dk,
			DispositionDisplay:  return_analysis.TranslateDisposition(dk),
			TotalQuantity:       dispQty[dk],
			ReturnCount:         cnt,
			Percentage:          pct,
		})
	}
	sort.Slice(dispRows, func(i, j int) bool {
		if dispRows[i].ReturnCount != dispRows[j].ReturnCount {
			return dispRows[i].ReturnCount > dispRows[j].ReturnCount
		}
		return dispRows[i].DetailedDisposition < dispRows[j].DetailedDisposition
	})

	// 8. Statuses
	var stRows []return_analysis.StatusItem
	for sk, events := range statusEvents {
		cnt := len(events)
		pct := 0.0
		if totalReturns > 0 {
			pct = round2(float64(cnt) / float64(totalReturns) * 100)
		}
		stRows = append(stRows, return_analysis.StatusItem{
			Status:        sk,
			StatusDisplay: return_analysis.TranslateStatus(sk),
			TotalQuantity: statusQty[sk],
			ReturnCount:   cnt,
			Percentage:    pct,
		})
	}
	sort.Slice(stRows, func(i, j int) bool {
		if stRows[i].ReturnCount != stRows[j].ReturnCount {
			return stRows[i].ReturnCount > stRows[j].ReturnCount
		}
		return stRows[i].Status < stRows[j].Status
	})

	// 9. Weekdays (only observed weekdays, matching the Python response)
	weekdayNames := []string{"周一", "周二", "周三", "周四", "周五", "周六", "周日"}
	var weekdayRows []return_analysis.WeekdayItem
	for i := 0; i < 7; i++ {
		events, ok := weekdayEvents[i]
		if !ok || len(events) == 0 {
			continue
		}
		cnt := len(events)
		pct := 0.0
		if totalReturns > 0 {
			pct = round2(float64(cnt) / float64(totalReturns) * 100)
		}
		weekdayRows = append(weekdayRows, return_analysis.WeekdayItem{
			Weekday:        i,
			WeekdayDisplay: weekdayNames[i],
			ReturnCount:    cnt,
			Percentage:     pct,
		})
	}

	// 10. Fulfillment centers
	var fcRows []return_analysis.FulfillmentCenterItem
	totalFCReturns := 0
	for _, events := range fcEvents {
		totalFCReturns += len(events)
	}
	for fc, events := range fcEvents {
		cnt := len(events)
		pct := 0.0
		if totalFCReturns > 0 {
			pct = round2(float64(cnt) / float64(totalFCReturns) * 100)
		}
		fcRows = append(fcRows, return_analysis.FulfillmentCenterItem{
			FulfillmentCenterID: fc,
			ReturnCount:         cnt,
			Quantity:            fcQty[fc],
			Percentage:          pct,
		})
	}
	sort.Slice(fcRows, func(i, j int) bool {
		if fcRows[i].ReturnCount != fcRows[j].ReturnCount {
			return fcRows[i].ReturnCount > fcRows[j].ReturnCount
		}
		return fcRows[i].FulfillmentCenterID < fcRows[j].FulfillmentCenterID
	})

	// 11. Daily trends for dates with return activity
	var trendRows []return_analysis.ReturnTrendItem
	var trendDates []string
	for date := range trendEvents {
		trendDates = append(trendDates, date)
	}
	sort.Strings(trendDates)
	for _, dStr := range trendDates {
		rc := len(trendEvents[dStr])
		rq := trendQty[dStr]
		sq := salesByDate[dStr]
		sa := amountByDate[dStr]
		var rRate *float64
		if sq > 0 {
			r := round2(float64(rq) / float64(sq) * 100)
			rRate = &r
		}
		trendRows = append(trendRows, return_analysis.ReturnTrendItem{
			Date:          dStr,
			TotalQuantity: rq,
			ReturnCount:   rc,
			SalesQuantity: sq,
			SalesAmount:   sa,
			ReturnRate:    rRate,
		})
	}

	// 12. Summary calculations
	var topSku, topReason, topReasonDisplay *string
	if len(rankingRows) > 0 {
		s := rankingRows[0].SKU
		topSku = &s
	}
	if len(reasonRows) > 0 {
		r := reasonRows[0].Reason
		topReason = &r
		rd := reasonRows[0].ReasonDisplay
		topReasonDisplay = &rd
	}

	overallRate := 0.0
	if totalSalesQty > 0 {
		overallRate = round2(float64(totalQuantity) / float64(totalSalesQty) * 100)
	}

	summaryText := fmt.Sprintf("项目 %s (%s) 在 %s 至 %s 期间共有 %d 笔退货、%d 件商品，涉及 %d 个 SKU。",
		projectName, filter.Country, filter.StartDate, filter.EndDate, totalReturns, totalQuantity, len(skuMap))
	if totalSalesQty > 0 {
		summaryText += fmt.Sprintf(" 同期计入销量 %d 件，整体退货率 %.2f%%。", totalSalesQty, overallRate)
	} else if !dataAvailable {
		summaryText += " 本窗口不在当前退货报表数据跨度内，退货率不可用。"
	} else {
		summaryText += " 同期无计入销量，无法计算退货率。"
	}

	return &return_analysis.ReturnAnalysisResponse{
		ProjectID:   filter.ProjectID,
		ProjectName: projectName,
		Country:     filter.Country,
		StartDate:   filter.StartDate,
		EndDate:     filter.EndDate,
		Summary: return_analysis.ReturnAnalysisSummary{
			TotalReturns:           totalReturns,
			TotalQuantity:          totalQuantity,
			UniqueSKUs:             len(skuMap),
			TopReturnSKU:           topSku,
			TopReturnReason:        topReason,
			TopReturnReasonDisplay: topReasonDisplay,
			TotalSalesQuantity:     totalSalesQty,
			TotalSalesAmount:       totalSalesAmt,
			OverallReturnRate:      overallRate,
			DataAvailable:          dataAvailable,
			DataSpan:               dataSpan,
		},
		SummaryText:             summaryText,
		RankingRows:             rankingRows,
		RankingTruncated:        rankingTruncated,
		RankingTotalCount:       rankingTotalCount,
		ReasonRows:              reasonRows,
		TrendRows:               trendRows,
		DispositionRows:         dispRows,
		StatusRows:              stRows,
		FeedbackRows:            feedbacks,
		WeekdayRows:             weekdayRows,
		FulfillmentCenterRows:   fcRows,
		MultiItemReturnCount:    multiItemCount,
		MultiItemReturnQuantity: multiItemQty,
	}, nil
}

func addEvent[Key comparable, Event comparable](events map[Key]map[Event]struct{}, key Key, event Event) {
	set, ok := events[key]
	if !ok {
		set = make(map[Event]struct{})
		events[key] = set
	}
	set[event] = struct{}{}
}

func buildReturnCycleStats(rows []returnRowData, purchaseDateByOrderSKU map[returnEventKey]string) map[string]*returnCycleStat {
	stats := make(map[string]*returnCycleStat)
	for _, rd := range rows {
		purchaseDate, ok := purchaseDateByOrderSKU[returnEventKey{orderID: rd.orderID, sku: rd.sku}]
		if !ok {
			continue
		}
		purchased, err := time.Parse("2006-01-02", purchaseDate)
		if err != nil {
			continue
		}
		returned, err := time.Parse("2006-01-02", rd.returnDate)
		if err != nil {
			continue
		}
		days := int(returned.Sub(purchased).Hours() / 24)
		if days < 0 {
			continue
		}
		stat, ok := stats[rd.sku]
		if !ok {
			stat = &returnCycleStat{min: days, max: days}
			stats[rd.sku] = stat
		}
		stat.total += days
		stat.count++
		if days < stat.min {
			stat.min = days
		}
		if days > stat.max {
			stat.max = days
		}
	}
	return stats
}

type returnFeedbackAccumulator struct {
	reason   string
	segments []string
	seen     map[string]struct{}
}

type returnFeedbackKey struct {
	eventKey returnEventKey
	date     string
}

func buildReturnFeedbackRows(rows []returnRowData) []return_analysis.CustomerFeedbackItem {
	merged := make(map[returnFeedbackKey]*returnFeedbackAccumulator)
	var orderKeys []returnFeedbackKey
	for _, rd := range rows {
		if rd.customerComments == nil {
			continue
		}
		cleaned := strings.ReplaceAll(strings.ReplaceAll(*rd.customerComments, "&#39;", "'"), "&amp;", "&")
		key := returnFeedbackKey{
			eventKey: returnEventKey{orderID: rd.orderID, sku: rd.sku},
			date:     rd.returnDate,
		}
		acc, ok := merged[key]
		if !ok {
			acc = &returnFeedbackAccumulator{
				reason: rd.reason,
				seen:   make(map[string]struct{}),
			}
			merged[key] = acc
			orderKeys = append(orderKeys, key)
		}
		for _, segment := range strings.Split(cleaned, "|") {
			segment = strings.TrimSpace(segment)
			if segment == "" {
				continue
			}
			if _, exists := acc.seen[segment]; exists {
				continue
			}
			acc.seen[segment] = struct{}{}
			acc.segments = append(acc.segments, segment)
		}
	}

	feedback := make([]return_analysis.CustomerFeedbackItem, 0, len(orderKeys))
	for _, key := range orderKeys {
		acc := merged[key]
		if len(acc.segments) == 0 {
			continue
		}
		feedback = append(feedback, return_analysis.CustomerFeedbackItem{
			SKU:             key.eventKey.sku,
			OrderID:         key.eventKey.orderID,
			Reason:          acc.reason,
			ReasonDisplay:   return_analysis.TranslateReason(acc.reason),
			CustomerComment: strings.Join(acc.segments, " | "),
			ReturnDate:      key.date,
		})
	}
	return feedback
}

func (s *ReturnAnalysisStore) GetRawRows(ctx context.Context, filter return_analysis.ReturnAnalysisFilter, limit int) ([]return_analysis.ReturnRawRowItem, error) {
	var conditions []string
	var args []any
	conditions = append(conditions,
		"s.project_id = $1",
		"s.country = $2",
		"s.report_type = 'return_report'",
		"s.is_current = true",
		"r.return_date >= $3::date",
		"r.return_date <= $4::date",
	)
	args = append(args, filter.ProjectID, filter.Country, filter.StartDate, filter.EndDate)
	idx := 5

	if filter.SKU != nil && *filter.SKU != "" {
		conditions = append(conditions, fmt.Sprintf("r.sku = $%d", idx))
		args = append(args, *filter.SKU)
		idx++
	}

	querySQL := buildReturnRawRowsSQL(conditions, idx)
	args = append(args, limit)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []return_analysis.ReturnRawRowItem
	for rows.Next() {
		var it return_analysis.ReturnRawRowItem
		if err := rows.Scan(
			&it.ReturnDate, &it.OriginalReturnDatetime, &it.OrderID, &it.SKU, &it.ASIN, &it.FNSKU,
			&it.ProductName, &it.Quantity, &it.FulfillmentCenterID, &it.DetailedDisposition,
			&it.Reason, &it.Status, &it.LicensePlateNumber, &it.CustomerComment,
		); err != nil {
			return nil, err
		}
		it.DispositionDisplay = return_analysis.TranslateDisposition(it.DetailedDisposition)
		it.ReasonDisplay = return_analysis.TranslateReason(it.Reason)
		it.StatusDisplay = return_analysis.TranslateStatus(it.Status)
		items = append(items, it)
	}
	if items == nil {
		items = []return_analysis.ReturnRawRowItem{}
	}
	return items, rows.Err()
}
