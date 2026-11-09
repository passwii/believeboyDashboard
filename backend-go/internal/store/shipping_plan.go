package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipping_plan"
)

type ShippingPlanStore struct {
	db FullDB
}

func NewShippingPlanStore(db FullDB) *ShippingPlanStore {
	return &ShippingPlanStore{db: db}
}

func (s *ShippingPlanStore) VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	var projectOperator, assistantOperator *string
	err := s.db.QueryRow(ctx, `
		select project_operator, assistant_operator
		from public.projects
		where id = $1
	`, projectID).Scan(&projectOperator, &assistantOperator)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return shipping_plan.ErrNotFound
		}
		return err
	}
	operator := strings.TrimSpace(op)
	if operator == "" {
		return shipping_plan.ErrForbidden
	}
	if textContainsName(projectOperator, operator) || textContainsName(assistantOperator, operator) {
		return nil
	}
	return shipping_plan.ErrForbidden
}

func (s *ShippingPlanStore) ListSkus(ctx context.Context, projectID int64, country string, page, pageSize int) (shipping_plan.ShippingPlanSkuListResponse, error) {
	rows, err := s.db.Query(ctx, `
		select
			p.sku, p.asin, p.product_name,
			coalesce(s.growth_factor, 1.0)
		from public.product_costs p
		left join public.shipping_plan_sku_settings s
			on s.project_id = p.project_id and upper(s.country) = upper(p.country) and s.sku = p.sku
		where p.project_id = $1 and upper(p.country) = upper($2)
		order by p.sort_order asc, p.id asc
		limit $3 offset $4
	`, projectID, strings.ToUpper(country), pageSize, (page-1)*pageSize)
	if err != nil {
		return shipping_plan.ShippingPlanSkuListResponse{}, err
	}
	defer rows.Close()

	var items []shipping_plan.ShippingPlanSkuItem
	for rows.Next() {
		var item shipping_plan.ShippingPlanSkuItem
		if err := rows.Scan(&item.SKU, &item.ASIN, &item.ProductName, &item.GrowthFactor); err == nil {
			item.DemandSource = "default"
			item.DataQuality = []string{}
			items = append(items, item)
		}
	}

	var total int
	_ = s.db.QueryRow(ctx, `select count(*) from public.product_costs where project_id = $1 and upper(country) = upper($2)`, projectID, country).Scan(&total)

	return shipping_plan.ShippingPlanSkuListResponse{
		Items:                 items,
		Total:                 total,
		Page:                  page,
		PageSize:              pageSize,
		ValidForecastSKUCount: len(items),
	}, nil
}

func (s *ShippingPlanStore) GetForecast(ctx context.Context, projectID int64, country, sku string) (shipping_plan.ShippingPlanForecastResponse, error) {
	growthFactor := 1.0
	demandSource := "default"
	var gf float64
	err := s.db.QueryRow(ctx, `
		select coalesce(growth_factor, 1.0)
		from public.shipping_plan_sku_settings
		where project_id = $1 and upper(country) = upper($2) and sku = $3
	`, projectID, country, sku).Scan(&gf)
	if err == nil {
		growthFactor = gf
		demandSource = "manual"
	}

	var baseDMS *float64
	var availableInventory *int

	var dmsOverride *float64
	var availQty *int
	baseRow := s.db.QueryRow(ctx, `
		select
			s.base_dms_override,
			coalesce(inv.available_qty, 0)
		from public.product_costs p
		left join public.inventory_replenishment_settings s
			on s.project_id = p.project_id and upper(s.country) = upper(p.country) and s.sku = p.sku
		left join (
			select r.sku, coalesce(sum(r.available_qty), 0) as available_qty
			from public.inventory_snapshot_rows r
			join public.analysis_source_files asf on asf.id = r.source_file_id
			where asf.project_id = $1 and upper(asf.country) = upper($2)
			group by r.sku
		) inv on inv.sku = p.sku
		where p.project_id = $1 and upper(p.country) = upper($2) and p.sku = $3
		limit 1
	`, projectID, country, sku)
	if err := baseRow.Scan(&dmsOverride, &availQty); err == nil {
		if dmsOverride != nil && *dmsOverride > 0 {
			baseDMS = dmsOverride
		}
		availableInventory = availQty
	}

	if baseDMS == nil {
		var avgDMS *float64
		salesRow := s.db.QueryRow(ctx, `
			select coalesce(sum(r.quantity)::float / 30.0, 0.0)
			from public.analysis_sales_order_rows r
			join public.analysis_source_files asf on asf.id = r.source_file_id
			where asf.project_id = $1 and upper(asf.country) = upper($2) and r.sku = $3
			  and r.purchase_date >= (current_date - interval '30 days')
		`, projectID, country, sku)
		if err := salesRow.Scan(&avgDMS); err == nil && avgDMS != nil && *avgDMS > 0 {
			baseDMS = avgDMS
		}
	}

	asOfDate := time.Now().UTC()
	today := asOfDate.Format("2006-01-02")
	startDate := asOfDate.AddDate(0, 0, 1)
	endDate := startDate.AddDate(0, 0, 179)
	startDateStr := startDate.Format("2006-01-02")
	endDateStr := endDate.Format("2006-01-02")
	salesBaselineStartDate := asOfDate.AddDate(0, 0, -29).Format("2006-01-02")
	salesBaselineEndDate := today

	var arrivals []shipping_plan.ForecastArrival
	var quality []string
	overdueShipmentQuantity := 0
	overduePlanQuantity := 0
	unverifiedCompletedQuantity := 0

	confirmedArrivals := make(map[string]int)
	plannedOnlyArrivals := make(map[string]int)

	// Query shipments
	shipmentSQL := `
		select
			s.shipment_no, s.shipment_status,
			s.eta_date::text, s.actual_inbound_date::text,
			coalesce(i.quantity, 0)
		from public.shipment_schedules s
		join public.shipment_schedule_items i on s.id = i.shipment_schedule_id
		where s.project_id = $1 and upper(s.country) = upper($2) and i.sku = $3
		order by s.id asc
	`
	shipmentRows, err := s.db.Query(ctx, shipmentSQL, projectID, country, sku)
	if err == nil {
		defer shipmentRows.Close()
		for shipmentRows.Next() {
			var shipmentNo, status string
			var etaDate, actualInboundDate *string
			var quantity int
			if err := shipmentRows.Scan(&shipmentNo, &status, &etaDate, &actualInboundDate, &quantity); err == nil {
				if status == "completed" {
					if actualInboundDate == nil || *actualInboundDate == "" {
						unverifiedCompletedQuantity += quantity
						quality = append(quality, "completed_inbound_unverified")
						inbQ := "inbound_unverified"
						arrivals = append(arrivals, shipping_plan.ForecastArrival{
							ArrivalDate: "",
							SKU:         sku,
							Quantity:    quantity,
							SourceType:  "completed",
							Reference:   &shipmentNo,
							DataQuality: &inbQ,
						})
					} else if *actualInboundDate < startDateStr {
						quality = append(quality, "post_snapshot_inbound_before_forecast_start")
						invQ := "inventory_snapshot_required"
						arrivals = append(arrivals, shipping_plan.ForecastArrival{
							ArrivalDate: *actualInboundDate,
							SKU:         sku,
							Quantity:    quantity,
							SourceType:  "completed",
							Reference:   &shipmentNo,
							DataQuality: &invQ,
						})
					} else if *actualInboundDate <= endDateStr {
						confirmedArrivals[*actualInboundDate] += quantity
						arrivals = append(arrivals, shipping_plan.ForecastArrival{
							ArrivalDate: *actualInboundDate,
							SKU:         sku,
							Quantity:    quantity,
							SourceType:  "completed",
							Reference:   &shipmentNo,
						})
					}
				} else {
					if etaDate == nil || *etaDate == "" {
						quality = append(quality, "shipment_eta_missing")
						etaQ := "eta_missing"
						arrivals = append(arrivals, shipping_plan.ForecastArrival{
							ArrivalDate: "",
							SKU:         sku,
							Quantity:    quantity,
							SourceType:  status,
							Reference:   &shipmentNo,
							DataQuality: &etaQ,
						})
					} else if *etaDate < startDateStr {
						overdueShipmentQuantity += quantity
						quality = append(quality, "shipment_eta_overdue")
						etaQ := "eta_overdue"
						arrivals = append(arrivals, shipping_plan.ForecastArrival{
							ArrivalDate: *etaDate,
							SKU:         sku,
							Quantity:    quantity,
							SourceType:  status,
							Reference:   &shipmentNo,
							DataQuality: &etaQ,
						})
					} else if *etaDate <= endDateStr {
						if status == "in_transit" {
							confirmedArrivals[*etaDate] += quantity
						} else {
							plannedOnlyArrivals[*etaDate] += quantity
						}
						arrivals = append(arrivals, shipping_plan.ForecastArrival{
							ArrivalDate: *etaDate,
							SKU:         sku,
							Quantity:    quantity,
							SourceType:  status,
							Reference:   &shipmentNo,
						})
					}
				}
			}
		}
	}

	// Query planned batches
	planSQL := `
		select
			b.name, b.expected_arrival_date::text,
			coalesce(i.quantity, 0)
		from public.shipping_plan_batches b
		join public.shipping_plan_items i on b.id = i.batch_id
		where b.project_id = $1 and upper(b.country) = upper($2) and i.sku = $3
		  and b.status = 'active'
		order by b.id asc
	`
	planRows, err := s.db.Query(ctx, planSQL, projectID, country, sku)
	if err == nil {
		defer planRows.Close()
		for planRows.Next() {
			var batchName string
			var arrivalDate *string
			var quantity int
			if err := planRows.Scan(&batchName, &arrivalDate, &quantity); err == nil {
				if arrivalDate == nil || *arrivalDate == "" {
					arrivals = append(arrivals, shipping_plan.ForecastArrival{
						ArrivalDate: "",
						SKU:         sku,
						Quantity:    quantity,
						SourceType:  "expected_plan",
						Reference:   &batchName,
					})
				} else if *arrivalDate < startDateStr {
					overduePlanQuantity += quantity
					quality = append(quality, "plan_eta_overdue")
					planQ := "plan_overdue"
					arrivals = append(arrivals, shipping_plan.ForecastArrival{
						ArrivalDate: *arrivalDate,
						SKU:         sku,
						Quantity:    quantity,
						SourceType:  "expected_plan",
						Reference:   &batchName,
						DataQuality: &planQ,
					})
				} else if *arrivalDate <= endDateStr {
					plannedOnlyArrivals[*arrivalDate] += quantity
					arrivals = append(arrivals, shipping_plan.ForecastArrival{
						ArrivalDate: *arrivalDate,
						SKU:         sku,
						Quantity:    quantity,
						SourceType:  "expected_plan",
						Reference:   &batchName,
					})
				}
			}
		}
	}

	if availableInventory == nil {
		quality = append(quality, "inventory_snapshot_missing")
	}
	if baseDMS == nil {
		quality = append(quality, "sales_baseline_missing")
	}

	dailyPoints := SimulateForecast(
		startDate,
		180,
		availableInventory,
		baseDMS,
		growthFactor,
		confirmedArrivals,
		plannedOnlyArrivals,
	)
	uniqQuality := make([]string, 0, len(quality))
	seenQ := make(map[string]bool)
	for _, q := range quality {
		if !seenQ[q] {
			seenQ[q] = true
			uniqQuality = append(uniqQuality, q)
		}
	}

	return shipping_plan.ShippingPlanForecastResponse{
		ProjectID:                   projectID,
		Country:                     strings.ToUpper(country),
		SKU:                         sku,
		AsOfDate:                    today,
		ForecastStartDate:           startDateStr,
		ForecastEndDate:             endDateStr,
		SalesBaselineStartDate:      salesBaselineStartDate,
		SalesBaselineEndDate:        salesBaselineEndDate,
		GrowthFactor:                growthFactor,
		DemandSource:                demandSource,
		DataQuality:                 uniqQuality,
		DailyPoints:                 dailyPoints,
		Arrivals:                    arrivals,
		UnverifiedCompletedQuantity: unverifiedCompletedQuantity,
		OverdueShipmentQuantity:     overdueShipmentQuantity,
		OverduePlanQuantity:         overduePlanQuantity,
	}, nil
}

func (s *ShippingPlanStore) UpdateGrowthFactor(ctx context.Context, sku string, update shipping_plan.ShippingPlanGrowthFactorUpdate) (shipping_plan.ShippingPlanGrowthFactorResponse, error) {
	sku = strings.TrimSpace(sku)
	if sku == "" {
		return shipping_plan.ShippingPlanGrowthFactorResponse{}, fmt.Errorf("422: sku 不能为空")
	}
	country := strings.ToUpper(strings.TrimSpace(update.Country))
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var exists bool
		if err := txDB.QueryRow(ctx, `
			select exists (
				select 1
				from public.product_costs
				where project_id = $1
				  and upper(country) = $2
				  and sku = $3
				  and is_active = true
			)
		`, update.ProjectID, country, sku).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return shipping_plan.ErrSKUNotFound
		}
		_, err := txDB.Exec(ctx, `
			insert into public.shipping_plan_sku_settings (project_id, country, sku, growth_factor, updated_at)
			values ($1, $2, $3, $4, now())
			on conflict (project_id, country, sku) do update set
				growth_factor = excluded.growth_factor,
				updated_at = now()
		`, update.ProjectID, country, sku, update.GrowthFactor)
		return err
	})
	if err != nil {
		return shipping_plan.ShippingPlanGrowthFactorResponse{}, err
	}
	return shipping_plan.ShippingPlanGrowthFactorResponse{
		ProjectID:    update.ProjectID,
		Country:      country,
		SKU:          sku,
		GrowthFactor: update.GrowthFactor,
		DemandSource: "manual",
	}, nil
}

func (s *ShippingPlanStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, shipping_plan.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &ShippingPlanStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (s *ShippingPlanStore) GetShipmentHistory(ctx context.Context, projectID int64, country, etdFrom, etdTo string) (shipping_plan.ShipmentHistoryResponse, error) {
	return shipping_plan.ShipmentHistoryResponse{
		ProjectID:        projectID,
		Country:          strings.ToUpper(country),
		EtdFrom:          etdFrom,
		EtdTo:            etdTo,
		Months:           []shipping_plan.ShipmentHistoryMonth{},
		IncludedStatuses: []string{"in_transit", "completed"},
		DateBasis:        "ETD",
		SalesMonths:      []shipping_plan.ShipmentHistorySalesMonth{},
		SalesBasis:       "purchase_date_pt",
	}, nil
}

func (s *ShippingPlanStore) loadBatchWithDB(ctx context.Context, db DB, batchID int64) (*shipping_plan.ShippingPlanBatchResponse, error) {
	var b shipping_plan.ShippingPlanBatchResponse
	err := db.QueryRow(ctx, `
		select id, project_id, country, name, expected_arrival_date::text, status, remark
		from public.shipping_plan_batches
		where id = $1
	`, batchID).Scan(&b.ID, &b.ProjectID, &b.Country, &b.Name, &b.ExpectedArrivalDate, &b.Status, &b.Remark)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	b.Items = []shipping_plan.ShippingPlanBatchItemResponse{}
	itemRows, err := db.Query(ctx, `
		select id, sku, quantity
		from public.shipping_plan_items
		where batch_id = $1
		order by id asc
	`, batchID)
	if err == nil {
		defer itemRows.Close()
		for itemRows.Next() {
			var it shipping_plan.ShippingPlanBatchItemResponse
			if err := itemRows.Scan(&it.ID, &it.SKU, &it.Quantity); err == nil {
				it.Allocations = []shipping_plan.ShippingPlanAllocationResponse{}
				b.Items = append(b.Items, it)
			}
		}
	}

	for i := range b.Items {
		item := &b.Items[i]
		allocRows, err := db.Query(ctx, `
			select id, plan_item_id, shipment_schedule_id, sku, quantity
			from public.shipping_plan_allocations
			where plan_item_id = $1
			order by id asc
		`, item.ID)
		if err == nil {
			defer allocRows.Close()
			allocated := 0
			for allocRows.Next() {
				var al shipping_plan.ShippingPlanAllocationResponse
				if err := allocRows.Scan(&al.ID, &al.PlanItemID, &al.ShipmentScheduleID, &al.SKU, &al.Quantity); err == nil {
					allocated += al.Quantity
					item.Allocations = append(item.Allocations, al)
				}
			}
			item.AllocatedQuantity = allocated
			rem := item.Quantity - allocated
			if rem < 0 {
				rem = 0
			}
			item.RemainingQuantity = rem
		}
	}

	return &b, nil
}

func (s *ShippingPlanStore) GetBatch(ctx context.Context, batchID int64) (*shipping_plan.ShippingPlanBatchResponse, error) {
	return s.loadBatchWithDB(ctx, s.db, batchID)
}

func (s *ShippingPlanStore) GetAllocationProjectID(ctx context.Context, allocationID int64) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(ctx, `
		select b.project_id
		from public.shipping_plan_allocations a
		join public.shipping_plan_items i on a.plan_item_id = i.id
		join public.shipping_plan_batches b on i.batch_id = b.id
		where a.id = $1
	`, allocationID).Scan(&projectID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf("404: 货件关联不存在")
		}
		return 0, err
	}
	return projectID, nil
}

func (s *ShippingPlanStore) ListBatches(ctx context.Context, projectID int64, country string) (shipping_plan.ShippingPlanBatchListResponse, error) {
	rows, err := s.db.Query(ctx, `
		select id
		from public.shipping_plan_batches
		where project_id = $1 and upper(country) = upper($2)
		order by expected_arrival_date asc, id desc
	`, projectID, country)
	if err != nil {
		return shipping_plan.ShippingPlanBatchListResponse{}, err
	}
	defer rows.Close()

	var batchIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			batchIDs = append(batchIDs, id)
		}
	}

	var items []shipping_plan.ShippingPlanBatchResponse
	for _, id := range batchIDs {
		b, err := s.loadBatchWithDB(ctx, s.db, id)
		if err == nil && b != nil {
			items = append(items, *b)
		}
	}
	return shipping_plan.ShippingPlanBatchListResponse{
		Items: items,
		Total: len(items),
	}, nil
}

func (s *ShippingPlanStore) CreateBatch(ctx context.Context, create shipping_plan.ShippingPlanBatchCreate, op string) (shipping_plan.ShippingPlanBatchResponse, error) {
	var created shipping_plan.ShippingPlanBatchResponse
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)

		insertSQL := `
			insert into public.shipping_plan_batches (
				project_id, country, name, expected_arrival_date, status, remark, created_by, updated_by, created_at, updated_at
			) values (
				$1, upper($2), $3, $4, 'active', $5, $6, $6, now(), now()
			) returning id
		`
		var batchID int64
		err := txDB.QueryRow(ctx, insertSQL, create.ProjectID, create.Country, create.Name, create.ExpectedArrivalDate, create.Remark, op).Scan(&batchID)
		if err != nil {
			return err
		}

		for _, it := range create.Items {
			if it.Quantity <= 0 {
				return fmt.Errorf("422: 明细数量必须大于0")
			}
			_, err := txDB.Exec(ctx, `
				insert into public.shipping_plan_items (batch_id, sku, quantity, created_at, updated_at)
				values ($1, $2, $3, now(), now())
			`, batchID, it.SKU, it.Quantity)
			if err != nil {
				return err
			}
		}

		loaded, err := s.loadBatchWithDB(ctx, txDB, batchID)
		if err != nil {
			return err
		}
		if loaded == nil {
			return fmt.Errorf("failed to load created batch")
		}
		created = *loaded
		return nil
	})
	if err != nil {
		return shipping_plan.ShippingPlanBatchResponse{}, err
	}
	return created, nil
}

func (s *ShippingPlanStore) UpdateBatch(ctx context.Context, batchID int64, update shipping_plan.ShippingPlanBatchUpdate, op string) (*shipping_plan.ShippingPlanBatchResponse, error) {
	var updated *shipping_plan.ShippingPlanBatchResponse
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)

		var status string
		err := txDB.QueryRow(ctx, `
			select status
			from public.shipping_plan_batches
			where id = $1
			for update
		`, batchID).Scan(&status)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("404: 计划批次不存在")
			}
			return err
		}
		if status != "active" {
			return fmt.Errorf("409: 已取消计划批次不可编辑")
		}

		updateSQL := `
			update public.shipping_plan_batches
			set name = coalesce($2, name),
			    expected_arrival_date = coalesce($3, expected_arrival_date),
			    remark = coalesce($4, remark),
			    updated_by = $5,
			    updated_at = now()
			where id = $1
		`
		_, err = txDB.Exec(ctx, updateSQL, batchID, update.Name, update.ExpectedArrivalDate, update.Remark, op)
		if err != nil {
			return err
		}

		if update.Items != nil {
			type existingItem struct {
				id       int64
				sku      string
				quantity int
			}
			itemRows, err := txDB.Query(ctx, `
				select id, sku, quantity
				from public.shipping_plan_items
				where batch_id = $1
				for update
			`, batchID)
			if err != nil {
				return err
			}
			defer itemRows.Close()

			var existing []existingItem
			for itemRows.Next() {
				var it existingItem
				if err := itemRows.Scan(&it.id, &it.sku, &it.quantity); err == nil {
					existing = append(existing, it)
				}
			}

			incoming := make(map[string]int)
			for _, it := range update.Items {
				if it.Quantity <= 0 {
					return fmt.Errorf("422: 明细数量必须大于0")
				}
				incoming[it.SKU] = it.Quantity
			}

			for _, it := range existing {
				var allocated int
				_ = txDB.QueryRow(ctx, `
					select coalesce(sum(quantity), 0)
					from public.shipping_plan_allocations
					where plan_item_id = $1
				`, it.id).Scan(&allocated)

				reqQty, exists := incoming[it.sku]
				if !exists {
					if allocated > 0 {
						return fmt.Errorf("409: SKU %s 存在已关联数量，不能从批次移除", it.sku)
					}
					_, _ = txDB.Exec(ctx, `delete from public.shipping_plan_items where id = $1`, it.id)
				} else {
					delete(incoming, it.sku)
					if reqQty < allocated {
						return fmt.Errorf("409: SKU %s 的计划数量不能小于已关联数量", it.sku)
					}
					_, _ = txDB.Exec(ctx, `
						update public.shipping_plan_items
						set quantity = $2, updated_at = now()
						where id = $1
					`, it.id, reqQty)
				}
			}

			for sku, qty := range incoming {
				_, err := txDB.Exec(ctx, `
					insert into public.shipping_plan_items (batch_id, sku, quantity, created_at, updated_at)
					values ($1, $2, $3, now(), now())
				`, batchID, sku, qty)
				if err != nil {
					return err
				}
			}
		}

		loaded, err := s.loadBatchWithDB(ctx, txDB, batchID)
		if err != nil {
			return err
		}
		updated = loaded
		return nil
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

func (s *ShippingPlanStore) CancelBatch(ctx context.Context, batchID int64, op string) (*shipping_plan.ShippingPlanBatchResponse, error) {
	var cancelled *shipping_plan.ShippingPlanBatchResponse
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var id int64
		err := txDB.QueryRow(ctx, `
			select id from public.shipping_plan_batches where id = $1 for update
		`, batchID).Scan(&id)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("404: 计划批次不存在")
			}
			return err
		}

		_, err = txDB.Exec(ctx, `
			update public.shipping_plan_batches
			set status = 'cancelled', updated_by = $2, updated_at = now()
			where id = $1
		`, batchID, op)
		if err != nil {
			return err
		}

		cancelled, err = s.loadBatchWithDB(ctx, txDB, batchID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return cancelled, nil
}

func (s *ShippingPlanStore) CreateAllocation(ctx context.Context, batchID int64, create shipping_plan.ShippingPlanAllocationCreate, _ string) (shipping_plan.ShippingPlanAllocationResult, error) {
	if create.Quantity <= 0 {
		return shipping_plan.ShippingPlanAllocationResult{}, fmt.Errorf("422: 分配数量必须为正整数")
	}
	var result shipping_plan.ShippingPlanAllocationResult
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)

		var planItem struct {
			id       int64
			batchID  int64
			sku      string
			quantity int
		}
		err := txDB.QueryRow(ctx, `
			select id, batch_id, sku, quantity
			from public.shipping_plan_items
			where id = $1
			for update
		`, create.PlanItemID).Scan(&planItem.id, &planItem.batchID, &planItem.sku, &planItem.quantity)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("404: 计划 SKU 明细不存在")
			}
			return err
		}
		if planItem.batchID != batchID {
			return fmt.Errorf("404: 计划 SKU 明细不存在")
		}

		var schedule struct {
			id             int64
			projectID      int64
			country        string
			shipmentStatus string
		}
		err = txDB.QueryRow(ctx, `
			select id, project_id, country, shipment_status
			from public.shipment_schedules
			where id = $1
			for update
		`, create.ShipmentScheduleID).Scan(&schedule.id, &schedule.projectID, &schedule.country, &schedule.shipmentStatus)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("404: 正式货件不存在")
			}
			return err
		}

		var batch struct {
			id        int64
			projectID int64
			country   string
			status    string
		}
		err = txDB.QueryRow(ctx, `
			select id, project_id, country, status
			from public.shipping_plan_batches
			where id = $1
			for update
		`, batchID).Scan(&batch.id, &batch.projectID, &batch.country, &batch.status)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("404: 计划 SKU 明细不存在")
			}
			return err
		}

		if batch.projectID != schedule.projectID || !strings.EqualFold(batch.country, schedule.country) {
			return fmt.Errorf("404: 正式货件不存在")
		}

		if batch.status != "active" {
			return fmt.Errorf("409: 已取消计划不能新增货件关联")
		}
		if schedule.shipmentStatus != "draft" && schedule.shipmentStatus != "in_transit" {
			return fmt.Errorf("409: 仅 draft / in_transit 货件可关联")
		}

		var scheduleItemQuantity int
		err = txDB.QueryRow(ctx, `
			select quantity
			from public.shipment_schedule_items
			where shipment_schedule_id = $1 and sku = $2
			for update
		`, schedule.id, planItem.sku).Scan(&scheduleItemQuantity)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("422: 正式货件不包含该 SKU")
			}
			return err
		}

		var planAllocated int
		_ = txDB.QueryRow(ctx, `
			select coalesce(sum(quantity), 0)
			from public.shipping_plan_allocations
			where plan_item_id = $1
		`, planItem.id).Scan(&planAllocated)

		var shipmentAllocated int
		_ = txDB.QueryRow(ctx, `
			select coalesce(sum(quantity), 0)
			from public.shipping_plan_allocations
			where shipment_schedule_id = $1 and sku = $2
		`, schedule.id, planItem.sku).Scan(&shipmentAllocated)

		if planAllocated+create.Quantity > planItem.quantity {
			return fmt.Errorf("409: 关联数量超过计划余额")
		}
		if shipmentAllocated+create.Quantity > scheduleItemQuantity {
			return fmt.Errorf("409: 关联数量超过正式货件 SKU 未分配数量")
		}

		var existingCount int
		_ = txDB.QueryRow(ctx, `
			select count(*)
			from public.shipping_plan_allocations
			where plan_item_id = $1 and shipment_schedule_id = $2
		`, planItem.id, schedule.id).Scan(&existingCount)
		if existingCount > 0 {
			return fmt.Errorf("409: 该计划明细与正式货件已关联")
		}

		var allocID int64
		err = txDB.QueryRow(ctx, `
			insert into public.shipping_plan_allocations (
				plan_item_id, shipment_schedule_id, sku, quantity, created_at, updated_at
			) values (
				$1, $2, $3, $4, now(), now()
			) returning id
		`, planItem.id, schedule.id, planItem.sku, create.Quantity).Scan(&allocID)
		if err != nil {
			return err
		}

		result = shipping_plan.ShippingPlanAllocationResult{
			Allocation: shipping_plan.ShippingPlanAllocationResponse{
				ID:                 allocID,
				PlanItemID:         planItem.id,
				ShipmentScheduleID: schedule.id,
				SKU:                planItem.sku,
				Quantity:           create.Quantity,
			},
			PlanItemRemainingQuantity:    planItem.quantity - planAllocated - create.Quantity,
			ShipmentSKURemainingQuantity: scheduleItemQuantity - shipmentAllocated - create.Quantity,
		}
		return nil
	})
	if err != nil {
		return shipping_plan.ShippingPlanAllocationResult{}, err
	}
	return result, nil
}

func (s *ShippingPlanStore) DeleteAllocation(ctx context.Context, allocationID int64, _ string) (bool, error) {
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var shipmentScheduleID int64
		err := txDB.QueryRow(ctx, `
			select shipment_schedule_id
			from public.shipping_plan_allocations
			where id = $1
			for update
		`, allocationID).Scan(&shipmentScheduleID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("404: 货件关联不存在")
			}
			return err
		}

		var schedID int64
		err = txDB.QueryRow(ctx, `
			select id
			from public.shipment_schedules
			where id = $1
			for update
		`, shipmentScheduleID).Scan(&schedID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("404: 货件关联不存在")
			}
			return err
		}

		tag, err := txDB.Exec(ctx, `delete from public.shipping_plan_allocations where id = $1`, allocationID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("404: 货件关联不存在")
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	return true, nil
}

func SimulateForecast(
	startDate time.Time,
	horizonDays int,
	availableInventory *int,
	baseDMS *float64,
	growthFactor float64,
	confirmedArrivals map[string]int,
	plannedOnlyArrivals map[string]int,
) []shipping_plan.ForecastPoint {
	dailyPoints := make([]shipping_plan.ForecastPoint, horizonDays)
	if availableInventory == nil || baseDMS == nil {
		for i := 0; i < horizonDays; i++ {
			dateStr := startDate.AddDate(0, 0, i).Format("2006-01-02")
			dailyPoints[i] = shipping_plan.ForecastPoint{
				ForecastDate: dateStr,
			}
		}
		return dailyPoints
	}

	confirmedInv := float64(*availableInventory)
	plannedInv := float64(*availableInventory)
	dailyDemand := *baseDMS * growthFactor

	for i := 0; i < horizonDays; i++ {
		dateStr := startDate.AddDate(0, 0, i).Format("2006-01-02")
		cArr := float64(confirmedArrivals[dateStr])
		pArr := float64(plannedOnlyArrivals[dateStr])

		confirmedInv += cArr
		plannedInv += cArr + pArr

		cSales := math.Min(dailyDemand, confirmedInv)
		pSales := math.Min(dailyDemand, plannedInv)

		confirmedInv -= cSales
		plannedInv -= pSales

		demandCopy := dailyDemand
		cSalesCopy := cSales
		pSalesCopy := pSales
		cInvCopy := confirmedInv
		pInvCopy := plannedInv

		dailyPoints[i] = shipping_plan.ForecastPoint{
			ForecastDate:              dateStr,
			Demand:                    &demandCopy,
			ConfirmedSales:            &cSalesCopy,
			PlannedSales:              &pSalesCopy,
			ConfirmedClosingInventory: &cInvCopy,
			PlannedClosingInventory:   &pInvCopy,
		}
	}
	return dailyPoints
}
