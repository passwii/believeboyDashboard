package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
)

type InventoryReplenishmentStore struct {
	db FullDB
}

func NewInventoryReplenishmentStore(db FullDB) *InventoryReplenishmentStore {
	return &InventoryReplenishmentStore{db: db}
}

func (s *InventoryReplenishmentStore) VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	var projOp, asstOp *string
	err := s.db.QueryRow(ctx, "select project_operator, assistant_operator from public.projects where id = $1", projectID).Scan(&projOp, &asstOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return inventory_replenishment.ErrProjectNotFound
		}
		return err
	}
	op = strings.TrimSpace(op)
	if op == "" {
		return inventory_replenishment.ErrProjectForbidden
	}
	if textContainsName(projOp, op) || textContainsName(asstOp, op) {
		return nil
	}
	return inventory_replenishment.ErrProjectForbidden
}

func (s *InventoryReplenishmentStore) ListSnapshotOptions(ctx context.Context, projectID *int64, country *string) ([]inventory_replenishment.InventorySnapshotOption, error) {
	today := time.Now().Format("2006-01-02")
	options := []inventory_replenishment.InventorySnapshotOption{
		{
			SnapshotDate: today,
			Label:        "当前实时数据",
			IsCurrent:    true,
		},
	}

	if projectID != nil && *projectID > 0 {
		var conditions []string
		var args []any
		args = append(args, *projectID)
		conditions = append(conditions, "project_id = $1")
		idx := 2
		if country != nil && *country != "" {
			conditions = append(conditions, fmt.Sprintf("upper(country) = $%d", idx))
			args = append(args, normalizeCountry(*country))
			idx++
		}
		query := fmt.Sprintf(`
			select id, snapshot_date::text, name, is_current
			from public.inventory_replenishment_snapshots
			where %s
			order by snapshot_date desc, created_at desc
		`, strings.Join(conditions, " and "))

		rows, err := s.db.Query(ctx, query, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var id int64
				var sDate string
				var name *string
				var isCur bool
				if err := rows.Scan(&id, &sDate, &name, &isCur); err == nil {
					lbl := sDate
					if name != nil && *name != "" {
						lbl = fmt.Sprintf("%s (%s)", sDate, *name)
					}
					options = append(options, inventory_replenishment.InventorySnapshotOption{
						ID:           &id,
						SnapshotDate: sDate,
						Name:         name,
						Label:        lbl,
						IsCurrent:    isCur,
					})
				}
			}
		}
	}

	return options, nil
}

func (s *InventoryReplenishmentStore) ListAnalysis(ctx context.Context, filter inventory_replenishment.ReplenishmentFilter) (inventory_replenishment.InventoryReplenishmentListResponse, error) {
	// First check if there is a snapshot specified or if we should read from snapshot
	if filter.SnapshotDate != nil && *filter.SnapshotDate != "" && *filter.SnapshotDate != time.Now().Format("2006-01-02") {
		return s.listAnalysisFromSnapshot(ctx, filter)
	}

	// Live database query
	var conditions []string
	var args []any
	idx := 1
	var invFilter, tFilter string
	if filter.ProjectID != nil && *filter.ProjectID > 0 {
		conditions = append(conditions, fmt.Sprintf("p.project_id = $%d", idx))
		args = append(args, *filter.ProjectID)
		invFilter = fmt.Sprintf("where asf.project_id = $%d", idx)
		tFilter = fmt.Sprintf("and sch.project_id = $%d", idx)
		idx++
	} else if len(filter.ProjectIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("p.project_id = any($%d)", idx))
		args = append(args, filter.ProjectIDs)
		invFilter = fmt.Sprintf("where asf.project_id = any($%d)", idx)
		tFilter = fmt.Sprintf("and sch.project_id = any($%d)", idx)
		idx++
	}
	if filter.Country != nil && *filter.Country != "" {
		conditions = append(conditions, fmt.Sprintf("upper(p.country) = $%d", idx))
		args = append(args, normalizeCountry(*filter.Country))
		idx++
	}
	if filter.Keyword != nil && *filter.Keyword != "" {
		conditions = append(conditions, fmt.Sprintf("(p.sku ilike $%d or p.asin ilike $%d)", idx, idx))
		args = append(args, "%"+*filter.Keyword+"%")
		idx++
	}
	conditions = append(conditions, "coalesce(p.is_active, true) = true")

	where := "where " + strings.Join(conditions, " and ")

	countSQL := fmt.Sprintf("select count(*) from public.product_costs p %s", where)
	var total int
	err := s.db.QueryRow(ctx, countSQL, args...).Scan(&total)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}

	limit := filter.PageSize
	offset := (filter.Page - 1) * filter.PageSize
	if offset < 0 {
		offset = 0
	}

	querySQL := fmt.Sprintf(`
		select
			p.project_id, coalesce(proj.project_name, '#' || p.project_id::text), p.sku, p.country, p.asin, p.product_name,
			coalesce(s.safety_factor, 0.20), coalesce(s.production_lead_days, 20), coalesce(s.shipping_days, 25),
			coalesce(inv.available_qty, 0), coalesce(t.in_transit_qty, 0)
		from public.product_costs p
		left join public.projects proj on proj.id = p.project_id
		left join public.inventory_replenishment_settings s
			on s.project_id = p.project_id and s.sku = p.sku and upper(s.country) = upper(p.country)
		left join (
			select asf.project_id, r.sku, coalesce(sum(r.available_qty), 0) as available_qty
			from public.inventory_snapshot_rows r
			join public.analysis_source_files asf on asf.id = r.source_file_id
			%s
			group by asf.project_id, r.sku
		) inv on inv.project_id = p.project_id and inv.sku = p.sku
		left join (
			select sch.project_id, i.sku, coalesce(sum(i.quantity), 0) as in_transit_qty
			from public.shipment_schedules sch
			join public.shipment_schedule_items i on i.shipment_schedule_id = sch.id
			where sch.shipment_status not in ('cancelled', 'delivered')
			%s
			group by sch.project_id, i.sku
		) t on t.project_id = p.project_id and t.sku = p.sku
		%s
		order by p.sort_order asc, p.id asc
		limit $%d offset $%d
	`, invFilter, tFilter, where, idx, idx+1)
	args = append(args, limit, offset)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	defer rows.Close()

	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	var items []inventory_replenishment.InventoryReplenishmentListItem
	summary := inventory_replenishment.InventoryReplenishmentSummary{
		StateDistribution:  make(map[string]int),
		ActionDistribution: make(map[string]int),
		StateActionMatrix:  make(map[string]map[string]int),
	}

	for rows.Next() {
		var it inventory_replenishment.InventoryReplenishmentListItem
		if err := rows.Scan(
			&it.ProjectID, &it.ProjectName, &it.SKU, &it.Country, &it.ASIN, &it.ProductName,
			&it.SafetyFactor, &it.ProductionLeadDays, &it.ShippingDays,
			&it.AvailableInventory, &it.InTransitQuantity,
		); err == nil {
			it.Country = normalizeCountry(it.Country)
			// Compute risk status dynamically based on real data
			if it.AvailableInventory == 0 && it.InTransitQuantity == 0 {
				it.RiskStatus = "长期断货"
			} else {
				it.RiskStatus = "待补数据"
			}

			// Apply risk_status filter if specified
			if filter.RiskStatus != nil && *filter.RiskStatus != "" && *filter.RiskStatus != "all" {
				if it.RiskStatus != *filter.RiskStatus {
					continue
				}
			}

			todayStr := today
			it.SelloutDate = &todayStr

			summary.TotalAvailableInventory += it.AvailableInventory
			summary.TotalInTransitQuantity += it.InTransitQuantity
			summary.SKUCount++

			switch it.RiskStatus {
			case "健康库存":
				summary.HealthyCount++
			case "断货风险", "短期断货", "长期断货":
				summary.OutOfStockRiskCount++
			case "滞销", "严重滞销":
				summary.SlowMovingCount++
			case "待补数据":
				summary.PendingDataCount++
			}

			summary.StateDistribution[it.RiskStatus]++
			items = append(items, it)
		}
	}

	return inventory_replenishment.InventoryReplenishmentListResponse{
		Items:    items,
		Summary:  summary,
		Total:    total,
		Page:     filter.Page,
		PageSize: filter.PageSize,
		HasNext:  offset+len(items) < total,
	}, nil
}

func (s *InventoryReplenishmentStore) listAnalysisFromSnapshot(ctx context.Context, filter inventory_replenishment.ReplenishmentFilter) (inventory_replenishment.InventoryReplenishmentListResponse, error) {
	var conditions []string
	var args []any
	idx := 1
	if filter.ProjectID != nil && *filter.ProjectID > 0 {
		conditions = append(conditions, fmt.Sprintf("s.project_id = $%d", idx))
		args = append(args, *filter.ProjectID)
		idx++
	}
	if filter.Country != nil && *filter.Country != "" {
		conditions = append(conditions, fmt.Sprintf("upper(s.country) = $%d", idx))
		args = append(args, normalizeCountry(*filter.Country))
		idx++
	}
	if filter.SnapshotDate != nil && *filter.SnapshotDate != "" {
		conditions = append(conditions, fmt.Sprintf("s.snapshot_date = $%d", idx))
		args = append(args, *filter.SnapshotDate)
		idx++
	}
	if filter.Keyword != nil && *filter.Keyword != "" {
		conditions = append(conditions, fmt.Sprintf("(i.sku ilike $%d or i.asin ilike $%d)", idx, idx))
		args = append(args, "%"+*filter.Keyword+"%")
		idx++
	}
	if filter.RiskStatus != nil && *filter.RiskStatus != "" && *filter.RiskStatus != "all" {
		conditions = append(conditions, fmt.Sprintf("i.risk_status = $%d", idx))
		args = append(args, *filter.RiskStatus)
		idx++
	}

	where := "where " + strings.Join(conditions, " and ")
	countSQL := fmt.Sprintf(`
		select count(*)
		from public.inventory_replenishment_snapshots s
		join public.inventory_replenishment_snapshot_items i on i.snapshot_id = s.id
		%s
	`, where)

	var total int
	err := s.db.QueryRow(ctx, countSQL, args...).Scan(&total)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}

	limit := filter.PageSize
	offset := (filter.Page - 1) * filter.PageSize
	if offset < 0 {
		offset = 0
	}

	querySQL := fmt.Sprintf(`
		select
			s.project_id, s.project_name, i.sku, s.country, i.asin, coalesce(p.product_name, ''),
			i.available_inventory, i.in_transit_quantity,
			i.dms_30, i.dms_14, i.dms_7, i.dms_3, i.base_dms,
			i.safety_factor, i.production_lead_days, i.shipping_days,
			i.weighted_dms, i.sellable_days, i.sellout_date, i.sellout_date_with_transit,
			i.replenishment_order_date, i.warehouse_entry_date, i.shipment_order_date,
			i.estimated_replenishment_quantity, i.risk_status, i.risk_anchor_date
		from public.inventory_replenishment_snapshots s
		join public.inventory_replenishment_snapshot_items i on i.snapshot_id = s.id
		left join public.product_costs p on p.project_id = s.project_id and p.sku = i.sku and upper(p.country) = upper(s.country)
		%s
		order by i.source_row_no asc, i.id asc
		limit $%d offset $%d
	`, where, idx, idx+1)
	args = append(args, limit, offset)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	defer rows.Close()

	var items []inventory_replenishment.InventoryReplenishmentListItem
	summary := inventory_replenishment.InventoryReplenishmentSummary{
		StateDistribution:  make(map[string]int),
		ActionDistribution: make(map[string]int),
		StateActionMatrix:  make(map[string]map[string]int),
	}

	for rows.Next() {
		var it inventory_replenishment.InventoryReplenishmentListItem
		if err := rows.Scan(
			&it.ProjectID, &it.ProjectName, &it.SKU, &it.Country, &it.ASIN, &it.ProductName,
			&it.AvailableInventory, &it.InTransitQuantity,
			&it.DMS30, &it.DMS14, &it.DMS7, &it.DMS3, &it.BaseDMS,
			&it.SafetyFactor, &it.ProductionLeadDays, &it.ShippingDays,
			&it.WeightedDMS, &it.SellableDays, &it.SelloutDate, &it.SelloutDateWithTransit,
			&it.ReplenishmentOrderDate, &it.WarehouseEntryDate, &it.ShipmentOrderDate,
			&it.EstimatedReplenishmentQuantity, &it.RiskStatus, &it.RiskAnchorDate,
		); err == nil {
			it.Country = normalizeCountry(it.Country)
			summary.TotalAvailableInventory += it.AvailableInventory
			summary.TotalInTransitQuantity += it.InTransitQuantity
			summary.SKUCount++
			switch it.RiskStatus {
			case "健康库存":
				summary.HealthyCount++
			case "断货风险", "短期断货", "长期断货":
				summary.OutOfStockRiskCount++
			case "滞销", "严重滞销":
				summary.SlowMovingCount++
			case "待补数据":
				summary.PendingDataCount++
			}
			summary.StateDistribution[it.RiskStatus]++
			items = append(items, it)
		}
	}

	return inventory_replenishment.InventoryReplenishmentListResponse{
		Items:    items,
		Summary:  summary,
		Total:    total,
		Page:     filter.Page,
		PageSize: filter.PageSize,
		HasNext:  offset+len(items) < total,
	}, nil
}

func (s *InventoryReplenishmentStore) UpdateSetting(ctx context.Context, projectID int64, sku string, update inventory_replenishment.InventoryReplenishmentSettingUpdate, op string) (inventory_replenishment.InventoryReplenishmentSettingItem, error) {
	safety := 0.20
	if update.SafetyFactor != nil {
		safety = *update.SafetyFactor
	}
	prodLead := 20
	if update.ProductionLeadDays != nil {
		prodLead = *update.ProductionLeadDays
	}
	shipping := 25
	if update.ShippingDays != nil {
		shipping = *update.ShippingDays
	}
	targetDays := 90
	if update.TargetDays != nil {
		targetDays = *update.TargetDays
	}
	country := normalizeCountry(update.Country)
	if country == "" {
		country = "US"
	}

	upsertSQL := `
		insert into public.inventory_replenishment_settings (
			project_id, project_name, sku, country, asin,
			production_lead_days, shipping_days, safety_factor, target_days,
			created_by, updated_by, created_at, updated_at
		) values (
			$1, coalesce((select project_name from public.projects where id = $1), '#' || $1::text),
			$2, $3, $4,
			$5, $6, $7, $8,
			$9, $9, now(), now()
		) on conflict (project_id, sku, country) do update set
			production_lead_days = excluded.production_lead_days,
			shipping_days = excluded.shipping_days,
			safety_factor = excluded.safety_factor,
			target_days = case when $10::boolean then excluded.target_days else inventory_replenishment_settings.target_days end,
			asin = excluded.asin,
			updated_by = excluded.updated_by,
			updated_at = now()
		returning id, project_id, project_name, sku, country, asin,
		          production_lead_days, shipping_days, safety_factor, target_days, updated_at
	`
	var item inventory_replenishment.InventoryReplenishmentSettingItem
	var updatedAt time.Time
	sku = strings.TrimSpace(sku)
	err := s.db.QueryRow(ctx, upsertSQL, projectID, sku, country, update.ASIN, prodLead, shipping, safety, targetDays, op, update.TargetDays != nil).Scan(
		&item.ID, &item.ProjectID, &item.ProjectName, &item.SKU, &item.Country, &item.ASIN,
		&item.ProductionLeadDays, &item.ShippingDays, &item.SafetyFactor, &item.TargetDays, &updatedAt,
	)
	if err != nil {
		return item, err
	}
	item.Country = normalizeCountry(item.Country)
	item.UpdatedAt = formatFastAPITimestamp(updatedAt)
	return item, nil
}

func (s *InventoryReplenishmentStore) ListShipments(ctx context.Context, projectID *int64, country *string) (inventory_replenishment.InventoryReplenishmentShipmentResponse, error) {
	if projectID == nil || *projectID <= 0 {
		return inventory_replenishment.InventoryReplenishmentShipmentResponse{Items: []inventory_replenishment.InventoryReplenishmentShipmentItem{}}, nil
	}

	query := `
		select
			s.shipment_no, i.sku, i.quantity, s.shipping_method,
			s.etd_date::text, s.eta_date::text, s.shipment_status
		from public.shipment_schedules s
		join public.shipment_schedule_items i on i.shipment_schedule_id = s.id
		where s.project_id = $1 and s.shipment_status != 'cancelled'
		order by coalesce(s.created_date, s.etd_date) desc, s.id desc
	`
	rows, err := s.db.Query(ctx, query, *projectID)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentShipmentResponse{}, err
	}
	defer rows.Close()

	var items []inventory_replenishment.InventoryReplenishmentShipmentItem
	for rows.Next() {
		var it inventory_replenishment.InventoryReplenishmentShipmentItem
		if err := rows.Scan(
			&it.ShipmentNo, &it.SKU, &it.Quantity, &it.ShippingMethod,
			&it.EtdDate, &it.EtaDate, &it.ShipmentStatus,
		); err == nil {
			items = append(items, it)
		}
	}
	if items == nil {
		items = []inventory_replenishment.InventoryReplenishmentShipmentItem{}
	}
	return inventory_replenishment.InventoryReplenishmentShipmentResponse{Items: items}, nil
}

func (s *InventoryReplenishmentStore) ListCalendar(ctx context.Context, projectID *int64, country *string) (inventory_replenishment.CalendarResponse, error) {
	filter := inventory_replenishment.ReplenishmentFilter{
		ProjectID: projectID,
		Country:   country,
		Page:      1,
		PageSize:  50,
	}
	resp, err := s.ListAnalysis(ctx, filter)
	if err != nil {
		return inventory_replenishment.CalendarResponse{Items: []inventory_replenishment.CalendarRowItem{}}, nil
	}

	var items []inventory_replenishment.CalendarRowItem
	for _, it := range resp.Items {
		dateStr := time.Now().Format("2006-01-02")
		if it.ReplenishmentOrderDate != nil && *it.ReplenishmentOrderDate != "" {
			dateStr = *it.ReplenishmentOrderDate
		}
		items = append(items, inventory_replenishment.CalendarRowItem{
			Date:   dateStr,
			Action: it.RiskStatus,
			SKU:    it.SKU,
		})
	}
	if items == nil {
		items = []inventory_replenishment.CalendarRowItem{}
	}
	return inventory_replenishment.CalendarResponse{Items: items}, nil
}

func (s *InventoryReplenishmentStore) ListSeasonal(ctx context.Context, projectID *int64, country *string) (inventory_replenishment.SeasonalReplenishmentListResponse, error) {
	filter := inventory_replenishment.ReplenishmentFilter{
		ProjectID: projectID,
		Country:   country,
		Page:      1,
		PageSize:  50,
	}
	resp, err := s.ListAnalysis(ctx, filter)
	if err != nil {
		return inventory_replenishment.SeasonalReplenishmentListResponse{Items: []inventory_replenishment.SeasonalReplenishmentListItem{}}, nil
	}

	var items []inventory_replenishment.SeasonalReplenishmentListItem
	for _, it := range resp.Items {
		items = append(items, inventory_replenishment.SeasonalReplenishmentListItem{
			SKU:    it.SKU,
			Phase:  "stable",
			Factor: 1.0,
		})
	}
	if items == nil {
		items = []inventory_replenishment.SeasonalReplenishmentListItem{}
	}
	return inventory_replenishment.SeasonalReplenishmentListResponse{Items: items}, nil
}

func (s *InventoryReplenishmentStore) ListSnapshots(ctx context.Context, projectID *int64, country *string) ([]inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
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
		args = append(args, normalizeCountry(*country))
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	query := fmt.Sprintf(`
		select
			id, project_id, project_name, country, snapshot_date::text, is_current,
			name, description, inventory_report_date::text, business_report_date::text,
			sales_report_date::text, row_count, created_by, created_at, summary_json::text
		from public.inventory_replenishment_snapshots
		%s
		order by snapshot_date desc, created_at desc
	`, where)

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []inventory_replenishment.InventoryReplenishmentSnapshotListItem
	for rows.Next() {
		var it inventory_replenishment.InventoryReplenishmentSnapshotListItem
		var summaryJSON string
		var createdAt time.Time
		if err := rows.Scan(
			&it.ID, &it.ProjectID, &it.ProjectName, &it.Country, &it.SnapshotDate, &it.IsCurrent,
			&it.Name, &it.Description, &it.InventoryReportDate, &it.BusinessReportDate,
			&it.SalesReportDate, &it.RowCount, &it.CreatedBy, &createdAt, &summaryJSON,
		); err != nil {
			return nil, err
		}
		it.Country = normalizeCountry(it.Country)
		it.CreatedAt = formatFastAPITimestamp(createdAt)
		if err := json.Unmarshal([]byte(summaryJSON), &it.Summary); err != nil {
			return nil, fmt.Errorf("decode inventory replenishment snapshot summary: %w", err)
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if items == nil {
		items = []inventory_replenishment.InventoryReplenishmentSnapshotListItem{}
	}
	return items, nil
}

func (s *InventoryReplenishmentStore) GetSnapshot(ctx context.Context, snapshotID int64) (*inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	query := `
		select
			id, project_id, project_name, country, snapshot_date::text, is_current,
			name, description, inventory_report_date::text, business_report_date::text,
			sales_report_date::text, row_count, created_by, created_at, summary_json::text
		from public.inventory_replenishment_snapshots
		where id = $1
	`
	var item inventory_replenishment.InventoryReplenishmentSnapshotListItem
	var summaryJSON string
	var createdAt time.Time
	err := s.db.QueryRow(ctx, query, snapshotID).Scan(
		&item.ID, &item.ProjectID, &item.ProjectName, &item.Country, &item.SnapshotDate, &item.IsCurrent,
		&item.Name, &item.Description, &item.InventoryReportDate, &item.BusinessReportDate,
		&item.SalesReportDate, &item.RowCount, &item.CreatedBy, &createdAt, &summaryJSON,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	item.Country = normalizeCountry(item.Country)
	item.CreatedAt = formatFastAPITimestamp(createdAt)
	if err := json.Unmarshal([]byte(summaryJSON), &item.Summary); err != nil {
		return nil, fmt.Errorf("decode inventory replenishment snapshot summary: %w", err)
	}
	return &item, nil
}

func (s *InventoryReplenishmentStore) ListSnapshotItems(ctx context.Context, snapshotID int64) ([]inventory_replenishment.InventoryReplenishmentSnapshotItem, error) {
	rows, err := s.db.Query(ctx, `
		select
			source_row_no, sku, asin, available_inventory, in_transit_quantity,
			dms_30, dms_14, dms_7, dms_3, base_dms,
			safety_factor, production_lead_days, shipping_days,
			weighted_dms, sellable_days, sellout_date, sellout_date_with_transit,
			replenishment_order_date, warehouse_entry_date, shipment_order_date,
			estimated_replenishment_quantity, risk_status, risk_anchor_date
		from public.inventory_replenishment_snapshot_items
		where snapshot_id = $1
		order by source_row_no asc, id asc
	`, snapshotID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]inventory_replenishment.InventoryReplenishmentSnapshotItem, 0)
	for rows.Next() {
		var item inventory_replenishment.InventoryReplenishmentSnapshotItem
		if err := rows.Scan(
			&item.SourceRowNo, &item.SKU, &item.ASIN, &item.AvailableInventory, &item.InTransitQuantity,
			&item.DMS30, &item.DMS14, &item.DMS7, &item.DMS3, &item.BaseDMS,
			&item.SafetyFactor, &item.ProductionLeadDays, &item.ShippingDays,
			&item.WeightedDMS, &item.SellableDays, &item.SelloutDate, &item.SelloutDateWithTransit,
			&item.ReplenishmentOrderDate, &item.WarehouseEntryDate, &item.ShipmentOrderDate,
			&item.EstimatedReplenishmentQuantity, &item.RiskStatus, &item.RiskAnchorDate,
		); err != nil {
			return nil, err
		}
		normalizeSnapshotItemFloats(&item)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *InventoryReplenishmentStore) ListSnapshotItemsPage(
	ctx context.Context,
	snapshot *inventory_replenishment.InventoryReplenishmentSnapshotListItem,
	filter inventory_replenishment.SnapshotItemsFilter,
) (inventory_replenishment.InventoryReplenishmentListResponse, error) {
	if snapshot == nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, nil
	}
	conditions := []string{"i.snapshot_id = $1"}
	args := []any{snapshot.ID}
	idx := 2
	if filter.Keyword != nil && strings.TrimSpace(*filter.Keyword) != "" {
		conditions = append(conditions, fmt.Sprintf("(i.sku ilike $%d or i.asin ilike $%d)", idx, idx))
		args = append(args, "%"+strings.TrimSpace(*filter.Keyword)+"%")
		idx++
	}
	if filter.RiskStatus != nil && strings.TrimSpace(*filter.RiskStatus) != "" && strings.TrimSpace(*filter.RiskStatus) != "all" {
		conditions = append(conditions, fmt.Sprintf("i.risk_status = $%d", idx))
		args = append(args, strings.TrimSpace(*filter.RiskStatus))
		idx++
	}
	if filter.InTransitOnly {
		conditions = append(conditions, "i.in_transit_quantity > 0")
	}
	where := "where " + strings.Join(conditions, " and ")

	var total int
	if err := s.db.QueryRow(ctx, fmt.Sprintf(`
		select count(*)
		from public.inventory_replenishment_snapshot_items i
		%s
	`, where), args...).Scan(&total); err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}

	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 50
	}
	offset := (page - 1) * pageSize
	query := fmt.Sprintf(`
		select
			i.sku, i.asin, p.product_name, i.available_inventory, i.in_transit_quantity,
			i.dms_30, i.dms_14, i.dms_7, i.dms_3, i.base_dms,
			i.safety_factor, i.production_lead_days, i.shipping_days,
			i.weighted_dms, i.sellable_days, i.sellout_date, i.sellout_date_with_transit,
			i.replenishment_order_date, i.warehouse_entry_date, i.shipment_order_date,
			i.estimated_replenishment_quantity, i.risk_status, i.risk_anchor_date
		from public.inventory_replenishment_snapshot_items i
		left join lateral (
			select pc.product_name
			from public.product_costs pc
			where pc.project_id = $%d
			  and upper(pc.country) = upper($%d)
			  and pc.sku = i.sku
			  and pc.is_active = true
			  and nullif(btrim(pc.product_name), '') is not null
			order by pc.id desc
			limit 1
		) p on true
		%s
		order by i.source_row_no asc, i.id asc
		limit $%d offset $%d
	`, idx, idx+1, where, idx+2, idx+3)
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, snapshot.ProjectID, snapshot.Country, pageSize, offset)

	rows, err := s.db.Query(ctx, query, queryArgs...)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}
	defer rows.Close()

	items := make([]inventory_replenishment.InventoryReplenishmentListItem, 0)
	for rows.Next() {
		item := inventory_replenishment.InventoryReplenishmentListItem{
			ProjectID:           snapshot.ProjectID,
			ProjectName:         snapshot.ProjectName,
			Country:             snapshot.Country,
			TargetDays:          90,
			InventoryState:      "unknown",
			ReplenishmentAction: "NO_ACTION",
		}
		if err := rows.Scan(
			&item.SKU, &item.ASIN, &item.ProductName, &item.AvailableInventory, &item.InTransitQuantity,
			&item.DMS30, &item.DMS14, &item.DMS7, &item.DMS3, &item.BaseDMS,
			&item.SafetyFactor, &item.ProductionLeadDays, &item.ShippingDays,
			&item.WeightedDMS, &item.SellableDays, &item.SelloutDate, &item.SelloutDateWithTransit,
			&item.ReplenishmentOrderDate, &item.WarehouseEntryDate, &item.ShipmentOrderDate,
			&item.EstimatedReplenishmentQuantity, &item.RiskStatus, &item.RiskAnchorDate,
		); err != nil {
			return inventory_replenishment.InventoryReplenishmentListResponse{}, err
		}
		normalizeListFloats(&item)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return inventory_replenishment.InventoryReplenishmentListResponse{}, err
	}

	return inventory_replenishment.InventoryReplenishmentListResponse{
		Items:    items,
		Summary:  snapshot.Summary.ReplenishmentSummary(),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		HasNext:  offset+len(items) < total,
	}, nil
}

func (s *InventoryReplenishmentStore) CreateSnapshot(ctx context.Context, projectID int64, country string, req inventory_replenishment.CreateSnapshotRequest, op string) (inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	normCountry := normalizeCountry(country)
	if normCountry == "" {
		normCountry = "US"
	}

	var projectName string
	err := s.db.QueryRow(ctx, "select project_name from public.projects where id = $1", projectID).Scan(&projectName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return inventory_replenishment.InventoryReplenishmentSnapshotListItem{}, inventory_replenishment.ErrProjectNotFound
		}
		return inventory_replenishment.InventoryReplenishmentSnapshotListItem{}, err
	}

	// Fetch current replenishment analysis data
	filter := inventory_replenishment.ReplenishmentFilter{
		ProjectID: &projectID,
		Country:   &normCountry,
		Page:      1,
		PageSize:  10000,
	}
	analysis, err := s.ListAnalysis(ctx, filter)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentSnapshotListItem{}, err
	}

	summaryBytes, err := json.Marshal(analysis.Summary)
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentSnapshotListItem{}, err
	}
	today := time.Now().Format("2006-01-02")

	var snapshotID int64
	var createdAt time.Time

	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)

		// 1) Mark old current snapshots as not current
		_, err := txDB.Exec(ctx, `
			update public.inventory_replenishment_snapshots
			set is_current = false
			where project_id = $1 and upper(country) = upper($2) and is_current = true
		`, projectID, normCountry)
		if err != nil {
			return err
		}

		// 2) Insert master snapshot row
		insertSnapshotSQL := `
			insert into public.inventory_replenishment_snapshots (
				project_id, project_name, country, snapshot_date, is_current,
				name, description, summary_json, row_count, computation_time_ms,
				created_by, created_at
			) values (
				$1, $2, $3, $4, true,
				$5, $6, $7::json, $8, 10,
				$9, now()
			) returning id, created_at
		`
		err = txDB.QueryRow(ctx, insertSnapshotSQL,
			projectID, projectName, normCountry, today,
			req.Name, req.Description, string(summaryBytes), len(analysis.Items),
			op,
		).Scan(&snapshotID, &createdAt)
		if err != nil {
			return err
		}

		// 3) Insert snapshot items
		insertItemSQL := `
			insert into public.inventory_replenishment_snapshot_items (
				snapshot_id, source_row_no, sku, asin,
				available_inventory, in_transit_quantity,
				dms_30, dms_14, dms_7, dms_3, base_dms,
				safety_factor, production_lead_days, shipping_days,
				weighted_dms, sellable_days, sellout_date, sellout_date_with_transit,
				replenishment_order_date, warehouse_entry_date, shipment_order_date,
				estimated_replenishment_quantity, risk_status, risk_anchor_date
			) values (
				$1, $2, $3, $4,
				$5, $6,
				$7, $8, $9, $10, $11,
				$12, $13, $14,
				$15, $16, $17, $18,
				$19, $20, $21,
				$22, $23, $24
			)
		`
		for idx, it := range analysis.Items {
			_, err := txDB.Exec(ctx, insertItemSQL,
				snapshotID, idx, it.SKU, it.ASIN,
				it.AvailableInventory, it.InTransitQuantity,
				it.DMS30, it.DMS14, it.DMS7, it.DMS3, it.BaseDMS,
				it.SafetyFactor, it.ProductionLeadDays, it.ShippingDays,
				it.WeightedDMS, it.SellableDays, it.SelloutDate, it.SelloutDateWithTransit,
				it.ReplenishmentOrderDate, it.WarehouseEntryDate, it.ShipmentOrderDate,
				it.EstimatedReplenishmentQuantity, it.RiskStatus, it.RiskAnchorDate,
			)
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return inventory_replenishment.InventoryReplenishmentSnapshotListItem{}, err
	}

	return inventory_replenishment.InventoryReplenishmentSnapshotListItem{
		ID:           snapshotID,
		ProjectID:    projectID,
		ProjectName:  projectName,
		Country:      normCountry,
		SnapshotDate: today,
		IsCurrent:    true,
		Name:         req.Name,
		Description:  req.Description,
		RowCount:     len(analysis.Items),
		CreatedBy:    &op,
		CreatedAt:    formatFastAPITimestamp(createdAt),
		Summary: inventory_replenishment.InventoryReplenishmentSnapshotSummary{
			SKUCount:                analysis.Summary.SKUCount,
			OutOfStockRiskCount:     analysis.Summary.OutOfStockRiskCount,
			HealthyCount:            analysis.Summary.HealthyCount,
			SlowMovingCount:         analysis.Summary.SlowMovingCount,
			PendingDataCount:        analysis.Summary.PendingDataCount,
			TotalAvailableInventory: analysis.Summary.TotalAvailableInventory,
			TotalInTransitQuantity:  analysis.Summary.TotalInTransitQuantity,
		},
	}, nil
}

func (s *InventoryReplenishmentStore) UpdateSnapshot(ctx context.Context, snapshotID int64, req inventory_replenishment.UpdateSnapshotRequest, op string) (*inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	updateSQL := `
		update public.inventory_replenishment_snapshots
		set
			name = case when $1::boolean then $2 else name end,
			description = case when $3::boolean then $4 else description end
		where id = $5
		returning id, project_id, project_name, country, snapshot_date::text, is_current,
		          name, description, inventory_report_date::text, business_report_date::text,
		          sales_report_date::text, row_count, created_by, created_at, summary_json::text
	`
	var it inventory_replenishment.InventoryReplenishmentSnapshotListItem
	var summaryJSON string
	var createdAt time.Time
	err := s.db.QueryRow(ctx, updateSQL, req.Name != nil, req.Name, req.Description != nil, req.Description, snapshotID).Scan(
		&it.ID, &it.ProjectID, &it.ProjectName, &it.Country, &it.SnapshotDate, &it.IsCurrent,
		&it.Name, &it.Description, &it.InventoryReportDate, &it.BusinessReportDate,
		&it.SalesReportDate, &it.RowCount, &it.CreatedBy, &createdAt, &summaryJSON,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	it.Country = normalizeCountry(it.Country)
	it.CreatedAt = formatFastAPITimestamp(createdAt)
	if err := json.Unmarshal([]byte(summaryJSON), &it.Summary); err != nil {
		return nil, fmt.Errorf("decode inventory replenishment snapshot summary: %w", err)
	}
	return &it, nil
}

func (s *InventoryReplenishmentStore) DeleteSnapshot(ctx context.Context, snapshotID int64, op string) (bool, error) {
	tag, err := s.db.Exec(ctx, "delete from public.inventory_replenishment_snapshots where id = $1", snapshotID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *InventoryReplenishmentStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, inventory_replenishment.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &InventoryReplenishmentStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func formatFastAPITimestamp(value time.Time) string {
	base := value.Format("2006-01-02T15:04:05")
	if micros := value.Nanosecond() / 1000; micros != 0 {
		base += fmt.Sprintf(".%06d", micros)
	}
	return base + value.Format("-07:00")
}

func normalizeOptionalFloat(value *float64) *float64 {
	if value != nil && math.Abs(*value) < 1e-12 {
		return nil
	}
	return value
}

func normalizeSnapshotItemFloats(item *inventory_replenishment.InventoryReplenishmentSnapshotItem) {
	item.DMS30 = normalizeOptionalFloat(item.DMS30)
	item.DMS14 = normalizeOptionalFloat(item.DMS14)
	item.DMS7 = normalizeOptionalFloat(item.DMS7)
	item.DMS3 = normalizeOptionalFloat(item.DMS3)
	item.BaseDMS = normalizeOptionalFloat(item.BaseDMS)
	item.WeightedDMS = normalizeOptionalFloat(item.WeightedDMS)
	item.SellableDays = normalizeOptionalFloat(item.SellableDays)
}

func normalizeListFloats(item *inventory_replenishment.InventoryReplenishmentListItem) {
	item.DMS30 = normalizeOptionalFloat(item.DMS30)
	item.DMS14 = normalizeOptionalFloat(item.DMS14)
	item.DMS7 = normalizeOptionalFloat(item.DMS7)
	item.DMS3 = normalizeOptionalFloat(item.DMS3)
	item.BaseDMS = normalizeOptionalFloat(item.BaseDMS)
	item.WeightedDMS = normalizeOptionalFloat(item.WeightedDMS)
	item.SellableDays = normalizeOptionalFloat(item.SellableDays)
}
