package store

import (
	"context"
	"crypto/md5"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_ledger"
)

type InventoryLedgerStore struct {
	db FullDB
}

func NewInventoryLedgerStore(db FullDB) *InventoryLedgerStore {
	return &InventoryLedgerStore{db: db}
}

func (s *InventoryLedgerStore) VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	var projOp, asstOp *string
	err := s.db.QueryRow(ctx, "select project_operator, assistant_operator from public.projects where id = $1", projectID).Scan(&projOp, &asstOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return inventory_ledger.ErrProjectNotFound
		}
		return err
	}
	op = strings.TrimSpace(op)
	if op == "" {
		return inventory_ledger.ErrProjectForbidden
	}
	if textContainsName(projOp, op) || textContainsName(asstOp, op) {
		return nil
	}
	return inventory_ledger.ErrProjectForbidden
}

func (s *InventoryLedgerStore) projectCountryMatches(ctx context.Context, projectID int64, country *string) (bool, error) {
	if country == nil || *country == "" {
		return true, nil
	}
	var projCountry *string
	err := s.db.QueryRow(ctx, "select country from public.projects where id = $1", projectID).Scan(&projCountry)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if projCountry == nil {
		return false, nil
	}
	return strings.EqualFold(*projCountry, *country), nil
}

func parsePeriod(month string) (time.Time, string, string) {
	month = strings.TrimSpace(month)
	now := time.Now().UTC()
	var t time.Time
	var err error

	if month == "" || strings.EqualFold(month, "this_month") {
		t = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	} else if strings.EqualFold(month, "last_month") {
		t = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -1, 0)
	} else {
		t, err = time.Parse("2006-01-02", month)
		if err != nil {
			t, err = time.Parse("2006-01", month)
			if err != nil {
				t, err = time.Parse("200601", month)
				if err != nil {
					t = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
				}
			}
		}
		t = time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	}

	startDate := t.Format("2006-01-02")
	lastDay := time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	endDate := fmt.Sprintf("%04d-%02d-%02d", t.Year(), t.Month(), lastDay)
	return t, startDate, endDate
}

func prevPeriod(t time.Time) (time.Time, string, string) {
	prev := t.AddDate(0, -1, 0)
	prev = time.Date(prev.Year(), prev.Month(), 1, 0, 0, 0, 0, time.UTC)
	prevStart := prev.Format("2006-01-02")
	prevLastDay := time.Date(prev.Year(), prev.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	prevEnd := fmt.Sprintf("%04d-%02d-%02d", prev.Year(), prev.Month(), prevLastDay)
	return prev, prevStart, prevEnd
}

func (s *InventoryLedgerStore) ListMonths(ctx context.Context, projectID int64, country *string) (inventory_ledger.MonthsResponse, error) {
	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.MonthsResponse{ProjectID: projectID, Country: country, Months: []string{}}, err
	}
	if !matches {
		return inventory_ledger.MonthsResponse{ProjectID: projectID, Country: country, Months: []string{}}, nil
	}

	rows, err := s.db.Query(ctx, `
		select distinct to_char(report_month, 'YYYY-MM-01') as m
		from (
			select report_month from public.inventory_ledger_summary where project_id = $1
			union
			select report_month from public.inventory_ledger_detail where project_id = $1
		) sub
		order by m desc
	`, projectID)
	if err != nil {
		return inventory_ledger.MonthsResponse{ProjectID: projectID, Country: country, Months: []string{}}, err
	}
	defer rows.Close()

	months := make([]string, 0)
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err == nil {
			months = append(months, m)
		}
	}
	return inventory_ledger.MonthsResponse{
		ProjectID: projectID,
		Country:   country,
		Months:    months,
	}, nil
}

func (s *InventoryLedgerStore) GetSnapshot(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.MonthlySnapshotResponse, error) {
	t, startDate, endDate := parsePeriod(month)
	reportMonthStr := t.Format("2006-01-02")

	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.MonthlySnapshotResponse{}, err
	}
	if !matches {
		return inventory_ledger.MonthlySnapshotResponse{
			ReportMonth:        reportMonthStr,
			Country:            country,
			SKUCount:           0,
			TotalQty:           0,
			DispositionSummary: []inventory_ledger.DispositionSummary{},
			SKUs:               []inventory_ledger.SkuMonthEom{},
		}, nil
	}

	// 1. Current month EOM per SKU
	rows, err := s.db.Query(ctx, `
		with eom as (
			select msku, title, disposition, location, ending_balance,
			       row_number() over (partition by msku, location, disposition order by date desc, id desc) as rn
			from public.inventory_ledger_summary
			where project_id = $1 and date >= $2::date and date <= $3::date
		)
		select
			msku,
			coalesce(max(title), ''),
			coalesce(sum(ending_balance), 0),
			coalesce(sum(case when disposition = 'SELLABLE' then ending_balance else 0 end), 0),
			coalesce(sum(case when disposition != 'SELLABLE' then ending_balance else 0 end), 0)
		from eom
		where rn = 1 and ending_balance > 0
		group by msku
		order by msku asc
	`, projectID, startDate, endDate)
	if err != nil {
		return inventory_ledger.MonthlySnapshotResponse{}, err
	}
	defer rows.Close()

	type skuEOMRow struct {
		msku     string
		title    string
		qtyEOM   int
		sellable int
		damaged  int
	}
	var currRows []skuEOMRow
	totalQty := 0
	for rows.Next() {
		var r skuEOMRow
		if err := rows.Scan(&r.msku, &r.title, &r.qtyEOM, &r.sellable, &r.damaged); err == nil {
			currRows = append(currRows, r)
			totalQty += r.qtyEOM
		}
	}

	// 2. Previous month EOM for MoM
	_, prevStart, prevEnd := prevPeriod(t)
	prevRows, err := s.db.Query(ctx, `
		with prev_eom as (
			select msku, ending_balance,
			       row_number() over (partition by msku, location, disposition order by date desc, id desc) as rn
			from public.inventory_ledger_summary
			where project_id = $1 and date >= $2::date and date <= $3::date
		)
		select
			msku,
			coalesce(sum(ending_balance), 0)
		from prev_eom
		where rn = 1 and ending_balance > 0
		group by msku
	`, projectID, prevStart, prevEnd)
	prevMap := make(map[string]int)
	if err == nil {
		defer prevRows.Close()
		for prevRows.Next() {
			var msku string
			var qty int
			if err := prevRows.Scan(&msku, &qty); err == nil {
				prevMap[msku] = qty
			}
		}
	}

	skus := make([]inventory_ledger.SkuMonthEom, 0, len(currRows))
	for _, cr := range currRows {
		item := inventory_ledger.SkuMonthEom{
			MSKU:        cr.msku,
			QtyEOM:      cr.qtyEOM,
			SellableQty: cr.sellable,
			DamagedQty:  cr.damaged,
		}
		if cr.title != "" {
			item.Title = &cr.title
		}
		if prevQty, ok := prevMap[cr.msku]; ok {
			pQty := prevQty
			chg := cr.qtyEOM - prevQty
			item.PrevQtyEOM = &pQty
			item.Change = &chg
		}
		skus = append(skus, item)
	}

	// 3. Disposition summary
	dispRows, err := s.db.Query(ctx, `
		with eom as (
			select disposition, ending_balance,
			       row_number() over (partition by msku, location, disposition order by date desc, id desc) as rn
			from public.inventory_ledger_summary
			where project_id = $1 and date >= $2::date and date <= $3::date
		)
		select
			disposition,
			coalesce(sum(ending_balance), 0)
		from eom
		where rn = 1 and ending_balance > 0
		group by disposition
		order by disposition asc
	`, projectID, startDate, endDate)
	dispositionSummary := make([]inventory_ledger.DispositionSummary, 0)
	if err == nil {
		defer dispRows.Close()
		dispTotal := 0
		type dispItem struct {
			disposition string
			qty         int
		}
		var disps []dispItem
		for dispRows.Next() {
			var d dispItem
			if err := dispRows.Scan(&d.disposition, &d.qty); err == nil {
				disps = append(disps, d)
				dispTotal += d.qty
			}
		}
		for _, d := range disps {
			pct := 0.0
			if dispTotal > 0 {
				pct = math.Round((float64(d.qty)/float64(dispTotal))*10000) / 100
			}
			dispositionSummary = append(dispositionSummary, inventory_ledger.DispositionSummary{
				Disposition: d.disposition,
				QtyEOM:      d.qty,
				PctOfTotal:  pct,
			})
		}
	}

	// 4. Integrity check
	integrity, _ := s.CheckIntegrity(ctx, projectID, country, t)

	return inventory_ledger.MonthlySnapshotResponse{
		ReportMonth:        reportMonthStr,
		Country:            country,
		SKUCount:           len(skus),
		TotalQty:           totalQty,
		DispositionSummary: dispositionSummary,
		SKUs:               skus,
		Integrity:          &integrity,
	}, nil
}

func (s *InventoryLedgerStore) GetEvents(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.EventsResponse, error) {
	t, startDate, endDate := parsePeriod(month)
	reportMonthStr := t.Format("2006-01-02")

	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.EventsResponse{}, err
	}
	if !matches {
		return inventory_ledger.EventsResponse{
			ReportMonth: reportMonthStr,
			Country:     country,
			SKUs:        []inventory_ledger.SkuMonthEvents{},
		}, nil
	}

	rows, err := s.db.Query(ctx, `
		select
			msku,
			coalesce(max(title), ''),
			coalesce(sum(receipts), 0),
			coalesce(sum(customer_shipments), 0),
			coalesce(sum(customer_returns), 0),
			coalesce(sum(damaged), 0),
			coalesce(sum(lost), 0),
			coalesce(sum(disposed), 0),
			coalesce(sum(found), 0),
			coalesce(sum(vendor_returns), 0),
			coalesce(sum(warehouse_transfer_io), 0),
			coalesce(sum(other_events), 0)
		from public.inventory_ledger_summary
		where project_id = $1 and date >= $2::date and date <= $3::date
		group by msku
		order by msku asc
	`, projectID, startDate, endDate)
	if err != nil {
		return inventory_ledger.EventsResponse{}, err
	}
	defer rows.Close()

	skus := make([]inventory_ledger.SkuMonthEvents, 0)
	for rows.Next() {
		var item inventory_ledger.SkuMonthEvents
		var title string
		if err := rows.Scan(
			&item.MSKU,
			&title,
			&item.TotalReceipts,
			&item.TotalShipments,
			&item.TotalReturns,
			&item.TotalDamaged,
			&item.TotalLost,
			&item.TotalDisposed,
			&item.TotalFound,
			&item.TotalVendorReturns,
			&item.TotalTransfer,
			&item.TotalOther,
		); err == nil {
			if title != "" {
				item.Title = &title
			}
			item.NetChange = item.TotalReceipts + item.TotalShipments + item.TotalReturns +
				item.TotalDamaged + item.TotalLost + item.TotalDisposed + item.TotalFound +
				item.TotalVendorReturns + item.TotalTransfer + item.TotalOther
			skus = append(skus, item)
		}
	}
	return inventory_ledger.EventsResponse{
		ReportMonth: reportMonthStr,
		Country:     country,
		SKUs:        skus,
	}, nil
}

func (s *InventoryLedgerStore) GetClusters(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.ReceiptClustersResponse, error) {
	t, startDate, endDate := parsePeriod(month)
	reportMonthStr := t.Format("2006-01-02")

	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.ReceiptClustersResponse{}, err
	}
	if !matches {
		return inventory_ledger.ReceiptClustersResponse{
			ReportMonth: reportMonthStr,
			Country:     country,
			Clusters:    []inventory_ledger.ReceiptCluster{},
		}, nil
	}

	rows, err := s.db.Query(ctx, `
		select
			date::text,
			location,
			coalesce(string_agg(msku, ','), ''),
			count(distinct msku),
			coalesce(sum(receipts), 0)
		from public.inventory_ledger_summary
		where project_id = $1 and date >= $2::date and date <= $3::date and receipts > 0
		group by date, location
		order by date desc, location asc
	`, projectID, startDate, endDate)
	if err != nil {
		return inventory_ledger.ReceiptClustersResponse{}, err
	}
	defer rows.Close()

	clusters := make([]inventory_ledger.ReceiptCluster, 0)
	for rows.Next() {
		var item inventory_ledger.ReceiptCluster
		var rawSKU string
		if err := rows.Scan(&item.Date, &item.Location, &rawSKU, &item.SKUCount, &item.TotalQty); err == nil {
			parts := strings.Split(rawSKU, ",")
			uniqueMap := make(map[string]struct{})
			for _, p := range parts {
				p = strings.TrimSpace(p)
				if p != "" {
					uniqueMap[p] = struct{}{}
				}
			}
			uniqueList := make([]string, 0, len(uniqueMap))
			for k := range uniqueMap {
				uniqueList = append(uniqueList, k)
			}
			sort.Strings(uniqueList)
			item.SKUSet = strings.Join(uniqueList, ",")
			h := md5.Sum([]byte(fmt.Sprintf("%s|%s|%s|%s", startDate, item.Date, item.Location, item.SKUSet)))
			item.ClusterID = fmt.Sprintf("%x", h)
			clusters = append(clusters, item)
		}
	}
	return inventory_ledger.ReceiptClustersResponse{
		ReportMonth: reportMonthStr,
		Country:     country,
		Clusters:    clusters,
	}, nil
}

func (s *InventoryLedgerStore) GetLocationDetail(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.LocationDetailResponse, error) {
	t, startDate, endDate := parsePeriod(month)
	reportMonthStr := t.Format("2006-01-02")

	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.LocationDetailResponse{}, err
	}
	if !matches {
		return inventory_ledger.LocationDetailResponse{
			ReportMonth: reportMonthStr,
			Country:     country,
			Rows:        []inventory_ledger.LocationDetail{},
		}, nil
	}

	rows, err := s.db.Query(ctx, `
		with eom as (
			select msku, title, location, disposition, ending_balance,
			       row_number() over (partition by msku, location, disposition order by date desc, id desc) as rn
			from public.inventory_ledger_summary
			where project_id = $1 and date >= $2::date and date <= $3::date
		)
		select
			msku,
			coalesce(title, ''),
			location,
			disposition,
			coalesce(ending_balance, 0)
		from eom
		where rn = 1 and ending_balance > 0
		order by msku asc, ending_balance desc
	`, projectID, startDate, endDate)
	if err != nil {
		return inventory_ledger.LocationDetailResponse{}, err
	}
	defer rows.Close()

	detailRows := make([]inventory_ledger.LocationDetail, 0)
	for rows.Next() {
		var item inventory_ledger.LocationDetail
		var title string
		if err := rows.Scan(&item.MSKU, &title, &item.Location, &item.Disposition, &item.QtyEOM); err == nil {
			if title != "" {
				item.Title = &title
			}
			detailRows = append(detailRows, item)
		}
	}
	return inventory_ledger.LocationDetailResponse{
		ReportMonth: reportMonthStr,
		Country:     country,
		Rows:        detailRows,
	}, nil
}

func (s *InventoryLedgerStore) GetTrend(ctx context.Context, projectID int64, country *string) (inventory_ledger.TrendResponse, error) {
	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.TrendResponse{}, err
	}
	if !matches {
		return inventory_ledger.TrendResponse{
			ProjectID: projectID,
			Country:   country,
			Months:    []inventory_ledger.TrendMonthItem{},
		}, nil
	}

	monthsResp, err := s.ListMonths(ctx, projectID, country)
	if err != nil || len(monthsResp.Months) == 0 {
		return inventory_ledger.TrendResponse{
			ProjectID: projectID,
			Country:   country,
			Months:    []inventory_ledger.TrendMonthItem{},
		}, nil
	}

	targetCount := len(monthsResp.Months)
	if targetCount > 6 {
		targetCount = 6
	}
	targetMonths := make([]string, targetCount)
	copy(targetMonths, monthsResp.Months[:targetCount])

	// Chronological order: reverse targetMonths
	for i, j := 0, len(targetMonths)-1; i < j; i, j = i+1, j-1 {
		targetMonths[i], targetMonths[j] = targetMonths[j], targetMonths[i]
	}

	trendItems := make([]inventory_ledger.TrendMonthItem, 0, len(targetMonths))
	for _, m := range targetMonths {
		t, startDate, endDate := parsePeriod(m)
		mLabel := t.Format("2006-01")

		var skuCount, totalQty, damagedQty int
		_ = s.db.QueryRow(ctx, `
			with eom as (
				select msku, disposition, ending_balance,
				       row_number() over (partition by msku, location, disposition order by date desc, id desc) as rn
				from public.inventory_ledger_summary
				where project_id = $1 and date >= $2::date and date <= $3::date
			)
			select
				count(distinct msku),
				coalesce(sum(ending_balance), 0),
				coalesce(sum(case when disposition != 'SELLABLE' then ending_balance else 0 end), 0)
			from eom
			where rn = 1 and ending_balance > 0
		`, projectID, startDate, endDate).Scan(&skuCount, &totalQty, &damagedQty)

		var receipts, shipments, returnsVal, damaged, lost, disposed int
		_ = s.db.QueryRow(ctx, `
			select
				coalesce(sum(receipts), 0),
				coalesce(sum(customer_shipments), 0),
				coalesce(sum(customer_returns), 0),
				coalesce(sum(damaged), 0),
				coalesce(sum(lost), 0),
				coalesce(sum(disposed), 0)
			from public.inventory_ledger_summary
			where project_id = $1 and date >= $2::date and date <= $3::date
		`, projectID, startDate, endDate).Scan(&receipts, &shipments, &returnsVal, &damaged, &lost, &disposed)

		damagedPct := 0.0
		if totalQty > 0 {
			damagedPct = math.Round((float64(damagedQty)/float64(totalQty))*10000) / 100
		}

		trendItems = append(trendItems, inventory_ledger.TrendMonthItem{
			ReportMonth:    mLabel,
			SKUCount:       skuCount,
			TotalQtyEOM:    totalQty,
			TotalReceipts:  receipts,
			TotalShipments: shipments,
			TotalReturns:   returnsVal,
			TotalDamaged:   damaged,
			TotalLost:      lost,
			TotalDisposed:  disposed,
			DamagedPct:     damagedPct,
		})
	}

	return inventory_ledger.TrendResponse{
		ProjectID: projectID,
		Country:   country,
		Months:    trendItems,
	}, nil
}

func (s *InventoryLedgerStore) GetDetail(ctx context.Context, projectID int64, country *string, month string, msku, eventType *string) (inventory_ledger.LedgerDetailResponse, error) {
	t, startDate, endDate := parsePeriod(month)
	reportMonthStr := t.Format("2006-01-02")

	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.LedgerDetailResponse{}, err
	}
	if !matches {
		return inventory_ledger.LedgerDetailResponse{
			ReportMonth: reportMonthStr,
			Country:     country,
			Rows:        []inventory_ledger.LedgerDetailRow{},
		}, nil
	}

	query := `
		select
			id, date::text, fnsku, asin, msku, title, event_type, reference_id,
			quantity, fulfillment_center, disposition, reason, country,
			reconciled_quantity, unreconciled_quantity,
			to_char(date_and_time, 'YYYY-MM-DD"T"HH24:MI:SS.USZ'),
			store, batch_id
		from public.inventory_ledger_detail
		where project_id = $1 and date >= $2::date and date <= $3::date
	`
	args := []any{projectID, startDate, endDate}
	argIdx := 4
	if msku != nil && *msku != "" {
		query += fmt.Sprintf(" and msku = $%d", argIdx)
		args = append(args, *msku)
		argIdx++
	}
	if eventType != nil && *eventType != "" {
		query += fmt.Sprintf(" and event_type = $%d", argIdx)
		args = append(args, *eventType)
		argIdx++
	}
	if country != nil && *country != "" {
		query += fmt.Sprintf(" and country = $%d", argIdx)
		args = append(args, *country)
		argIdx++
	}
	query += " order by date desc, id desc limit 2000"

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return inventory_ledger.LedgerDetailResponse{}, err
	}
	defer rows.Close()

	detailRows := make([]inventory_ledger.LedgerDetailRow, 0)
	for rows.Next() {
		var r inventory_ledger.LedgerDetailRow
		if err := rows.Scan(
			&r.ID,
			&r.Date,
			&r.FNSKU,
			&r.ASIN,
			&r.MSKU,
			&r.Title,
			&r.EventType,
			&r.ReferenceID,
			&r.Quantity,
			&r.FulfillmentCenter,
			&r.Disposition,
			&r.Reason,
			&r.Country,
			&r.ReconciledQuantity,
			&r.UnreconciledQuantity,
			&r.DateAndTime,
			&r.Store,
			&r.BatchID,
		); err == nil {
			detailRows = append(detailRows, r)
		}
	}
	return inventory_ledger.LedgerDetailResponse{
		ReportMonth: reportMonthStr,
		Country:     country,
		Rows:        detailRows,
	}, nil
}

func (s *InventoryLedgerStore) GetSummary(ctx context.Context, projectID int64, country *string, month string, msku, disposition *string) (inventory_ledger.LedgerSummaryResponse, error) {
	t, startDate, endDate := parsePeriod(month)
	reportMonthStr := t.Format("2006-01-02")

	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.LedgerSummaryResponse{}, err
	}
	if !matches {
		return inventory_ledger.LedgerSummaryResponse{
			ReportMonth: reportMonthStr,
			Country:     country,
			Rows:        []inventory_ledger.LedgerSummaryRow{},
		}, nil
	}

	query := `
		select
			id, date::text, fnsku, asin, msku, title, disposition, location,
			starting_balance, in_transit_between, receipts, customer_shipments,
			customer_returns, vendor_returns, warehouse_transfer_io,
			found, lost, damaged, disposed, other_events, ending_balance,
			unknown_events, store, batch_id
		from public.inventory_ledger_summary
		where project_id = $1 and date >= $2::date and date <= $3::date
	`
	args := []any{projectID, startDate, endDate}
	argIdx := 4
	if msku != nil && *msku != "" {
		query += fmt.Sprintf(" and msku = $%d", argIdx)
		args = append(args, *msku)
		argIdx++
	}
	if disposition != nil && *disposition != "" {
		query += fmt.Sprintf(" and disposition = $%d", argIdx)
		args = append(args, *disposition)
		argIdx++
	}
	query += " order by date desc, id desc limit 5000"

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return inventory_ledger.LedgerSummaryResponse{}, err
	}
	defer rows.Close()

	summaryRows := make([]inventory_ledger.LedgerSummaryRow, 0)
	for rows.Next() {
		var r inventory_ledger.LedgerSummaryRow
		if err := rows.Scan(
			&r.ID,
			&r.Date,
			&r.FNSKU,
			&r.ASIN,
			&r.MSKU,
			&r.Title,
			&r.Disposition,
			&r.Location,
			&r.StartingBalance,
			&r.InTransitBetween,
			&r.Receipts,
			&r.CustomerShipments,
			&r.CustomerReturns,
			&r.VendorReturns,
			&r.WarehouseTransferIO,
			&r.Found,
			&r.Lost,
			&r.Damaged,
			&r.Disposed,
			&r.OtherEvents,
			&r.EndingBalance,
			&r.UnknownEvents,
			&r.Store,
			&r.BatchID,
		); err == nil {
			summaryRows = append(summaryRows, r)
		}
	}
	return inventory_ledger.LedgerSummaryResponse{
		ReportMonth: reportMonthStr,
		Country:     country,
		Rows:        summaryRows,
	}, nil
}

func (s *InventoryLedgerStore) ListBatches(ctx context.Context, projectID int64, country *string) (inventory_ledger.IngestBatchesResponse, error) {
	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.IngestBatchesResponse{}, err
	}
	if !matches {
		return inventory_ledger.IngestBatchesResponse{
			ProjectID: projectID,
			Country:   country,
			Batches:   []inventory_ledger.IngestBatchInfo{},
		}, nil
	}

	rows, err := s.db.Query(ctx, `
		select
			id, project_id, to_char(report_month, 'YYYY-MM-01'), source_filename, file_hash, file_size_bytes,
			file_kind, loaded_by, to_char(loaded_at, 'YYYY-MM-DD"T"HH24:MI:SS.USZ'),
			to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.USZ'),
			status, rows_parsed, rows_written_summary, rows_written_detail,
			rows_skipped_duplicate, rows_failed_validation, error_message,
			consistency_check, consistency_mismatch_count
		from public.inventory_ledger_ingest_batch
		where project_id = $1
		order by loaded_at desc
		limit 100
	`, projectID)
	if err != nil {
		return inventory_ledger.IngestBatchesResponse{
			ProjectID: projectID,
			Country:   country,
			Batches:   []inventory_ledger.IngestBatchInfo{},
		}, nil
	}
	defer rows.Close()

	batches := make([]inventory_ledger.IngestBatchInfo, 0)
	for rows.Next() {
		var b inventory_ledger.IngestBatchInfo
		if err := rows.Scan(
			&b.ID,
			&b.ProjectID,
			&b.ReportMonth,
			&b.SourceFilename,
			&b.FileHash,
			&b.FileSizeBytes,
			&b.FileKind,
			&b.LoadedBy,
			&b.LoadedAt,
			&b.CompletedAt,
			&b.Status,
			&b.RowsParsed,
			&b.RowsWrittenSummary,
			&b.RowsWrittenDetail,
			&b.RowsSkippedDuplicate,
			&b.RowsFailedValidation,
			&b.ErrorMessage,
			&b.ConsistencyCheck,
			&b.ConsistencyMismatchCount,
		); err == nil {
			batches = append(batches, b)
		}
	}
	return inventory_ledger.IngestBatchesResponse{
		ProjectID: projectID,
		Country:   country,
		Batches:   batches,
	}, nil
}

func (s *InventoryLedgerStore) GetConsistency(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.ConsistencyCheckResult, error) {
	t, _, _ := parsePeriod(month)
	reportMonthStr := t.Format("2006-01-02")
	reportMonthDate := t.Format("2006-01-01")
	now := time.Now().UTC().Format(time.RFC3339Nano)

	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.ConsistencyCheckResult{}, err
	}
	if !matches {
		return inventory_ledger.ConsistencyCheckResult{
			ReportMonth:   reportMonthStr,
			Country:       country,
			Status:        "PENDING",
			MismatchCount: 0,
			Mismatches:    []inventory_ledger.ConsistencyMismatch{},
			CheckedAt:     now,
		}, nil
	}

	var summaryCount, detailCount int
	if err := s.db.QueryRow(ctx, "select count(*) from public.inventory_ledger_summary where project_id = $1 and report_month = $2::date", projectID, reportMonthDate).Scan(&summaryCount); err != nil {
		return inventory_ledger.ConsistencyCheckResult{}, err
	}
	if err := s.db.QueryRow(ctx, "select count(*) from public.inventory_ledger_detail where project_id = $1 and report_month = $2::date", projectID, reportMonthDate).Scan(&detailCount); err != nil {
		return inventory_ledger.ConsistencyCheckResult{}, err
	}

	if summaryCount == 0 && detailCount == 0 {
		return inventory_ledger.ConsistencyCheckResult{
			ReportMonth:   reportMonthStr,
			Country:       country,
			Status:        "PENDING",
			MismatchCount: 0,
			Mismatches:    []inventory_ledger.ConsistencyMismatch{},
			CheckedAt:     now,
		}, nil
	}

	// Summary delta
	summaryRows, err := s.db.Query(ctx, `
		with first_row as (
			select msku, location, disposition, starting_balance,
			       row_number() over (partition by msku, location, disposition order by date asc, id asc) as rn
			from public.inventory_ledger_summary
			where project_id = $1 and report_month = $2::date
		),
		last_row as (
			select msku, location, disposition, ending_balance,
			       row_number() over (partition by msku, location, disposition order by date desc, id desc) as rn
			from public.inventory_ledger_summary
			where project_id = $1 and report_month = $2::date
		)
		select f.msku, f.location, f.disposition, (l.ending_balance - f.starting_balance)
		from first_row f
		join last_row l on f.msku = l.msku and f.location = l.location and f.disposition = l.disposition
		where f.rn = 1 and l.rn = 1
	`, projectID, reportMonthDate)
	if err != nil {
		return inventory_ledger.ConsistencyCheckResult{}, err
	}
	defer summaryRows.Close()

	type tripleKey struct {
		msku        string
		location    string
		disposition string
	}
	summaryDelta := make(map[tripleKey]int)
	for summaryRows.Next() {
		var k tripleKey
		var delta int
		if err := summaryRows.Scan(&k.msku, &k.location, &k.disposition, &delta); err != nil {
			return inventory_ledger.ConsistencyCheckResult{}, err
		}
		summaryDelta[k] = delta
	}
	if err := summaryRows.Err(); err != nil {
		return inventory_ledger.ConsistencyCheckResult{}, err
	}

	// Detail sum
	detailRows, err := s.db.Query(ctx, `
		select msku, fulfillment_center, disposition, coalesce(sum(quantity), 0)
		from public.inventory_ledger_detail
		where project_id = $1 and report_month = $2::date
		group by msku, fulfillment_center, disposition
	`, projectID, reportMonthDate)
	if err != nil {
		return inventory_ledger.ConsistencyCheckResult{}, err
	}
	defer detailRows.Close()

	detailSum := make(map[tripleKey]int)
	for detailRows.Next() {
		var k tripleKey
		var sumQty int
		if err := detailRows.Scan(&k.msku, &k.location, &k.disposition, &sumQty); err != nil {
			return inventory_ledger.ConsistencyCheckResult{}, err
		}
		detailSum[k] = sumQty
	}
	if err := detailRows.Err(); err != nil {
		return inventory_ledger.ConsistencyCheckResult{}, err
	}

	allKeys := make(map[tripleKey]struct{})
	for k := range summaryDelta {
		allKeys[k] = struct{}{}
	}
	for k := range detailSum {
		allKeys[k] = struct{}{}
	}

	// Compare union of keys
	mismatches := make([]inventory_ledger.ConsistencyMismatch, 0)
	for key := range allKeys {
		detailQty, hasDetail := detailSum[key]
		delta, hasSummary := summaryDelta[key]

		if hasDetail && hasSummary {
			if detailQty != delta {
				mismatches = append(mismatches, inventory_ledger.ConsistencyMismatch{
					MSKU:           key.msku,
					Location:       key.location,
					Disposition:    key.disposition,
					DetailQuantity: detailQty,
					SummaryDelta:   delta,
					Diff:           detailQty - delta,
				})
			}
		} else if hasDetail && !hasSummary {
			mismatches = append(mismatches, inventory_ledger.ConsistencyMismatch{
				MSKU:           key.msku,
				Location:       key.location,
				Disposition:    key.disposition,
				DetailQuantity: detailQty,
				SummaryDelta:   0,
				Diff:           detailQty,
			})
		} else if !hasDetail && hasSummary {
			mismatches = append(mismatches, inventory_ledger.ConsistencyMismatch{
				MSKU:           key.msku,
				Location:       key.location,
				Disposition:    key.disposition,
				DetailQuantity: 0,
				SummaryDelta:   delta,
				Diff:           -delta,
			})
		}
	}

	sort.Slice(mismatches, func(i, j int) bool {
		if mismatches[i].MSKU != mismatches[j].MSKU {
			return mismatches[i].MSKU < mismatches[j].MSKU
		}
		if mismatches[i].Location != mismatches[j].Location {
			return mismatches[i].Location < mismatches[j].Location
		}
		return mismatches[i].Disposition < mismatches[j].Disposition
	})

	status := "OK"
	if len(mismatches) > 0 {
		status = "MISMATCH"
	}

	return inventory_ledger.ConsistencyCheckResult{
		ReportMonth:   reportMonthStr,
		Country:       country,
		Status:        status,
		MismatchCount: len(mismatches),
		Mismatches:    mismatches,
		CheckedAt:     now,
	}, nil
}

func (s *InventoryLedgerStore) CheckIntegrity(ctx context.Context, projectID int64, country *string, t time.Time) (inventory_ledger.IntegrityCheckResult, error) {
	reportMonthStr := t.Format("2006-01-02")
	currMonthDate := t.Format("2006-01-01")
	now := time.Now().UTC().Format(time.RFC3339Nano)

	matches, err := s.projectCountryMatches(ctx, projectID, country)
	if err != nil {
		return inventory_ledger.IntegrityCheckResult{}, err
	}
	if !matches {
		return inventory_ledger.IntegrityCheckResult{
			ReportMonth:   reportMonthStr,
			Country:       country,
			Status:        "PENDING",
			MismatchCount: 0,
			Mismatches:    []inventory_ledger.IntegrityMismatch{},
			Comparisons:   []inventory_ledger.IntegrityComparison{},
			CheckedAt:     now,
		}, nil
	}

	prevT, prevStart, prevEnd := prevPeriod(t)
	prevMonthDate := prevT.Format("2006-01-01")

	var prevCount int
	_ = s.db.QueryRow(ctx, "select count(*) from public.inventory_ledger_summary where project_id = $1 and report_month = $2::date", projectID, prevMonthDate).Scan(&prevCount)

	type tripleKey struct {
		msku        string
		location    string
		disposition string
	}
	prevMap := make(map[tripleKey]int)
	if prevCount > 0 {
		prevRows, err := s.db.Query(ctx, `
			with eom as (
				select msku, location, disposition, ending_balance,
				       row_number() over (partition by msku, location, disposition order by date desc, id desc) as rn
				from public.inventory_ledger_summary
				where project_id = $1 and date >= $2::date and date <= $3::date
			)
			select msku, location, disposition, coalesce(ending_balance, 0)
			from eom
			where rn = 1
		`, projectID, prevStart, prevEnd)
		if err == nil {
			defer prevRows.Close()
			for prevRows.Next() {
				var k tripleKey
				var ending int
				if err := prevRows.Scan(&k.msku, &k.location, &k.disposition, &ending); err == nil {
					prevMap[k] = ending
				}
			}
		}
	}

	currRows, err := s.db.Query(ctx, `
		with first_row as (
			select msku, location, disposition, starting_balance,
			       row_number() over (partition by msku, location, disposition order by date asc, id asc) as rn
			from public.inventory_ledger_summary
			where project_id = $1 and report_month = $2::date
		)
		select msku, location, disposition, coalesce(starting_balance, 0)
		from first_row
		where rn = 1
	`, projectID, currMonthDate)

	currMap := make(map[tripleKey]int)
	if err == nil {
		defer currRows.Close()
		for currRows.Next() {
			var k tripleKey
			var starting int
			if err := currRows.Scan(&k.msku, &k.location, &k.disposition, &starting); err == nil {
				currMap[k] = starting
			}
		}
	}

	allKeysMap := make(map[tripleKey]struct{})
	for k := range prevMap {
		allKeysMap[k] = struct{}{}
	}
	for k := range currMap {
		allKeysMap[k] = struct{}{}
	}

	comparisons := make([]inventory_ledger.IntegrityComparison, 0)
	mismatches := make([]inventory_ledger.IntegrityMismatch, 0)
	hasUnpaired := false

	for k := range allKeysMap {
		prevEnding, hasPrev := prevMap[k]
		currStarting, hasCurr := currMap[k]
		if hasPrev && hasCurr {
			diff := currStarting - prevEnding
			state := "MATCHED"
			if diff != 0 {
				state = "MISMATCH"
				mismatches = append(mismatches, inventory_ledger.IntegrityMismatch{
					MSKU:         k.msku,
					Location:     k.location,
					Disposition:  k.disposition,
					PrevEnding:   prevEnding,
					CurrStarting: currStarting,
					Diff:         diff,
				})
			}
			pE := prevEnding
			cS := currStarting
			d := diff
			comparisons = append(comparisons, inventory_ledger.IntegrityComparison{
				MSKU:         k.msku,
				Location:     k.location,
				Disposition:  k.disposition,
				State:        state,
				PrevEnding:   &pE,
				CurrStarting: &cS,
				Diff:         &d,
			})
		} else if hasCurr {
			hasUnpaired = true
			cS := currStarting
			comparisons = append(comparisons, inventory_ledger.IntegrityComparison{
				MSKU:         k.msku,
				Location:     k.location,
				Disposition:  k.disposition,
				State:        "CURRENT_ONLY",
				CurrStarting: &cS,
			})
		} else {
			hasUnpaired = true
			pE := prevEnding
			comparisons = append(comparisons, inventory_ledger.IntegrityComparison{
				MSKU:        k.msku,
				Location:    k.location,
				Disposition: k.disposition,
				State:       "PREVIOUS_ONLY",
				PrevEnding:  &pE,
			})
		}
	}

	status := "OK"
	if len(mismatches) > 0 {
		status = "MISMATCH"
	} else if prevCount == 0 || hasUnpaired {
		status = "PENDING"
	}

	return inventory_ledger.IntegrityCheckResult{
		ReportMonth:   reportMonthStr,
		Country:       country,
		Status:        status,
		MismatchCount: len(mismatches),
		Mismatches:    mismatches,
		Comparisons:   comparisons,
		CheckedAt:     now,
	}, nil
}

func (s *InventoryLedgerStore) GetMonthAnalysis(ctx context.Context, projectID int64, country *string, month string) (inventory_ledger.LedgerMonthAnalysisResponse, error) {
	t, startDate, endDate := parsePeriod(month)
	reportMonthStr := t.Format("2006-01-02")
	now := time.Now().UTC().Format(time.RFC3339Nano)

	var projectName, projCountry string
	err := s.db.QueryRow(ctx, "select project_name, country from public.projects where id = $1", projectID).Scan(&projectName, &projCountry)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return inventory_ledger.LedgerMonthAnalysisResponse{}, err
	}
	finalCountry := country
	if finalCountry == nil && projCountry != "" {
		finalCountry = &projCountry
	}

	snapshot, _ := s.GetSnapshot(ctx, projectID, finalCountry, month)
	trend, _ := s.GetTrend(ctx, projectID, finalCountry)
	summaryResp, _ := s.GetSummary(ctx, projectID, finalCountry, month, nil, nil)
	detailResp, _ := s.GetDetail(ctx, projectID, finalCountry, month, nil, nil)
	consistency, _ := s.GetConsistency(ctx, projectID, finalCountry, month)
	batchesResp, _ := s.ListBatches(ctx, projectID, finalCountry)

	return inventory_ledger.LedgerMonthAnalysisResponse{
		ProjectID:   projectID,
		ProjectName: projectName,
		Country:     finalCountry,
		ReportMonth: reportMonthStr,
		StartDate:   startDate,
		EndDate:     endDate,
		GeneratedAt: now,
		SummaryRows: summaryResp.Rows,
		DetailRows:  detailResp.Rows,
		Snapshot:    snapshot,
		Trend:       trend,
		Consistency: consistency,
		Batches:     batchesResp.Batches,
	}, nil
}
