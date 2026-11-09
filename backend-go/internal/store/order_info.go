package store

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/order_info"
)

type OrderInfoStore struct {
	db FullDB
}

func NewOrderInfoStore(db FullDB) *OrderInfoStore {
	return &OrderInfoStore{db: db}
}

func (s *OrderInfoStore) getAccessibleProjectIDs(ctx context.Context, operator string, isAdmin bool) ([]int64, error) {
	if isAdmin {
		return nil, nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return []int64{}, nil
	}
	rows, err := s.db.Query(ctx, `
		select id
		from public.projects
		where coalesce(is_active, true) = true
		  and (
		    exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(project_operator, ''),
		        '[、,，;' || chr(10) || ']+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		    or exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(assistant_operator, ''),
		        '[、,，;' || chr(10) || ']+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		  )
		order by sort_order asc, id asc
	`, operator)
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
	if ids == nil {
		ids = []int64{}
	}
	return ids, rows.Err()
}

func (s *OrderInfoStore) resolveProjectScope(ctx context.Context, filter order_info.OrderInfoFilter) ([]int64, bool, error) {
	if filter.IsAdmin {
		return filter.ProjectIDs, true, nil
	}
	accessible, err := s.getAccessibleProjectIDs(ctx, filter.Operator, false)
	if err != nil {
		return nil, false, err
	}
	if len(accessible) == 0 {
		return []int64{}, false, nil
	}
	if len(filter.ProjectIDs) == 0 {
		return accessible, true, nil
	}
	accSet := make(map[int64]bool, len(accessible))
	for _, id := range accessible {
		accSet[id] = true
	}
	var scoped []int64
	for _, id := range filter.ProjectIDs {
		if accSet[id] {
			scoped = append(scoped, id)
		}
	}
	if len(scoped) == 0 {
		return []int64{}, false, nil
	}
	return scoped, true, nil
}

func (s *OrderInfoStore) GetPageData(ctx context.Context, filter order_info.OrderInfoFilter) (order_info.OrderInfoPageData, error) {
	orders, err := s.ListOrders(ctx, filter)
	if err != nil {
		return order_info.OrderInfoPageData{}, err
	}
	stats, err := s.ComputeStats(ctx, filter)
	if err != nil {
		return order_info.OrderInfoPageData{}, err
	}
	opts, err := s.CollectFilterOptions(ctx, filter.Operator, filter.IsAdmin)
	if err != nil {
		return order_info.OrderInfoPageData{}, err
	}
	return order_info.OrderInfoPageData{
		Items:         orders.Items,
		Total:         orders.Total,
		Page:          orders.Page,
		PageSize:      orders.PageSize,
		Stats:         stats,
		FilterOptions: opts,
	}, nil
}

func (s *OrderInfoStore) GetOverview(ctx context.Context, filter order_info.OrderInfoFilter) (order_info.OrderInfoOverview, error) {
	orders, err := s.ListOrders(ctx, filter)
	if err != nil {
		return order_info.OrderInfoOverview{}, err
	}
	stats, err := s.ComputeStats(ctx, filter)
	if err != nil {
		return order_info.OrderInfoOverview{}, err
	}
	return order_info.OrderInfoOverview{
		Items:    orders.Items,
		Total:    orders.Total,
		Page:     orders.Page,
		PageSize: orders.PageSize,
		Stats:    stats,
	}, nil
}

func buildOrderInfoWhere(scopedProjectIDs []int64, filter order_info.OrderInfoFilter) (string, []any) {
	var conditions []string
	var args []any
	idx := 1

	if len(scopedProjectIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("r.project_id = any($%d)", idx))
		args = append(args, scopedProjectIDs)
		idx++
	}

	if len(filter.OrderStatuses) > 0 {
		conditions = append(conditions, fmt.Sprintf("r.order_status = any($%d)", idx))
		args = append(args, filter.OrderStatuses)
		idx++
	}

	if len(filter.Countries) > 0 {
		conditions = append(conditions, fmt.Sprintf("upper(r.country) = any($%d)", idx))
		upperCountries := make([]string, len(filter.Countries))
		for i, c := range filter.Countries {
			upperCountries[i] = strings.ToUpper(c)
		}
		args = append(args, upperCountries)
		idx++
	}

	if len(filter.Currencies) > 0 {
		conditions = append(conditions, fmt.Sprintf("r.currency = any($%d)", idx))
		args = append(args, filter.Currencies)
		idx++
	}

	if len(filter.FulfillmentChannels) > 0 {
		conditions = append(conditions, fmt.Sprintf("coalesce(r.fulfillment_channel, r.raw_row->>'fulfillment-channel', r.raw_row->>'fulfillment channel') = any($%d)", idx))
		args = append(args, filter.FulfillmentChannels)
		idx++
	}

	if filter.SKUKeyword != nil && *filter.SKUKeyword != "" {
		conditions = append(conditions, fmt.Sprintf("r.sku ilike $%d", idx))
		args = append(args, "%"+*filter.SKUKeyword+"%")
		idx++
	}

	if filter.OrderIDKeyword != nil && *filter.OrderIDKeyword != "" {
		conditions = append(conditions, fmt.Sprintf("r.amazon_order_id ilike $%d", idx))
		args = append(args, "%"+*filter.OrderIDKeyword+"%")
		idx++
	}

	if filter.ASINKeyword != nil && *filter.ASINKeyword != "" {
		conditions = append(conditions, fmt.Sprintf("r.asin ilike $%d", idx))
		args = append(args, "%"+*filter.ASINKeyword+"%")
		idx++
	}

	if filter.DateFrom != nil && *filter.DateFrom != "" {
		conditions = append(conditions, fmt.Sprintf("r.purchase_date_pt >= $%d", idx))
		args = append(args, *filter.DateFrom)
		idx++
	}

	if filter.DateTo != nil && *filter.DateTo != "" {
		conditions = append(conditions, fmt.Sprintf("r.purchase_date_pt <= $%d", idx))
		args = append(args, *filter.DateTo)
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}
	return where, args
}

func (s *OrderInfoStore) ListOrders(ctx context.Context, filter order_info.OrderInfoFilter) (order_info.OrderInfoListResponse, error) {
	scopedIDs, hasAccess, err := s.resolveProjectScope(ctx, filter)
	if err != nil {
		return order_info.OrderInfoListResponse{}, err
	}
	if !hasAccess {
		return order_info.OrderInfoListResponse{
			Items:    []order_info.OrderInfoItem{},
			Total:    0,
			Page:     filter.Page,
			PageSize: filter.PageSize,
		}, nil
	}

	where, args := buildOrderInfoWhere(scopedIDs, filter)

	countSQL := fmt.Sprintf(`
		select count(*)
		from public.analysis_sales_order_rows r
		%s
	`, where)

	var total int
	if err := s.db.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return order_info.OrderInfoListResponse{}, err
	}

	sortCol := "r.purchase_at_pt"
	switch filter.SortBy {
	case "purchase_date_pt":
		sortCol = "r.purchase_date_pt"
	case "quantity":
		sortCol = "r.quantity"
	case "item_price":
		sortCol = "r.item_price"
	case "id":
		sortCol = "r.id"
	}
	sortDir := "desc"
	if strings.ToLower(filter.SortDir) == "asc" {
		sortDir = "asc"
	}

	limitIdx := len(args) + 1
	offsetIdx := len(args) + 2
	args = append(args, filter.PageSize, filter.Offset)

	querySQL := fmt.Sprintf(`
		select
			r.id, r.project_id, coalesce(p.project_name, ''), p.brand_name, r.source_file_id,
			r.purchase_at_utc, r.purchase_at_pt, r.purchase_date_pt,
			r.amazon_order_id, r.order_status,
			coalesce(r.fulfillment_channel, r.raw_row->>'fulfillment-channel', r.raw_row->>'fulfillment channel', 'Amazon'),
			r.raw_row->>'ship-service-level',
			r.sku, r.asin, coalesce(r.raw_row->>'product-name', r.raw_row->>'product name'),
			r.quantity, coalesce(r.item_price, 0), coalesce(r.shipping_price, 0), r.currency,
			coalesce(r.country, 'US'),
			coalesce(r.raw_row->>'ship-state', r.raw_row->>'ship state'),
			coalesce(r.raw_row->>'ship-city', r.raw_row->>'ship city'),
			coalesce(r.raw_row->>'ship-postal-code', r.raw_row->>'ship postal code'),
			coalesce(r.is_counted_sales, false),
			r.created_at, r.carrier, r.tracking_no, r.shipped_at, r.updated_by, r.updated_at
		from public.analysis_sales_order_rows r
		left join public.projects p on p.id = r.project_id
		%s
		order by %s %s
		limit $%d offset $%d
	`, where, sortCol, sortDir, limitIdx, offsetIdx)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return order_info.OrderInfoListResponse{}, err
	}
	defer rows.Close()

	items := make([]order_info.OrderInfoItem, 0)
	for rows.Next() {
		var item order_info.OrderInfoItem
		var purchaseAtUTC, purchaseAtPT, createdAt time.Time
		var purchaseDatePT time.Time
		var shippedAt, updatedAt *time.Time

		err := rows.Scan(
			&item.ID, &item.ProjectID, &item.ProjectName, &item.BrandName, &item.SourceFileID,
			&purchaseAtUTC, &purchaseAtPT, &purchaseDatePT,
			&item.AmazonOrderID, &item.OrderStatus,
			&item.FulfillmentChannel, &item.ShipServiceLevel,
			&item.SKU, &item.ASIN, &item.ProductName,
			&item.Quantity, &item.ItemPrice, &item.ShippingPrice, &item.Currency,
			&item.Country, &item.State, &item.City, &item.PostalCode,
			&item.IsCountedSales,
			&createdAt, &item.Carrier, &item.TrackingNo, &shippedAt, &item.UpdatedBy, &updatedAt,
		)
		if err != nil {
			return order_info.OrderInfoListResponse{}, err
		}

		item.PurchaseAtUTC = purchaseAtUTC.UTC().Format(time.RFC3339Nano)
		item.PurchaseAtPT = purchaseAtPT.Format("2006-01-02T15:04:05.999999")
		item.PurchaseDatePT = purchaseDatePT.Format("2006-01-02")
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		if shippedAt != nil {
			tStr := shippedAt.UTC().Format(time.RFC3339Nano)
			item.ShippedAt = &tStr
		}
		if updatedAt != nil {
			tStr := updatedAt.UTC().Format(time.RFC3339Nano)
			item.UpdatedAt = &tStr
		}
		item.FulfillmentLabel = order_info.FulfillmentLabel(item.FulfillmentChannel)
		items = append(items, item)
	}

	return order_info.OrderInfoListResponse{
		Items:    items,
		Total:    total,
		Page:     filter.Page,
		PageSize: filter.PageSize,
	}, nil
}

func (s *OrderInfoStore) ComputeStats(ctx context.Context, filter order_info.OrderInfoFilter) (order_info.OrderInfoStats, error) {
	scopedIDs, hasAccess, err := s.resolveProjectScope(ctx, filter)
	if err != nil {
		return order_info.OrderInfoStats{}, err
	}
	if !hasAccess {
		return order_info.OrderInfoStats{}, nil
	}

	where, args := buildOrderInfoWhere(scopedIDs, filter)

	querySQL := fmt.Sprintf(`
		select
			count(*),
			coalesce(sum(r.quantity), 0),
			coalesce(sum(r.item_price + r.shipping_price), 0),
			count(*) filter (where coalesce(r.fulfillment_channel, r.raw_row->>'fulfillment-channel', r.raw_row->>'fulfillment channel') in ('Amazon', 'FBA')),
			count(*) filter (where coalesce(r.fulfillment_channel, r.raw_row->>'fulfillment-channel', r.raw_row->>'fulfillment channel') in ('Merchant', 'FBM'))
		from public.analysis_sales_order_rows r
		%s
	`, where)

	var stats order_info.OrderInfoStats
	err = s.db.QueryRow(ctx, querySQL, args...).Scan(
		&stats.TotalOrders,
		&stats.TotalQuantity,
		&stats.TotalAmount,
		&stats.FBACount,
		&stats.FBMCount,
	)
	if err != nil {
		return stats, err
	}

	if len(filter.Currencies) == 1 {
		curr := filter.Currencies[0]
		stats.Currency = &curr
	}

	return stats, nil
}

func (s *OrderInfoStore) CollectFilterOptions(ctx context.Context, operator string, isAdmin bool) (order_info.OrderInfoFilterOptions, error) {
	opts := order_info.OrderInfoFilterOptions{
		Projects:            make([]order_info.FilterOption, 0),
		OrderStatuses:       make([]order_info.FilterOption, 0),
		FulfillmentChannels: make([]order_info.FilterOption, 0),
		Countries:           make([]order_info.FilterOption, 0),
		Currencies:          make([]order_info.FilterOption, 0),
	}

	operator = strings.TrimSpace(operator)
	projectQuery := `
		select id, coalesce(project_name, ''), brand_name
		from public.projects
		where coalesce(is_active, true) = true
		  and (
		    $1::boolean
		    or (
		      $2::text <> ''
		      and (
		        exists (
		          select 1 from unnest(regexp_split_to_array(
		            coalesce(project_operator, ''),
		            '[、,，;' || chr(10) || ']+'
		          )) as names(value)
		          where btrim(names.value) = $2
		        )
		        or exists (
		          select 1 from unnest(regexp_split_to_array(
		            coalesce(assistant_operator, ''),
		            '[、,，;' || chr(10) || ']+'
		          )) as names(value)
		          where btrim(names.value) = $2
		        )
		      )
		    )
		  )
		order by sort_order asc, id asc
	`
	rows, err := s.db.Query(ctx, projectQuery, isAdmin, operator)
	if err == nil {
		for rows.Next() {
			var id int64
			var name string
			var brandName *string
			if err := rows.Scan(&id, &name, &brandName); err == nil {
				label := name
				if brandName != nil && strings.TrimSpace(*brandName) != "" {
					label = fmt.Sprintf("%s（%s）", name, strings.TrimSpace(*brandName))
				}
				opts.Projects = append(opts.Projects, order_info.FilterOption{
					Value: strconv.FormatInt(id, 10),
					Label: label,
				})
			}
		}
		rows.Close()
	}

	opts.FulfillmentChannels = []order_info.FilterOption{
		{Value: "Amazon", Label: "FBA（亚马逊配送）"},
		{Value: "Merchant", Label: "FBM（自发货配送）"},
	}

	// Order statuses
	rows, err = s.db.Query(ctx, `
		select distinct order_status
		from public.analysis_sales_order_rows
		where order_status is not null and trim(order_status) <> ''
		order by order_status asc
	`)
	if err == nil {
		for rows.Next() {
			var status string
			if err := rows.Scan(&status); err == nil {
				opts.OrderStatuses = append(opts.OrderStatuses, order_info.FilterOption{
					Value: status,
					Label: status,
				})
			}
		}
		rows.Close()
	}

	// Countries
	rows, err = s.db.Query(ctx, `
		select distinct upper(country)
		from public.analysis_sales_order_rows
		where country is not null and trim(country) <> ''
		order by upper(country) asc
	`)
	if err == nil {
		for rows.Next() {
			var c string
			if err := rows.Scan(&c); err == nil {
				opts.Countries = append(opts.Countries, order_info.FilterOption{
					Value: c,
					Label: c,
				})
			}
		}
		rows.Close()
	}

	// Currencies
	rows, err = s.db.Query(ctx, `
		select distinct currency
		from public.analysis_sales_order_rows
		where currency is not null and trim(currency) <> ''
		order by currency asc
	`)
	if err == nil {
		for rows.Next() {
			var curr string
			if err := rows.Scan(&curr); err == nil {
				opts.Currencies = append(opts.Currencies, order_info.FilterOption{
					Value: curr,
					Label: curr,
				})
			}
		}
		rows.Close()
	}

	return opts, nil
}

func (s *OrderInfoStore) QueryLiveStream(ctx context.Context, projectIDs []int64, countries []string, limit int, operator string, isAdmin bool) ([]order_info.OrderLiveStreamItem, error) {
	scopedIDs, hasAccess, err := s.resolveProjectScope(ctx, order_info.OrderInfoFilter{
		ProjectIDs: projectIDs,
		Operator:   operator,
		IsAdmin:    isAdmin,
	})
	if err != nil {
		return nil, err
	}
	if !hasAccess {
		return []order_info.OrderLiveStreamItem{}, nil
	}

	var conditions []string
	var args []any
	idx := 1

	if len(scopedIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("r.project_id = any($%d)", idx))
		args = append(args, scopedIDs)
		idx++
	}
	if len(countries) > 0 {
		conditions = append(conditions, fmt.Sprintf("upper(r.country) = any($%d)", idx))
		upper := make([]string, len(countries))
		for i, c := range countries {
			upper[i] = strings.ToUpper(c)
		}
		args = append(args, upper)
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	querySQL := fmt.Sprintf(`
		select
			r.amazon_order_id, r.project_id, coalesce(p.project_name, ''),
			r.country, r.currency,
			r.item_price + r.shipping_price, r.quantity, r.order_status,
			r.purchase_at_utc
		from public.analysis_sales_order_rows r
		left join public.projects p on p.id = r.project_id
		%s
		order by r.purchase_at_utc desc
		limit $%d
	`, where, idx)
	args = append(args, limit)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	beijingLoc, _ := time.LoadLocation("Asia/Shanghai")
	if beijingLoc == nil {
		beijingLoc = time.FixedZone("CST", 8*3600)
	}

	var items []order_info.OrderLiveStreamItem
	for rows.Next() {
		var amazonOrderID, projName, country, status string
		var projectID int64
		var currency *string
		var amount float64
		var quantity int
		var purchaseAtUTC time.Time

		if err := rows.Scan(&amazonOrderID, &projectID, &projName, &country, &currency, &amount, &quantity, &status, &purchaseAtUTC); err != nil {
			return nil, err
		}

		beijingTime := purchaseAtUTC.In(beijingLoc)
		timeLabel := beijingTime.Format("15:04")
		title := fmt.Sprintf("%s 出单: %s %d 件", projName, amazonOrderID, quantity)

		items = append(items, order_info.OrderLiveStreamItem{
			ID:          fmt.Sprintf("%d:%s", projectID, amazonOrderID),
			Title:       title,
			TimeLabel:   timeLabel,
			OccurredAt:  purchaseAtUTC.UTC().Format(time.RFC3339Nano),
			ProjectID:   projectID,
			ProjectName: &projName,
			Country:     &country,
			Currency:    currency,
			Amount:      amount,
			Quantity:    quantity,
			OrderStatus: &status,
		})
	}
	if items == nil {
		items = []order_info.OrderLiveStreamItem{}
	}
	return items, nil
}

func (s *OrderInfoStore) ExportOrders(ctx context.Context, filter order_info.OrderInfoFilter) (string, []byte, error) {
	scopedIDs, hasAccess, err := s.resolveProjectScope(ctx, filter)
	if err != nil {
		return "", nil, err
	}
	if !hasAccess {
		var buf bytes.Buffer
		w := csv.NewWriter(&buf)
		_ = w.Write([]string{
			"订单号", "项目", "站点", "订单状态", "配送方式", "SKU", "ASIN", "商品名", "数量",
			"商品单价", "运费", "币种", "购买时间(UTC)", "购买时间(当地)",
		})
		w.Flush()
		filename := fmt.Sprintf("orders_export_%s.csv", time.Now().Format("20060102_150405"))
		return filename, buf.Bytes(), nil
	}

	filter.ProjectIDs = scopedIDs
	filter.Page = 1
	filter.PageSize = 5000
	filter.Offset = 0

	res, err := s.ListOrders(ctx, filter)
	if err != nil {
		return "", nil, err
	}

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{
		"订单号", "项目", "站点", "订单状态", "配送方式", "SKU", "ASIN", "商品名", "数量",
		"商品单价", "运费", "币种", "购买时间(UTC)", "购买时间(当地)",
	})

	for _, item := range res.Items {
		prod := ""
		if item.ProductName != nil {
			prod = *item.ProductName
		}
		sku := ""
		if item.SKU != nil {
			sku = *item.SKU
		}
		asin := ""
		if item.ASIN != nil {
			asin = *item.ASIN
		}
		curr := ""
		if item.Currency != nil {
			curr = *item.Currency
		}
		_ = w.Write([]string{
			item.AmazonOrderID, item.ProjectName, item.Country, item.OrderStatus,
			item.FulfillmentLabel, sku, asin, prod, strconv.Itoa(item.Quantity),
			fmt.Sprintf("%.2f", item.ItemPrice), fmt.Sprintf("%.2f", item.ShippingPrice),
			curr, item.PurchaseAtUTC, item.PurchaseAtPT,
		})
	}
	w.Flush()

	filename := fmt.Sprintf("orders_export_%s.csv", time.Now().Format("20060102_150405"))
	return filename, buf.Bytes(), nil
}

func (s *OrderInfoStore) GetOrderByID(ctx context.Context, id int64) (*order_info.OrderInfoItem, error) {
	querySQL := `
		select
			r.id, r.project_id, coalesce(p.project_name, ''), p.brand_name, r.source_file_id,
			r.purchase_at_utc, r.purchase_at_pt, r.purchase_date_pt,
			r.amazon_order_id, r.order_status,
			coalesce(r.fulfillment_channel, r.raw_row->>'fulfillment-channel', r.raw_row->>'fulfillment channel', 'Amazon'),
			r.raw_row->>'ship-service-level',
			r.sku, r.asin, coalesce(r.raw_row->>'product-name', r.raw_row->>'product name'),
			r.quantity, coalesce(r.item_price, 0), coalesce(r.shipping_price, 0), r.currency,
			coalesce(r.country, 'US'),
			coalesce(r.raw_row->>'ship-state', r.raw_row->>'ship state'),
			coalesce(r.raw_row->>'ship-city', r.raw_row->>'ship city'),
			coalesce(r.raw_row->>'ship-postal-code', r.raw_row->>'ship postal code'),
			coalesce(r.is_counted_sales, false),
			r.created_at, r.carrier, r.tracking_no, r.shipped_at, r.updated_by, r.updated_at
		from public.analysis_sales_order_rows r
		left join public.projects p on p.id = r.project_id
		where r.id = $1
	`
	row := s.db.QueryRow(ctx, querySQL, id)
	var item order_info.OrderInfoItem
	var purchaseAtUTC, purchaseAtPT, createdAt time.Time
	var purchaseDatePT time.Time
	var shippedAt, updatedAt *time.Time

	err := row.Scan(
		&item.ID, &item.ProjectID, &item.ProjectName, &item.BrandName, &item.SourceFileID,
		&purchaseAtUTC, &purchaseAtPT, &purchaseDatePT,
		&item.AmazonOrderID, &item.OrderStatus,
		&item.FulfillmentChannel, &item.ShipServiceLevel,
		&item.SKU, &item.ASIN, &item.ProductName,
		&item.Quantity, &item.ItemPrice, &item.ShippingPrice, &item.Currency,
		&item.Country, &item.State, &item.City, &item.PostalCode,
		&item.IsCountedSales,
		&createdAt, &item.Carrier, &item.TrackingNo, &shippedAt, &item.UpdatedBy, &updatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	item.PurchaseAtUTC = purchaseAtUTC.UTC().Format(time.RFC3339Nano)
	item.PurchaseAtPT = purchaseAtPT.Format("2006-01-02T15:04:05.999999")
	item.PurchaseDatePT = purchaseDatePT.Format("2006-01-02")
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	if shippedAt != nil {
		tStr := shippedAt.UTC().Format(time.RFC3339Nano)
		item.ShippedAt = &tStr
	}
	if updatedAt != nil {
		tStr := updatedAt.UTC().Format(time.RFC3339Nano)
		item.UpdatedAt = &tStr
	}
	item.FulfillmentLabel = order_info.FulfillmentLabel(item.FulfillmentChannel)
	return &item, nil
}

func (s *OrderInfoStore) UpdateOrderByID(ctx context.Context, id int64, update order_info.OrderInfoUpdate, operator string, isAdmin bool) (*order_info.OrderInfoItem, error) {
	item, err := s.GetOrderByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if item == nil {
		return nil, nil
	}

	if !isAdmin {
		accessible, err := s.getAccessibleProjectIDs(ctx, operator, false)
		if err != nil {
			return nil, err
		}
		allowed := false
		for _, pID := range accessible {
			if pID == item.ProjectID {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, fmt.Errorf("403: 无权限编辑该项目下的订单")
		}
	}

	now := time.Now().UTC()
	var shippedAtTime *time.Time
	if update.ShippedAt != nil && *update.ShippedAt != "" {
		if t, err := time.Parse(time.RFC3339, *update.ShippedAt); err == nil {
			shippedAtTime = &t
		}
	}

	updatedBy := update.UpdatedBy
	if updatedBy == nil || *updatedBy == "" {
		if operator != "" {
			updatedBy = &operator
		}
	}

	updateSQL := `
		update public.analysis_sales_order_rows
		set
			carrier = coalesce($2, carrier),
			tracking_no = coalesce($3, tracking_no),
			shipped_at = coalesce($4, shipped_at),
			updated_by = coalesce($5, updated_by),
			updated_at = $6
		where id = $1
	`
	_, err = s.db.Exec(ctx, updateSQL, id, update.Carrier, update.TrackingNo, shippedAtTime, updatedBy, now)
	if err != nil {
		return nil, err
	}

	return s.GetOrderByID(ctx, id)
}
