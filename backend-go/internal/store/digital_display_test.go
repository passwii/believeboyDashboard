package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/digital_display"
)

func TestDigitalDisplayStoreBuildsRealAggregatePayload(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	db := &fakeDB{
		rowsQueueQuery: []Rows{
			&fakeRows{batches: [][]any{
				{"2026-11-03", int64(1), numericFromString("10.00")},
				{"2026-11-04", int64(2), numericFromString("20.00")},
				{"2026-11-05", int64(3), numericFromString("30.00")},
				{"2026-11-06", int64(4), numericFromString("40.00")},
				{"2026-11-07", int64(5), numericFromString("50.00")},
				{"2026-11-08", int64(6), numericFromString("60.00")},
			}},
		},
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"润茗"}},
			fakeRow{values: []any{int64(100), numericFromString("999.99")}},
			fakeRow{values: []any{int64(5), int64(2), int64(120)}},
			fakeRow{values: []any{int64(3), int64(80)}},
			fakeRow{values: []any{int64(4), int64(2)}},
			fakeRow{values: []any{"DEFECTIVE", int64(3)}},
			fakeRow{values: []any{int64(20)}},
			fakeRow{values: []any{
				numericFromString("100.00"),
				numericFromString("400.00"),
				int64(10),
				int64(1000),
				int64(4),
			}},
		},
	}
	store := NewDigitalDisplayStore(db)
	payload, err := store.BuildDigitalDisplay(ctx, 4, "DE", 5, now)
	if err != nil {
		t.Fatal(err)
	}
	if payload.ProjectID != 4 || payload.ProjectName != "润茗" ||
		payload.Country != "DE" || payload.ServerTime != "2026-11-08" {
		t.Fatalf("payload header = %#v", payload)
	}
	if payload.Sales.TodayOrderQty != 6 ||
		payload.Sales.TodaySalesAmount != 60 ||
		payload.Sales.TodaySessions != 100 ||
		payload.Sales.TodayOrderedSalesAmount != 999.99 ||
		payload.Sales.PrevOrderQty != 15 ||
		payload.Sales.PrevSalesAmount != 150 ||
		payload.Sales.PrevSessions != 100 {
		t.Fatalf("sales = %#v", payload.Sales)
	}
	if len(payload.SalesTrend) != 5 ||
		payload.SalesTrend[4].Date != "2026-11-08" ||
		payload.SalesTrend[4].OrderQty != 6 ||
		payload.SalesTrend[4].SalesAmount != 60 ||
		payload.SalesTrend[4].Sessions != 100 {
		t.Fatalf("trend = %#v", payload.SalesTrend)
	}
	if payload.Inventory.SKUCount != 5 ||
		payload.Inventory.OutOfStockCount != 2 ||
		payload.Inventory.AvailableQty != 120 {
		t.Fatalf("inventory = %#v", payload.Inventory)
	}
	if payload.Shipments.InTransitCount != 3 || payload.Shipments.InTransitQty != 80 {
		t.Fatalf("shipments = %#v", payload.Shipments)
	}
	if payload.Returns.TotalReturns != 4 ||
		payload.Returns.TotalQuantity != 2 ||
		payload.Returns.ReturnRate != 10 ||
		payload.Returns.TopReason == nil ||
		*payload.Returns.TopReason != "有缺陷" {
		t.Fatalf("returns = %#v", payload.Returns)
	}
	if payload.Ads.PeriodSpend != 100 ||
		payload.Ads.PeriodSales != 400 ||
		payload.Ads.PeriodROAS != 4 ||
		payload.Ads.PeriodACOS != 25 ||
		payload.Ads.PeriodCTR != 1 ||
		payload.Ads.PeriodOrders != 4 {
		t.Fatalf("ads = %#v", payload.Ads)
	}
	if len(db.queryCalls) != 1 ||
		len(db.queryRowCalls) != 8 {
		t.Fatalf("query calls = %d / row calls = %d", len(db.queryCalls), len(db.queryRowCalls))
	}
	if !strings.Contains(db.queryCalls[0].sql, "public.analysis_sales_order_rows") {
		t.Errorf("sales SQL does not use the real order-row table: %s", db.queryCalls[0].sql)
	}
	for index, fragment := range []string{
		"public.projects",
		"public.analysis_business_rows",
		"public.inventory_snapshot_rows",
		"public.shipment_schedules",
		"public.analysis_return_rows",
		"public.analysis_return_rows",
		"public.analysis_sales_order_rows",
		"public.ad_upload_promoted_product_rows",
	} {
		if !strings.Contains(db.queryRowCalls[index].sql, fragment) {
			t.Errorf("query %d does not contain %q: %s", index, fragment, db.queryRowCalls[index].sql)
		}
	}
}

func TestDigitalDisplayStoreReturnsProjectNotFound(t *testing.T) {
	store := NewDigitalDisplayStore(&fakeDB{
		row: fakeRow{err: pgx.ErrNoRows},
	})
	_, err := store.BuildDigitalDisplay(
		context.Background(),
		99,
		"US",
		7,
		time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC),
	)
	if !errors.Is(err, digital_display.ErrProjectNotFound) {
		t.Fatalf("error = %v, want ErrProjectNotFound", err)
	}
}
