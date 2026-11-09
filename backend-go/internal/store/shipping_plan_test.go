package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipping_plan"
)

func TestShippingPlanStoreInstantiate(t *testing.T) {
	store := NewShippingPlanStore(nil)
	if store == nil {
		t.Fatal("expected non-nil store")
	}
}

func TestShippingPlanCreateBatchTxRollbackOnItemError(t *testing.T) {
	ctx := context.Background()
	// Mock DB where batch insert returns id=10, but item insert returns execErr
	db := &fakeDB{
		row: fakeRow{values: []any{int64(10)}},
	}
	itemErr := errors.New("failed to insert item: disk full")
	writeDB := &fakeWriteDB{
		fakeDB:  db,
		execErr: itemErr,
	}
	s := NewShippingPlanStore(writeDB)

	create := shipping_plan.ShippingPlanBatchCreate{
		ProjectID:           1,
		Country:             "US",
		Name:                "Test Batch",
		ExpectedArrivalDate: "2026-12-01",
		Items: []shipping_plan.ShippingPlanItemInput{
			{SKU: "SKU-1", Quantity: 100},
		},
	}

	_, err := s.CreateBatch(ctx, create, "alice")
	if err == nil {
		t.Fatal("expected error on item insert failure, got nil")
	}
	if !errors.Is(err, itemErr) {
		t.Fatalf("expected %v, got %v", itemErr, err)
	}
}

func TestShippingPlanUpdateBatchQuantityCannotBeLessThanAllocated(t *testing.T) {
	ctx := context.Background()
	// 1st queryRow: status = 'active'
	// 2nd query: existing item id=1, sku='SKU1', qty=10
	// 3rd queryRow: allocated = 8
	existingRows := &fakeRows{
		batches: [][]any{
			{int64(1), "SKU1", 10},
		},
	}
	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"active"}}, // status check
			fakeRow{values: []any{8}},        // allocated check for SKU1
		},
		rows: existingRows,
	}
	writeDB := &fakeWriteDB{
		fakeDB:  db,
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	s := NewShippingPlanStore(writeDB)

	// Try to update SKU1 quantity to 5 (less than allocated 8)
	update := shipping_plan.ShippingPlanBatchUpdate{
		Items: []shipping_plan.ShippingPlanItemInput{
			{SKU: "SKU1", Quantity: 5},
		},
	}

	_, err := s.UpdateBatch(ctx, 10, update, "alice")
	if err == nil {
		t.Fatal("expected error when updating quantity < allocated, got nil")
	}
	if !strings.Contains(err.Error(), "不能小于已关联数量") && !strings.Contains(err.Error(), "409") {
		t.Fatalf("expected 409 不能小于已关联数量 error, got: %v", err)
	}
}

func TestShippingPlanUpdateBatchCannotRemoveAllocatedSKU(t *testing.T) {
	ctx := context.Background()
	// 1st queryRow: status = 'active'
	// 2nd query: existing item id=1, sku='SKU1', qty=10
	// 3rd queryRow: allocated = 5
	existingRows := &fakeRows{
		batches: [][]any{
			{int64(1), "SKU1", 10},
		},
	}
	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"active"}}, // status check
			fakeRow{values: []any{5}},        // allocated check for SKU1
		},
		rows: existingRows,
	}
	writeDB := &fakeWriteDB{
		fakeDB:  db,
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	s := NewShippingPlanStore(writeDB)

	// Try to remove SKU1 by not including it in items
	update := shipping_plan.ShippingPlanBatchUpdate{
		Items: []shipping_plan.ShippingPlanItemInput{
			{SKU: "SKU2", Quantity: 20},
		},
	}

	_, err := s.UpdateBatch(ctx, 10, update, "alice")
	if err == nil {
		t.Fatal("expected error when removing SKU with allocated quantity, got nil")
	}
	if !strings.Contains(err.Error(), "存在已关联数量") && !strings.Contains(err.Error(), "409") {
		t.Fatalf("expected 409 存在已关联数量 error, got: %v", err)
	}
}

func TestShippingPlanCreateAllocationValidation(t *testing.T) {
	ctx := context.Background()

	t.Run("cancelled batch cannot add allocation", func(t *testing.T) {
		db := &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: []any{int64(1), int64(10), "SKU1", 100}},       // plan_item
				fakeRow{values: []any{int64(5), int64(1), "US", "in_transit"}}, // schedule
				fakeRow{values: []any{int64(10), int64(1), "US", "cancelled"}}, // batch is cancelled!
			},
		}
		s := NewShippingPlanStore(&fakeWriteDB{fakeDB: db})

		_, err := s.CreateAllocation(ctx, 10, shipping_plan.ShippingPlanAllocationCreate{
			PlanItemID:         1,
			ShipmentScheduleID: 5,
			Quantity:           10,
		}, "alice")

		if err == nil || !strings.Contains(err.Error(), "已取消") {
			t.Fatalf("expected conflict on cancelled batch, got: %v", err)
		}
	})

	t.Run("schedule completed cannot add allocation", func(t *testing.T) {
		db := &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: []any{int64(1), int64(10), "SKU1", 100}},      // plan_item
				fakeRow{values: []any{int64(5), int64(1), "US", "completed"}}, // schedule is completed!
				fakeRow{values: []any{int64(10), int64(1), "US", "active"}},   // batch active
			},
		}
		s := NewShippingPlanStore(&fakeWriteDB{fakeDB: db})

		_, err := s.CreateAllocation(ctx, 10, shipping_plan.ShippingPlanAllocationCreate{
			PlanItemID:         1,
			ShipmentScheduleID: 5,
			Quantity:           10,
		}, "alice")

		if err == nil || !strings.Contains(err.Error(), "仅 draft / in_transit") {
			t.Fatalf("expected conflict on completed schedule, got: %v", err)
		}
	})

	t.Run("allocation quantity exceeds plan balance", func(t *testing.T) {
		db := &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: []any{int64(1), int64(10), "SKU1", 50}},        // plan_item qty=50
				fakeRow{values: []any{int64(5), int64(1), "US", "in_transit"}}, // schedule
				fakeRow{values: []any{int64(10), int64(1), "US", "active"}},    // batch
				fakeRow{values: []any{100}},                                    // schedule item qty=100
				fakeRow{values: []any{45}},                                     // plan allocated=45 (remaining 5)
				fakeRow{values: []any{0}},                                      // shipment allocated=0
			},
		}
		s := NewShippingPlanStore(&fakeWriteDB{fakeDB: db})

		// Try to allocate 10 when plan remaining is only 5
		_, err := s.CreateAllocation(ctx, 10, shipping_plan.ShippingPlanAllocationCreate{
			PlanItemID:         1,
			ShipmentScheduleID: 5,
			Quantity:           10,
		}, "alice")

		if err == nil || !strings.Contains(err.Error(), "超过计划余额") {
			t.Fatalf("expected conflict on exceeding plan balance, got: %v", err)
		}
	})
}

func TestShippingPlanGetForecast(t *testing.T) {
	ctx := context.Background()

	// 1st query: sku settings -> growth_factor = 1.2
	settingRow := fakeRow{values: []any{1.2}}

	tomorrow := time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02")
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")

	// 2nd query: shipment arrivals
	shipmentRows := &fakeRows{
		batches: [][]any{
			// Completed with valid inbound date
			{"FBA-COMPLETED-1", "completed", stringPointer(tomorrow), stringPointer(tomorrow), 50},
			// Completed with unverified inbound date (nil)
			{"FBA-COMPLETED-UNVERIFIED", "completed", nil, nil, 30},
			// In-transit overdue
			{"FBA-OVERDUE", "in_transit", stringPointer(yesterday), nil, 20},
			// In-transit valid
			{"FBA-TRANSIT-1", "in_transit", stringPointer(tomorrow), nil, 40},
		},
	}

	// 3rd query: planned batches
	planRows := &fakeRows{
		batches: [][]any{
			// Plan batch valid
			{"BATCH-1", stringPointer(tomorrow), 100},
			// Plan batch overdue
			{"BATCH-OVERDUE", stringPointer(yesterday), 25},
		},
	}

	db := &fakeDB{
		row: settingRow,
		rowsQueueQuery: []Rows{
			shipmentRows,
			planRows,
		},
	}
	s := NewShippingPlanStore(&fakeWriteDB{fakeDB: db})

	res, err := s.GetForecast(ctx, 10, "US", "SKU1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.ProjectID != 10 || res.Country != "US" || res.SKU != "SKU1" {
		t.Fatalf("unexpected header in response: %+v", res)
	}
	if res.GrowthFactor != 1.2 || res.DemandSource != "manual" {
		t.Fatalf("expected growthFactor=1.2, demandSource=manual, got %v, %s", res.GrowthFactor, res.DemandSource)
	}

	// Daily points: 180 days
	if len(res.DailyPoints) != 180 {
		t.Fatalf("expected 180 daily points, got %d", len(res.DailyPoints))
	}
	if res.DailyPoints[0].ForecastDate != tomorrow {
		t.Fatalf("expected first forecast point to be tomorrow (%s), got %s", tomorrow, res.DailyPoints[0].ForecastDate)
	}

	// Overdue and unverified tallies
	if res.UnverifiedCompletedQuantity != 30 {
		t.Fatalf("expected unverifiedCompletedQuantity=30, got %d", res.UnverifiedCompletedQuantity)
	}
	if res.OverdueShipmentQuantity != 20 {
		t.Fatalf("expected overdueShipmentQuantity=20, got %d", res.OverdueShipmentQuantity)
	}
	if res.OverduePlanQuantity != 25 {
		t.Fatalf("expected overduePlanQuantity=25, got %d", res.OverduePlanQuantity)
	}

	// Arrivals count
	if len(res.Arrivals) < 4 {
		t.Fatalf("expected at least 4 arrivals, got %d: %+v", len(res.Arrivals), res.Arrivals)
	}
}

func TestSimulateForecastCalculation(t *testing.T) {
	startDate := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	day1 := startDate.AddDate(0, 0, 1).Format("2006-01-02")

	avail := 30
	baseDMS := 10.0
	growth := 1.5 // daily demand = 15.0

	confirmedArrivals := map[string]int{
		day1: 20,
	}
	plannedOnlyArrivals := map[string]int{
		day1: 10,
	}

	points := SimulateForecast(
		startDate,
		5,
		&avail,
		&baseDMS,
		growth,
		confirmedArrivals,
		plannedOnlyArrivals,
	)

	if len(points) != 5 {
		t.Fatalf("expected 5 points, got %d", len(points))
	}

	// Day 0: inv=30, arr=0. demand=15, sales=15, closing=15
	p0 := points[0]
	if *p0.Demand != 15.0 {
		t.Fatalf("expected demand 15.0, got %v", *p0.Demand)
	}
	if *p0.ConfirmedSales != 15.0 || *p0.PlannedSales != 15.0 {
		t.Fatalf("expected sales 15.0, got confirmed=%v, planned=%v", *p0.ConfirmedSales, *p0.PlannedSales)
	}
	if *p0.ConfirmedClosingInventory != 15.0 || *p0.PlannedClosingInventory != 15.0 {
		t.Fatalf("expected closing 15.0, got confirmed=%v, planned=%v", *p0.ConfirmedClosingInventory, *p0.PlannedClosingInventory)
	}

	// Day 1:
	// Confirmed: inv = 15 + 20 = 35. sales=15, closing=20
	// Planned: inv = 15 + 20 + 10 = 45. sales=15, closing=30
	p1 := points[1]
	if *p1.ConfirmedSales != 15.0 || *p1.ConfirmedClosingInventory != 20.0 {
		t.Fatalf("expected confirmed sales=15, closing=20, got sales=%v, closing=%v", *p1.ConfirmedSales, *p1.ConfirmedClosingInventory)
	}
	if *p1.PlannedSales != 15.0 || *p1.PlannedClosingInventory != 30.0 {
		t.Fatalf("expected planned sales=15, closing=30, got sales=%v, closing=%v", *p1.PlannedSales, *p1.PlannedClosingInventory)
	}
}

func TestStage10B1ShippingPlanGrowthFactorRequiresActiveSKU(t *testing.T) {
	ctx := context.Background()
	foundDB := &fakeWriteDB{
		fakeDB: &fakeDB{
			rowsQueue: []pgx.Row{fakeRow{values: []any{true}}},
		},
	}
	store := NewShippingPlanStore(foundDB)
	resp, err := store.UpdateGrowthFactor(ctx, " FAMILY/BLUE/01 ", shipping_plan.ShippingPlanGrowthFactorUpdate{
		ProjectID:    1,
		Country:      "us",
		GrowthFactor: 1.25,
	})
	if err != nil {
		t.Fatalf("UpdateGrowthFactor error: %v", err)
	}
	if resp.SKU != "FAMILY/BLUE/01" || resp.Country != "US" || resp.GrowthFactor != 1.25 {
		t.Fatalf("unexpected growth factor response: %#v", resp)
	}
	if len(foundDB.execCalls) != 1 || !strings.Contains(foundDB.execCalls[0].sql, "shipping_plan_sku_settings") {
		t.Fatalf("growth factor write calls = %#v", foundDB.execCalls)
	}

	missingDB := &fakeWriteDB{
		fakeDB: &fakeDB{
			rowsQueue: []pgx.Row{fakeRow{values: []any{false}}},
		},
	}
	_, err = NewShippingPlanStore(missingDB).UpdateGrowthFactor(ctx, "MISSING/SKU", shipping_plan.ShippingPlanGrowthFactorUpdate{
		ProjectID:    1,
		Country:      "US",
		GrowthFactor: 1.25,
	})
	if !errors.Is(err, shipping_plan.ErrSKUNotFound) {
		t.Fatalf("missing SKU error = %v, want ErrSKUNotFound", err)
	}
	if len(missingDB.execCalls) != 0 {
		t.Fatalf("missing SKU should not write settings: %#v", missingDB.execCalls)
	}
}

func TestStage10B1ShippingPlanProjectAccess(t *testing.T) {
	ctx := context.Background()
	store := NewShippingPlanStore(&fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}})
	if err := store.VerifyProjectAccess(ctx, 1, "bob", false); err != nil {
		t.Fatalf("expected bob to access project: %v", err)
	}
	if err := store.VerifyProjectAccess(ctx, 1, "eve", false); !errors.Is(err, shipping_plan.ErrForbidden) {
		t.Fatalf("expected ErrForbidden for eve, got %v", err)
	}
}
