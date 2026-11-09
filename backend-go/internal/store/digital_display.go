package store

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/digital_display"
)

type DigitalDisplayStore struct {
	db DB
}

var _ digital_display.Store = (*DigitalDisplayStore)(nil)

func NewDigitalDisplayStore(db DB) *DigitalDisplayStore {
	return &DigitalDisplayStore{db: db}
}

type digitalSalesAggregate struct {
	OrderQty    int64
	SalesAmount float64
}

type digitalBusinessAggregate struct {
	Sessions           int64
	OrderedSalesAmount float64
}

func (s *DigitalDisplayStore) BuildDigitalDisplay(
	ctx context.Context,
	projectID int64,
	country string,
	days int,
	now time.Time,
) (digital_display.Response, error) {
	var projectName string
	err := s.db.QueryRow(
		ctx,
		`select project_name from public.projects where id = $1`,
		projectID,
	).Scan(&projectName)
	if errors.Is(err, pgx.ErrNoRows) {
		return digital_display.Response{}, digital_display.ErrProjectNotFound
	}
	if err != nil {
		return digital_display.Response{}, err
	}

	normalizedCountry, err := digital_display.NormalizeCountry(country)
	if err != nil {
		return digital_display.Response{}, err
	}
	now = now.UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	periodStart := today.AddDate(0, 0, -(days - 1))
	prevEnd := today.AddDate(0, 0, -1)
	prevStart := prevEnd.AddDate(0, 0, -(days - 1))

	salesByDate, err := s.loadSalesAggregates(ctx, projectID, normalizedCountry, prevStart, today)
	if err != nil {
		return digital_display.Response{}, err
	}
	business, err := s.loadBusinessAggregate(ctx, projectID, normalizedCountry)
	if err != nil {
		return digital_display.Response{}, err
	}
	inventory, err := s.loadInventorySnapshot(ctx, projectID, normalizedCountry)
	if err != nil {
		return digital_display.Response{}, err
	}
	shipments, err := s.loadShipmentSnapshot(ctx, projectID, normalizedCountry)
	if err != nil {
		return digital_display.Response{}, err
	}
	returns, err := s.loadReturnSnapshot(
		ctx,
		projectID,
		normalizedCountry,
		periodStart,
		today,
	)
	if err != nil {
		return digital_display.Response{}, err
	}
	ads, err := s.loadAdSnapshot(ctx, projectID, normalizedCountry, periodStart, today)
	if err != nil {
		return digital_display.Response{}, err
	}

	todaySales := salesByDate[today.Format("2006-01-02")]
	previousPeriod := digitalSalesAggregate{}
	for day := prevStart; !day.After(prevEnd); day = day.AddDate(0, 0, 1) {
		item := salesByDate[day.Format("2006-01-02")]
		previousPeriod.OrderQty += item.OrderQty
		previousPeriod.SalesAmount += item.SalesAmount
	}

	trend := make([]digital_display.SalesTrendItem, 0, days)
	for offset := days - 1; offset >= 0; offset-- {
		day := today.AddDate(0, 0, -offset)
		item := salesByDate[day.Format("2006-01-02")]
		trend = append(trend, digital_display.SalesTrendItem{
			Date:        day.Format("2006-01-02"),
			OrderQty:    int(item.OrderQty),
			SalesAmount: roundDigitalDisplayMoney(item.SalesAmount),
			Sessions:    int(business.Sessions),
		})
	}

	return digital_display.Response{
		ProjectID:   projectID,
		ProjectName: projectName,
		Country:     normalizedCountry,
		ServerTime:  today.Format("2006-01-02"),
		Sales: digital_display.SalesSnapshot{
			TodayOrderQty:           int(todaySales.OrderQty),
			TodaySalesAmount:        roundDigitalDisplayMoney(todaySales.SalesAmount),
			TodaySessions:           int(business.Sessions),
			TodayOrderedSalesAmount: roundDigitalDisplayMoney(business.OrderedSalesAmount),
			PrevOrderQty:            int(previousPeriod.OrderQty),
			PrevSalesAmount:         roundDigitalDisplayMoney(previousPeriod.SalesAmount),
			PrevSessions:            int(business.Sessions),
		},
		SalesTrend: trend,
		Inventory:  inventory,
		Shipments:  shipments,
		Returns:    returns,
		Ads:        ads,
	}, nil
}

func (s *DigitalDisplayStore) loadSalesAggregates(
	ctx context.Context,
	projectID int64,
	country string,
	start, end time.Time,
) (map[string]digitalSalesAggregate, error) {
	rows, err := s.db.Query(
		ctx,
		`select
		   purchase_date_pt::text,
		   coalesce(sum(quantity), 0),
		   coalesce(sum(
		     case
		       when upper(country) in ('DE', 'UK') then
		         coalesce(item_price, 0) + coalesce(shipping_price, 0) +
		         coalesce(item_tax, 0) + coalesce(shipping_tax, 0)
		       else
		         coalesce(item_price, 0) + coalesce(shipping_price, 0)
		     end
		   ), 0)
		 from public.analysis_sales_order_rows
		 where project_id = $1
		   and country = $2
		   and purchase_date_pt >= $3
		   and purchase_date_pt <= $4
		   and is_counted_sales = true
		   and order_status <> 'Cancelled'
		 group by purchase_date_pt
		 order by purchase_date_pt asc`,
		projectID,
		country,
		start,
		end,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]digitalSalesAggregate)
	for rows.Next() {
		var dateText string
		var quantity int64
		var amount pgtype.Numeric
		if err := rows.Scan(&dateText, &quantity, &amount); err != nil {
			return nil, err
		}
		result[dateText] = digitalSalesAggregate{
			OrderQty:    quantity,
			SalesAmount: digitalNumericFloat(amount),
		}
	}
	return result, rows.Err()
}

func (s *DigitalDisplayStore) loadBusinessAggregate(
	ctx context.Context,
	projectID int64,
	country string,
) (digitalBusinessAggregate, error) {
	var sessions int64
	var orderedSales pgtype.Numeric
	err := s.db.QueryRow(
		ctx,
		`select
		   coalesce(sum(b.sessions), 0),
		   coalesce(sum(b.ordered_sales_amount), 0)
		 from public.analysis_business_rows b
		 join public.analysis_source_files sf on sf.id = b.source_file_id
		 where sf.project_id = $1
		   and sf.country = $2
		   and sf.report_type = 'business_report'
		   and sf.is_current = true`,
		projectID,
		country,
	).Scan(&sessions, &orderedSales)
	if err != nil {
		return digitalBusinessAggregate{}, err
	}
	return digitalBusinessAggregate{
		Sessions:           sessions,
		OrderedSalesAmount: digitalNumericFloat(orderedSales),
	}, nil
}

func (s *DigitalDisplayStore) loadInventorySnapshot(
	ctx context.Context,
	projectID int64,
	country string,
) (digital_display.InventorySnapshot, error) {
	var skuCount, outOfStockCount, availableQty int64
	err := s.db.QueryRow(
		ctx,
		`select
		   count(distinct sku),
		   count(distinct sku) filter (where available_qty <= 0),
		   coalesce(sum(available_qty), 0)
		 from public.inventory_snapshot_rows
		 where source_file_id = (
		   select id
		   from public.analysis_source_files
		   where project_id = $1
		     and country = $2
		     and report_type = 'inventory_report'
		     and is_current = true
		   order by report_date desc nulls last, snapshot_at desc nulls last
		   limit 1
		 )`,
		projectID,
		country,
	).Scan(&skuCount, &outOfStockCount, &availableQty)
	if err != nil {
		return digital_display.InventorySnapshot{}, err
	}
	return digital_display.InventorySnapshot{
		SKUCount:        int(skuCount),
		OutOfStockCount: int(outOfStockCount),
		AvailableQty:    int(availableQty),
	}, nil
}

func (s *DigitalDisplayStore) loadShipmentSnapshot(
	ctx context.Context,
	projectID int64,
	country string,
) (digital_display.ShipmentSnapshot, error) {
	var count, quantity int64
	err := s.db.QueryRow(
		ctx,
		`select
		   count(distinct ss.id),
		   coalesce(sum(si.quantity), 0)
		 from public.shipment_schedules ss
		 left join public.shipment_schedule_items si
		   on si.shipment_schedule_id = ss.id
		 where ss.project_id = $1
		   and ss.country = $2
		   and ss.shipment_status = 'in_transit'`,
		projectID,
		country,
	).Scan(&count, &quantity)
	if err != nil {
		return digital_display.ShipmentSnapshot{}, err
	}
	return digital_display.ShipmentSnapshot{
		InTransitCount: int(count),
		InTransitQty:   int(quantity),
	}, nil
}

func (s *DigitalDisplayStore) loadReturnSnapshot(
	ctx context.Context,
	projectID int64,
	country string,
	start, end time.Time,
) (digital_display.ReturnSnapshot, error) {
	var totalReturns, totalQuantity int64
	err := s.db.QueryRow(
		ctx,
		`select
		   count(rr.id),
		   coalesce(sum(rr.quantity), 0)
		 from public.analysis_return_rows rr
		 join public.analysis_source_files sf on sf.id = rr.source_file_id
		 where sf.project_id = $1
		   and sf.country = $2
		   and sf.report_type = 'return_report'
		   and sf.is_current = true
		   and rr.return_date >= $3
		   and rr.return_date <= $4`,
		projectID,
		country,
		start,
		end,
	).Scan(&totalReturns, &totalQuantity)
	if err != nil {
		return digital_display.ReturnSnapshot{}, err
	}

	var reason string
	var reasonCount int64
	err = s.db.QueryRow(
		ctx,
		`select rr.reason, count(rr.id)
		 from public.analysis_return_rows rr
		 join public.analysis_source_files sf on sf.id = rr.source_file_id
		 where sf.project_id = $1
		   and sf.country = $2
		   and sf.report_type = 'return_report'
		   and sf.is_current = true
		   and rr.return_date >= $3
		   and rr.return_date <= $4
		 group by rr.reason
		 order by count(rr.id) desc
		 limit 1`,
		projectID,
		country,
		start,
		end,
	).Scan(&reason, &reasonCount)
	var topReason *string
	if err == nil {
		translated := digital_display.TranslateReturnReason(reason)
		topReason = &translated
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return digital_display.ReturnSnapshot{}, err
	}

	var salesQuantity int64
	err = s.db.QueryRow(
		ctx,
		`select coalesce(sum(quantity), 0)
		 from public.analysis_sales_order_rows
		 where project_id = $1
		   and country = $2
		   and purchase_date_pt >= $3
		   and purchase_date_pt <= $4
		   and is_counted_sales = true
		   and order_status <> 'Cancelled'`,
		projectID,
		country,
		start,
		end,
	).Scan(&salesQuantity)
	if err != nil {
		return digital_display.ReturnSnapshot{}, err
	}

	return digital_display.ReturnSnapshot{
		TotalReturns:  int(totalReturns),
		TotalQuantity: int(totalQuantity),
		ReturnRate:    digitalDisplayRate(float64(totalQuantity), float64(salesQuantity)),
		TopReason:     topReason,
	}, nil
}

func (s *DigitalDisplayStore) loadAdSnapshot(
	ctx context.Context,
	projectID int64,
	country string,
	start, end time.Time,
) (digital_display.AdSnapshot, error) {
	var spend, sales pgtype.Numeric
	var clicks, impressions, orders int64
	err := s.db.QueryRow(
		ctx,
		`select
		   coalesce(sum(r.spend), 0),
		   coalesce(sum(r.sales_7d), 0),
		   coalesce(sum(r.clicks), 0),
		   coalesce(sum(r.impressions), 0),
		   coalesce(sum(r.orders_7d), 0)
		 from public.ad_upload_promoted_product_rows r
		 join public.ad_upload_files f on f.id = r.source_file_id
		 where f.project_id = $1
		   and f.country = $2
		   and f.report_type = 'ad_promoted_product_report'
		   and f.is_current = true
		   and f.period_end_date >= $3
		   and f.period_end_date <= $4
		   and r.scope_status = 'included_product'`,
		projectID,
		country,
		start,
		end,
	).Scan(&spend, &sales, &clicks, &impressions, &orders)
	if err != nil {
		return digital_display.AdSnapshot{}, err
	}

	spendValue := digitalNumericFloat(spend)
	salesValue := digitalNumericFloat(sales)
	roas := 0.0
	if spendValue > 0 {
		roas = roundDigitalDisplayRatio(salesValue / spendValue)
	}
	acos := 0.0
	if salesValue > 0 {
		acos = roundDigitalDisplayRatio(spendValue / salesValue * 100)
	}
	ctr := 0.0
	if impressions > 0 {
		ctr = roundDigitalDisplayRatio(float64(clicks) / float64(impressions) * 100)
	}
	return digital_display.AdSnapshot{
		PeriodSpend:       roundDigitalDisplayRatio(spendValue),
		PeriodSales:       roundDigitalDisplayRatio(salesValue),
		PeriodROAS:        roas,
		PeriodACOS:        acos,
		PeriodCTR:         ctr,
		PeriodImpressions: int(impressions),
		PeriodClicks:      int(clicks),
		PeriodOrders:      int(orders),
	}, nil
}

func digitalNumericFloat(value pgtype.Numeric) float64 {
	if !value.Valid {
		return 0
	}
	result, err := value.Float64Value()
	if err != nil || !result.Valid {
		return 0
	}
	return result.Float64
}

func roundDigitalDisplayMoney(value float64) float64 {
	return math.Round(value*100) / 100
}

func roundDigitalDisplayRatio(value float64) float64 {
	return math.Round(value*100) / 100
}

func digitalDisplayRate(numerator, denominator float64) float64 {
	if denominator <= 0 {
		return 0
	}
	return roundDigitalDisplayRatio(numerator / denominator * 100)
}
