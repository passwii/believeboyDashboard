package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipment_schedules"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestShipmentScheduleStoreInstantiate(t *testing.T) {
	store := NewShipmentScheduleStore(nil)
	if store == nil {
		t.Fatal("expected non-nil store")
	}
}

func TestShipmentScheduleGetLoadsItems(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	// Schedule row
	schedRow := fakeRow{
		values: []any{
			int64(1), int64(10), "US Shop", "US",
			"FBA123", (*string)(nil), (*string)(nil), (*string)(nil),
			"sea", (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil),
			(*string)(nil), "in_transit",
			1, 50, 10.0, 1.0, 15.0, 150.0, true,
			now, (*string)(nil),
		},
	}
	// Item rows
	itemRows := &fakeRows{
		batches: [][]any{
			{int64(101), (*string)(nil), "SKU-A", 50, (*int)(nil), (*string)(nil), 1.0, 15.0, 15.0, 15.0, 150.0, 10.0},
		},
	}
	db := &fakeDB{
		row:  schedRow,
		rows: itemRows,
	}
	s := NewShipmentScheduleStore(&fakeWriteDB{fakeDB: db})

	detail, err := s.GetShipmentSchedule(ctx, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if detail == nil {
		t.Fatal("expected non-nil detail")
	}
	if len(detail.Items) != 1 || detail.Items[0].SKU != "SKU-A" {
		t.Fatalf("expected 1 loaded item SKU-A, got: %v", detail.Items)
	}
}

func TestShipmentScheduleHideBatchInsertsRecord(t *testing.T) {
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "alice",
	})
	writeDB := &fakeWriteDB{
		fakeDB:  &fakeDB{},
		execTag: pgconn.NewCommandTag("INSERT 0 1"),
	}
	s := NewShipmentScheduleStore(writeDB)

	ok, err := s.HideBatch(ctx, shipment_schedules.ShipmentBatchHiddenDeleteRequest{
		ProjectID:     10,
		Country:       "US",
		ShipmentBatch: "batch-202611",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected HideBatch to return true")
	}

	if len(writeDB.execCalls) == 0 || !strings.Contains(writeDB.execCalls[0].sql, "shipment_batch_dropdown_hidden") {
		t.Fatalf("expected insert into shipment_batch_dropdown_hidden, got: %v", writeDB.execCalls)
	}
}

func TestShipmentScheduleImportSchedulesCSV(t *testing.T) {
	ctx := context.Background()
	csvContent := "project_name,country,shipment_no,shipping_method,shipment_status\nUS Shop,US,FBA999,sea,in_transit\n"

	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{int64(10)}}, // project lookup
			fakeRow{err: pgx.ErrNoRows},       // shipment_no duplicate check: none!
		},
	}
	writeDB := &fakeWriteDB{
		fakeDB:  db,
		execTag: pgconn.NewCommandTag("INSERT 0 1"),
	}
	s := NewShipmentScheduleStore(writeDB)

	resp, err := s.ImportSchedulesCSV(ctx, []byte(csvContent), "alice", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Inserted != 1 || len(resp.ShipmentNos) != 1 || resp.ShipmentNos[0] != "FBA999" {
		t.Fatalf("expected 1 inserted FBA999, got: %v", resp)
	}
}

func TestShipmentScheduleImportItemsCSV(t *testing.T) {
	ctx := context.Background()
	csvContent := "project_name,shipment_no,sku,quantity\nUS Shop,FBA999,SKU-1,100\n"

	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"FBA999", int64(10), "US", "US Shop"}}, // schedule lookup
			fakeRow{values: []any{5}},                                    // replaced items count
		},
	}
	writeDB := &fakeWriteDB{
		fakeDB:  db,
		execTag: pgconn.NewCommandTag("INSERT 0 1"),
	}
	s := NewShipmentScheduleStore(writeDB)

	resp, err := s.ImportItemsCSV(ctx, 1, []byte(csvContent), "alice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Inserted != 1 || resp.Replaced != 5 || resp.TotalQuantity != 100 {
		t.Fatalf("expected 1 inserted, 5 replaced, totalQty 100, got: %v", resp)
	}
}

func TestShipmentScheduleListFbaBoxDetails(t *testing.T) {
	ctx := context.Background()

	// 1st query: schedules
	schedulesRows := &fakeRows{
		batches: [][]any{
			{int64(1), int64(10), "US Shop", "US", "FBA100", stringPointer("TRACK123"), stringPointer("ONT8")},
		},
	}
	// 2nd query: schedule items
	itemsRows := &fakeRows{
		batches: [][]any{
			{int64(1), int64(1), "SKU1", 100, 2, "2026-10-01"},
			{int64(2), int64(1), "SKU2", 15, 2, "2026-10-02"},
		},
	}
	// 3rd query: product costs
	l40, w30, h20 := 40.0, 30.0, 20.0
	wt10 := 10.0
	l20, w20, h10 := 20.0, 20.0, 10.0
	wt5 := 5.0
	costRows := &fakeRows{
		batches: [][]any{
			{
				int64(10), "US", "SKU1", stringPointer("Product 1"), stringPointer("B001"), stringPointer("X001"),
				&l40, &w30, &h20, &wt10, // package
				&l40, &w30, &h20, &wt10, // carton
				50,                       // units_per_carton
				stringPointer("https://r2/thumb1.jpg"), stringPointer("https://r2/img1.jpg"),
			},
			{
				int64(10), "US", "SKU2", stringPointer("Product 2"), stringPointer("B002"), stringPointer("X002"),
				&l20, &w20, &h10, &wt5,
				&l20, &w20, &h10, &wt5,
				10, // units_per_carton
				stringPointer("https://r2/thumb2.jpg"), stringPointer("https://r2/img2.jpg"),
			},
		},
	}

	db := &fakeDB{
		rowsQueueQuery: []Rows{
			schedulesRows,
			itemsRows,
			costRows,
		},
	}
	s := NewShipmentScheduleStore(&fakeWriteDB{fakeDB: db})

	res, err := s.ListFbaBoxDetails(ctx, nil, nil, []string{"FBA100"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(res.ShipmentNos) != 1 || res.ShipmentNos[0] != "FBA100" {
		t.Fatalf("expected FBA100 in shipment_nos, got: %v", res.ShipmentNos)
	}
	if len(res.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(res.Items))
	}

	// SKU1: 100 qty / 50 per carton = 2 full boxes
	it1 := res.Items[0]
	if it1.SKU != "SKU1" || it1.FullCartonCount != 2 || it1.PartialCartonUnits != 0 || it1.CartonCount != 2 {
		t.Fatalf("unexpected carton counts for SKU1: %+v", it1)
	}
	if it1.OuterBoxText != "2 箱整箱" {
		t.Fatalf("expected '2 箱整箱', got %q", it1.OuterBoxText)
	}
	if it1.TotalWeightKG != 20.0 {
		t.Fatalf("expected 20kg weight, got %v", it1.TotalWeightKG)
	}

	// SKU2: 15 qty / 10 per carton = 1 full box + 1 tail box (5 units)
	it2 := res.Items[1]
	if it2.SKU != "SKU2" || it2.FullCartonCount != 1 || it2.PartialCartonUnits != 5 || it2.CartonCount != 2 {
		t.Fatalf("unexpected carton counts for SKU2: %+v", it2)
	}
	if it2.OuterBoxText != "1 箱整箱 + 1 箱尾箱（5 件）" {
		t.Fatalf("expected tail box description, got %q", it2.OuterBoxText)
	}
}
