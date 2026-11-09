package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_domains"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
)

func (s *AIInsightStore) CreateAdAnalysisRun(ctx context.Context, input insight_domains.AdAnalysisInput, meta ai_insight.MutationMeta) (*insight_runs.Run, bool, error) {
	projectName, err := s.lookupProjectName(ctx, input.ProjectID)
	if err != nil {
		return nil, false, err
	}
	country := strings.ToUpper(input.Country)
	sales, err := s.aggregateAdSales(ctx, input.ProjectID, country, input.StartDate, input.EndDate)
	if err != nil {
		return nil, false, err
	}
	ads, err := s.aggregateAdDaily(ctx, input.ProjectID, country, input.StartDate, input.EndDate)
	if err != nil {
		return nil, false, err
	}
	campaigns, err := s.aggregateAdCampaigns(ctx, input.ProjectID, country, input.StartDate, input.EndDate)
	if err != nil {
		return nil, false, err
	}
	topSKUs, err := s.topSalesSKUs(ctx, input.ProjectID, country, input.StartDate, input.EndDate)
	if err != nil {
		return nil, false, err
	}
	breakdown, err := s.adBreakdownPresence(ctx, input.ProjectID, country, input.StartDate, input.EndDate)
	if err != nil {
		return nil, false, err
	}
	totalDays := int(input.EndDate.Sub(input.StartDate).Hours()/24) + 1
	freshness := adFreshness(appendLatestDate(sales, ads), time.Now().In(aiInsightShanghaiLocation()), totalDays)
	missing := map[string]any{"is_complete": true, "missing_dimensions": []string{}}
	missingDims := make([]string, 0)
	if len(sales) == 0 {
		missingDims = append(missingDims, "sales_series")
	}
	if len(ads) == 0 {
		missingDims = append(missingDims, "ad_series")
	}
	if len(campaigns) == 0 {
		missingDims = append(missingDims, "ad_campaigns")
	}
	if len(topSKUs) == 0 {
		missingDims = append(missingDims, "top_skus")
	}
	hasBreakdown := false
	for _, block := range breakdown {
		if flag, _ := block["has_data"].(bool); flag {
			hasBreakdown = true
			break
		}
	}
	if !hasBreakdown {
		missingDims = append(missingDims, "ad_breakdown")
	}
	missing["missing_dimensions"] = missingDims
	missing["is_complete"] = len(missingDims) == 0
	comparisonStart := input.StartDate.AddDate(0, 0, -totalDays)
	comparisonEnd := input.StartDate.AddDate(0, 0, -1)
	comparisonSales, err := s.aggregateAdSales(ctx, input.ProjectID, country, comparisonStart, comparisonEnd)
	if err != nil {
		return nil, false, err
	}
	comparisonAds, err := s.aggregateAdDaily(ctx, input.ProjectID, country, comparisonStart, comparisonEnd)
	if err != nil {
		return nil, false, err
	}
	comparison := map[string]any{
		"period_start": ai_insight.DateOnly(comparisonStart),
		"period_end":   ai_insight.DateOnly(comparisonEnd),
		"period_days":  totalDays,
	}
	addSummaryTotals(comparison, comparisonSales, comparisonAds)
	data := map[string]any{
		"project_name":      projectName,
		"country":           country,
		"date_range_start":  ai_insight.DateOnly(input.StartDate),
		"date_range_end":    ai_insight.DateOnly(input.EndDate),
		"comparison_period": comparison,
		"data_coverage": map[string]any{
			"sales_days": len(sales), "ad_days": len(ads), "total_requested_days": totalDays,
		},
		"inventory_summary":    map[string]any{},
		"ad_breakdown_by_type": breakdown,
		"sales_by_date":        sales,
		"ad_by_date":           ads,
		"ad_campaigns":         campaigns,
		"top_skus":             topSKUs,
	}
	context := map[string]any{
		"slot_version":     1,
		"date_range_start": ai_insight.DateOnly(input.StartDate),
		"date_range_end":   ai_insight.DateOnly(input.EndDate),
		"project_ids":      []int64{input.ProjectID},
		"country":          country,
		"data_freshness":   freshness,
		"missing_data":     missing,
		"project_name":     projectName,
	}
	slots := map[string]any{
		"ad.context": context,
		"ad.data": map[string]any{
			"slot_version": 1,
			"encoding":     "json",
			"payload":      data,
		},
	}
	idempotencyKey := fmt.Sprintf("ad:%d:%s:%s:%s", input.ProjectID, country,
		ai_insight.DateOnly(input.StartDate), ai_insight.DateOnly(input.EndDate))
	modelID := ""
	if input.ModelID != nil {
		modelID = strings.TrimSpace(*input.ModelID)
	}
	return s.createCanonicalRunFromSlots(ctx, canonicalDomainRunInput{
		RoleID: "ad_analysis", RoleVersion: 1, ProjectID: input.ProjectID, Country: country,
		Slots: slots, IdempotencyKey: idempotencyKey, EndpointID: "default", ModelID: modelID,
		Capability: "ad_analysis", Operator: input.Operator, Meta: meta,
	})
}

func (s *AIInsightStore) CreateInventoryHealthRun(ctx context.Context, input insight_domains.InventoryHealthInput, meta ai_insight.MutationMeta) (*insight_runs.Run, bool, error) {
	projectName, err := s.lookupProjectName(ctx, input.ProjectID)
	if err != nil {
		return nil, false, err
	}
	country := strings.ToUpper(input.Country)
	anchor := time.Now().In(aiInsightShanghaiLocation())
	if input.ReportDate != nil {
		anchor = *input.ReportDate
	}
	snapshotDate, summary, rows, totalRows, err := s.loadInventorySnapshotForInsight(ctx, input.ProjectID, country, input.ReportDate)
	if err != nil {
		return nil, false, err
	}
	freshness := inventoryFreshness(snapshotDate, time.Now().In(aiInsightShanghaiLocation()))
	missingDims := make([]string, 0)
	if snapshotDate == nil {
		missingDims = append(missingDims, "snapshot")
	}
	if len(rows) == 0 {
		missingDims = append(missingDims, "skus")
	}
	if skuCount, _ := summary["sku_count"].(float64); skuCount > 0 {
		if pending, _ := summary["pending_data_count"].(float64); pending >= skuCount {
			missingDims = append(missingDims, "dms")
		}
	}
	if available, _ := summary["total_available_inventory"].(float64); available == 0 {
		missingDims = append(missingDims, "aging")
	}
	if inTransit, _ := summary["total_in_transit_quantity"].(float64); inTransit == 0 {
		missingDims = append(missingDims, "in_transit")
	}
	missing := map[string]any{
		"is_complete":        len(missingDims) == 0,
		"missing_dimensions": missingDims,
	}
	rowsTruncated := totalRows > len(rows)
	data := map[string]any{
		"project_name":         projectName,
		"country":              country,
		"report_date":          ai_insight.DateOnly(anchor),
		"snapshot_report_date": datePointerString(snapshotDate),
		"summary":              summary,
		"rows":                 rows,
		"row_total":            totalRows,
		"rows_truncated":       rowsTruncated,
		"row_limit":            200,
	}
	context := map[string]any{
		"slot_version":   1,
		"report_date":    ai_insight.DateOnly(anchor),
		"project_ids":    []int64{input.ProjectID},
		"country":        country,
		"data_freshness": freshness,
		"missing_data":   missing,
		"project_name":   projectName,
	}
	slots := map[string]any{
		"inventory.context": context,
		"inventory.data": map[string]any{
			"slot_version": 1,
			"encoding":     "json",
			"payload":      data,
		},
	}
	stamp := ai_insight.DateOnly(anchor)
	idempotencyKey := fmt.Sprintf("inventory:%d:%s:%s", input.ProjectID, country, stamp)
	modelID := ""
	if input.ModelID != nil {
		modelID = strings.TrimSpace(*input.ModelID)
	}
	return s.createCanonicalRunFromSlots(ctx, canonicalDomainRunInput{
		RoleID: "inventory_health", RoleVersion: 1, ProjectID: input.ProjectID, Country: country,
		Slots: slots, IdempotencyKey: idempotencyKey, EndpointID: "default", ModelID: modelID,
		Capability: "inventory_health", Operator: input.Operator, Meta: meta,
	})
}

type canonicalDomainRunInput struct {
	RoleID         string
	RoleVersion    int
	ProjectID      int64
	Country        string
	Slots          map[string]any
	IdempotencyKey string
	EndpointID     string
	ModelID        string
	Capability     string
	Operator       string
	Meta           ai_insight.MutationMeta
}

func (s *AIInsightStore) createCanonicalRunFromSlots(ctx context.Context, input canonicalDomainRunInput) (*insight_runs.Run, bool, error) {
	slotsJSON, err := json.Marshal(input.Slots)
	if err != nil {
		return nil, false, err
	}
	canonical := map[string]any{
		"schema_version": 1, "role_id": input.RoleID, "role_version": input.RoleVersion,
		"project_id": input.ProjectID, "country": input.Country, "slots": input.Slots,
	}
	if input.EndpointID != "" {
		canonical["endpoint_id"] = input.EndpointID
	}
	if input.ModelID != "" {
		canonical["model_id"] = input.ModelID
	}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return nil, false, err
	}
	digest := sha256.Sum256(raw)
	return s.CreateRun(ctx, insight_runs.CreateRunInput{
		RoleID: input.RoleID, RoleVersion: input.RoleVersion, ProjectID: input.ProjectID,
		Country: input.Country, Slots: input.Slots, SlotsJSON: slotsJSON,
		IdempotencyKey: input.IdempotencyKey, Fingerprint: hexSHA(digest[:]),
		EndpointID: input.EndpointID, ModelID: input.ModelID, Capability: input.Capability,
		Operator: input.Operator,
	}, input.Meta)
}

func hexSHA(raw []byte) string {
	return hex.EncodeToString(raw)
}

func (s *AIInsightStore) lookupProjectName(ctx context.Context, projectID int64) (string, error) {
	var name string
	err := s.db.QueryRow(ctx, `select project_name from public.projects where id=$1`, projectID).Scan(&name)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", insight_runs.ErrProjectNotFound
		}
		return "", err
	}
	return name, nil
}

func (s *AIInsightStore) aggregateAdSales(ctx context.Context, projectID int64, country string, start, end time.Time) ([]map[string]any, error) {
	rows, err := s.db.Query(
		ctx,
		`select f.report_date,
		        coalesce(sum(r.quantity),0)::int as order_qty,
		        coalesce(sum(case when upper(f.country) in ('DE','UK')
		          then coalesce(r.item_price,0)+coalesce(r.shipping_price,0)+coalesce(r.item_tax,0)+coalesce(r.shipping_tax,0)
		          else coalesce(r.item_price,0)+coalesce(r.shipping_price,0) end),0)::float8 as sales_amount,
		        count(distinct r.asin)::int as unique_asins
		 from public.analysis_source_files f
		 join public.analysis_sales_order_rows r on r.source_file_id=f.id
		 where f.project_id=$1 and upper(f.country)=$2 and f.report_type='sales_report'
		   and f.is_current=true and f.report_date >= $3 and f.report_date <= $4
		   and r.is_counted_sales=true
		 group by f.report_date order by f.report_date`,
		projectID, country, start, end,
	)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []map[string]any{}, nil
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var date time.Time
		var orders, asins int
		var sales float64
		if err := rows.Scan(&date, &orders, &sales, &asins); err != nil {
			return nil, err
		}
		result = append(result, map[string]any{
			"date": ai_insight.DateOnly(date), "order_qty": orders,
			"sales_amount": aiInsightRound2(sales), "unique_asins": asins,
		})
	}
	return result, rows.Err()
}

func (s *AIInsightStore) aggregateAdDaily(ctx context.Context, projectID int64, country string, start, end time.Time) ([]map[string]any, error) {
	rows, err := s.db.Query(
		ctx,
		`select f.report_date,
		        coalesce(sum(r.impressions),0)::int,
		        coalesce(sum(r.clicks),0)::int,
		        coalesce(sum(r.spend),0)::float8,
		        coalesce(sum(r.sales_7d),0)::float8,
		        coalesce(sum(r.orders_7d),0)::int
		 from public.ad_upload_files f
		 join public.ad_upload_promoted_product_rows r on r.source_file_id=f.id
		 where f.project_id=$1 and upper(f.country)=$2
		   and f.report_type='ad_promoted_product_report' and f.is_current=true
		   and f.report_date >= $3 and f.report_date <= $4
		   and r.scope_status='included_product'
		 group by f.report_date order by f.report_date`,
		projectID, country, start, end,
	)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []map[string]any{}, nil
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var date time.Time
		var impressions, clicks, orders int
		var spend, sales float64
		if err := rows.Scan(&date, &impressions, &clicks, &spend, &sales, &orders); err != nil {
			return nil, err
		}
		ctr, roas := 0.0, 0.0
		if impressions > 0 {
			ctr = aiInsightRound2(float64(clicks) / float64(impressions) * 100)
		}
		if spend > 0 {
			roas = aiInsightRound2(sales / spend)
		}
		result = append(result, map[string]any{
			"date": ai_insight.DateOnly(date), "impressions": impressions, "clicks": clicks,
			"ad_spend": aiInsightRound2(spend), "ad_sales": aiInsightRound2(sales), "ad_orders": orders,
			"ctr": ctr, "roas": roas,
		})
	}
	return result, rows.Err()
}

func (s *AIInsightStore) aggregateAdCampaigns(ctx context.Context, projectID int64, country string, start, end time.Time) ([]map[string]any, error) {
	rows, err := s.db.Query(
		ctx,
		`select coalesce(r.campaign_name,''),
		        coalesce(sum(r.impressions),0)::int,
		        coalesce(sum(r.clicks),0)::int,
		        coalesce(sum(r.spend),0)::float8,
		        coalesce(sum(r.sales_7d),0)::float8,
		        coalesce(sum(r.orders_7d),0)::int
		 from public.ad_upload_campaign_rows r
		 join public.ad_upload_files f on f.id=r.source_file_id
		 where f.project_id=$1 and upper(f.country)=$2
		   and f.report_type='ad_campaign_report' and f.is_current=true
		   and f.report_date >= $3 and f.report_date <= $4
		 group by r.campaign_name order by coalesce(sum(r.spend),0) desc limit 60`,
		projectID, country, start, end,
	)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []map[string]any{}, nil
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var campaign string
		var impressions, clicks, orders int
		var spend, sales float64
		if err := rows.Scan(&campaign, &impressions, &clicks, &spend, &sales, &orders); err != nil {
			return nil, err
		}
		result = append(result, map[string]any{
			"campaign_name": campaign, "impressions": impressions, "clicks": clicks,
			"spend": aiInsightRound2(spend), "sales": aiInsightRound2(sales), "orders": orders,
		})
	}
	return result, rows.Err()
}

func (s *AIInsightStore) topSalesSKUs(ctx context.Context, projectID int64, country string, start, end time.Time) ([]map[string]any, error) {
	rows, err := s.db.Query(
		ctx,
		`select coalesce(r.sku,''), coalesce(r.asin,''),
		        coalesce(sum(r.quantity),0)::int,
		        coalesce(sum(case when upper(f.country) in ('DE','UK')
		          then coalesce(r.item_price,0)+coalesce(r.shipping_price,0)+coalesce(r.item_tax,0)+coalesce(r.shipping_tax,0)
		          else coalesce(r.item_price,0)+coalesce(r.shipping_price,0) end),0)::float8
		 from public.analysis_source_files f
		 join public.analysis_sales_order_rows r on r.source_file_id=f.id
		 where f.project_id=$1 and upper(f.country)=$2 and f.report_type='sales_report'
		   and f.is_current=true and f.report_date >= $3 and f.report_date <= $4
		   and r.is_counted_sales=true
		 group by r.sku, r.asin
		 order by coalesce(sum(
		   case when upper(f.country) in ('DE','UK')
		     then coalesce(r.item_price,0)+coalesce(r.shipping_price,0)+coalesce(r.item_tax,0)+coalesce(r.shipping_tax,0)
		     else coalesce(r.item_price,0)+coalesce(r.shipping_price,0) end
		 ),0) desc
		 limit 50`,
		projectID, country, start, end,
	)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []map[string]any{}, nil
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var sku, asin string
		var quantity int
		var sales float64
		if err := rows.Scan(&sku, &asin, &quantity, &sales); err != nil {
			return nil, err
		}
		result = append(result, map[string]any{
			"sku": sku, "asin": asin, "order_qty": quantity,
			"sales_amount": aiInsightRound2(sales),
		})
	}
	return result, rows.Err()
}

func (s *AIInsightStore) adBreakdownPresence(ctx context.Context, projectID int64, country string, start, end time.Time) (map[string]map[string]any, error) {
	rows, err := s.db.Query(
		ctx,
		`select f.report_type, count(*)::int
		 from public.ad_upload_files f
		 where f.project_id=$1 and upper(f.country)=$2 and f.is_current=true
		   and f.report_date >= $3 and f.report_date <= $4
		 group by f.report_type`,
		projectID, country, start, end,
	)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return map[string]map[string]any{}, nil
	}
	defer rows.Close()
	result := make(map[string]map[string]any)
	for rows.Next() {
		var reportType string
		var count int
		if err := rows.Scan(&reportType, &count); err != nil {
			return nil, err
		}
		result[reportType] = map[string]any{"has_data": count > 0, "top": []any{}, "summary": map[string]any{"rows": count}}
	}
	return result, rows.Err()
}

func addSummaryTotals(target map[string]any, sales, ads []map[string]any) {
	totalSales, totalOrders, spend, adSales := 0.0, 0, 0.0, 0.0
	for _, row := range sales {
		if value, ok := row["sales_amount"].(float64); ok {
			totalSales += value
		}
		if value, ok := row["order_qty"].(int); ok {
			totalOrders += value
		}
	}
	for _, row := range ads {
		if value, ok := row["ad_spend"].(float64); ok {
			spend += value
		}
		if value, ok := row["ad_sales"].(float64); ok {
			adSales += value
		}
	}
	target["total_sales"] = aiInsightRound2(totalSales)
	target["total_orders"] = totalOrders
	target["total_ad_spend"] = aiInsightRound2(spend)
	target["total_ad_sales"] = aiInsightRound2(adSales)
}

func adFreshness(latest *time.Time, today time.Time, requestedDays int) map[string]any {
	if latest == nil {
		return map[string]any{"status": "missing", "as_of": nil, "age_days": nil, "source": "ad_reports"}
	}
	age := daysBetween(latest, today)
	asOf := ai_insight.DateOnly(*latest)
	if requestedDays <= 0 {
		return map[string]any{"status": "unknown", "as_of": asOf, "age_days": 0, "source": "ad_reports"}
	}
	status := "fresh"
	if age > 3 {
		status = "stale"
	}
	return map[string]any{"status": status, "as_of": asOf, "age_days": age, "source": "ad_reports"}
}

func inventoryFreshness(snapshot *time.Time, today time.Time) map[string]any {
	if snapshot == nil {
		return map[string]any{"status": "missing", "as_of": nil, "age_days": nil, "source": "inventory_report"}
	}
	age := daysBetween(snapshot, today)
	status := "fresh"
	if age > 1 {
		status = "stale"
	}
	return map[string]any{"status": status, "as_of": ai_insight.DateOnly(*snapshot), "age_days": age, "source": "inventory_report"}
}

func daysBetween(value *time.Time, reference time.Time) int {
	dateOnly := time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, value.Location())
	refOnly := time.Date(reference.Year(), reference.Month(), reference.Day(), 0, 0, 0, 0, reference.Location())
	days := int(refOnly.Sub(dateOnly).Hours() / 24)
	if days < 0 {
		return 0
	}
	return days
}

func appendLatestDate(series ...[]map[string]any) *time.Time {
	var latest *time.Time
	for _, rows := range series {
		for _, row := range rows {
			raw, _ := row["date"].(string)
			if raw == "" {
				continue
			}
			parsed, err := time.Parse("2006-01-02", raw)
			if err != nil {
				continue
			}
			if latest == nil || parsed.After(*latest) {
				copyValue := parsed
				latest = &copyValue
			}
		}
	}
	return latest
}

func aiInsightRound2(value float64) float64 {
	rounded := int64(value*100 + mathSign(value)*0.5)
	return float64(rounded) / 100
}

func mathSign(value float64) float64 {
	if value < 0 {
		return -1
	}
	return 1
}

func datePointerString(value *time.Time) any {
	if value == nil {
		return nil
	}
	return ai_insight.DateOnly(*value)
}

func (s *AIInsightStore) loadInventorySnapshotForInsight(ctx context.Context, projectID int64, country string, reportDate *time.Time) (*time.Time, map[string]any, []map[string]any, int, error) {
	query := `select id, snapshot_date, summary_json, row_count
		from public.inventory_replenishment_snapshots
		where project_id=$1 and upper(country)=$2`
	args := []any{projectID, country}
	if reportDate != nil {
		args = append(args, *reportDate)
		query += ` and snapshot_date <= $3`
	}
	query += ` order by is_current desc, snapshot_date desc, created_at desc limit 1`
	var snapshotID int64
	var snapshotDate time.Time
	var summaryRaw []byte
	var rowCount int
	err := s.db.QueryRow(ctx, query, args...).Scan(&snapshotID, &snapshotDate, &summaryRaw, &rowCount)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, map[string]any{}, []map[string]any{}, 0, nil
		}
		return nil, nil, nil, 0, err
	}
	summary := make(map[string]any)
	_ = json.Unmarshal(summaryRaw, &summary)
	if summary == nil {
		summary = map[string]any{}
	}
	rows, err := s.db.Query(
		ctx,
		`select i.sku, coalesce(i.asin,''), i.available_inventory, i.in_transit_quantity,
		        i.base_dms::float8, i.sellable_days::float8, i.risk_status,
		        coalesce(p.product_name,'')
		 from public.inventory_replenishment_snapshot_items i
		 left join public.product_costs p
		   on p.project_id=$2 and p.sku=i.sku and upper(p.country)=$3
		 where i.snapshot_id=$1
		 order by i.sellable_days asc nulls last, i.source_row_no asc
		 limit 200`,
		snapshotID, projectID, country,
	)
	if err != nil {
		return nil, nil, nil, 0, err
	}
	if rows == nil {
		return &snapshotDate, summary, []map[string]any{}, rowCount, nil
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var sku, asin, risk, productName string
		var available, inTransit int
		var baseDMS, sellableDays *float64
		if err := rows.Scan(&sku, &asin, &available, &inTransit, &baseDMS, &sellableDays, &risk, &productName); err != nil {
			return nil, nil, nil, 0, err
		}
		items = append(items, map[string]any{
			"sku": sku, "asin": asin, "product_name": productName,
			"available_inventory": available, "in_transit_quantity": inTransit,
			"base_dms": baseDMS, "sellable_days": sellableDays, "risk_status": risk,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, 0, err
	}
	return &snapshotDate, summary, items, rowCount, nil
}
