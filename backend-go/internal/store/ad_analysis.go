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
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_analysis"
)

type AdAnalysisStore struct {
	db FullDB
}

func NewAdAnalysisStore(db FullDB) *AdAnalysisStore {
	return &AdAnalysisStore{db: db}
}

func (s *AdAnalysisStore) VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error {
	var projOp, assistOp *string
	err := s.db.QueryRow(ctx, `
		select project_operator, assistant_operator
		from public.projects
		where id = $1 and coalesce(is_active, true) = true
	`, projectID).Scan(&projOp, &assistOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ad_analysis.ErrProjectNotFound
		}
		return err
	}
	if isAdmin {
		return nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return ad_analysis.ErrProjectForbidden
	}
	if textContainsName(projOp, operator) || textContainsName(assistOp, operator) {
		return nil
	}
	return ad_analysis.ErrProjectForbidden
}

func adSafeRatio(num, den float64) float64 {
	if den <= 0 {
		return 0
	}
	return num / den
}

func adRoundRatio(v float64) float64 {
	return math.Round(v*10000) / 10000
}

func adRoundMoney(v float64) float64 {
	return math.Round(v*100) / 100
}

func strPtr(s string) *string {
	return &s
}

func floatPtr(f float64) *float64 {
	return &f
}

func buildPreviousPeriod(dateFrom, dateTo *string) (*string, *string) {
	if dateFrom == nil || dateTo == nil {
		return nil, nil
	}
	tFrom, err1 := time.Parse("2006-01-02", *dateFrom)
	tTo, err2 := time.Parse("2006-01-02", *dateTo)
	if err1 != nil || err2 != nil || tTo.Before(tFrom) {
		return nil, nil
	}
	days := int(tTo.Sub(tFrom).Hours()/24) + 1
	prevEnd := tFrom.AddDate(0, 0, -1)
	prevStart := prevEnd.AddDate(0, 0, -(days - 1))
	pStartStr := prevStart.Format("2006-01-02")
	pEndStr := prevEnd.Format("2006-01-02")
	return &pStartStr, &pEndStr
}

func calculateComparison(
	currStart, currEnd, prevStart, prevEnd *string,
	currSpend, prevSpend float64,
	currClicks, prevClicks int,
	currSales, prevSales float64,
	currOrders, prevOrders int,
) *ad_analysis.AdAnalysisPeriodComparison {
	if currStart == nil || currEnd == nil || prevStart == nil || prevEnd == nil {
		return nil
	}
	currCPC := adSafeRatio(currSpend, float64(currClicks))
	prevCPC := adSafeRatio(prevSpend, float64(prevClicks))
	currACOS := adSafeRatio(currSpend, currSales)
	prevACOS := adSafeRatio(prevSpend, prevSales)

	var spendRatio, clicksRatio, salesRatio, ordersRatio, cpcRatio, acosRatio *float64
	if prevSpend > 0 {
		spendRatio = floatPtr(adRoundRatio((currSpend - prevSpend) / prevSpend))
	}
	if prevClicks > 0 {
		clicksRatio = floatPtr(adRoundRatio(float64(currClicks-prevClicks) / float64(prevClicks)))
	}
	if prevSales > 0 {
		salesRatio = floatPtr(adRoundRatio((currSales - prevSales) / prevSales))
	}
	if prevOrders > 0 {
		ordersRatio = floatPtr(adRoundRatio(float64(currOrders-prevOrders) / float64(prevOrders)))
	}
	if prevCPC > 0 {
		cpcRatio = floatPtr(adRoundRatio((currCPC - prevCPC) / prevCPC))
	}
	if prevACOS > 0 {
		acosRatio = floatPtr(adRoundRatio((currACOS - prevACOS) / prevACOS))
	}

	summary := "上一周期没有足够数据，当前周期先作为基准观察。"
	if spendRatio != nil {
		if *spendRatio > 0 && (salesRatio == nil || *salesRatio < *spendRatio) {
			summary = "当前周期投放规模放大，但产出增长弱于花费增长，效率承压。"
		} else if *spendRatio > 0 {
			summary = "当前周期花费和产出同步增长，整体属于扩量阶段。"
		} else if salesRatio != nil && *salesRatio >= 0 {
			summary = "当前周期在收缩花费的同时保持了产出，偏向收缩提效。"
		} else {
			summary = "当前周期规模和产出同步走弱，需要优先回看管理层与来源层。"
		}
	}

	return &ad_analysis.AdAnalysisPeriodComparison{
		CurrentStart:      currStart,
		CurrentEnd:        currEnd,
		PreviousStart:     prevStart,
		PreviousEnd:       prevEnd,
		SpendChangeRatio:  spendRatio,
		ClicksChangeRatio: clicksRatio,
		SalesChangeRatio:  salesRatio,
		OrdersChangeRatio: ordersRatio,
		CPCChangeRatio:    cpcRatio,
		ACOSChangeRatio:   acosRatio,
		Summary:           &summary,
	}
}

func gradeCampaign(orders int, acos float64, clicks int, spend float64) string {
	if orders >= 2 && (acos <= 0.25 || acos == 0) {
		return "A"
	}
	if orders >= 1 && acos <= 0.35 {
		return "B"
	}
	if clicks >= 5 && orders == 0 && spend >= 5 {
		return "D"
	}
	if acos > 0.45 {
		return "C"
	}
	return "Observe"
}

func gradeProduct(orders int, acos, ctr float64, clicks int) string {
	if orders >= 2 && (acos <= 0.25 || acos == 0) {
		return "主推"
	}
	if orders >= 1 && acos <= 0.35 {
		return "潜力"
	}
	if clicks >= 5 && orders == 0 {
		return "止损"
	}
	if ctr < 0.005 {
		return "低点击"
	}
	return "观察"
}

func classifyCrossSellAction(sales float64, orders int) string {
	if orders >= 2 || sales >= 100 {
		return "放大关联"
	}
	if orders >= 1 {
		return "继续观察"
	}
	return "暂无关联转化"
}

func classifyProductNextAction(grade string, ctr float64, clicks, orders int, crossSell string) string {
	if grade == "主推" && crossSell == "放大关联" {
		return "优先放量并强化关联承接"
	}
	if grade == "主推" || grade == "潜力" {
		return "保持放量并继续抢高质量流量"
	}
	if clicks >= 5 && orders == 0 {
		return "先查转化承接，再决定是否控量"
	}
	if ctr < 0.005 {
		return "先优化点击承接，再追加预算"
	}
	return "继续观察"
}

func classifyCampaignNextAction(grade string, budgetGap, crossSellSales float64, orders int, spend float64) string {
	if grade == "A" && budgetGap > 0 {
		return "加预算放量"
	}
	if (grade == "A" || grade == "B") && (orders > 0 || crossSellSales > 0) {
		return "稳定放量"
	}
	if grade == "D" || (orders == 0 && spend >= 10) {
		return "暂停排查"
	}
	if grade == "C" {
		return "优化控量"
	}
	return "继续观察"
}

func classifySearchTermAction(orders int, share, acos float64, clicks int) string {
	if orders >= 1 && share > 0 && share < 0.08 {
		return "提竞价争份额"
	}
	if orders >= 1 && (acos <= 0.35 || acos == 0) {
		return "加词放量"
	}
	if clicks >= 5 && orders == 0 {
		return "否词/降价"
	}
	return "继续观察"
}

func classifyTargetAction(orders int, acos float64, clicks int, ctr, topShare float64) string {
	if orders >= 1 && (acos <= 0.35 || acos == 0) {
		return "保留放量"
	}
	if clicks >= 5 && orders == 0 {
		return "降价/隔离"
	}
	if ctr >= 0.01 && topShare < 0.01 {
		return "提高首页系数"
	}
	return "持续观察"
}

func classifyBudgetAction(utilization float64, orders int, acos, spend float64) string {
	if utilization < 0.95 {
		if orders > 0 && (acos <= 0.35 || acos == 0) {
			return "优先加预算"
		}
		if spend >= 10 && orders == 0 {
			return "先优化再加预算"
		}
		return "观察预算"
	}
	return "预算充足"
}

func classifyBudgetNextStep(action string) string {
	switch action {
	case "优先加预算":
		return "今天补预算，优先保障在线时长。"
	case "先优化再加预算":
		return "先回看搜索词、入口和广告位质量，再决定是否补预算。"
	case "观察预算":
		return "先保留当前预算，继续观察转化承接。"
	default:
		return "当前不用调整预算。"
	}
}

func classifyPlacementAction(orders int, cvr, acos float64, clicks int, ctr float64) string {
	if orders >= 1 && cvr >= 0.08 && (acos <= 0.35 || acos == 0) {
		return "可提高系数"
	}
	if clicks >= 5 && orders == 0 {
		return "谨慎降价"
	}
	if ctr < 0.005 {
		return "流量偏弱"
	}
	return "持续观察"
}

func classifyPlacementNextStep(action string) string {
	switch action {
	case "可提高系数":
		return "可以提高该广告位系数，优先争取更多高质量曝光。"
	case "谨慎降价":
		return "先下调系数，避免继续在低效位置消耗。"
	case "流量偏弱":
		return "先不要抬价，回看素材和入口质量。"
	default:
		return "维持当前系数，继续看量和转化。"
	}
}

func classifyTrafficRisk(clickRate, impRate float64) string {
	if clickRate >= 0.25 || impRate >= 0.4 {
		return "高风险"
	}
	if clickRate >= 0.15 || impRate >= 0.25 {
		return "中风险"
	}
	return "正常"
}

func classifyTrafficNextAction(risk string) string {
	switch risk {
	case "高风险":
		return "先暂停排查，优先检查异常入口和异常广告位。"
	case "中风险":
		return "继续监控，并回看投放入口是否集中在低质流量。"
	default:
		return "当前无需处理，保持监控。"
	}
}

// Internal models for querying
type campaignRowData struct {
	CampaignName    string
	Status          string
	TargetingType   string
	BiddingStrategy string
	Budget          float64
	Impressions     int
	Clicks          int
	Spend           float64
	Sales7d         float64
	Orders7d        int
	ReportEndDate   string
	ID              int64
}

type budgetRowData struct {
	CampaignName          string
	Status                string
	Budget                float64
	SuggestedBudget       float64
	BudgetUtilizationRate float64
	MissedImpressionsMin  int
	MissedImpressionsMax  int
	MissedClicksMin       int
	MissedClicksMax       int
	MissedSalesMin        float64
	MissedSalesMax        float64
	Spend                 float64
	Sales7d               float64
	Orders7d              int
	ACOS                  float64
	ReportEndDate         string
	ID                    int64
}

type productRowData struct {
	CampaignName string
	AdSKU        string
	AdASIN       string
	Impressions  int
	Clicks       int
	Spend        float64
	Sales7d      float64
	Orders7d     int
	Units7d      int
	CTR          float64
	ACOS         float64
	ScopeStatus  string
}

type placementRowData struct {
	CampaignName string
	Placement    string
	Impressions  int
	Clicks       int
	Spend        float64
	Sales7d      float64
	Orders7d     int
	Units7d      int
}

type searchTermRowData struct {
	CampaignName string
	SearchTerm   string
	MatchType    string
	Impressions  int
	Clicks       int
	Spend        float64
	Sales7d      float64
	Orders7d     int
}

type searchTermShareRowData struct {
	CampaignName    string
	SearchTerm      string
	MatchType       string
	ImpressionRank  int
	ImpressionShare float64
}

type invalidTrafficRowData struct {
	CampaignName          string
	Status                string
	TotalImpressions      int
	ValidImpressions      int
	InvalidImpressions    int
	InvalidImpressionRate float64
	TotalClicks           int
	ValidClicks           int
	InvalidClicks         int
	InvalidClickRate      float64
}

type targetRowData struct {
	CampaignName             string
	TargetText               string
	MatchType                string
	Impressions              int
	Clicks                   int
	Spend                    float64
	Sales7d                  float64
	Orders7d                 int
	TopSearchImpressionShare float64
}

type timeTrendRowData struct {
	ReportStartDate string
	Clicks          int
	Spend           float64
}

type purchasedProductRowData struct {
	CampaignName     string
	AdSKU            string
	AdASIN           string
	PurchasedASIN    string
	OtherSKUUnits7d  int
	OtherSKUOrders7d int
	OtherSKUSales7d  float64
}

func (s *AdAnalysisStore) queryCampaignRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]campaignRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.status, '-'), coalesce(r.targeting_type, '-'),
		       coalesce(r.bidding_strategy, '-'), coalesce(r.budget, 0), coalesce(r.impressions, 0),
		       coalesce(r.clicks, 0), coalesce(r.spend, 0), coalesce(r.sales_7d, 0), coalesce(r.orders_7d, 0),
		       coalesce(r.report_end_date::text, ''), r.id
		from ad_upload_campaign_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_campaign_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []campaignRowData
	for rows.Next() {
		var c campaignRowData
		if err := rows.Scan(&c.CampaignName, &c.Status, &c.TargetingType, &c.BiddingStrategy, &c.Budget,
			&c.Impressions, &c.Clicks, &c.Spend, &c.Sales7d, &c.Orders7d, &c.ReportEndDate, &c.ID); err != nil {
			return nil, err
		}
		res = append(res, c)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) queryBudgetRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]budgetRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.status, '-'), coalesce(r.budget, 0),
		       coalesce(r.suggested_budget, 0), coalesce(r.budget_utilization_rate, 0),
		       coalesce(r.missed_impressions_min, 0), coalesce(r.missed_impressions_max, 0),
		       coalesce(r.missed_clicks_min, 0), coalesce(r.missed_clicks_max, 0),
		       coalesce(r.missed_sales_min, 0), coalesce(r.missed_sales_max, 0),
		       coalesce(r.spend, 0), coalesce(r.sales_7d, 0), coalesce(r.orders_7d, 0),
		       coalesce(r.acos, 0), coalesce(r.report_end_date::text, ''), r.id
		from ad_upload_budget_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_budget_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []budgetRowData
	for rows.Next() {
		var b budgetRowData
		if err := rows.Scan(&b.CampaignName, &b.Status, &b.Budget, &b.SuggestedBudget, &b.BudgetUtilizationRate,
			&b.MissedImpressionsMin, &b.MissedImpressionsMax, &b.MissedClicksMin, &b.MissedClicksMax,
			&b.MissedSalesMin, &b.MissedSalesMax, &b.Spend, &b.Sales7d, &b.Orders7d, &b.ACOS,
			&b.ReportEndDate, &b.ID); err != nil {
			return nil, err
		}
		res = append(res, b)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) queryProductRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]productRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.ad_sku, ''), coalesce(r.ad_asin, ''),
		       coalesce(r.impressions, 0), coalesce(r.clicks, 0), coalesce(r.spend, 0),
		       coalesce(r.sales_7d, 0), coalesce(r.orders_7d, 0), coalesce(r.units_7d, 0),
		       coalesce(r.ctr, 0), coalesce(r.acos, 0), coalesce(r.scope_status, 'included_product')
		from ad_upload_promoted_product_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_promoted_product_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []productRowData
	for rows.Next() {
		var p productRowData
		if err := rows.Scan(&p.CampaignName, &p.AdSKU, &p.AdASIN, &p.Impressions, &p.Clicks, &p.Spend,
			&p.Sales7d, &p.Orders7d, &p.Units7d, &p.CTR, &p.ACOS, &p.ScopeStatus); err != nil {
			return nil, err
		}
		res = append(res, p)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) queryPurchasedRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]purchasedProductRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.ad_sku, ''), coalesce(r.ad_asin, ''),
		       coalesce(r.purchased_asin, ''), coalesce(r.other_sku_units_7d, 0),
		       coalesce(r.other_sku_orders_7d, 0), coalesce(r.other_sku_sales_7d, 0)
		from ad_upload_purchased_product_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_purchased_product_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []purchasedProductRowData
	for rows.Next() {
		var r purchasedProductRowData
		if err := rows.Scan(&r.CampaignName, &r.AdSKU, &r.AdASIN, &r.PurchasedASIN, &r.OtherSKUUnits7d,
			&r.OtherSKUOrders7d, &r.OtherSKUSales7d); err != nil {
			return nil, err
		}
		res = append(res, r)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) queryTimeTrendRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]timeTrendRowData, error) {
	query := `
		select coalesce(r.report_start_date::text, ''), coalesce(r.clicks, 0), coalesce(r.spend, 0)
		from ad_upload_time_trend_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_time_trend_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []timeTrendRowData
	for rows.Next() {
		var t timeTrendRowData
		if err := rows.Scan(&t.ReportStartDate, &t.Clicks, &t.Spend); err != nil {
			return nil, err
		}
		res = append(res, t)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) querySearchTermRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]searchTermRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.search_term, ''), coalesce(r.match_type, ''),
		       coalesce(r.impressions, 0), coalesce(r.clicks, 0), coalesce(r.spend, 0),
		       coalesce(r.sales_7d, 0), coalesce(r.orders_7d, 0)
		from ad_upload_search_term_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_search_term_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []searchTermRowData
	for rows.Next() {
		var st searchTermRowData
		if err := rows.Scan(&st.CampaignName, &st.SearchTerm, &st.MatchType, &st.Impressions, &st.Clicks,
			&st.Spend, &st.Sales7d, &st.Orders7d); err != nil {
			return nil, err
		}
		res = append(res, st)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) querySearchTermShareRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]searchTermShareRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.search_term, ''), coalesce(r.match_type, ''),
		       coalesce(r.impression_rank, 0), coalesce(r.impression_share, 0)
		from ad_upload_search_term_share_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_search_term_share_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []searchTermShareRowData
	for rows.Next() {
		var sh searchTermShareRowData
		if err := rows.Scan(&sh.CampaignName, &sh.SearchTerm, &sh.MatchType, &sh.ImpressionRank, &sh.ImpressionShare); err != nil {
			return nil, err
		}
		res = append(res, sh)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) queryPlacementRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]placementRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.placement, ''), coalesce(r.impressions, 0),
		       coalesce(r.clicks, 0), coalesce(r.spend, 0), coalesce(r.sales_7d, 0),
		       coalesce(r.orders_7d, 0), coalesce(r.units_7d, 0)
		from ad_upload_placement_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_placement_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []placementRowData
	for rows.Next() {
		var pl placementRowData
		if err := rows.Scan(&pl.CampaignName, &pl.Placement, &pl.Impressions, &pl.Clicks, &pl.Spend,
			&pl.Sales7d, &pl.Orders7d, &pl.Units7d); err != nil {
			return nil, err
		}
		res = append(res, pl)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) queryInvalidTrafficRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]invalidTrafficRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.status, '-'), coalesce(r.total_impressions, 0),
		       coalesce(r.valid_impressions, 0), coalesce(r.invalid_impressions, 0),
		       coalesce(r.invalid_impression_rate, 0), coalesce(r.total_clicks, 0),
		       coalesce(r.valid_clicks, 0), coalesce(r.invalid_clicks, 0), coalesce(r.invalid_click_rate, 0)
		from ad_upload_invalid_traffic_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_invalid_traffic_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []invalidTrafficRowData
	for rows.Next() {
		var iv invalidTrafficRowData
		if err := rows.Scan(&iv.CampaignName, &iv.Status, &iv.TotalImpressions, &iv.ValidImpressions,
			&iv.InvalidImpressions, &iv.InvalidImpressionRate, &iv.TotalClicks, &iv.ValidClicks,
			&iv.InvalidClicks, &iv.InvalidClickRate); err != nil {
			return nil, err
		}
		res = append(res, iv)
	}
	return res, rows.Err()
}

func (s *AdAnalysisStore) queryTargetRows(ctx context.Context, projectID int64, country string, dateFrom, dateTo *string) ([]targetRowData, error) {
	query := `
		select coalesce(r.campaign_name, ''), coalesce(r.target_text, ''), coalesce(r.match_type, ''),
		       coalesce(r.impressions, 0), coalesce(r.clicks, 0), coalesce(r.spend, 0),
		       coalesce(r.sales_7d, 0), coalesce(r.orders_7d, 0), coalesce(r.top_of_search_impression_share, 0)
		from ad_upload_target_rows r
		join ad_upload_files f on r.source_file_id = f.id
		where f.project_id = $1 and f.country = $2 and f.report_type = 'ad_target_report' and f.is_current = true
	`
	args := []any{projectID, country}
	if dateFrom != nil {
		args = append(args, *dateFrom)
		query += fmt.Sprintf(" and f.report_date >= $%d", len(args))
	}
	if dateTo != nil {
		args = append(args, *dateTo)
		query += fmt.Sprintf(" and f.report_date <= $%d", len(args))
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return nil, nil
	}

	var res []targetRowData
	for rows.Next() {
		var tr targetRowData
		if err := rows.Scan(&tr.CampaignName, &tr.TargetText, &tr.MatchType, &tr.Impressions, &tr.Clicks,
			&tr.Spend, &tr.Sales7d, &tr.Orders7d, &tr.TopSearchImpressionShare); err != nil {
			return nil, err
		}
		res = append(res, tr)
	}
	return res, rows.Err()
}

func buildTrendSummary(rows []timeTrendRowData) []map[string]any {
	type dayBucket struct {
		clicks int
		spend  float64
	}
	grouped := make(map[string]*dayBucket)
	for _, row := range rows {
		dateKey := row.ReportStartDate
		if dateKey == "" {
			continue
		}
		b, ok := grouped[dateKey]
		if !ok {
			b = &dayBucket{}
			grouped[dateKey] = b
		}
		b.clicks += row.Clicks
		b.spend += row.Spend
	}
	dates := make([]string, 0, len(grouped))
	for d := range grouped {
		dates = append(dates, d)
	}
	sort.Strings(dates)

	var res []map[string]any
	var runningSpend, prevSpend float64
	for _, d := range dates {
		b := grouped[d]
		runningSpend += b.spend
		cpc := adSafeRatio(b.spend, float64(b.clicks))
		var spendChangeRatio float64
		if prevSpend > 0 {
			spendChangeRatio = adRoundRatio((b.spend - prevSpend) / prevSpend)
		}
		res = append(res, map[string]any{
			"report_date":        d,
			"clicks":             b.clicks,
			"spend":              adRoundMoney(b.spend),
			"cpc":                adRoundMoney(cpc),
			"running_spend":      adRoundMoney(runningSpend),
			"spend_change_ratio": spendChangeRatio,
		})
		prevSpend = b.spend
	}
	return res
}

func (s *AdAnalysisStore) BuildOverview(ctx context.Context, filter ad_analysis.BaseFilter) (*ad_analysis.AdAnalysisOverviewResponse, error) {
	prevFrom, prevTo := buildPreviousPeriod(filter.DateFrom, filter.DateTo)

	campaignRows, err := s.queryCampaignRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	budgetRows, err := s.queryBudgetRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	productRows, err := s.queryProductRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	placementRows, err := s.queryPlacementRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	searchRows, err := s.querySearchTermRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	invalidTrafficRows, err := s.queryInvalidTrafficRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	timeTrendRows, err := s.queryTimeTrendRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	purchasedRows, err := s.queryPurchasedRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	var prevCampaignRows []campaignRowData
	if prevFrom != nil && prevTo != nil {
		prevCampaignRows, _ = s.queryCampaignRows(ctx, filter.ProjectID, filter.Country, prevFrom, prevTo)
	}

	trendSummary := buildTrendSummary(timeTrendRows)

	var totalImpressions, totalClicks, totalOrders int
	var totalSpend, totalSales float64
	for _, r := range campaignRows {
		totalImpressions += r.Impressions
		totalClicks += r.Clicks
		totalOrders += r.Orders7d
		totalSpend += r.Spend
		totalSales += r.Sales7d
	}

	var prevClicks, prevOrders int
	var prevSpend, prevSales float64
	for _, r := range prevCampaignRows {
		prevClicks += r.Clicks
		prevOrders += r.Orders7d
		prevSpend += r.Spend
		prevSales += r.Sales7d
	}

	var totalCrossSellSales float64
	var totalCrossSellOrders int
	type crossKey struct {
		asin string
		sku  string
	}
	crossGrouped := make(map[crossKey]*struct {
		units  int
		orders int
		sales  float64
	})
	for _, r := range purchasedRows {
		k := crossKey{asin: r.PurchasedASIN, sku: r.AdSKU}
		b, ok := crossGrouped[k]
		if !ok {
			b = &struct {
				units  int
				orders int
				sales  float64
			}{}
			crossGrouped[k] = b
		}
		b.units += r.OtherSKUUnits7d
		b.orders += r.OtherSKUOrders7d
		b.sales += r.OtherSKUSales7d
		totalCrossSellSales += r.OtherSKUSales7d
		totalCrossSellOrders += r.OtherSKUOrders7d
	}

	ctr := adSafeRatio(float64(totalClicks), float64(totalImpressions))
	cpc := adSafeRatio(totalSpend, float64(totalClicks))
	acos := adSafeRatio(totalSpend, totalSales)
	roas := adSafeRatio(totalSales, totalSpend)

	comparison := calculateComparison(
		filter.DateFrom, filter.DateTo,
		prevFrom, prevTo,
		totalSpend, prevSpend,
		totalClicks, prevClicks,
		totalSales, prevSales,
		totalOrders, prevOrders,
	)

	var issueCards []ad_analysis.AdAnalysisIssueCard
	if totalClicks > 0 && totalOrders == 0 && totalSpend >= 10 {
		issueCards = append(issueCards, ad_analysis.AdAnalysisIssueCard{
			Title:    "高花费无单",
			Level:    "high",
			Summary:  "当前汇总层出现明显点击消耗，但还没有形成订单转化。",
			DrillTo:  strPtr("campaigns"),
			NextStep: strPtr("先下钻活动页，收紧高花费无单活动，再联动搜索词排查浪费点。"),
		})
	}
	if totalImpressions > 0 && ctr < 0.005 {
		issueCards = append(issueCards, ad_analysis.AdAnalysisIssueCard{
			Title:    "点击率偏低",
			Level:    "medium",
			Summary:  "当前 CTR 偏低，建议优先检查广告位、主图和关键词精准度。",
			DrillTo:  strPtr("placements"),
			NextStep: strPtr("先看广告位和投放入口，再决定是调 placement 还是回到素材与词路。"),
		})
	}

	var budgetLimitedCount int
	for _, r := range budgetRows {
		if r.BudgetUtilizationRate < 0.95 && (r.Orders7d > 0 || r.Sales7d > 0) {
			budgetLimitedCount++
		}
	}
	if budgetLimitedCount > 0 {
		issueCards = append(issueCards, ad_analysis.AdAnalysisIssueCard{
			Title:    "存在预算受限活动",
			Level:    "medium",
			Summary:  fmt.Sprintf("当前识别到 %d 个有单或有销售额但预算在线时间不足的活动。", budgetLimitedCount),
			DrillTo:  strPtr("budget"),
			NextStep: strPtr("进入预算页，优先处理有订单或有关联销售的预算缺口活动。"),
		})
	}

	var wasteTermsCount int
	for _, r := range searchRows {
		if r.Clicks >= 3 && r.Orders7d == 0 {
			wasteTermsCount++
		}
	}
	if wasteTermsCount > 0 {
		issueCards = append(issueCards, ad_analysis.AdAnalysisIssueCard{
			Title:    "存在浪费搜索词",
			Level:    "medium",
			Summary:  fmt.Sprintf("当前识别到 %d 个达到观察门槛但未出单的搜索词。", wasteTermsCount),
			DrillTo:  strPtr("search-terms"),
			NextStep: strPtr("进入搜索词页，优先处理达到否词或降价门槛的词。"),
		})
	}

	var highRiskTrafficCount int
	for _, r := range invalidTrafficRows {
		if r.InvalidClickRate >= 0.2 || r.InvalidImpressionRate >= 0.35 {
			highRiskTrafficCount++
		}
	}
	if highRiskTrafficCount > 0 {
		issueCards = append(issueCards, ad_analysis.AdAnalysisIssueCard{
			Title:    "流量质量异常",
			Level:    "high",
			Summary:  fmt.Sprintf("当前识别到 %d 个无效流量偏高的活动，建议优先排查异常入口。", highRiskTrafficCount),
			DrillTo:  strPtr("traffic-quality"),
			NextStep: strPtr("先定位异常活动，再回到投放入口和广告位检查是否有异常流量来源。"),
		})
	}

	var weakPlacementCount int
	for _, r := range placementRows {
		if r.Clicks >= 3 && r.Orders7d == 0 && r.Spend >= 3 {
			weakPlacementCount++
		}
	}
	if weakPlacementCount > 0 {
		issueCards = append(issueCards, ad_analysis.AdAnalysisIssueCard{
			Title:    "存在低效广告位",
			Level:    "medium",
			Summary:  fmt.Sprintf("当前识别到 %d 条高点击未出单的广告位明细，建议结合广告位页下钻。", weakPlacementCount),
			DrillTo:  strPtr("placements"),
			NextStep: strPtr("进入广告位页，优先下调高点击无单的位置系数。"),
		})
	}

	var topCampaigns []map[string]any
	sort.Slice(campaignRows, func(i, j int) bool {
		if campaignRows[i].Spend != campaignRows[j].Spend {
			return campaignRows[i].Spend > campaignRows[j].Spend
		}
		return campaignRows[i].Sales7d > campaignRows[j].Sales7d
	})
	for i := 0; i < len(campaignRows) && i < 5; i++ {
		c := campaignRows[i]
		cSpend := adRoundMoney(c.Spend)
		cSales := adRoundMoney(c.Sales7d)
		cACOS := adRoundRatio(adSafeRatio(c.Spend, c.Sales7d))
		topCampaigns = append(topCampaigns, map[string]any{
			"campaign_name": c.CampaignName,
			"spend":         cSpend,
			"sales_7d":      cSales,
			"orders_7d":     c.Orders7d,
			"acos":          cACOS,
		})
	}

	var topProducts []map[string]any
	sort.Slice(productRows, func(i, j int) bool {
		if productRows[i].Spend != productRows[j].Spend {
			return productRows[i].Spend > productRows[j].Spend
		}
		return productRows[i].Sales7d > productRows[j].Sales7d
	})
	for i := 0; i < len(productRows) && i < 5; i++ {
		p := productRows[i]
		pACOS := adRoundRatio(adSafeRatio(p.Spend, p.Sales7d))
		topProducts = append(topProducts, map[string]any{
			"ad_sku":    p.AdSKU,
			"ad_asin":   p.AdASIN,
			"spend":     adRoundMoney(p.Spend),
			"sales_7d":  adRoundMoney(p.Sales7d),
			"orders_7d": p.Orders7d,
			"acos":      pACOS,
		})
	}

	var wasteTerms []map[string]any
	for _, r := range searchRows {
		if r.Clicks >= 3 && r.Orders7d == 0 {
			wasteTerms = append(wasteTerms, map[string]any{
				"search_term":   r.SearchTerm,
				"campaign_name": r.CampaignName,
				"clicks":        r.Clicks,
				"spend":         adRoundMoney(r.Spend),
				"orders_7d":     r.Orders7d,
			})
		}
	}
	sort.Slice(wasteTerms, func(i, j int) bool {
		sI := wasteTerms[i]["spend"].(float64)
		sJ := wasteTerms[j]["spend"].(float64)
		if sI != sJ {
			return sI > sJ
		}
		return wasteTerms[i]["clicks"].(int) > wasteTerms[j]["clicks"].(int)
	})
	var topWasteTerms []map[string]any
	for i := 0; i < len(wasteTerms) && i < 5; i++ {
		topWasteTerms = append(topWasteTerms, wasteTerms[i])
	}

	var crossSellItems []map[string]any
	for k, b := range crossGrouped {
		crossSellItems = append(crossSellItems, map[string]any{
			"purchased_asin":      k.asin,
			"ad_sku":              k.sku,
			"other_sku_units_7d":  b.units,
			"other_sku_orders_7d": b.orders,
			"other_sku_sales_7d":  adRoundMoney(b.sales),
			"action":              classifyCrossSellAction(b.sales, b.orders),
		})
	}
	sort.Slice(crossSellItems, func(i, j int) bool {
		sI := crossSellItems[i]["other_sku_sales_7d"].(float64)
		sJ := crossSellItems[j]["other_sku_sales_7d"].(float64)
		return sI > sJ
	})
	var topCrossSellProducts []map[string]any
	for i := 0; i < len(crossSellItems) && i < 5; i++ {
		topCrossSellProducts = append(topCrossSellProducts, crossSellItems[i])
	}

	// Narrative sections
	scaleOrEfficiencySummary := "当前广告整体"
	scaleEvidence := []string{
		fmt.Sprintf("花费 %.2f 美元，销售额 %.2f 美元，订单 %d 单。", adRoundMoney(totalSpend), adRoundMoney(totalSales), totalOrders),
		fmt.Sprintf("CTR %.2f%%，CPC %.2f 美元，ACOS %.2f%%。", adRoundRatio(ctr)*100, adRoundMoney(cpc), adRoundRatio(acos)*100),
	}
	if totalSales > 0 && acos <= 0.35 {
		scaleOrEfficiencySummary += "处于可放量区间，效率仍在可控范围内。"
	} else if totalSales > 0 {
		scaleOrEfficiencySummary += "仍有产出，但效率承压，需要先控浪费再扩量。"
	} else if totalSpend > 0 {
		scaleOrEfficiencySummary += "已有消耗但产出不足，当前更像是控损阶段。"
	} else {
		scaleOrEfficiencySummary += "尚未形成有效投放规模。"
	}
	if len(topCampaigns) > 0 {
		scaleEvidence = append(scaleEvidence, fmt.Sprintf("当前高消耗活动是 %s，花费 %.2f 美元。", topCampaigns[0]["campaign_name"], topCampaigns[0]["spend"].(float64)))
	}
	if comparison != nil && comparison.Summary != nil && *comparison.Summary != "" {
		scaleOrEfficiencySummary += " " + *comparison.Summary
	}

	narrativeSections := []ad_analysis.AdAnalysisNarrativeSection{
		{
			Title:    "总体结论",
			Summary:  scaleOrEfficiencySummary,
			Evidence: scaleEvidence,
			Action:   strPtr("先确认整体是在放量提效还是放量失效，再决定往活动还是承接层继续下钻。"),
			DrillTo:  strPtr("campaigns"),
		},
		{
			Title:    "管理层归因",
			Summary:  "管理运营层目前没有出现明显的预算、广告位或流量质量异常。",
			Evidence: []string{"预算、广告位、流量质量三层目前都没有触发明显异常信号。"},
			Action:   strPtr("保持当前活动结构，继续观察趋势和核心活动。"),
			DrillTo:  strPtr("campaigns"),
		},
		{
			Title:    "来源层归因",
			Summary:  "来源层暂时没有明显的浪费词集中问题。",
			Evidence: []string{"当前搜索词层没有出现集中性的高花费无单词。"},
			Action:   strPtr("继续观察搜索词结构，重点看新词与高份额缺口词。"),
			DrillTo:  strPtr("search-terms"),
		},
		{
			Title:    "承接层归因",
			Summary:  "商品承接层暂时没有形成强烈异常，流量与成交大体匹配。",
			Evidence: []string{"推广商品和已购买商品层暂时没有出现明显承接异常。"},
			Action:   strPtr("继续观察高消耗 SKU 的点击与转化，确认是否需要做素材或页面优化。"),
			DrillTo:  strPtr("products"),
		},
	}

	helperSpend := "广告总花费"
	helperSales := "7天销售额"
	helperOrders := "7天订单数"
	helperCTR := "点击率"
	helperCPC := "单次点击成本"
	helperACOS := "广告投入产出比"
	helperROAS := "广告投资回报率"
	helperTrend := "当前筛选范围内已入库的趋势天数"
	helperCross := fmt.Sprintf("关联购买销售额 / 订单 %d", totalCrossSellOrders)

	metrics := []ad_analysis.AdAnalysisMetricCard{
		{Label: "Spend", Value: adRoundMoney(totalSpend), DisplayValue: fmt.Sprintf("$%.2f", adRoundMoney(totalSpend)), Helper: &helperSpend},
		{Label: "Sales 7d", Value: adRoundMoney(totalSales), DisplayValue: fmt.Sprintf("$%.2f", adRoundMoney(totalSales)), Helper: &helperSales},
		{Label: "Orders 7d", Value: float64(totalOrders), DisplayValue: fmt.Sprintf("%d", totalOrders), Helper: &helperOrders},
		{Label: "CTR", Value: adRoundRatio(ctr), DisplayValue: fmt.Sprintf("%.2f%%", adRoundRatio(ctr)*100), Helper: &helperCTR},
		{Label: "CPC", Value: adRoundMoney(cpc), DisplayValue: fmt.Sprintf("$%.2f", adRoundMoney(cpc)), Helper: &helperCPC},
		{Label: "ACOS", Value: adRoundRatio(acos), DisplayValue: fmt.Sprintf("%.2f%%", adRoundRatio(acos)*100), Helper: &helperACOS},
		{Label: "ROAS", Value: adRoundRatio(roas), DisplayValue: fmt.Sprintf("%.2f", adRoundRatio(roas)), Helper: &helperROAS},
		{Label: "Trend Days", Value: float64(len(trendSummary)), DisplayValue: fmt.Sprintf("%d", len(trendSummary)), Helper: &helperTrend},
		{Label: "Cross-sell Sales 7d", Value: adRoundMoney(totalCrossSellSales), DisplayValue: fmt.Sprintf("$%.2f", adRoundMoney(totalCrossSellSales)), Helper: &helperCross},
	}

	trendSummarySlice := trendSummary
	if len(trendSummarySlice) > 7 {
		trendSummarySlice = trendSummarySlice[len(trendSummarySlice)-7:]
	}
	if issueCards == nil {
		issueCards = []ad_analysis.AdAnalysisIssueCard{}
	}
	if topCampaigns == nil {
		topCampaigns = []map[string]any{}
	}
	if topProducts == nil {
		topProducts = []map[string]any{}
	}
	if topWasteTerms == nil {
		topWasteTerms = []map[string]any{}
	}
	if trendSummarySlice == nil {
		trendSummarySlice = []map[string]any{}
	}
	if topCrossSellProducts == nil {
		topCrossSellProducts = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisOverviewResponse{
		ProjectID:            filter.ProjectID,
		Country:              filter.Country,
		Metrics:              metrics,
		IssueCards:           issueCards,
		NarrativeSections:    narrativeSections,
		Comparison:           comparison,
		TopCampaigns:         topCampaigns,
		TopProducts:          topProducts,
		TopWasteTerms:        topWasteTerms,
		TrendSummary:         trendSummarySlice,
		TopCrossSellProducts: topCrossSellProducts,
	}, nil
}

func (s *AdAnalysisStore) BuildCampaigns(ctx context.Context, filter ad_analysis.CampaignsFilter) (*ad_analysis.AdAnalysisCampaignsResponse, error) {
	rows, err := s.queryCampaignRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	budgetRows, err := s.queryBudgetRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	purchasedRows, err := s.queryPurchasedRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	budgetMap := make(map[string]struct {
		gap         float64
		utilization float64
		missedSales float64
	})
	for _, b := range budgetRows {
		cName := b.CampaignName
		gap := math.Max(b.SuggestedBudget-b.Budget, 0)
		budgetMap[cName] = struct {
			gap         float64
			utilization float64
			missedSales float64
		}{
			gap:         adRoundMoney(gap),
			utilization: adRoundRatio(b.BudgetUtilizationRate),
			missedSales: adRoundMoney(b.MissedSalesMax),
		}
	}

	crossSellMap := make(map[string]struct {
		orders int
		sales  float64
		action string
	})
	for _, p := range purchasedRows {
		cName := p.CampaignName
		cur := crossSellMap[cName]
		cur.orders += p.OtherSKUOrders7d
		cur.sales += p.OtherSKUSales7d
		cur.action = classifyCrossSellAction(cur.sales, cur.orders)
		crossSellMap[cName] = cur
	}

	type campBucket struct {
		name            string
		status          string
		targetingType   string
		biddingStrategy string
		budget          float64
		impressions     int
		clicks          int
		spend           float64
		sales           float64
		orders          int
	}
	grouped := make(map[string]*campBucket)
	for _, r := range rows {
		if filter.Campaign != nil && *filter.Campaign != "" && !strings.EqualFold(r.CampaignName, *filter.Campaign) {
			continue
		}
		b, ok := grouped[r.CampaignName]
		if !ok {
			b = &campBucket{
				name:            r.CampaignName,
				status:          r.Status,
				targetingType:   r.TargetingType,
				biddingStrategy: r.BiddingStrategy,
				budget:          r.Budget,
			}
			grouped[r.CampaignName] = b
		}
		b.impressions += r.Impressions
		b.clicks += r.Clicks
		b.spend += r.Spend
		b.sales += r.Sales7d
		b.orders += r.Orders7d
	}

	var items []map[string]any
	for _, b := range grouped {
		ctr := adSafeRatio(float64(b.clicks), float64(b.impressions))
		cpc := adSafeRatio(b.spend, float64(b.clicks))
		acos := adSafeRatio(b.spend, b.sales)
		roas := adSafeRatio(b.sales, b.spend)
		grade := gradeCampaign(b.orders, acos, b.clicks, b.spend)

		bInfo := budgetMap[b.name]
		crossInfo := crossSellMap[b.name]
		if crossInfo.action == "" {
			crossInfo.action = "暂无关联转化"
		}

		nextAction := classifyCampaignNextAction(grade, bInfo.gap, crossInfo.sales, b.orders, b.spend)

		items = append(items, map[string]any{
			"campaign_name":           b.name,
			"status":                  b.status,
			"targeting_type":          b.targetingType,
			"bidding_strategy":        b.biddingStrategy,
			"budget":                  adRoundMoney(b.budget),
			"impressions":             b.impressions,
			"clicks":                  b.clicks,
			"ctr":                     adRoundRatio(ctr),
			"cpc":                     adRoundMoney(cpc),
			"spend":                   adRoundMoney(b.spend),
			"sales_7d":                adRoundMoney(b.sales),
			"orders_7d":               b.orders,
			"acos":                    adRoundRatio(acos),
			"roas":                    adRoundRatio(roas),
			"grade":                   grade,
			"budget_gap":              bInfo.gap,
			"budget_utilization_rate": bInfo.utilization,
			"missed_sales_max":        bInfo.missedSales,
			"cross_sell_orders_7d":    crossInfo.orders,
			"cross_sell_sales_7d":     adRoundMoney(crossInfo.sales),
			"cross_sell_action":       crossInfo.action,
			"next_action":             nextAction,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		sI := items[i]["spend"].(float64)
		sJ := items[j]["spend"].(float64)
		if sI != sJ {
			return sI > sJ
		}
		return items[i]["sales_7d"].(float64) > items[j]["sales_7d"].(float64)
	})

	highGradeCount := 0
	budgetCandidateCount := 0
	crossSellWinnerCount := 0
	for _, item := range items {
		g := item["grade"].(string)
		if g == "A" || g == "B" {
			highGradeCount++
		}
		if item["budget_gap"].(float64) > 0 && (item["orders_7d"].(int) > 0 || item["cross_sell_sales_7d"].(float64) > 0) {
			budgetCandidateCount++
		}
		if item["cross_sell_action"].(string) == "放大关联" {
			crossSellWinnerCount++
		}
	}

	summaryCards := []map[string]any{
		{"label": "活动数", "value": fmt.Sprintf("%d", len(items)), "helper": "当前筛选条件下的活动数量"},
		{"label": "A/B 活动", "value": fmt.Sprintf("%d", highGradeCount), "helper": "达到稳定放量或持续观察标准的活动"},
		{"label": "预算候选", "value": fmt.Sprintf("%d", budgetCandidateCount), "helper": "有预算缺口且仍有产出空间的活动"},
		{"label": "关联放量", "value": fmt.Sprintf("%d", crossSellWinnerCount), "helper": "带动其他商品成交的活动"},
	}

	narratives := []ad_analysis.AdAnalysisNarrativeSection{
		{
			Title:    "活动层结论",
			Summary:  "当前活动层以稳定放量为主。",
			Evidence: []string{fmt.Sprintf("当前共有 %d 个活动，其中 A/B 级活动 %d 个。", len(items), highGradeCount)},
			Action:   strPtr("先保住 A/B 级活动的量，再把 C/D 级活动拉回活动、搜索词、广告位逐层控浪费。"),
			DrillTo:  strPtr("campaigns"),
		},
		{
			Title:    "预算归因",
			Summary:  "活动层当前没有明显预算承接间隔，预算不是首要矛盾。",
			Evidence: []string{"当前高质量活动没有出现明显预算不足信号。"},
			Action:   strPtr("预算只优先给有单且 ACOS 可控的活动，其他活动先优化词路和入口。"),
			DrillTo:  strPtr("budget"),
		},
	}

	if items == nil {
		items = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisCampaignsResponse{
		ProjectID:         filter.ProjectID,
		Country:           filter.Country,
		SummaryCards:      summaryCards,
		NarrativeSections: narratives,
		Items:             items,
	}, nil
}

func (s *AdAnalysisStore) BuildProducts(ctx context.Context, filter ad_analysis.ProductsFilter) (*ad_analysis.AdAnalysisProductsResponse, error) {
	rows, err := s.queryProductRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	purchasedRows, err := s.queryPurchasedRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	type crossKey struct {
		sku  string
		asin string
	}
	crossMap := make(map[crossKey]struct {
		asinCount int
		orders    int
		sales     float64
		topAsin   string
		action    string
	})
	for _, p := range purchasedRows {
		k := crossKey{sku: p.AdSKU, asin: p.AdASIN}
		cur := crossMap[k]
		cur.orders += p.OtherSKUOrders7d
		cur.sales += p.OtherSKUSales7d
		if cur.topAsin == "" {
			cur.topAsin = p.PurchasedASIN
		}
		cur.action = classifyCrossSellAction(cur.sales, cur.orders)
		crossMap[k] = cur
	}

	type prodBucket struct {
		sku         string
		asin        string
		campaigns   map[string]bool
		impressions int
		clicks      int
		spend       float64
		sales       float64
		orders      int
		units       int
	}
	grouped := make(map[crossKey]*prodBucket)
	for _, r := range rows {
		if filter.Campaign != nil && *filter.Campaign != "" && !strings.EqualFold(r.CampaignName, *filter.Campaign) {
			continue
		}
		if filter.SKU != nil && *filter.SKU != "" && !strings.EqualFold(r.AdSKU, *filter.SKU) {
			continue
		}
		k := crossKey{sku: r.AdSKU, asin: r.AdASIN}
		b, ok := grouped[k]
		if !ok {
			b = &prodBucket{
				sku:       r.AdSKU,
				asin:      r.AdASIN,
				campaigns: make(map[string]bool),
			}
			grouped[k] = b
		}
		b.campaigns[r.CampaignName] = true
		b.impressions += r.Impressions
		b.clicks += r.Clicks
		b.spend += r.Spend
		b.sales += r.Sales7d
		b.orders += r.Orders7d
		b.units += r.Units7d
	}

	var items []map[string]any
	highGradeCount := 0
	crossSellWinnerCount := 0
	var totalCrossSellSales float64

	for k, b := range grouped {
		ctr := adSafeRatio(float64(b.clicks), float64(b.impressions))
		cpc := adSafeRatio(b.spend, float64(b.clicks))
		acos := adSafeRatio(b.spend, b.sales)
		cvr := adSafeRatio(float64(b.orders), float64(b.clicks))
		grade := gradeProduct(b.orders, acos, ctr, b.clicks)

		if grade == "主推" || grade == "潜力" {
			highGradeCount++
		}

		cInfo := crossMap[k]
		if cInfo.action == "" {
			cInfo.action = "暂无关联转化"
			cInfo.topAsin = "-"
		}
		if cInfo.action == "放大关联" {
			crossSellWinnerCount++
		}
		totalCrossSellSales += cInfo.sales

		nextAction := classifyProductNextAction(grade, ctr, b.clicks, b.orders, cInfo.action)

		primaryCamp := "-"
		for c := range b.campaigns {
			primaryCamp = c
			break
		}

		items = append(items, map[string]any{
			"ad_sku":                b.sku,
			"ad_asin":               b.asin,
			"campaign_count":        len(b.campaigns),
			"primary_campaign":      primaryCamp,
			"impressions":           b.impressions,
			"clicks":                b.clicks,
			"ctr":                   adRoundRatio(ctr),
			"cpc":                   adRoundMoney(cpc),
			"spend":                 adRoundMoney(b.spend),
			"sales_7d":              adRoundMoney(b.sales),
			"orders_7d":             b.orders,
			"units_7d":              b.units,
			"cvr_7d":                adRoundRatio(cvr),
			"acos":                  adRoundRatio(acos),
			"grade":                 grade,
			"cross_sell_asin_count": cInfo.asinCount,
			"cross_sell_orders_7d":  cInfo.orders,
			"cross_sell_sales_7d":   adRoundMoney(cInfo.sales),
			"top_purchased_asin":    cInfo.topAsin,
			"cross_sell_action":     cInfo.action,
			"next_action":           nextAction,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		sI := items[i]["spend"].(float64)
		sJ := items[j]["spend"].(float64)
		if sI != sJ {
			return sI > sJ
		}
		return items[i]["sales_7d"].(float64) > items[j]["sales_7d"].(float64)
	})

	summaryCards := []map[string]any{
		{"label": "SKU 数", "value": fmt.Sprintf("%d", len(items)), "helper": "当前筛选条件下的广告 SKU"},
		{"label": "主推/潜力", "value": fmt.Sprintf("%d", highGradeCount), "helper": "值得继续放量的 SKU 数量"},
		{"label": "关联销售额", "value": fmt.Sprintf("$%.2f", adRoundMoney(totalCrossSellSales)), "helper": "来自已购买商品报表的其他 SKU 销售额"},
		{"label": "关联放大量", "value": fmt.Sprintf("%d", crossSellWinnerCount), "helper": "存在明显交叉销售贡献的 SKU"},
	}

	if items == nil {
		items = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisProductsResponse{
		ProjectID:    filter.ProjectID,
		Country:      filter.Country,
		SummaryCards: summaryCards,
		Items:        items,
	}, nil
}

func (s *AdAnalysisStore) BuildTimeTrend(ctx context.Context, filter ad_analysis.BaseFilter) (*ad_analysis.AdAnalysisTimeTrendResponse, error) {
	prevFrom, prevTo := buildPreviousPeriod(filter.DateFrom, filter.DateTo)
	rows, err := s.queryTimeTrendRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	var prevRows []timeTrendRowData
	if prevFrom != nil && prevTo != nil {
		prevRows, _ = s.queryTimeTrendRows(ctx, filter.ProjectID, filter.Country, prevFrom, prevTo)
	}

	summary := buildTrendSummary(rows)
	var currSpend, prevSpend float64
	var currClicks, prevClicks int
	for _, r := range rows {
		currSpend += r.Spend
		currClicks += r.Clicks
	}
	for _, r := range prevRows {
		prevSpend += r.Spend
		prevClicks += r.Clicks
	}

	comparison := calculateComparison(
		filter.DateFrom, filter.DateTo,
		prevFrom, prevTo,
		currSpend, prevSpend,
		currClicks, prevClicks,
		0, 0,
		0, 0,
	)

	if summary == nil {
		summary = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisTimeTrendResponse{
		ProjectID:  filter.ProjectID,
		Country:    filter.Country,
		Summary:    summary,
		Comparison: comparison,
	}, nil
}

func (s *AdAnalysisStore) BuildPurchasedProducts(ctx context.Context, filter ad_analysis.PurchasedProductsFilter) (*ad_analysis.AdAnalysisPurchasedProductsResponse, error) {
	rows, err := s.queryPurchasedRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	type itemBucket struct {
		asin      string
		sku       string
		campaigns map[string]bool
		units     int
		orders    int
		sales     float64
	}
	grouped := make(map[string]*itemBucket)
	for _, r := range rows {
		if filter.Campaign != nil && *filter.Campaign != "" && !strings.EqualFold(r.CampaignName, *filter.Campaign) {
			continue
		}
		if filter.SKU != nil && *filter.SKU != "" && !strings.EqualFold(r.AdSKU, *filter.SKU) {
			continue
		}
		if filter.PurchasedASIN != nil && *filter.PurchasedASIN != "" && !strings.EqualFold(r.PurchasedASIN, *filter.PurchasedASIN) {
			continue
		}
		key := fmt.Sprintf("%s|%s", r.PurchasedASIN, r.AdSKU)
		b, ok := grouped[key]
		if !ok {
			b = &itemBucket{
				asin:      r.PurchasedASIN,
				sku:       r.AdSKU,
				campaigns: make(map[string]bool),
			}
			grouped[key] = b
		}
		b.campaigns[r.CampaignName] = true
		b.units += r.OtherSKUUnits7d
		b.orders += r.OtherSKUOrders7d
		b.sales += r.OtherSKUSales7d
	}

	var items []map[string]any
	for _, b := range grouped {
		items = append(items, map[string]any{
			"purchased_asin":      b.asin,
			"ad_sku":              b.sku,
			"campaign_count":      len(b.campaigns),
			"other_sku_units_7d":  b.units,
			"other_sku_orders_7d": b.orders,
			"other_sku_sales_7d":  adRoundMoney(b.sales),
			"action":              classifyCrossSellAction(b.sales, b.orders),
		})
	}
	sort.Slice(items, func(i, j int) bool {
		sI := items[i]["other_sku_sales_7d"].(float64)
		sJ := items[j]["other_sku_sales_7d"].(float64)
		if sI != sJ {
			return sI > sJ
		}
		return items[i]["other_sku_orders_7d"].(int) > items[j]["other_sku_orders_7d"].(int)
	})

	if items == nil {
		items = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisPurchasedProductsResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		Items:     items,
	}, nil
}

func (s *AdAnalysisStore) BuildSearchTerms(ctx context.Context, filter ad_analysis.SearchTermsFilter) (*ad_analysis.AdAnalysisSearchTermsResponse, error) {
	rows, err := s.querySearchTermRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}
	shares, err := s.querySearchTermShareRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	type shareKey struct {
		term      string
		matchType string
	}
	shareMap := make(map[shareKey]struct {
		rank  int
		share float64
	})
	for _, sh := range shares {
		k := shareKey{term: strings.ToLower(strings.TrimSpace(sh.SearchTerm)), matchType: strings.ToLower(strings.TrimSpace(sh.MatchType))}
		cur := shareMap[k]
		if sh.ImpressionShare > cur.share {
			cur.share = sh.ImpressionShare
		}
		if sh.ImpressionRank > 0 && (cur.rank == 0 || sh.ImpressionRank < cur.rank) {
			cur.rank = sh.ImpressionRank
		}
		shareMap[k] = cur
	}

	type stBucket struct {
		term        string
		matchType   string
		campaigns   map[string]bool
		impressions int
		clicks      int
		spend       float64
		sales       float64
		orders      int
	}
	grouped := make(map[shareKey]*stBucket)
	for _, r := range rows {
		if filter.Campaign != nil && *filter.Campaign != "" && !strings.EqualFold(r.CampaignName, *filter.Campaign) {
			continue
		}
		if filter.SearchTerm != nil && *filter.SearchTerm != "" && !strings.EqualFold(r.SearchTerm, *filter.SearchTerm) {
			continue
		}
		k := shareKey{term: strings.ToLower(strings.TrimSpace(r.SearchTerm)), matchType: strings.ToLower(strings.TrimSpace(r.MatchType))}
		b, ok := grouped[k]
		if !ok {
			b = &stBucket{
				term:      r.SearchTerm,
				matchType: r.MatchType,
				campaigns: make(map[string]bool),
			}
			grouped[k] = b
		}
		b.campaigns[r.CampaignName] = true
		b.impressions += r.Impressions
		b.clicks += r.Clicks
		b.spend += r.Spend
		b.sales += r.Sales7d
		b.orders += r.Orders7d
	}

	var items []map[string]any
	expandCount := 0
	negativeCount := 0
	shareGapCount := 0
	for k, b := range grouped {
		ctr := adSafeRatio(float64(b.clicks), float64(b.impressions))
		cpc := adSafeRatio(b.spend, float64(b.clicks))
		acos := adSafeRatio(b.spend, b.sales)
		cvr := adSafeRatio(float64(b.orders), float64(b.clicks))

		shInfo := shareMap[k]
		action := classifySearchTermAction(b.orders, shInfo.share, acos, b.clicks)
		if action == "提竞价争份额" || action == "加词放量" {
			expandCount++
		}
		if action == "否词/降价" {
			negativeCount++
		}
		if b.orders >= 1 && shInfo.share > 0 && shInfo.share < 0.08 {
			shareGapCount++
		}

		primaryCamp := "-"
		for c := range b.campaigns {
			primaryCamp = c
			break
		}

		items = append(items, map[string]any{
			"search_term":      b.term,
			"match_type":       b.matchType,
			"campaign_count":   len(b.campaigns),
			"primary_campaign": primaryCamp,
			"impressions":      b.impressions,
			"clicks":           b.clicks,
			"ctr":              adRoundRatio(ctr),
			"cpc":              adRoundMoney(cpc),
			"spend":            adRoundMoney(b.spend),
			"sales_7d":         adRoundMoney(b.sales),
			"orders_7d":        b.orders,
			"cvr_7d":           adRoundRatio(cvr),
			"acos":             adRoundRatio(acos),
			"impression_share": adRoundRatio(shInfo.share),
			"impression_rank":  shInfo.rank,
			"action":           action,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		sI := items[i]["spend"].(float64)
		sJ := items[j]["spend"].(float64)
		if sI != sJ {
			return sI > sJ
		}
		return items[i]["clicks"].(int) > items[j]["clicks"].(int)
	})

	summaryCards := []map[string]any{
		{"label": "搜索词数", "value": fmt.Sprintf("%d", len(items)), "helper": "当前筛选条件下的有效搜索词"},
		{"label": "扩量候选", "value": fmt.Sprintf("%d", expandCount), "helper": "建议提竞价或加词放量的搜索词"},
		{"label": "否词候选", "value": fmt.Sprintf("%d", negativeCount), "helper": "达到降价或否词门槛的搜索词"},
		{"label": "份额缺口", "value": fmt.Sprintf("%d", shareGapCount), "helper": "已有订单但展示量份额仍偏低的搜索词"},
	}

	narratives := []ad_analysis.AdAnalysisNarrativeSection{
		{
			Title:    "搜索词层结论",
			Summary:  "当前搜索词层暂时较平稳。",
			Evidence: []string{fmt.Sprintf("当前共识别到 %d 个搜索词，其中扩量候选 %d 个，否词候选 %d 个。", len(items), expandCount, negativeCount)},
			Action:   strPtr("先区分该词是值得继续抢份额，还是已经到达否词/降价门槛。"),
			DrillTo:  strPtr("search-terms"),
		},
	}

	if items == nil {
		items = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisSearchTermsResponse{
		ProjectID:         filter.ProjectID,
		Country:           filter.Country,
		SummaryCards:      summaryCards,
		NarrativeSections: narratives,
		Items:             items,
	}, nil
}

func (s *AdAnalysisStore) BuildTargets(ctx context.Context, filter ad_analysis.TargetsFilter) (*ad_analysis.AdAnalysisTargetsResponse, error) {
	rows, err := s.queryTargetRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	type tKey struct {
		text      string
		matchType string
	}
	type tBucket struct {
		text        string
		matchType   string
		campaigns   map[string]bool
		impressions int
		clicks      int
		spend       float64
		sales       float64
		orders      int
		topShare    float64
	}
	grouped := make(map[tKey]*tBucket)
	for _, r := range rows {
		if filter.Campaign != nil && *filter.Campaign != "" && !strings.EqualFold(r.CampaignName, *filter.Campaign) {
			continue
		}
		if filter.TargetText != nil && *filter.TargetText != "" && !strings.EqualFold(r.TargetText, *filter.TargetText) {
			continue
		}
		k := tKey{text: r.TargetText, matchType: r.MatchType}
		b, ok := grouped[k]
		if !ok {
			b = &tBucket{
				text:      r.TargetText,
				matchType: r.MatchType,
				campaigns: make(map[string]bool),
			}
			grouped[k] = b
		}
		b.campaigns[r.CampaignName] = true
		b.impressions += r.Impressions
		b.clicks += r.Clicks
		b.spend += r.Spend
		b.sales += r.Sales7d
		b.orders += r.Orders7d
		if r.TopSearchImpressionShare > b.topShare {
			b.topShare = r.TopSearchImpressionShare
		}
	}

	var items []map[string]any
	keepCount := 0
	isolateCount := 0
	topSlotGapCount := 0
	for _, b := range grouped {
		ctr := adSafeRatio(float64(b.clicks), float64(b.impressions))
		cpc := adSafeRatio(b.spend, float64(b.clicks))
		acos := adSafeRatio(b.spend, b.sales)
		cvr := adSafeRatio(float64(b.orders), float64(b.clicks))

		action := classifyTargetAction(b.orders, acos, b.clicks, ctr, b.topShare)
		if action == "保留放量" {
			keepCount++
		}
		if action == "降价/隔离" {
			isolateCount++
		}
		if ctr >= 0.01 && b.topShare < 0.01 {
			topSlotGapCount++
		}

		primaryCamp := "-"
		for c := range b.campaigns {
			primaryCamp = c
			break
		}

		items = append(items, map[string]any{
			"target_text":                    b.text,
			"match_type":                     b.matchType,
			"campaign_count":                 len(b.campaigns),
			"primary_campaign":               primaryCamp,
			"impressions":                    b.impressions,
			"clicks":                         b.clicks,
			"ctr":                            adRoundRatio(ctr),
			"cpc":                            adRoundMoney(cpc),
			"spend":                          adRoundMoney(b.spend),
			"sales_7d":                       adRoundMoney(b.sales),
			"orders_7d":                      b.orders,
			"cvr_7d":                         adRoundRatio(cvr),
			"acos":                           adRoundRatio(acos),
			"top_of_search_impression_share": adRoundRatio(b.topShare),
			"action":                         action,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		sI := items[i]["spend"].(float64)
		sJ := items[j]["spend"].(float64)
		if sI != sJ {
			return sI > sJ
		}
		return items[i]["clicks"].(int) > items[j]["clicks"].(int)
	})

	summaryCards := []map[string]any{
		{"label": "投放入口数", "value": fmt.Sprintf("%d", len(items)), "helper": "当前筛选条件下的入口维度数量"},
		{"label": "保留放量", "value": fmt.Sprintf("%d", keepCount), "helper": "表现稳定、值得继续承接的入口"},
		{"label": "隔离候选", "value": fmt.Sprintf("%d", isolateCount), "helper": "高消耗低转化、需要控价的入口"},
		{"label": "首页缺口", "value": fmt.Sprintf("%d", topSlotGapCount), "helper": "CTR 不差但首页曝光份额偏低的入口"},
	}

	if items == nil {
		items = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisTargetsResponse{
		ProjectID:    filter.ProjectID,
		Country:      filter.Country,
		SummaryCards: summaryCards,
		Items:        items,
	}, nil
}

func (s *AdAnalysisStore) BuildBudget(ctx context.Context, filter ad_analysis.BudgetFilter) (*ad_analysis.AdAnalysisBudgetResponse, error) {
	rows, err := s.queryBudgetRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	var items []map[string]any
	addBudgetCount := 0
	optimizeCount := 0
	observeCount := 0

	for _, r := range rows {
		if filter.Campaign != nil && *filter.Campaign != "" && !strings.EqualFold(r.CampaignName, *filter.Campaign) {
			continue
		}
		budgetGap := math.Max(r.SuggestedBudget-r.Budget, 0)
		action := classifyBudgetAction(r.BudgetUtilizationRate, r.Orders7d, r.ACOS, r.Spend)
		if action == "优先加预算" {
			addBudgetCount++
		}
		if action == "先优化再加预算" {
			optimizeCount++
		}
		if action == "观察预算" {
			observeCount++
		}

		items = append(items, map[string]any{
			"campaign_name":           r.CampaignName,
			"status":                  r.Status,
			"budget":                  adRoundMoney(r.Budget),
			"suggested_budget":        adRoundMoney(r.SuggestedBudget),
			"budget_gap":              adRoundMoney(budgetGap),
			"budget_utilization_rate": adRoundRatio(r.BudgetUtilizationRate),
			"missed_impressions_min":  r.MissedImpressionsMin,
			"missed_impressions_max":  r.MissedImpressionsMax,
			"missed_clicks_min":       r.MissedClicksMin,
			"missed_clicks_max":       r.MissedClicksMax,
			"missed_sales_min":        adRoundMoney(r.MissedSalesMin),
			"missed_sales_max":        adRoundMoney(r.MissedSalesMax),
			"spend":                   adRoundMoney(r.Spend),
			"sales_7d":                adRoundMoney(r.Sales7d),
			"orders_7d":               r.Orders7d,
			"acos":                    adRoundRatio(r.ACOS),
			"action":                  action,
			"next_step":               classifyBudgetNextStep(action),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		gI := items[i]["budget_gap"].(float64)
		gJ := items[j]["budget_gap"].(float64)
		if gI != gJ {
			return gI > gJ
		}
		return items[i]["missed_sales_max"].(float64) > items[j]["missed_sales_max"].(float64)
	})

	summaryCards := []map[string]any{
		{"label": "预算活动数", "value": fmt.Sprintf("%d", len(items)), "helper": "当前筛选条件下的预算条目"},
		{"label": "优先加预算", "value": fmt.Sprintf("%d", addBudgetCount), "helper": "建议今天直接补预算的活动"},
		{"label": "先优化再加", "value": fmt.Sprintf("%d", optimizeCount), "helper": "需要先控浪费再决定预算的活动"},
		{"label": "继续观察", "value": fmt.Sprintf("%d", observeCount), "helper": "当前只需要跟踪的预算条目"},
	}

	narratives := []ad_analysis.AdAnalysisNarrativeSection{
		{
			Title:    "预算层结论",
			Summary:  "当前预算层整体平稳，预算不是当前最明显的限制项。",
			Evidence: []string{fmt.Sprintf("当前共有 %d 条预算记录，其中优先加预算 %d 条。", len(items), addBudgetCount)},
			Action:   strPtr("先把有限预算给到有效活动，再回头处理低效活动，避免平均分配预算。"),
			DrillTo:  strPtr("budget"),
		},
	}

	if items == nil {
		items = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisBudgetResponse{
		ProjectID:         filter.ProjectID,
		Country:           filter.Country,
		SummaryCards:      summaryCards,
		NarrativeSections: narratives,
		Items:             items,
	}, nil
}

func (s *AdAnalysisStore) BuildPlacements(ctx context.Context, filter ad_analysis.PlacementsFilter) (*ad_analysis.AdAnalysisPlacementsResponse, error) {
	rows, err := s.queryPlacementRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	type pKey struct {
		campaign  string
		placement string
	}
	type pBucket struct {
		campaign    string
		placement   string
		impressions int
		clicks      int
		spend       float64
		sales       float64
		orders      int
		units       int
	}
	grouped := make(map[pKey]*pBucket)
	for _, r := range rows {
		if filter.Campaign != nil && *filter.Campaign != "" && !strings.EqualFold(r.CampaignName, *filter.Campaign) {
			continue
		}
		if filter.Placement != nil && *filter.Placement != "" && !strings.EqualFold(r.Placement, *filter.Placement) {
			continue
		}
		k := pKey{campaign: r.CampaignName, placement: r.Placement}
		b, ok := grouped[k]
		if !ok {
			b = &pBucket{
				campaign:  r.CampaignName,
				placement: r.Placement,
			}
			grouped[k] = b
		}
		b.impressions += r.Impressions
		b.clicks += r.Clicks
		b.spend += r.Spend
		b.sales += r.Sales7d
		b.orders += r.Orders7d
		b.units += r.Units7d
	}

	var items []map[string]any
	raiseCount := 0
	downCount := 0
	weakCount := 0
	for _, b := range grouped {
		ctr := adSafeRatio(float64(b.clicks), float64(b.impressions))
		cpc := adSafeRatio(b.spend, float64(b.clicks))
		acos := adSafeRatio(b.spend, b.sales)
		roas := adSafeRatio(b.sales, b.spend)
		cvr := adSafeRatio(float64(b.orders), float64(b.clicks))

		action := classifyPlacementAction(b.orders, cvr, acos, b.clicks, ctr)
		if action == "可提高系数" {
			raiseCount++
		}
		if action == "谨慎降价" {
			downCount++
		}
		if action == "流量偏弱" {
			weakCount++
		}

		items = append(items, map[string]any{
			"campaign_name": b.campaign,
			"placement":     b.placement,
			"impressions":   b.impressions,
			"clicks":        b.clicks,
			"ctr":           adRoundRatio(ctr),
			"cpc":           adRoundMoney(cpc),
			"spend":         adRoundMoney(b.spend),
			"sales_7d":      adRoundMoney(b.sales),
			"orders_7d":     b.orders,
			"units_7d":      b.units,
			"cvr_7d":        adRoundRatio(cvr),
			"acos":          adRoundRatio(acos),
			"roas":          adRoundRatio(roas),
			"action":        action,
			"next_step":     classifyPlacementNextStep(action),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		sI := items[i]["spend"].(float64)
		sJ := items[j]["spend"].(float64)
		if sI != sJ {
			return sI > sJ
		}
		return items[i]["sales_7d"].(float64) > items[j]["sales_7d"].(float64)
	})

	summaryCards := []map[string]any{
		{"label": "可提高系数", "value": fmt.Sprintf("%d", raiseCount), "helper": "高转化低 ACOS 位置"},
		{"label": "谨慎降价", "value": fmt.Sprintf("%d", downCount), "helper": "高花费无单位置"},
		{"label": "流量偏弱", "value": fmt.Sprintf("%d", weakCount), "helper": "CTR 偏低位置"},
	}

	narratives := []ad_analysis.AdAnalysisNarrativeSection{
		{
			Title:    "广告位层结论",
			Summary:  "当前广告位层暂时没有明显分化，位置不是当前最强归因。",
			Evidence: []string{fmt.Sprintf("当前共有 %d 条“活动 × 广告位”记录，其中可提高系数 %d 条，谨慎降价 %d 条。", len(items), raiseCount, downCount)},
			Action:   strPtr("优先回看高点击无单的广告位，避免首页或商品页继续低效消耗。"),
			DrillTo:  strPtr("placements"),
		},
	}

	if items == nil {
		items = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisPlacementsResponse{
		ProjectID:         filter.ProjectID,
		Country:           filter.Country,
		SummaryCards:      summaryCards,
		NarrativeSections: narratives,
		Items:             items,
	}, nil
}

func (s *AdAnalysisStore) BuildTrafficQuality(ctx context.Context, filter ad_analysis.TrafficQualityFilter) (*ad_analysis.AdAnalysisTrafficQualityResponse, error) {
	rows, err := s.queryInvalidTrafficRows(ctx, filter.ProjectID, filter.Country, filter.DateFrom, filter.DateTo)
	if err != nil {
		return nil, err
	}

	var items []map[string]any
	highRiskCount := 0
	mediumRiskCount := 0
	normalCount := 0
	maxInvalidClickRate := 0.0

	for _, r := range rows {
		if filter.Campaign != nil && *filter.Campaign != "" && !strings.EqualFold(r.CampaignName, *filter.Campaign) {
			continue
		}
		risk := classifyTrafficRisk(r.InvalidClickRate, r.InvalidImpressionRate)
		if risk == "高风险" {
			highRiskCount++
		} else if risk == "中风险" {
			mediumRiskCount++
		} else {
			normalCount++
		}
		if r.InvalidClickRate > maxInvalidClickRate {
			maxInvalidClickRate = r.InvalidClickRate
		}

		items = append(items, map[string]any{
			"campaign_name":           r.CampaignName,
			"status":                  r.Status,
			"total_impressions":       r.TotalImpressions,
			"valid_impressions":       r.ValidImpressions,
			"invalid_impressions":     r.InvalidImpressions,
			"invalid_impression_rate": adRoundRatio(r.InvalidImpressionRate),
			"total_clicks":            r.TotalClicks,
			"valid_clicks":            r.ValidClicks,
			"invalid_clicks":          r.InvalidClicks,
			"invalid_click_rate":      adRoundRatio(r.InvalidClickRate),
			"risk_level":              risk,
			"next_step":               classifyTrafficNextAction(risk),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		cI := items[i]["invalid_click_rate"].(float64)
		cJ := items[j]["invalid_click_rate"].(float64)
		if cI != cJ {
			return cI > cJ
		}
		return items[i]["invalid_impression_rate"].(float64) > items[j]["invalid_impression_rate"].(float64)
	})

	summaryCards := []map[string]any{
		{"label": "高风险活动", "value": fmt.Sprintf("%d", highRiskCount), "helper": "优先排查异常入口和异常广告位"},
		{"label": "中风险活动", "value": fmt.Sprintf("%d", mediumRiskCount), "helper": "需要继续跟踪的流量异常活动"},
		{"label": "正常活动", "value": fmt.Sprintf("%d", normalCount), "helper": "当前无明显流量异常的活动"},
		{"label": "最高无效点击率", "value": fmt.Sprintf("%.2f%%", adRoundRatio(maxInvalidClickRate)*100), "helper": "用于快速判断当前最差入口"},
	}

	narratives := []ad_analysis.AdAnalysisNarrativeSection{
		{
			Title:    "流量质量结论",
			Summary:  "当前流量质量层整体稳定，没有看到明显异常流量。",
			Evidence: []string{fmt.Sprintf("当前高风险活动 %d 个，中风险活动 %d 个，正常活动 %d 个。", highRiskCount, mediumRiskCount, normalCount)},
			Action:   strPtr("先确认异常是否集中在少数活动，再回查投放入口和广告位，而不是直接全账户降价。"),
			DrillTo:  strPtr("traffic-quality"),
		},
	}

	if items == nil {
		items = []map[string]any{}
	}

	return &ad_analysis.AdAnalysisTrafficQualityResponse{
		ProjectID:         filter.ProjectID,
		Country:           filter.Country,
		SummaryCards:      summaryCards,
		NarrativeSections: narratives,
		Items:             items,
	}, nil
}
