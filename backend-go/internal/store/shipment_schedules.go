package store

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipment_schedules"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type ShipmentScheduleStore struct {
	db FullDB
}

func NewShipmentScheduleStore(db FullDB) *ShipmentScheduleStore {
	return &ShipmentScheduleStore{db: db}
}

func (s *ShipmentScheduleStore) ListShipmentSchedules(ctx context.Context, filter shipment_schedules.ShipmentFilter) (shipment_schedules.ShipmentScheduleListResponse, error) {
	var conditions []string
	var args []any
	idx := 1

	if len(filter.ProjectIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("s.project_id = any($%d)", idx))
		args = append(args, filter.ProjectIDs)
		idx++
	} else if filter.ProjectID != nil && *filter.ProjectID > 0 {
		conditions = append(conditions, fmt.Sprintf("s.project_id = $%d", idx))
		args = append(args, *filter.ProjectID)
		idx++
	} else if !filter.IsAdmin && strings.TrimSpace(filter.Operator) != "" {
		accessible, err := s.getAccessibleProjectIDs(ctx, filter.Operator)
		if err != nil {
			return shipment_schedules.ShipmentScheduleListResponse{}, err
		}
		if len(accessible) == 0 {
			zero := 0
			return shipment_schedules.ShipmentScheduleListResponse{
				Items:    []shipment_schedules.ShipmentScheduleListItem{},
				Page:     filter.Page,
				PageSize: filter.PageSize,
				Total:    &zero,
				HasNext:  false,
			}, nil
		}
		conditions = append(conditions, fmt.Sprintf("s.project_id = any($%d)", idx))
		args = append(args, accessible)
		idx++
	}
	if filter.Country != nil && *filter.Country != "" {
		conditions = append(conditions, fmt.Sprintf("upper(s.country) = $%d", idx))
		args = append(args, strings.ToUpper(*filter.Country))
		idx++
	}
	if filter.ShipmentStatus != nil && *filter.ShipmentStatus != "" {
		conditions = append(conditions, fmt.Sprintf("s.shipment_status = $%d", idx))
		args = append(args, *filter.ShipmentStatus)
		idx++
	}
	if filter.Keyword != nil && *filter.Keyword != "" {
		conditions = append(conditions, fmt.Sprintf("(s.shipment_no ilike $%d or s.tracking_no ilike $%d)", idx, idx))
		args = append(args, "%"+*filter.Keyword+"%")
		idx++
	}
	if filter.StartDate != nil && *filter.StartDate != "" {
		conditions = append(conditions, fmt.Sprintf("s.etd_date >= $%d", idx))
		args = append(args, *filter.StartDate)
		idx++
	}
	if filter.EndDate != nil && *filter.EndDate != "" {
		conditions = append(conditions, fmt.Sprintf("s.etd_date <= $%d", idx))
		args = append(args, *filter.EndDate)
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	var totalCount *int
	if filter.IncludeTotal {
		var total int
		countSQL := fmt.Sprintf("select count(*) from public.shipment_schedules s %s", where)
		if err := s.db.QueryRow(ctx, countSQL, args...).Scan(&total); err == nil {
			totalCount = &total
		}
	}

	limit := filter.PageSize
	offset := (filter.Page - 1) * filter.PageSize
	if offset < 0 {
		offset = 0
	}

	querySQL := fmt.Sprintf(`
		select
			s.id, s.project_id, coalesce(p.project_name, ''), s.country,
			s.shipment_no, s.tracking_no, s.warehouse_code, s.forwarder_name,
			s.shipping_method, s.created_date::text, s.etd_date::text, s.eta_date::text, s.actual_inbound_date::text,
			s.shipment_status, s.remark,
			coalesce(item_agg.sku_count, 0), coalesce(item_agg.total_quantity, 0),
			coalesce(s.logistics_unit_price, 0), coalesce(s.total_volume_m3, 0),
			coalesce(s.total_chargeable_weight_kg, 0), coalesce(s.logistics_total_price, 0),
			coalesce(s.include_in_history_shipping_calc, true),
			s.updated_at, s.shipment_batch
		from public.shipment_schedules s
		left join public.projects p on p.id = s.project_id
		left join (
			select shipment_schedule_id, count(*) as sku_count, coalesce(sum(quantity), 0) as total_quantity
			from public.shipment_schedule_items
			group by shipment_schedule_id
		) item_agg on item_agg.shipment_schedule_id = s.id
		%s
		order by s.id desc
		limit $%d offset $%d
	`, where, idx, idx+1)
	args = append(args, limit+1, offset)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return shipment_schedules.ShipmentScheduleListResponse{}, err
	}
	defer rows.Close()

	items := make([]shipment_schedules.ShipmentScheduleListItem, 0)
	for rows.Next() {
		var item shipment_schedules.ShipmentScheduleListItem
		var updatedAt time.Time
		if err := rows.Scan(
			&item.ID, &item.ProjectID, &item.ProjectName, &item.Country,
			&item.ShipmentNo, &item.TrackingNo, &item.WarehouseCode, &item.ForwarderName,
			&item.ShippingMethod, &item.CreatedDate, &item.EtdDate, &item.EtaDate, &item.ActualInboundDate,
			&item.ShipmentStatus, &item.Remark,
			&item.SKUCount, &item.TotalQuantity,
			&item.LogisticsUnitPrice, &item.TotalVolumeM3,
			&item.TotalChargeableWeightKG, &item.LogisticsTotalPrice,
			&item.IncludeInHistoryShippingCalc,
			&updatedAt, &item.ShipmentBatch,
		); err == nil {
			item.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
			items = append(items, item)
		}
	}

	hasNext := false
	if len(items) > limit {
		hasNext = true
		items = items[:limit]
	}

	return shipment_schedules.ShipmentScheduleListResponse{
		Items:    items,
		Page:     filter.Page,
		PageSize: filter.PageSize,
		Total:    totalCount,
		HasNext:  hasNext,
	}, nil
}

func (s *ShipmentScheduleStore) getAccessibleProjectIDs(ctx context.Context, operator string) ([]int64, error) {
	if strings.TrimSpace(operator) == "" {
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
	`, strings.TrimSpace(operator))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

func (s *ShipmentScheduleStore) SummarizeCosts(ctx context.Context, projectID *int64, projectIDs []int64, country, startDate, endDate *string) (shipment_schedules.ShipmentScheduleCostSummary, error) {
	var conditions []string
	var args []any
	idx := 1
	if projectID != nil && *projectID > 0 {
		conditions = append(conditions, fmt.Sprintf("project_id = $%d", idx))
		args = append(args, *projectID)
		idx++
	} else if len(projectIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", idx))
		args = append(args, projectIDs)
		idx++
	} else {
		identity, _ := auth.UserContextFromContext(ctx)
		if !identity.IsAdmin && strings.TrimSpace(identity.Operator) != "" {
			accessible, err := s.getAccessibleProjectIDs(ctx, identity.Operator)
			if err != nil {
				return shipment_schedules.ShipmentScheduleCostSummary{}, err
			}
			if len(accessible) == 0 {
				return shipment_schedules.ShipmentScheduleCostSummary{}, nil
			}
			conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", idx))
			args = append(args, accessible)
			idx++
		}
	}
	if country != nil && *country != "" {
		conditions = append(conditions, fmt.Sprintf("upper(country) = $%d", idx))
		args = append(args, strings.ToUpper(*country))
		idx++
	}
	if startDate != nil && *startDate != "" {
		conditions = append(conditions, fmt.Sprintf("etd_date >= $%d", idx))
		args = append(args, *startDate)
		idx++
	}
	if endDate != nil && *endDate != "" {
		conditions = append(conditions, fmt.Sprintf("etd_date <= $%d", idx))
		args = append(args, *endDate)
		idx++
	}
	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}
	querySQL := fmt.Sprintf(`
		select
			count(*),
			coalesce(sum(item_agg.sku_count), 0),
			coalesce(sum(item_agg.total_quantity), 0),
			coalesce(sum(s.total_chargeable_weight_kg), 0),
			coalesce(sum(s.logistics_total_price), 0)
		from public.shipment_schedules s
		left join (
			select shipment_schedule_id, count(*) as sku_count, coalesce(sum(quantity), 0) as total_quantity
			from public.shipment_schedule_items
			group by shipment_schedule_id
		) item_agg on item_agg.shipment_schedule_id = s.id
		%s
	`, where)
	var summary shipment_schedules.ShipmentScheduleCostSummary
	err := s.db.QueryRow(ctx, querySQL, args...).Scan(
		&summary.ShipmentCount,
		&summary.TotalSKU,
		&summary.TotalQuantity,
		&summary.TotalChargeableWeightKG,
		&summary.TotalLogisticsCost,
	)
	return summary, err
}

func (s *ShipmentScheduleStore) ListSkuSummary(ctx context.Context, projectID *int64, country, startDate, endDate *string) (shipment_schedules.ShipmentSkuSummaryResponse, error) {
	var conditions []string
	var args []any
	idx := 1
	if projectID != nil && *projectID > 0 {
		conditions = append(conditions, fmt.Sprintf("project_id = $%d", idx))
		args = append(args, *projectID)
		idx++
	}
	if country != nil && *country != "" {
		conditions = append(conditions, fmt.Sprintf("upper(country) = $%d", idx))
		args = append(args, strings.ToUpper(*country))
		idx++
	}
	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}
	querySQL := fmt.Sprintf(`
		select
			project_id, project_name_snapshot, country, sku,
			shipment_count, total_quantity,
			coalesce(total_chargeable_weight_kg, 0),
			coalesce(total_logistics_cost, 0),
			coalesce(average_logistics_unit_price, 0)
		from public.shipment_sku_summaries
		%s
		order by project_name_snapshot asc, country asc, sku asc
	`, where)
	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return shipment_schedules.ShipmentSkuSummaryResponse{Items: []shipment_schedules.ShipmentSkuSummaryItem{}}, nil
	}
	defer rows.Close()

	items := make([]shipment_schedules.ShipmentSkuSummaryItem, 0)
	for rows.Next() {
		var it shipment_schedules.ShipmentSkuSummaryItem
		if err := rows.Scan(
			&it.ProjectID, &it.ProjectName, &it.Country, &it.SKU,
			&it.ShipmentCount, &it.TotalQuantity,
			&it.TotalChargeableWeightKG, &it.TotalLogisticsCost, &it.AverageLogisticsUnitPrice,
		); err == nil {
			items = append(items, it)
		}
	}
	return shipment_schedules.ShipmentSkuSummaryResponse{Items: items}, nil
}

func (s *ShipmentScheduleStore) ListFbaBoxDetails(ctx context.Context, projectIDs []int64, countries, shipmentNos []string) (shipment_schedules.ShipmentFbaBoxDetailResponse, error) {
	emptyResp := shipment_schedules.ShipmentFbaBoxDetailResponse{
		ProjectIDs:   []int64{},
		ProjectNames: []string{},
		Countries:    []string{},
		ShipmentNos:  []string{},
		Items:        []shipment_schedules.ShipmentFbaBoxDetailItem{},
	}

	var conditions []string
	var args []any
	idx := 1

	if len(shipmentNos) > 0 {
		conditions = append(conditions, fmt.Sprintf("s.shipment_no = any($%d)", idx))
		args = append(args, shipmentNos)
		idx++
	}
	if len(projectIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("s.project_id = any($%d)", idx))
		args = append(args, projectIDs)
		idx++
	}
	if len(countries) > 0 {
		upperCountries := make([]string, len(countries))
		for i, c := range countries {
			upperCountries[i] = strings.ToUpper(c)
		}
		conditions = append(conditions, fmt.Sprintf("upper(s.country) = any($%d)", idx))
		args = append(args, upperCountries)
		idx++
	}

	if len(conditions) == 0 {
		return emptyResp, nil
	}

	where := "where " + strings.Join(conditions, " and ")
	scheduleSQL := fmt.Sprintf(`
		select
			s.id, s.project_id, coalesce(p.project_name, ''), s.country,
			s.shipment_no, s.tracking_no, s.warehouse_code
		from public.shipment_schedules s
		left join public.projects p on p.id = s.project_id
		%s
		order by s.id asc
	`, where)

	rows, err := s.db.Query(ctx, scheduleSQL, args...)
	if err != nil {
		return emptyResp, err
	}
	defer rows.Close()

	type schedInfo struct {
		id            int64
		projectID     int64
		projectName   string
		country       string
		shipmentNo    string
		trackingNo    *string
		warehouseCode *string
	}
	var schedules []schedInfo
	var scheduleIDs []int64
	for rows.Next() {
		var sc schedInfo
		if err := rows.Scan(
			&sc.id, &sc.projectID, &sc.projectName, &sc.country,
			&sc.shipmentNo, &sc.trackingNo, &sc.warehouseCode,
		); err == nil {
			schedules = append(schedules, sc)
			scheduleIDs = append(scheduleIDs, sc.id)
		}
	}
	if err := rows.Err(); err != nil {
		return emptyResp, err
	}
	if len(schedules) == 0 {
		return emptyResp, nil
	}

	type itemRow struct {
		id                 int64
		shipmentScheduleID int64
		sku                string
		quantity           int
		cartonCount        int
		itemDate           *string
	}
	itemSQL := `
		select id, shipment_schedule_id, sku, coalesce(quantity, 0), coalesce(carton_count, 0), item_date::text
		from public.shipment_schedule_items
		where shipment_schedule_id = any($1)
		order by item_date asc nulls first, sku asc, id asc
	`
	itemRows, err := s.db.Query(ctx, itemSQL, scheduleIDs)
	if err != nil {
		return emptyResp, err
	}
	defer itemRows.Close()

	itemsBySchedule := make(map[int64][]itemRow)
	skuSet := make(map[string]bool)
	projectIDSet := make(map[int64]bool)
	for itemRows.Next() {
		var it itemRow
		if err := itemRows.Scan(&it.id, &it.shipmentScheduleID, &it.sku, &it.quantity, &it.cartonCount, &it.itemDate); err == nil {
			itemsBySchedule[it.shipmentScheduleID] = append(itemsBySchedule[it.shipmentScheduleID], it)
			skuSet[it.sku] = true
		}
	}
	if err := itemRows.Err(); err != nil {
		return emptyResp, err
	}

	for _, sc := range schedules {
		projectIDSet[sc.projectID] = true
	}

	uniqueSKUs := make([]string, 0, len(skuSet))
	for sku := range skuSet {
		uniqueSKUs = append(uniqueSKUs, sku)
	}
	uniqueProjectIDs := make([]int64, 0, len(projectIDSet))
	for pid := range projectIDSet {
		uniqueProjectIDs = append(uniqueProjectIDs, pid)
	}

	type prodInfo struct {
		productName     *string
		asin            *string
		fnsku           *string
		packageLengthCM *float64
		packageWidthCM  *float64
		packageHeightCM *float64
		weightKG        *float64
		cartonLengthCM  *float64
		cartonWidthCM   *float64
		cartonHeightCM  *float64
		cartonWeightKG  *float64
		unitsPerCarton  int
		imageThumbURL   *string
		imageURL        *string
	}
	type prodKey struct {
		projectID int64
		country   string
		sku       string
	}
	products := make(map[prodKey]prodInfo)
	if len(uniqueSKUs) > 0 && len(uniqueProjectIDs) > 0 {
		costSQL := `
			select
				project_id, upper(country), sku, product_name, asin, fnsku,
				package_length_cm, package_width_cm, package_height_cm, weight_kg,
				carton_length_cm, carton_width_cm, carton_height_cm, carton_weight_kg,
				coalesce(units_per_carton, 0),
				product_image_thumbnail_r2_url, product_image_r2_url
			from public.product_costs
			where project_id = any($1) and sku = any($2)
		`
		costRows, err := s.db.Query(ctx, costSQL, uniqueProjectIDs, uniqueSKUs)
		if err == nil {
			defer costRows.Close()
			for costRows.Next() {
				var pid int64
				var ctry, sku string
				var pi prodInfo
				if err := costRows.Scan(
					&pid, &ctry, &sku, &pi.productName, &pi.asin, &pi.fnsku,
					&pi.packageLengthCM, &pi.packageWidthCM, &pi.packageHeightCM, &pi.weightKG,
					&pi.cartonLengthCM, &pi.cartonWidthCM, &pi.cartonHeightCM, &pi.cartonWeightKG,
					&pi.unitsPerCarton, &pi.imageThumbURL, &pi.imageURL,
				); err == nil {
					products[prodKey{projectID: pid, country: strings.ToUpper(ctry), sku: sku}] = pi
				}
			}
		}
	}

	var detailItems []shipment_schedules.ShipmentFbaBoxDetailItem
	var respProjectIDs []int64
	var respProjectNames []string
	var respCountries []string
	var respShipmentNos []string

	for _, sc := range schedules {
		respProjectIDs = append(respProjectIDs, sc.projectID)
		respProjectNames = append(respProjectNames, sc.projectName)
		respCountries = append(respCountries, sc.country)
		respShipmentNos = append(respShipmentNos, sc.shipmentNo)

		for _, item := range itemsBySchedule[sc.id] {
			pk := prodKey{projectID: sc.projectID, country: strings.ToUpper(sc.country), sku: item.sku}
			prod, hasProd := products[pk]

			quantity := item.quantity
			unitsPerCarton := 0
			if hasProd && prod.unitsPerCarton > 0 {
				unitsPerCarton = prod.unitsPerCarton
			}

			fullCartonCount := 0
			partialCartonUnits := 0
			cartonCount := 0
			if unitsPerCarton > 0 {
				fullCartonCount = quantity / unitsPerCarton
				partialCartonUnits = quantity % unitsPerCarton
				cartonCount = fullCartonCount
				if partialCartonUnits > 0 {
					cartonCount++
				}
			}

			hasCartonSize := hasProd &&
				prod.cartonLengthCM != nil && *prod.cartonLengthCM > 0 &&
				prod.cartonWidthCM != nil && *prod.cartonWidthCM > 0 &&
				prod.cartonHeightCM != nil && *prod.cartonHeightCM > 0

			var lengthCM, widthCM, heightCM float64
			var volumeMultiplier float64
			if hasCartonSize {
				lengthCM = *prod.cartonLengthCM
				widthCM = *prod.cartonWidthCM
				heightCM = *prod.cartonHeightCM
				volumeMultiplier = float64(cartonCount)
			} else {
				if hasProd {
					if prod.packageLengthCM != nil {
						lengthCM = *prod.packageLengthCM
					}
					if prod.packageWidthCM != nil {
						widthCM = *prod.packageWidthCM
					}
					if prod.packageHeightCM != nil {
						heightCM = *prod.packageHeightCM
					}
				}
				volumeMultiplier = float64(quantity)
			}

			var totalWeightKG float64
			if hasProd && prod.cartonWeightKG != nil && *prod.cartonWeightKG > 0 && cartonCount > 0 {
				totalWeightKG = *prod.cartonWeightKG * float64(cartonCount)
			} else if hasProd && prod.weightKG != nil {
				totalWeightKG = *prod.weightKG * float64(quantity)
			}

			totalVolumeM3 := (lengthCM * widthCM * heightCM / 1000000.0) * volumeMultiplier

			var outerBoxText string
			if !hasProd {
				outerBoxText = "未匹配 SKU 成本资料"
			} else if unitsPerCarton <= 0 {
				outerBoxText = "未维护装箱率"
			} else if partialCartonUnits > 0 && fullCartonCount > 0 {
				outerBoxText = fmt.Sprintf("%d 箱整箱 + 1 箱尾箱（%d 件）", fullCartonCount, partialCartonUnits)
			} else if partialCartonUnits > 0 {
				outerBoxText = fmt.Sprintf("1 箱尾箱（%d 件）", partialCartonUnits)
			} else {
				outerBoxText = fmt.Sprintf("%d 箱整箱", cartonCount)
			}

			lengthCM = math.Round(lengthCM*100) / 100
			widthCM = math.Round(widthCM*100) / 100
			heightCM = math.Round(heightCM*100) / 100
			totalWeightKG = math.Round(totalWeightKG*100) / 100
			totalVolumeM3 = math.Round(totalVolumeM3*10000) / 10000

			var prodName, asin, fnsku *string
			var pkgL, pkgW, pkgH, wt, cwt *float64
			var thumbURL, imgURL *string
			if hasProd {
				prodName = prod.productName
				asin = prod.asin
				fnsku = prod.fnsku
				pkgL = prod.packageLengthCM
				pkgW = prod.packageWidthCM
				pkgH = prod.packageHeightCM
				wt = prod.weightKG
				cwt = prod.cartonWeightKG
				thumbURL = prod.imageThumbURL
				imgURL = prod.imageURL
			}

			detailItems = append(detailItems, shipment_schedules.ShipmentFbaBoxDetailItem{
				ProjectID:                  sc.projectID,
				ProjectName:                sc.projectName,
				Country:                    sc.country,
				ShipmentNo:                 sc.shipmentNo,
				WarehouseCode:              sc.warehouseCode,
				SKU:                        item.sku,
				ProductName:                prodName,
				ASIN:                       asin,
				FNSKU:                      fnsku,
				PackageLengthCM:            pkgL,
				PackageWidthCM:             pkgW,
				PackageHeightCM:            pkgH,
				WeightKG:                   wt,
				LengthCM:                   lengthCM,
				WidthCM:                    widthCM,
				HeightCM:                   heightCM,
				CartonWeightKG:             cwt,
				Quantity:                   quantity,
				UnitsPerCarton:             unitsPerCarton,
				CartonCount:                cartonCount,
				FullCartonCount:            fullCartonCount,
				PartialCartonUnits:         partialCartonUnits,
				OuterBoxText:               outerBoxText,
				TotalWeightKG:              totalWeightKG,
				TotalVolumeM3:              totalVolumeM3,
				FBALabelPrefix:             sc.shipmentNo,
				TrackingNo:                 sc.trackingNo,
				ProductImageThumbnailR2URL: thumbURL,
				ProductImageR2URL:          imgURL,
			})
		}
	}

	return shipment_schedules.ShipmentFbaBoxDetailResponse{
		ProjectIDs:   respProjectIDs,
		ProjectNames: respProjectNames,
		Countries:    respCountries,
		ShipmentNos:  respShipmentNos,
		Items:        detailItems,
	}, nil
}

func (s *ShipmentScheduleStore) ListBatches(ctx context.Context, projectID *int64, projectIDs []int64, country *string) ([]string, error) {
	var conditions []string
	var args []any
	idx := 1
	if projectID != nil && *projectID > 0 {
		conditions = append(conditions, fmt.Sprintf("project_id = $%d", idx))
		args = append(args, *projectID)
		idx++
	} else if len(projectIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", idx))
		args = append(args, projectIDs)
		idx++
	} else {
		identity, _ := auth.UserContextFromContext(ctx)
		if !identity.IsAdmin && strings.TrimSpace(identity.Operator) != "" {
			accessible, err := s.getAccessibleProjectIDs(ctx, identity.Operator)
			if err != nil {
				return nil, err
			}
			if len(accessible) == 0 {
				return []string{}, nil
			}
			conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", idx))
			args = append(args, accessible)
			idx++
		}
	}
	if country != nil && *country != "" {
		conditions = append(conditions, fmt.Sprintf("upper(country) = $%d", idx))
		args = append(args, strings.ToUpper(*country))
		idx++
	}
	conditions = append(conditions, "shipment_batch is not null and trim(shipment_batch) <> ''")

	identity, _ := auth.UserContextFromContext(ctx)
	if identity.Operator != "" && projectID != nil && country != nil {
		conditions = append(conditions, fmt.Sprintf(`shipment_batch not in (
			select shipment_batch from public.shipment_batch_dropdown_hidden
			where project_id = $%d and upper(country) = upper($%d) and operator = $%d
		)`, 1, 2, idx))
		args = append(args, identity.Operator)
		idx++
	}
	where := "where " + strings.Join(conditions, " and ")

	querySQL := fmt.Sprintf(`select distinct shipment_batch from public.shipment_schedules %s order by shipment_batch asc`, where)
	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var batches []string
	for rows.Next() {
		var b string
		if err := rows.Scan(&b); err == nil {
			batches = append(batches, b)
		}
	}
	return batches, nil
}

func (s *ShipmentScheduleStore) HideBatch(ctx context.Context, req shipment_schedules.ShipmentBatchHiddenDeleteRequest) (bool, error) {
	identity, _ := auth.UserContextFromContext(ctx)
	op := strings.TrimSpace(identity.Operator)
	if op == "" {
		return false, fmt.Errorf("401: 缺少操作者信息")
	}
	_, err := s.db.Exec(ctx, `
		insert into public.shipment_batch_dropdown_hidden (
			operator, project_id, country, shipment_batch, created_at
		) values (
			$1, $2, upper($3), $4, now()
		) on conflict (operator, project_id, country, shipment_batch) do nothing
	`, op, req.ProjectID, req.Country, req.ShipmentBatch)
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *ShipmentScheduleStore) GetShipmentSchedule(ctx context.Context, id int64) (*shipment_schedules.ShipmentScheduleDetail, error) {
	querySQL := `
		select
			s.id, s.project_id, coalesce(p.project_name, ''), s.country,
			s.shipment_no, s.tracking_no, s.warehouse_code, s.forwarder_name,
			s.shipping_method, s.created_date::text, s.etd_date::text, s.eta_date::text, s.actual_inbound_date::text,
			s.remark, s.shipment_status,
			coalesce(item_agg.sku_count, 0), coalesce(item_agg.total_quantity, 0),
			coalesce(s.logistics_unit_price, 0), coalesce(s.total_volume_m3, 0),
			coalesce(s.total_chargeable_weight_kg, 0), coalesce(s.logistics_total_price, 0),
			coalesce(s.include_in_history_shipping_calc, true),
			s.updated_at, s.shipment_batch
		from public.shipment_schedules s
		left join public.projects p on p.id = s.project_id
		left join (
			select shipment_schedule_id, count(*) as sku_count, coalesce(sum(quantity), 0) as total_quantity
			from public.shipment_schedule_items
			group by shipment_schedule_id
		) item_agg on item_agg.shipment_schedule_id = s.id
		where s.id = $1
	`
	row := s.db.QueryRow(ctx, querySQL, id)
	var d shipment_schedules.ShipmentScheduleDetail
	var updatedAt time.Time
	err := row.Scan(
		&d.ID, &d.ProjectID, &d.ProjectName, &d.Country,
		&d.ShipmentNo, &d.TrackingNo, &d.WarehouseCode, &d.ForwarderName,
		&d.ShippingMethod, &d.CreatedDate, &d.EtdDate, &d.EtaDate, &d.ActualInboundDate,
		&d.Remark, &d.ShipmentStatus,
		&d.SKUCount, &d.TotalQuantity,
		&d.LogisticsUnitPrice, &d.TotalVolumeM3,
		&d.TotalChargeableWeightKG, &d.LogisticsTotalPrice,
		&d.IncludeInHistoryShippingCalc,
		&updatedAt, &d.ShipmentBatch,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	d.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	d.Items = []shipment_schedules.ShipmentScheduleItemRow{}

	itemRows, err := s.db.Query(ctx, `
		select
			id, item_date::text, sku, quantity, carton_count, remark,
			coalesce(volume_m3, 0), coalesce(actual_weight_kg, 0),
			coalesce(volumetric_weight_kg, 0), coalesce(chargeable_weight_kg, 0),
			coalesce(estimated_logistics_cost, 0), coalesce(average_logistics_unit_price, 0)
		from public.shipment_schedule_items
		where shipment_schedule_id = $1
		order by id asc
	`, id)
	if err == nil {
		defer itemRows.Close()
		for itemRows.Next() {
			var it shipment_schedules.ShipmentScheduleItemRow
			if err := itemRows.Scan(
				&it.ID, &it.ItemDate, &it.SKU, &it.Quantity, &it.CartonCount, &it.Remark,
				&it.VolumeM3, &it.ActualWeightKG, &it.VolumetricWeightKG, &it.ChargeableWeightKG,
				&it.EstimatedLogisticsCost, &it.AverageLogisticsUnitPrice,
			); err == nil {
				d.Items = append(d.Items, it)
			}
		}
	}

	return &d, nil
}

func (s *ShipmentScheduleStore) CreateShipmentSchedule(ctx context.Context, create shipment_schedules.ShipmentScheduleCreate, _ string) (shipment_schedules.ShipmentScheduleDetail, error) {
	now := time.Now().UTC()
	var id int64
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		insertSQL := `
			insert into public.shipment_schedules (
				project_id, country, shipment_no, tracking_no, warehouse_code, forwarder_name,
				shipping_method, logistics_unit_price, include_in_history_shipping_calc, remark,
				shipment_status, shipment_batch, created_at, updated_at
			) values (
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13
			) returning id
		`
		if err := txDB.QueryRow(ctx, insertSQL,
			create.ProjectID, strings.ToUpper(create.Country), create.ShipmentNo, create.TrackingNo,
			create.WarehouseCode, create.ForwarderName, create.ShippingMethod, create.LogisticsUnitPrice,
			create.IncludeInHistoryShippingCalc, create.Remark, create.ShipmentStatus, create.ShipmentBatch, now,
		).Scan(&id); err != nil {
			return err
		}

		for _, it := range create.Items {
			_, err := txDB.Exec(ctx, `
				insert into public.shipment_schedule_items (
					shipment_schedule_id, project_id, shipment_no, item_date, sku,
					quantity, carton_count, remark, source_type, created_at, updated_at
				) values (
					$1, $2, $3, $4, $5, $6, $7, $8, 'manual', now(), now()
				)
			`, id, create.ProjectID, create.ShipmentNo, it.ItemDate, it.SKU, it.Quantity, it.CartonCount, it.Remark)
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return shipment_schedules.ShipmentScheduleDetail{}, err
	}
	res, err := s.GetShipmentSchedule(ctx, id)
	if err != nil || res == nil {
		return shipment_schedules.ShipmentScheduleDetail{}, err
	}
	return *res, nil
}

func (s *ShipmentScheduleStore) UpdateShipmentSchedule(ctx context.Context, id int64, update shipment_schedules.ShipmentScheduleUpdate, _ string) (*shipment_schedules.ShipmentScheduleDetail, error) {
	now := time.Now().UTC()
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		updateSQL := `
			update public.shipment_schedules
			set
				tracking_no = coalesce($2, tracking_no),
				warehouse_code = coalesce($3, warehouse_code),
				forwarder_name = coalesce($4, forwarder_name),
				shipping_method = coalesce($5, shipping_method),
				logistics_unit_price = coalesce($6, logistics_unit_price),
				remark = coalesce($7, remark),
				shipment_status = coalesce($8, shipment_status),
				shipment_batch = coalesce($9, shipment_batch),
				updated_at = $10
			where id = $1
		`
		_, err := txDB.Exec(ctx, updateSQL,
			id, update.TrackingNo, update.WarehouseCode, update.ForwarderName,
			update.ShippingMethod, update.LogisticsUnitPrice, update.Remark,
			update.ShipmentStatus, update.ShipmentBatch, now,
		)
		if err != nil {
			return err
		}

		if update.Items != nil {
			_, _ = txDB.Exec(ctx, `delete from public.shipment_schedule_items where shipment_schedule_id = $1`, id)
			for _, it := range update.Items {
				_, err := txDB.Exec(ctx, `
					insert into public.shipment_schedule_items (
						shipment_schedule_id, project_id, shipment_no, item_date, sku,
						quantity, carton_count, remark, source_type, created_at, updated_at
					) values (
						$1, $2, $3, $4, $5, $6, $7, $8, 'manual', now(), now()
					)
				`, id, update.ProjectID, update.ShipmentNo, it.ItemDate, it.SKU, it.Quantity, it.CartonCount, it.Remark)
				if err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetShipmentSchedule(ctx, id)
}

func (s *ShipmentScheduleStore) DeleteShipmentSchedule(ctx context.Context, id int64) (bool, error) {
	tag, err := s.db.Exec(ctx, `delete from public.shipment_schedules where id = $1`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *ShipmentScheduleStore) ImportSchedulesCSV(ctx context.Context, data []byte, op string, isAdmin bool) (shipment_schedules.ShipmentSchedulesImportResponse, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	records, err := r.ReadAll()
	if err != nil {
		return shipment_schedules.ShipmentSchedulesImportResponse{}, fmt.Errorf("CSV 解析失败: %w", err)
	}
	if len(records) == 0 {
		return shipment_schedules.ShipmentSchedulesImportResponse{}, fmt.Errorf("CSV 缺少表头")
	}
	headerMap := make(map[string]int)
	for i, h := range records[0] {
		headerMap[strings.ToLower(strings.TrimSpace(h))] = i
	}
	required := []string{"project_name", "country", "shipment_no", "shipping_method", "shipment_status"}
	for _, req := range required {
		if _, ok := headerMap[req]; !ok {
			return shipment_schedules.ShipmentSchedulesImportResponse{}, fmt.Errorf("CSV 缺少字段: %s", req)
		}
	}

	var accessibleMap map[int64]bool
	if !isAdmin {
		accessible, err := s.getAccessibleProjectIDs(ctx, op)
		if err != nil {
			return shipment_schedules.ShipmentSchedulesImportResponse{}, err
		}
		accessibleMap = make(map[int64]bool, len(accessible))
		for _, pid := range accessible {
			accessibleMap[pid] = true
		}
	}

	var insertedNos []string
	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		seen := make(map[string]bool)
		for idx, record := range records[1:] {
			row := make(map[string]string)
			for h, colIdx := range headerMap {
				if colIdx < len(record) {
					row[h] = strings.TrimSpace(record[colIdx])
				}
			}
			projectName := row["project_name"]
			shipmentNo := row["shipment_no"]
			if projectName == "" && shipmentNo == "" {
				continue
			}
			if projectName == "" {
				return fmt.Errorf("第 %d 行 project_name 不能为空", idx+2)
			}
			if shipmentNo == "" {
				return fmt.Errorf("第 %d 行 shipment_no 不能为空", idx+2)
			}
			if seen[shipmentNo] {
				return fmt.Errorf("CSV 中存在重复 shipment_no: %s", shipmentNo)
			}
			seen[shipmentNo] = true

			var projectID int64
			if err := txDB.QueryRow(ctx, `select id from public.projects where project_name = $1`, projectName).Scan(&projectID); err != nil {
				return fmt.Errorf("以下项目不存在，请先在项目管理中维护：%s", projectName)
			}
			if !isAdmin && !accessibleMap[projectID] {
				return fmt.Errorf("403: 第 %d 行无权限访问项目: %s", idx+2, projectName)
			}

			var exists int
			_ = txDB.QueryRow(ctx, `select 1 from public.shipment_schedules where shipment_no = $1`, shipmentNo).Scan(&exists)
			if exists == 1 {
				return fmt.Errorf("已存在发货编号: %s", shipmentNo)
			}

			country := strings.ToUpper(row["country"])
			shippingMethod := row["shipping_method"]
			shipmentStatus := row["shipment_status"]
			trackingNo := optionalString(row["tracking_no"])
			warehouseCode := optionalString(row["warehouse_code"])
			forwarderName := optionalString(row["forwarder_name"])
			remark := optionalString(row["remark"])
			shipmentBatch := optionalString(row["shipment_batch"])
			createdDate := optionalDateString(row["created_date"])
			etdDate := optionalDateString(row["etd_date"])
			etaDate := optionalDateString(row["eta_date"])
			actualInboundDate := optionalDateString(row["actual_inbound_date"])

			insertSQL := `
				insert into public.shipment_schedules (
					project_id, country, shipment_no, tracking_no, warehouse_code,
					forwarder_name, shipping_method, shipment_status, created_date,
					etd_date, eta_date, actual_inbound_date, remark, shipment_batch,
					created_at, updated_at
				) values (
					$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), now()
				)
			`
			_, err := txDB.Exec(ctx, insertSQL,
				projectID, country, shipmentNo, trackingNo, warehouseCode,
				forwarderName, shippingMethod, shipmentStatus, createdDate,
				etdDate, etaDate, actualInboundDate, remark, shipmentBatch,
			)
			if err != nil {
				return err
			}
			insertedNos = append(insertedNos, shipmentNo)
		}
		return nil
	})
	if err != nil {
		return shipment_schedules.ShipmentSchedulesImportResponse{}, err
	}
	return shipment_schedules.ShipmentSchedulesImportResponse{
		Inserted:    len(insertedNos),
		ShipmentNos: insertedNos,
	}, nil
}

func (s *ShipmentScheduleStore) ImportItemsCSV(ctx context.Context, id int64, data []byte, _ string) (shipment_schedules.ShipmentItemsImportResponse, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	records, err := r.ReadAll()
	if err != nil {
		return shipment_schedules.ShipmentItemsImportResponse{}, fmt.Errorf("CSV 解析失败: %w", err)
	}
	if len(records) == 0 {
		return shipment_schedules.ShipmentItemsImportResponse{}, fmt.Errorf("CSV 缺少表头")
	}
	headerMap := make(map[string]int)
	for i, h := range records[0] {
		headerMap[strings.ToLower(strings.TrimSpace(h))] = i
	}
	if _, ok := headerMap["quantity"]; !ok {
		if _, ok := headerMap["carton_count"]; !ok {
			return shipment_schedules.ShipmentItemsImportResponse{}, fmt.Errorf("CSV 必须包含 quantity 或 carton_count 字段（至少填一个）")
		}
	}
	required := []string{"project_name", "shipment_no", "sku"}
	for _, req := range required {
		if _, ok := headerMap[req]; !ok {
			return shipment_schedules.ShipmentItemsImportResponse{}, fmt.Errorf("CSV 缺少字段: %s", req)
		}
	}

	var scheduleShipmentNo string
	var scheduleProjectID int64
	var scheduleCountry string
	var scheduleProjectName string
	err = s.db.QueryRow(ctx, `
		select s.shipment_no, s.project_id, s.country, coalesce(p.project_name, '')
		from public.shipment_schedules s
		left join public.projects p on p.id = s.project_id
		where s.id = $1
	`, id).Scan(&scheduleShipmentNo, &scheduleProjectID, &scheduleCountry, &scheduleProjectName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return shipment_schedules.ShipmentItemsImportResponse{}, shipment_schedules.ErrNotFound
		}
		return shipment_schedules.ShipmentItemsImportResponse{}, err
	}

	var replaced int
	var totalQty int
	var insertedCount int
	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		_ = txDB.QueryRow(ctx, `select count(*) from public.shipment_schedule_items where shipment_schedule_id = $1`, id).Scan(&replaced)
		_, _ = txDB.Exec(ctx, `delete from public.shipment_schedule_items where shipment_schedule_id = $1`, id)

		for idx, record := range records[1:] {
			row := make(map[string]string)
			for h, colIdx := range headerMap {
				if colIdx < len(record) {
					row[h] = strings.TrimSpace(record[colIdx])
				}
			}
			pName := row["project_name"]
			sNo := row["shipment_no"]
			sku := row["sku"]
			if pName == "" && sNo == "" && sku == "" {
				continue
			}
			if sNo != scheduleShipmentNo {
				return fmt.Errorf("CSV 中存在不匹配的货件编号: %s，当前记录是 %s", sNo, scheduleShipmentNo)
			}
			if scheduleProjectName != "" && pName != scheduleProjectName {
				return fmt.Errorf("CSV 中项目名称 %s 与当前记录项目 %s 不一致", pName, scheduleProjectName)
			}

			qty := 0
			if row["quantity"] != "" {
				q, err := strconv.Atoi(row["quantity"])
				if err != nil || q <= 0 {
					return fmt.Errorf("第 %d 行 quantity 必须大于 0", idx+2)
				}
				qty = q
			}
			var cartonCount *int
			if row["carton_count"] != "" {
				c, err := strconv.Atoi(row["carton_count"])
				if err == nil {
					cartonCount = &c
					if qty == 0 {
						unitsPerCarton := 1
						_ = txDB.QueryRow(ctx, `select coalesce(units_per_carton, 1) from public.product_costs where project_id = $1 and upper(country) = upper($2) and sku = $3`, scheduleProjectID, scheduleCountry, sku).Scan(&unitsPerCarton)
						if unitsPerCarton <= 0 {
							unitsPerCarton = 1
						}
						qty = c * unitsPerCarton
					}
				}
			}
			totalQty += qty
			itemDate := optionalDateString(row["date"])
			remark := optionalString(row["remark"])

			insertSQL := `
				insert into public.shipment_schedule_items (
					shipment_schedule_id, project_id, shipment_no, item_date, sku,
					quantity, carton_count, remark, source_type, created_at, updated_at
				) values (
					$1, $2, $3, $4, $5, $6, $7, $8, 'csv_import', now(), now()
				)
			`
			_, err := txDB.Exec(ctx, insertSQL, id, scheduleProjectID, scheduleShipmentNo, itemDate, sku, qty, cartonCount, remark)
			if err != nil {
				return err
			}
			insertedCount++
		}

		return nil
	})
	if err != nil {
		return shipment_schedules.ShipmentItemsImportResponse{}, err
	}
	return shipment_schedules.ShipmentItemsImportResponse{
		ShipmentScheduleID: id,
		ShipmentNo:         scheduleShipmentNo,
		Inserted:           insertedCount,
		Replaced:           replaced,
		TotalQuantity:      totalQty,
	}, nil
}

func optionalString(val string) *string {
	trimmed := strings.TrimSpace(val)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func optionalDateString(val string) *string {
	trimmed := strings.TrimSpace(val)
	if trimmed == "" {
		return nil
	}
	// parse potential date format
	for _, layout := range []string{"2006-01-02", "2006/01/02", "2006.01.02"} {
		if t, err := time.Parse(layout, trimmed); err == nil {
			res := t.Format("2006-01-02")
			return &res
		}
	}
	return &trimmed
}

func (s *ShipmentScheduleStore) CalculateCosts(ctx context.Context, id int64, req shipment_schedules.ShipmentCostCalculateRequest) (*shipment_schedules.ShipmentScheduleDetail, error) {
	_, err := s.db.Exec(ctx, `
		update public.shipment_schedules
		set logistics_unit_price = $2, logistics_total_price = round((total_chargeable_weight_kg * $2)::numeric, 2), updated_at = now()
		where id = $1
	`, id, req.LogisticsUnitPrice)
	if err != nil {
		return nil, err
	}
	return s.GetShipmentSchedule(ctx, id)
}
