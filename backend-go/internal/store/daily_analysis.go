package store

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/daily_analysis"
)

type DailyAnalysisStore struct {
	db DB
}

func NewDailyAnalysisStore(db DB) *DailyAnalysisStore {
	return &DailyAnalysisStore{db: db}
}

func (s *DailyAnalysisStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	if isAdmin {
		return nil
	}
	var projOp, asstOp *string
	err := s.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator from public.projects where id = $1`,
		projectID,
	).Scan(&projOp, &asstOp)
	if errors.Is(err, pgx.ErrNoRows) {
		return daily_analysis.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return daily_analysis.ErrProjectForbidden
	}
	if textContainsName(projOp, operator) || textContainsName(asstOp, operator) {
		return nil
	}
	return daily_analysis.ErrProjectForbidden
}

func (s *DailyAnalysisStore) AccessibleProjectIDs(
	ctx context.Context,
	operator string,
	isAdmin bool,
) ([]int64, error) {
	if isAdmin {
		rows, err := s.db.Query(
			ctx,
			`select id from public.projects
			 where coalesce(is_active, true)
			 order by coalesce(is_active, true) desc, sort_order asc, id asc`,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			ids = append(ids, id)
		}
		return ids, rows.Err()
	}

	operator = strings.TrimSpace(operator)
	if operator == "" {
		return []int64{}, nil
	}

	rows, err := s.db.Query(
		ctx,
		`select id, coalesce(project_operator, ''), coalesce(assistant_operator, '')
		 from public.projects
		 where coalesce(is_active, true)
		 order by coalesce(is_active, true) desc, sort_order asc, id asc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var (
			id             int64
			projOp, asstOp string
		)
		if err := rows.Scan(&id, &projOp, &asstOp); err != nil {
			return nil, err
		}
		if textContainsName(&projOp, operator) || textContainsName(&asstOp, operator) {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, nil
}

type dailyMetricBucket struct {
	asin                *string
	orderQty            int
	pendingOrderQty     int
	salesAmount         float64
	impressions         int
	clicks              int
	adSpend             float64
	adOrders            int
	availableQty        int
	inTransitQty        int
	pageViews           int
	unitsOrdered        int
	sessions            int
	businessSalesAmount float64
}

func (s *DailyAnalysisStore) GetDailyAnalysis(
	ctx context.Context,
	projectID int64,
	country string,
	startDate, endDate string,
	sku *string,
) (*daily_analysis.DailyAnalysisResponse, error) {
	var projectName string
	err := s.db.QueryRow(ctx, `select project_name from public.projects where id = $1`, projectID).Scan(&projectName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, daily_analysis.ErrProjectNotFound
	}
	if err != nil {
		return nil, err
	}

	buckets := make(map[string]*dailyMetricBucket) // key: date + "\x00" + sku
	salesDates, latestSales, err := s.loadSalesMetrics(ctx, buckets, projectID, country, startDate, endDate)
	if err != nil {
		return nil, err
	}
	adDates, latestAd, err := s.loadAdMetrics(ctx, buckets, projectID, country, startDate, endDate)
	if err != nil {
		return nil, err
	}
	invDates, latestInv, err := s.loadInventoryMetrics(ctx, buckets, projectID, country, startDate, endDate)
	if err != nil {
		return nil, err
	}
	asinToSKU, err := s.buildAsinToSKUMap(ctx, projectID, country, startDate, endDate)
	if err != nil {
		return nil, err
	}
	bizDates, latestBiz, err := s.loadBusinessMetrics(ctx, buckets, projectID, country, startDate, endDate, asinToSKU)
	if err != nil {
		return nil, err
	}
	inTransitMap, err := s.loadInTransitQuantities(ctx, projectID, country)
	if err != nil {
		return nil, err
	}
	latestDates, err := s.loadLatestAvailableDates(ctx, projectID, country)
	if err != nil {
		return nil, err
	}

	detailRows, summaryRows := s.aggregateBuckets(buckets, sku)
	for i := range detailRows {
		detailRows[i].InTransitQty = inTransitMap[detailRows[i].SKU]
	}

	requestedDates := generateDateRange(startDate, endDate)
	var missingDates []string
	for _, d := range requestedDates {
		if !salesDates[d] || !adDates[d] || !invDates[d] || !bizDates[d] {
			missingDates = append(missingDates, d)
		}
	}
	if missingDates == nil {
		missingDates = []string{}
	}

	salesDate := latestDates["latest_sales_date"]
	if salesDate == nil {
		salesDate = latestSales
	}
	adDate := latestDates["latest_ad_date"]
	if adDate == nil {
		adDate = latestAd
	}
	invDate := latestDates["latest_inventory_date"]
	if invDate == nil {
		invDate = latestInv
	}
	bizDate := latestDates["latest_business_date"]
	if bizDate == nil {
		bizDate = latestBiz
	}

	return &daily_analysis.DailyAnalysisResponse{
		Console: daily_analysis.DailyAnalysisConsoleResponse{
			ProjectID:           projectID,
			ProjectName:         projectName,
			Country:             country,
			StartDate:           startDate,
			EndDate:             endDate,
			RequestedDays:       len(requestedDates),
			SummaryDays:         len(summaryRows),
			DetailRows:          len(detailRows),
			SalesSourceDays:     len(salesDates),
			AdSourceDays:        len(adDates),
			InventorySourceDays: len(invDates),
			BusinessSourceDays:  len(bizDates),
			MissingDates:        missingDates,
			LatestSalesDate:     salesDate,
			LatestAdDate:        adDate,
			LatestInventoryDate: invDate,
			LatestBusinessDate:  bizDate,
		},
		SummaryRows: summaryRows,
		DetailRows:  detailRows,
		AvailableDates: map[string][]string{
			"sales_report":      setToSortedSlice(salesDates),
			"ad_product_report": setToSortedSlice(adDates),
			"inventory_report":  setToSortedSlice(invDates),
			"business_report":   setToSortedSlice(bizDates),
		},
	}, nil
}

func (s *DailyAnalysisStore) GetDailyAnalysisAll(
	ctx context.Context,
	projectIDs []int64,
	country string,
	startDate, endDate string,
	sku *string,
	includeDetail bool,
) (*daily_analysis.DailyAnalysisAllProjectsResponse, error) {
	projectBreakdown := make(map[int64]daily_analysis.ProjectBreakdownBlock, len(projectIDs))
	globalBuckets := make(map[string]*dailyMetricBucket)
	globalInTransit := make(map[string]int)

	availableDates := map[string][]string{
		"sales_report":      {},
		"ad_product_report": {},
		"inventory_report":  {},
		"business_report":   {},
	}

	for _, pid := range projectIDs {
		var projectName string
		err := s.db.QueryRow(ctx, `select project_name from public.projects where id = $1`, pid).Scan(&projectName)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, daily_analysis.ErrProjectNotFound
		}
		if err != nil {
			return nil, err
		}

		buckets := make(map[string]*dailyMetricBucket)
		_, _, err = s.loadSalesMetrics(ctx, buckets, pid, country, startDate, endDate)
		if err != nil {
			return nil, err
		}
		_, _, err = s.loadAdMetrics(ctx, buckets, pid, country, startDate, endDate)
		if err != nil {
			return nil, err
		}
		_, _, err = s.loadInventoryMetrics(ctx, buckets, pid, country, startDate, endDate)
		if err != nil {
			return nil, err
		}
		asinToSKU, err := s.buildAsinToSKUMap(ctx, pid, country, startDate, endDate)
		if err != nil {
			return nil, err
		}
		_, _, err = s.loadBusinessMetrics(ctx, buckets, pid, country, startDate, endDate, asinToSKU)
		if err != nil {
			return nil, err
		}

		pDetail, pSummary := s.aggregateBuckets(buckets, nil)
		inTransitMap, err := s.loadInTransitQuantities(ctx, pid, country)
		if err != nil {
			return nil, err
		}
		for i := range pDetail {
			pDetail[i].InTransitQty = inTransitMap[pDetail[i].SKU]
		}
		for k, v := range inTransitMap {
			globalInTransit[k] += v
		}

		if !includeDetail {
			pDetail = []daily_analysis.DailyAnalysisDetailRow{}
		}
		projectBreakdown[pid] = daily_analysis.ProjectBreakdownBlock{
			ProjectName: projectName,
			SummaryRows: pSummary,
			DetailRows:  pDetail,
		}

		mergeBuckets(globalBuckets, buckets)

		latestDates, err := s.loadLatestAvailableDates(ctx, pid, country)
		if err != nil {
			return nil, err
		}
		updateMaxDate(availableDates, "sales_report", latestDates["latest_sales_date"])
		updateMaxDate(availableDates, "ad_product_report", latestDates["latest_ad_date"])
		updateMaxDate(availableDates, "inventory_report", latestDates["latest_inventory_date"])
		updateMaxDate(availableDates, "business_report", latestDates["latest_business_date"])
	}

	globalDetail, globalSummary := s.aggregateBuckets(globalBuckets, nil)
	for i := range globalDetail {
		globalDetail[i].InTransitQty = globalInTransit[globalDetail[i].SKU]
	}
	if !includeDetail {
		globalDetail = []daily_analysis.DailyAnalysisDetailRow{}
	}

	return &daily_analysis.DailyAnalysisAllProjectsResponse{
		SummaryRows:      globalSummary,
		DetailRows:       globalDetail,
		AvailableDates:   availableDates,
		ProjectBreakdown: projectBreakdown,
	}, nil
}

func (s *DailyAnalysisStore) GetDailyAnalysisAllCountries(
	ctx context.Context,
	projectID int64,
	startDate, endDate string,
) (*daily_analysis.DailyAnalysisAllCountriesResponse, error) {
	var projectName string
	err := s.db.QueryRow(ctx, `select project_name from public.projects where id = $1`, projectID).Scan(&projectName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, daily_analysis.ErrProjectNotFound
	}
	if err != nil {
		return nil, err
	}

	yearMonths := yearMonthsInRange(startDate, endDate)
	usdFactors, err := s.loadUSDFactors(ctx, []string{"US", "DE", "UK"}, yearMonths)
	if err != nil {
		return nil, err
	}

	globalBuckets := make(map[string]*dailyMetricBucket)
	globalInTransit := make(map[string]int)
	countryBreakdown := make(map[string]daily_analysis.CountryBreakdownBlock)
	availableDates := map[string][]string{
		"sales_report":      {},
		"ad_product_report": {},
		"inventory_report":  {},
		"business_report":   {},
	}

	for _, countryValue := range []string{"US", "DE", "UK"} {
		buckets := make(map[string]*dailyMetricBucket)
		_, _, err = s.loadSalesMetrics(ctx, buckets, projectID, countryValue, startDate, endDate)
		if err != nil {
			return nil, err
		}
		_, _, err = s.loadAdMetrics(ctx, buckets, projectID, countryValue, startDate, endDate)
		if err != nil {
			return nil, err
		}
		_, _, err = s.loadInventoryMetrics(ctx, buckets, projectID, countryValue, startDate, endDate)
		if err != nil {
			return nil, err
		}
		asinToSKU, err := s.buildAsinToSKUMap(ctx, projectID, countryValue, startDate, endDate)
		if err != nil {
			return nil, err
		}
		_, _, err = s.loadBusinessMetrics(ctx, buckets, projectID, countryValue, startDate, endDate, asinToSKU)
		if err != nil {
			return nil, err
		}

		convertBucketAmountsToUSD(buckets, countryValue, usdFactors)

		countryDetail, countrySummary := s.aggregateBuckets(buckets, nil)
		inTransitMap, err := s.loadInTransitQuantities(ctx, projectID, countryValue)
		if err != nil {
			return nil, err
		}
		for i := range countryDetail {
			countryDetail[i].InTransitQty = inTransitMap[countryDetail[i].SKU]
			c := countryValue
			countryDetail[i].Country = &c
		}
		for k, v := range inTransitMap {
			globalInTransit[k] += v
		}

		sourceCurrency := "USD"
		if countryValue == "DE" {
			sourceCurrency = "EUR"
		} else if countryValue == "UK" {
			sourceCurrency = "GBP"
		}

		countryBreakdown[countryValue] = daily_analysis.CountryBreakdownBlock{
			SummaryRows:    countrySummary,
			DetailRows:     countryDetail,
			Currency:       "USD",
			SourceCurrency: sourceCurrency,
		}

		mergeBuckets(globalBuckets, buckets)

		latestDates, err := s.loadLatestAvailableDates(ctx, projectID, countryValue)
		if err != nil {
			return nil, err
		}
		updateMaxDate(availableDates, "sales_report", latestDates["latest_sales_date"])
		updateMaxDate(availableDates, "ad_product_report", latestDates["latest_ad_date"])
		updateMaxDate(availableDates, "inventory_report", latestDates["latest_inventory_date"])
		updateMaxDate(availableDates, "business_report", latestDates["latest_business_date"])
	}

	globalDetail, globalSummary := s.aggregateBuckets(globalBuckets, nil)
	for i := range globalDetail {
		globalDetail[i].InTransitQty = globalInTransit[globalDetail[i].SKU]
	}

	requestedDates := generateDateRange(startDate, endDate)
	currencyNote := "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。"

	return &daily_analysis.DailyAnalysisAllCountriesResponse{
		Console: daily_analysis.DailyAnalysisConsoleResponse{
			ProjectID:           projectID,
			ProjectName:         projectName,
			Country:             "ALL",
			StartDate:           startDate,
			EndDate:             endDate,
			RequestedDays:       len(requestedDates),
			SummaryDays:         len(globalSummary),
			DetailRows:          len(globalDetail),
			SalesSourceDays:     0,
			AdSourceDays:        0,
			InventorySourceDays: 0,
			BusinessSourceDays:  0,
			MissingDates:        []string{},
		},
		SummaryRows:      globalSummary,
		DetailRows:       globalDetail,
		AvailableDates:   availableDates,
		CountryBreakdown: countryBreakdown,
		Currency:         "USD",
		CurrencyNote:     &currencyNote,
	}, nil
}

func (s *DailyAnalysisStore) GetDailyAnalysisAllProjectsCountries(
	ctx context.Context,
	projectIDs []int64,
	startDate, endDate string,
) (*daily_analysis.DailyAnalysisAllProjectsCountriesResponse, error) {
	yearMonths := yearMonthsInRange(startDate, endDate)
	usdFactors, err := s.loadUSDFactors(ctx, []string{"US", "DE", "UK"}, yearMonths)
	if err != nil {
		return nil, err
	}

	globalBuckets := make(map[string]*dailyMetricBucket)
	globalInTransit := make(map[string]int)
	countryByProjectBuckets := make(map[string]map[string]*dailyMetricBucket)
	countryInTransitMaps := make(map[string]map[string]int)
	countryBreakdown := make(map[string]daily_analysis.CountryBreakdownBlock)
	projectBreakdown := make(map[int64]daily_analysis.ProjectBreakdownBlock)

	availableDates := map[string][]string{
		"sales_report":      {},
		"ad_product_report": {},
		"inventory_report":  {},
		"business_report":   {},
	}

	for _, countryValue := range []string{"US", "DE", "UK"} {
		countryByProjectBuckets[countryValue] = make(map[string]*dailyMetricBucket)
		countryInTransitMaps[countryValue] = make(map[string]int)
	}

	for _, pid := range projectIDs {
		var projectName string
		err := s.db.QueryRow(ctx, `select project_name from public.projects where id = $1`, pid).Scan(&projectName)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, daily_analysis.ErrProjectNotFound
		}
		if err != nil {
			return nil, err
		}

		projectBuckets := make(map[string]*dailyMetricBucket)
		projectInTransitMap := make(map[string]int)

		for _, countryValue := range []string{"US", "DE", "UK"} {
			buckets := make(map[string]*dailyMetricBucket)
			_, _, err = s.loadSalesMetrics(ctx, buckets, pid, countryValue, startDate, endDate)
			if err != nil {
				return nil, err
			}
			_, _, err = s.loadAdMetrics(ctx, buckets, pid, countryValue, startDate, endDate)
			if err != nil {
				return nil, err
			}
			_, _, err = s.loadInventoryMetrics(ctx, buckets, pid, countryValue, startDate, endDate)
			if err != nil {
				return nil, err
			}
			asinToSKU, err := s.buildAsinToSKUMap(ctx, pid, countryValue, startDate, endDate)
			if err != nil {
				return nil, err
			}
			_, _, err = s.loadBusinessMetrics(ctx, buckets, pid, countryValue, startDate, endDate, asinToSKU)
			if err != nil {
				return nil, err
			}

			convertBucketAmountsToUSD(buckets, countryValue, usdFactors)
			mergeBuckets(projectBuckets, buckets)
			mergeBuckets(countryByProjectBuckets[countryValue], buckets)

			inTransitMap, err := s.loadInTransitQuantities(ctx, pid, countryValue)
			if err != nil {
				return nil, err
			}
			for k, v := range inTransitMap {
				projectInTransitMap[k] += v
				countryInTransitMaps[countryValue][k] += v
				globalInTransit[k] += v
			}

			latestDates, err := s.loadLatestAvailableDates(ctx, pid, countryValue)
			if err != nil {
				return nil, err
			}
			updateMaxDate(availableDates, "sales_report", latestDates["latest_sales_date"])
			updateMaxDate(availableDates, "ad_product_report", latestDates["latest_ad_date"])
			updateMaxDate(availableDates, "inventory_report", latestDates["latest_inventory_date"])
			updateMaxDate(availableDates, "business_report", latestDates["latest_business_date"])
		}

		pDetail, pSummary := s.aggregateBuckets(projectBuckets, nil)
		for i := range pDetail {
			pDetail[i].InTransitQty = projectInTransitMap[pDetail[i].SKU]
		}
		projectBreakdown[pid] = daily_analysis.ProjectBreakdownBlock{
			ProjectName: projectName,
			SummaryRows: pSummary,
			DetailRows:  pDetail,
		}

		mergeBuckets(globalBuckets, projectBuckets)
	}

	for _, countryValue := range []string{"US", "DE", "UK"} {
		cDetail, cSummary := s.aggregateBuckets(countryByProjectBuckets[countryValue], nil)
		cInTransit := countryInTransitMaps[countryValue]
		for i := range cDetail {
			cDetail[i].InTransitQty = cInTransit[cDetail[i].SKU]
			c := countryValue
			cDetail[i].Country = &c
		}
		sourceCurrency := "USD"
		if countryValue == "DE" {
			sourceCurrency = "EUR"
		} else if countryValue == "UK" {
			sourceCurrency = "GBP"
		}
		countryBreakdown[countryValue] = daily_analysis.CountryBreakdownBlock{
			SummaryRows:    cSummary,
			DetailRows:     cDetail,
			Currency:       "USD",
			SourceCurrency: sourceCurrency,
		}
	}

	globalDetail, globalSummary := s.aggregateBuckets(globalBuckets, nil)
	for i := range globalDetail {
		globalDetail[i].InTransitQty = globalInTransit[globalDetail[i].SKU]
	}

	requestedDates := generateDateRange(startDate, endDate)
	currencyNote := "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。"

	return &daily_analysis.DailyAnalysisAllProjectsCountriesResponse{
		Console: daily_analysis.DailyAnalysisConsoleResponse{
			ProjectID:           0,
			ProjectName:         "全部项目",
			Country:             "ALL",
			StartDate:           startDate,
			EndDate:             endDate,
			RequestedDays:       len(requestedDates),
			SummaryDays:         len(globalSummary),
			DetailRows:          len(globalDetail),
			SalesSourceDays:     0,
			AdSourceDays:        0,
			InventorySourceDays: 0,
			BusinessSourceDays:  0,
			MissingDates:        []string{},
		},
		SummaryRows:      globalSummary,
		DetailRows:       globalDetail,
		AvailableDates:   availableDates,
		ProjectBreakdown: projectBreakdown,
		CountryBreakdown: countryBreakdown,
		Currency:         "USD",
		CurrencyNote:     &currencyNote,
	}, nil
}

func (s *DailyAnalysisStore) loadSalesMetrics(
	ctx context.Context,
	buckets map[string]*dailyMetricBucket,
	projectID int64,
	country string,
	startDate, endDate string,
) (map[string]bool, *string, error) {
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return nil, nil, err
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return nil, nil, err
	}

	rows, err := s.db.Query(
		ctx,
		`select
		   purchase_date_pt,
		   coalesce(sku, ''),
		   asin,
		   coalesce(quantity, 0),
		   coalesce(item_price, 0),
		   coalesce(shipping_price, 0),
		   coalesce(item_tax, 0),
		   coalesce(shipping_tax, 0),
		   coalesce(order_status, '')
		 from public.analysis_sales_order_rows
		 where project_id = $1
		   and country = $2
		   and purchase_date_pt >= $3
		   and purchase_date_pt <= $4
		   and is_counted_sales = true
		   and order_status != 'Cancelled'`,
		projectID,
		country,
		start,
		end,
	)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	dates := make(map[string]bool)
	var latest *string
	isVATInclusive := strings.ToUpper(country) == "DE" || strings.ToUpper(country) == "UK"

	for rows.Next() {
		var (
			purchaseDatePT time.Time
			sku            string
			asin           *string
			qty            int
			itemPrice      float64
			shippingPrice  float64
			itemTax        float64
			shippingTax    float64
			orderStatus    string
		)
		if err := rows.Scan(
			&purchaseDatePT, &sku, &asin, &qty,
			&itemPrice, &shippingPrice, &itemTax, &shippingTax,
			&orderStatus,
		); err != nil {
			return nil, nil, err
		}

		sku = strings.TrimSpace(sku)
		if sku == "" {
			continue
		}

		dateText := purchaseDatePT.Format("2006-01-02")
		dates[dateText] = true
		if latest == nil || dateText > *latest {
			l := dateText
			latest = &l
		}

		key := dateText + "\x00" + sku
		b, ok := buckets[key]
		if !ok {
			b = &dailyMetricBucket{}
			buckets[key] = b
		}
		setBucketASIN(b, asin)
		b.orderQty += qty
		st := strings.ToLower(strings.TrimSpace(orderStatus))
		if st == "pending" || st == "unshipped" {
			b.pendingOrderQty += qty
		}
		net := itemPrice + shippingPrice
		if isVATInclusive {
			b.salesAmount += net + itemTax + shippingTax
		} else {
			b.salesAmount += net
		}
	}
	return dates, latest, rows.Err()
}

func (s *DailyAnalysisStore) loadAdMetrics(
	ctx context.Context,
	buckets map[string]*dailyMetricBucket,
	projectID int64,
	country string,
	startDate, endDate string,
) (map[string]bool, *string, error) {
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return nil, nil, err
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return nil, nil, err
	}

	rows, err := s.db.Query(
		ctx,
		`select
		   f.report_date,
		   r.ad_sku,
		   r.ad_asin,
		   coalesce(r.impressions, 0),
		   coalesce(r.clicks, 0),
		   coalesce(r.spend, 0),
		   coalesce(r.orders_7d, 0)
		 from public.ad_upload_files f
		 join public.ad_upload_promoted_product_rows r on r.source_file_id = f.id
		 where f.project_id = $1
		   and f.report_type = 'ad_promoted_product_report'
		   and f.country = $2
		   and f.is_current = true
		   and f.report_date is not null
		   and f.report_date >= $3
		   and f.report_date <= $4
		   and r.scope_status = 'included_product'`,
		projectID,
		country,
		start,
		end,
	)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	dates := make(map[string]bool)
	var latest *string

	for rows.Next() {
		var (
			reportDate  time.Time
			adSKU       *string
			adASIN      *string
			impressions int
			clicks      int
			spend       float64
			orders7d    int
		)
		if err := rows.Scan(&reportDate, &adSKU, &adASIN, &impressions, &clicks, &spend, &orders7d); err != nil {
			return nil, nil, err
		}

		sku := ""
		if adSKU != nil {
			sku = strings.TrimSpace(*adSKU)
		}
		if sku == "" {
			continue
		}

		dateText := reportDate.Format("2006-01-02")
		dates[dateText] = true
		if latest == nil || dateText > *latest {
			l := dateText
			latest = &l
		}

		key := dateText + "\x00" + sku
		b, ok := buckets[key]
		if !ok {
			b = &dailyMetricBucket{}
			buckets[key] = b
		}
		setBucketASIN(b, adASIN)
		b.impressions += impressions
		b.clicks += clicks
		b.adSpend += spend
		b.adOrders += orders7d
	}
	return dates, latest, rows.Err()
}

func (s *DailyAnalysisStore) loadInventoryMetrics(
	ctx context.Context,
	buckets map[string]*dailyMetricBucket,
	projectID int64,
	country string,
	startDate, endDate string,
) (map[string]bool, *string, error) {
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return nil, nil, err
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return nil, nil, err
	}
	startDT := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	endDT := time.Date(end.Year(), end.Month(), end.Day(), 23, 59, 59, 999999999, time.UTC)

	rows, err := s.db.Query(
		ctx,
		`select id, report_date, snapshot_at
		 from public.analysis_source_files
		 where project_id = $1
		   and report_type = 'inventory_report'
		   and country = $2
		   and (
		     (report_date is not null and report_date >= $3 and report_date <= $4)
		     or (report_date is null and snapshot_at is not null and snapshot_at >= $5 and snapshot_at <= $6)
		   )
		 order by report_date desc nulls last, snapshot_at desc nulls last, version desc, id desc`,
		projectID,
		country,
		start,
		end,
		startDT,
		endDT,
	)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	latestSourceByDate := make(map[string]int64)
	for rows.Next() {
		var (
			id         int64
			reportDate *time.Time
			snapshotAt *time.Time
		)
		if err := rows.Scan(&id, &reportDate, &snapshotAt); err != nil {
			return nil, nil, err
		}
		var businessDate string
		if reportDate != nil {
			businessDate = reportDate.Format("2006-01-02")
		} else if snapshotAt != nil {
			businessDate = snapshotAt.Format("2006-01-02")
		}
		if businessDate == "" {
			continue
		}
		if _, seen := latestSourceByDate[businessDate]; !seen {
			latestSourceByDate[businessDate] = id
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	if len(latestSourceByDate) == 0 {
		return map[string]bool{}, nil, nil
	}

	sourceIDToDate := make(map[int64]string, len(latestSourceByDate))
	sourceIDs := make([]int64, 0, len(latestSourceByDate))
	var latest *string
	dates := make(map[string]bool, len(latestSourceByDate))
	for d, sid := range latestSourceByDate {
		sourceIDToDate[sid] = d
		sourceIDs = append(sourceIDs, sid)
		dates[d] = true
		if latest == nil || d > *latest {
			l := d
			latest = &l
		}
	}

	rowStmt, err := s.db.Query(
		ctx,
		`select source_file_id, coalesce(sku, ''), asin, coalesce(available_qty, 0)
		 from public.inventory_snapshot_rows
		 where source_file_id = any($1)`,
		sourceIDs,
	)
	if err != nil {
		return nil, nil, err
	}
	defer rowStmt.Close()

	for rowStmt.Next() {
		var (
			sid int64
			sku string
			asin *string
			qty int
		)
		if err := rowStmt.Scan(&sid, &sku, &asin, &qty); err != nil {
			return nil, nil, err
		}
		d := sourceIDToDate[sid]
		sku = strings.TrimSpace(sku)
		if sku == "" {
			continue
		}
		key := d + "\x00" + sku
		b, ok := buckets[key]
		if !ok {
			b = &dailyMetricBucket{}
			buckets[key] = b
		}
		setBucketASIN(b, asin)
		b.availableQty += qty
	}
	return dates, latest, rowStmt.Err()
}

func (s *DailyAnalysisStore) buildAsinToSKUMap(
	ctx context.Context,
	projectID int64,
	country string,
	startDate, endDate string,
) (map[string]string, error) {
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return nil, err
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return nil, err
	}

	rows, err := s.db.Query(
		ctx,
		`select distinct r.ad_asin, r.ad_sku
		 from public.ad_upload_files f
		 join public.ad_upload_promoted_product_rows r on r.source_file_id = f.id
		 where f.project_id = $1
		   and f.report_type = 'ad_promoted_product_report'
		   and f.country = $2
		   and f.is_current = true
		   and f.report_date is not null
		   and f.report_date >= $3
		   and f.report_date <= $4
		   and r.scope_status = 'included_product'
		   and r.ad_asin is not null
		   and r.ad_sku is not null`,
		projectID,
		country,
		start,
		end,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	asinToSKU := make(map[string]string)
	for rows.Next() {
		var asin, sku string
		if err := rows.Scan(&asin, &sku); err != nil {
			return nil, err
		}
		asin = strings.TrimSpace(asin)
		sku = strings.TrimSpace(sku)
		if asin != "" && sku != "" {
			if _, exists := asinToSKU[asin]; !exists {
				asinToSKU[asin] = sku
			}
		}
	}
	return asinToSKU, rows.Err()
}

func (s *DailyAnalysisStore) loadBusinessMetrics(
	ctx context.Context,
	buckets map[string]*dailyMetricBucket,
	projectID int64,
	country string,
	startDate, endDate string,
	asinToSKU map[string]string,
) (map[string]bool, *string, error) {
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return nil, nil, err
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return nil, nil, err
	}

	rows, err := s.db.Query(
		ctx,
		`select
		   f.period_start_date,
		   f.period_end_date,
		   r.asin,
		   coalesce(r.page_views, 0),
		   coalesce(r.units_ordered, 0),
		   coalesce(r.sessions, 0),
		   coalesce(r.ordered_sales_amount, 0)
		 from public.analysis_source_files f
		 join public.analysis_business_rows r on r.source_file_id = f.id
		 where f.project_id = $1
		   and f.report_type = 'business_report'
		   and f.country = $2
		   and f.is_current = true
		   and f.period_start_date is not null
		   and f.period_start_date = f.period_end_date
		   and f.period_start_date >= $3
		   and f.period_start_date <= $4`,
		projectID,
		country,
		start,
		end,
	)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	dates := make(map[string]bool)
	var latest *string

	for rows.Next() {
		var (
			periodStart, periodEnd time.Time
			asin                   *string
			pageViews              int
			unitsOrdered           int
			sessions               int
			salesAmount            float64
		)
		if err := rows.Scan(&periodStart, &periodEnd, &asin, &pageViews, &unitsOrdered, &sessions, &salesAmount); err != nil {
			return nil, nil, err
		}
		if asin == nil {
			continue
		}
		normASIN := strings.TrimSpace(*asin)
		if normASIN == "" {
			continue
		}

		dateText := periodStart.Format("2006-01-02")
		dates[dateText] = true
		if latest == nil || dateText > *latest {
			l := dateText
			latest = &l
		}

		sku, ok := asinToSKU[normASIN]
		if !ok {
			sku = "ASIN:" + normASIN
		}

		key := dateText + "\x00" + sku
		b, ok := buckets[key]
		if !ok {
			b = &dailyMetricBucket{}
			buckets[key] = b
		}
		b.asin = &normASIN
		b.pageViews += pageViews
		b.unitsOrdered += unitsOrdered
		b.sessions += sessions
		b.businessSalesAmount += salesAmount
	}
	return dates, latest, rows.Err()
}

func (s *DailyAnalysisStore) loadInTransitQuantities(
	ctx context.Context,
	projectID int64,
	country string,
) (map[string]int, error) {
	rows, err := s.db.Query(
		ctx,
		`select
		   i.sku,
		   coalesce(sum(i.quantity), 0)
		 from public.shipment_schedule_items i
		 join public.shipment_schedules s on s.id = i.shipment_schedule_id
		 where s.project_id = $1
		   and s.country = $2
		   and s.shipment_status in ('draft', 'in_transit')
		 group by i.sku`,
		projectID,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	inTransit := make(map[string]int)
	for rows.Next() {
		var sku string
		var qty int
		if err := rows.Scan(&sku, &qty); err != nil {
			return nil, err
		}
		sku = strings.TrimSpace(sku)
		if sku != "" {
			inTransit[sku] = qty
		}
	}
	return inTransit, rows.Err()
}

func (s *DailyAnalysisStore) loadLatestAvailableDates(
	ctx context.Context,
	projectID int64,
	country string,
) (map[string]*string, error) {
	var latestAd *time.Time
	_ = s.db.QueryRow(
		ctx,
		`select max(report_date)
		 from public.ad_upload_files
		 where project_id = $1
		   and country = $2
		   and is_current = true
		   and report_type = 'ad_promoted_product_report'
		   and report_date is not null`,
		projectID,
		country,
	).Scan(&latestAd)

	var latestSales, latestInv, latestBiz *time.Time
	_ = s.db.QueryRow(
		ctx,
		`select
		   max(report_date) filter (where report_type = 'sales_report'),
		   max(coalesce(report_date, snapshot_at::date)) filter (where report_type = 'inventory_report'),
		   max(period_start_date) filter (where report_type = 'business_report')
		 from public.analysis_source_files
		 where project_id = $1
		   and country = $2
		   and is_current = true
		   and report_type in ('sales_report', 'inventory_report', 'business_report')`,
		projectID,
		country,
	).Scan(&latestSales, &latestInv, &latestBiz)

	return map[string]*string{
		"latest_sales_date":     formatDatePtr(latestSales),
		"latest_ad_date":        formatDatePtr(latestAd),
		"latest_inventory_date": formatDatePtr(latestInv),
		"latest_business_date":  formatDatePtr(latestBiz),
	}, nil
}

func (s *DailyAnalysisStore) aggregateBuckets(
	buckets map[string]*dailyMetricBucket,
	skuFilter *string,
) ([]daily_analysis.DailyAnalysisDetailRow, []daily_analysis.DailyAnalysisSummaryRow) {
	type bucketEntry struct {
		date string
		sku  string
		b    *dailyMetricBucket
	}
	entries := make([]bucketEntry, 0, len(buckets))
	for key, b := range buckets {
		parts := strings.Split(key, "\x00")
		if len(parts) == 2 {
			entries = append(entries, bucketEntry{date: parts[0], sku: parts[1], b: b})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].date != entries[j].date {
			return entries[i].date < entries[j].date
		}
		return entries[i].sku < entries[j].sku
	})

	var detailRows []daily_analysis.DailyAnalysisDetailRow
	summaryMap := make(map[string]*dailyMetricBucket)

	for _, e := range entries {
		if skuFilter != nil && e.sku != *skuFilter {
			continue
		}
		b := e.b
		cpc := roundMoney(safeRatio(b.adSpend, float64(b.clicks)))
		var convRate float64
		if b.pageViews > 0 {
			convRate = roundMoney(safeRatio(float64(b.unitsOrdered), float64(b.pageViews)))
		}

		detailRows = append(detailRows, daily_analysis.DailyAnalysisDetailRow{
			Date:               e.date,
			SKU:                e.sku,
			ASIN:               b.asin,
			OrderQty:           b.orderQty,
			PendingOrderQty:    b.pendingOrderQty,
			SalesAmount:        roundMoney(b.salesAmount),
			Impressions:        b.impressions,
			Clicks:             b.clicks,
			CPC:                cpc,
			AdSpend:            roundMoney(b.adSpend),
			AdOrders:           b.adOrders,
			AvailableQty:       b.availableQty,
			InTransitQty:       b.inTransitQty,
			PageViews:          b.pageViews,
			UnitsOrdered:       b.unitsOrdered,
			Sessions:           b.sessions,
			OrderedSalesAmount: roundMoney(b.businessSalesAmount),
			ConversionRate:     convRate,
		})

		sum, ok := summaryMap[e.date]
		if !ok {
			sum = &dailyMetricBucket{}
			summaryMap[e.date] = sum
		}
		sum.orderQty += b.orderQty
		sum.pendingOrderQty += b.pendingOrderQty
		sum.salesAmount += b.salesAmount
		sum.impressions += b.impressions
		sum.clicks += b.clicks
		sum.adSpend += b.adSpend
		sum.adOrders += b.adOrders
		sum.availableQty += b.availableQty
		sum.pageViews += b.pageViews
		sum.unitsOrdered += b.unitsOrdered
		sum.sessions += b.sessions
		sum.businessSalesAmount += b.businessSalesAmount
	}

	var summaryDates []string
	for d := range summaryMap {
		summaryDates = append(summaryDates, d)
	}
	sort.Strings(summaryDates)

	var summaryRows []daily_analysis.DailyAnalysisSummaryRow
	for _, d := range summaryDates {
		sum := summaryMap[d]
		cpc := roundMoney(safeRatio(sum.adSpend, float64(sum.clicks)))
		var convRate float64
		if sum.pageViews > 0 {
			convRate = roundMoney(safeRatio(float64(sum.unitsOrdered), float64(sum.pageViews)))
		}
		summaryRows = append(summaryRows, daily_analysis.DailyAnalysisSummaryRow{
			Date:               d,
			OrderQty:           sum.orderQty,
			PendingOrderQty:    sum.pendingOrderQty,
			SalesAmount:        roundMoney(sum.salesAmount),
			Impressions:        sum.impressions,
			Clicks:             sum.clicks,
			CPC:                cpc,
			AdSpend:            roundMoney(sum.adSpend),
			AdOrders:           sum.adOrders,
			AvailableQty:       sum.availableQty,
			PageViews:          sum.pageViews,
			UnitsOrdered:       sum.unitsOrdered,
			Sessions:           sum.sessions,
			OrderedSalesAmount: roundMoney(sum.businessSalesAmount),
			ConversionRate:     convRate,
		})
	}

	if detailRows == nil {
		detailRows = []daily_analysis.DailyAnalysisDetailRow{}
	}
	if summaryRows == nil {
		summaryRows = []daily_analysis.DailyAnalysisSummaryRow{}
	}
	return detailRows, summaryRows
}

func (s *DailyAnalysisStore) loadUSDFactors(
	ctx context.Context,
	countries []string,
	yearMonths []string,
) (map[string]map[string]float64, error) {
	factors := make(map[string]map[string]float64) // country -> year_month -> factor
	if len(yearMonths) == 0 {
		return factors, nil
	}

	for _, country := range countries {
		factors[country] = make(map[string]float64)
		var currency string
		switch country {
		case "US":
			currency = "USD"
		case "DE":
			currency = "EUR"
		case "UK":
			currency = "GBP"
		default:
			continue
		}

		for _, ym := range yearMonths {
			if currency == "USD" {
				factors[country][ym] = 1.0
				continue
			}

			sourceRate, err := s.resolveExchangeRate(ctx, currency, ym)
			if err != nil || sourceRate <= 0 {
				return nil, fmt.Errorf("%w: missing %s rate for %s", daily_analysis.ErrExchangeRateMissing, currency, ym)
			}
			usdRate, err := s.resolveExchangeRate(ctx, "USD", ym)
			if err != nil || usdRate <= 0 {
				return nil, fmt.Errorf("%w: missing USD rate for %s", daily_analysis.ErrExchangeRateMissing, ym)
			}
			factors[country][ym] = sourceRate / usdRate
		}
	}
	return factors, nil
}

func (s *DailyAnalysisStore) resolveExchangeRate(
	ctx context.Context,
	currency string,
	yearMonth string,
) (float64, error) {
	queries := []struct {
		sql  string
		args []any
	}{
		{
			sql:  `select rate from public.exchange_rates where currency = $1 and year_month = $2 limit 1`,
			args: []any{currency, yearMonth},
		},
		{
			sql:  `select rate from public.exchange_rates where currency = $1 and year_month <= $2 order by year_month desc, id desc limit 1`,
			args: []any{currency, yearMonth},
		},
		{
			sql:  `select rate from public.exchange_rates where currency = $1 order by year_month desc, id desc limit 1`,
			args: []any{currency},
		},
	}

	for _, q := range queries {
		var rate float64
		err := s.db.QueryRow(ctx, q.sql, q.args...).Scan(&rate)
		if err == nil {
			return rate, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}
	}
	return 0, daily_analysis.ErrExchangeRateMissing
}

func convertBucketAmountsToUSD(
	buckets map[string]*dailyMetricBucket,
	country string,
	usdFactors map[string]map[string]float64,
) {
	countryFactors := usdFactors[country]
	if countryFactors == nil {
		return
	}
	for key, b := range buckets {
		parts := strings.Split(key, "\x00")
		if len(parts) < 1 || len(parts[0]) < 7 {
			continue
		}
		ym := parts[0][:7]
		factor, ok := countryFactors[ym]
		if !ok {
			continue
		}
		b.salesAmount = roundMoney(b.salesAmount * factor)
		b.adSpend = roundMoney(b.adSpend * factor)
		b.businessSalesAmount = roundMoney(b.businessSalesAmount * factor)
	}
}

func mergeBuckets(target, source map[string]*dailyMetricBucket) {
	for key, b := range source {
		tb, ok := target[key]
		if !ok {
			tb = &dailyMetricBucket{}
			target[key] = tb
		}
		setBucketASIN(tb, b.asin)
		tb.orderQty += b.orderQty
		tb.pendingOrderQty += b.pendingOrderQty
		tb.salesAmount += b.salesAmount
		tb.impressions += b.impressions
		tb.clicks += b.clicks
		tb.adSpend += b.adSpend
		tb.adOrders += b.adOrders
		tb.availableQty += b.availableQty
		tb.pageViews += b.pageViews
		tb.unitsOrdered += b.unitsOrdered
		tb.sessions += b.sessions
		tb.businessSalesAmount += b.businessSalesAmount
	}
}

func updateMaxDate(m map[string][]string, key string, newDate *string) {
	if newDate == nil {
		return
	}
	cur := m[key]
	if len(cur) == 0 || *newDate > cur[0] {
		m[key] = []string{*newDate}
	}
}

func setBucketASIN(b *dailyMetricBucket, asin *string) {
	if b.asin == nil && asin != nil {
		norm := strings.TrimSpace(*asin)
		if norm != "" {
			b.asin = &norm
		}
	}
}

func formatDatePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	formatted := t.Format("2006-01-02")
	return &formatted
}

func generateDateRange(startDate, endDate string) []string {
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return []string{}
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return []string{}
	}
	var dates []string
	for cur := start; !cur.After(end); cur = cur.AddDate(0, 0, 1) {
		dates = append(dates, cur.Format("2006-01-02"))
	}
	return dates
}

func yearMonthsInRange(startDate, endDate string) []string {
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return nil
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	var result []string
	cur := time.Date(start.Year(), start.Month(), 1, 0, 0, 0, 0, time.UTC)
	endMonth := time.Date(end.Year(), end.Month(), 1, 0, 0, 0, 0, time.UTC)
	for !cur.After(endMonth) {
		ym := cur.Format("2006-01")
		if !seen[ym] {
			seen[ym] = true
			result = append(result, ym)
		}
		cur = cur.AddDate(0, 1, 0)
	}
	sort.Strings(result)
	return result
}

func setToSortedSlice(set map[string]bool) []string {
	result := make([]string, 0, len(set))
	for k := range set {
		result = append(result, k)
	}
	sort.Strings(result)
	return result
}

func roundHalfUp(value float64, decimals int) float64 {
	rat, ok := new(big.Rat).SetString(strconv.FormatFloat(value, 'f', -1, 64))
	if !ok {
		return 0
	}
	factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	scaledNumerator := new(big.Int).Mul(rat.Num(), factor)
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(scaledNumerator, rat.Denom(), remainder)
	absRemainder := new(big.Int).Abs(remainder)
	twiceRemainder := new(big.Int).Lsh(absRemainder, 1)
	if twiceRemainder.Cmp(rat.Denom()) >= 0 {
		if scaledNumerator.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	rounded := new(big.Rat).SetFrac(quotient, factor)
	result, _ := rounded.Float64()
	return result
}

func roundMoney(v float64) float64 {
	return roundHalfUp(v, 2)
}

func safeRatio(num float64, denom float64) float64 {
	if denom <= 0 {
		return 0
	}
	return num / denom
}
