package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
)

func TestInventoryReplenishmentStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()

	// 1. Admin always succeeds
	adminStore := NewInventoryReplenishmentStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	if err := adminStore.VerifyProjectAccess(ctx, 1, "any_op", true); err != nil {
		t.Fatalf("expected admin to succeed, got %v", err)
	}

	// 2. Project not found returns ErrProjectNotFound
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	missingStore := NewInventoryReplenishmentStore(&fakeWriteDB{fakeDB: missingDB})
	if err := missingStore.VerifyProjectAccess(ctx, 999, "alice", false); !errors.Is(err, inventory_replenishment.ErrProjectNotFound) {
		t.Fatalf("expected ErrProjectNotFound, got %v", err)
	}

	// 3. Authorized operator succeeds
	foundDB := &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}
	foundStore := NewInventoryReplenishmentStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "bob", false); err != nil {
		t.Fatalf("expected bob to be allowed, got %v", err)
	}

	// 4. Unauthorized operator returns ErrProjectForbidden
	foundDB = &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}
	foundStore = NewInventoryReplenishmentStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "eve", false); !errors.Is(err, inventory_replenishment.ErrProjectForbidden) {
		t.Fatalf("expected ErrProjectForbidden for eve, got %v", err)
	}
}

func TestInventoryReplenishmentStoreSnapshotCRUD(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()

	// 1. CreateSnapshot returns generated ID (e.g. 101, not hardcoded 1)
	createDB := &fakeWriteDB{
		fakeDB: &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: []any{"Test Project"}},  // query project name
				fakeRow{values: []any{int(1)}},          // count(*) for analysis
				fakeRow{values: []any{int64(101), now}}, // insert snapshot RETURNING id, created_at
			},
			rows: &fakeRows{
				batches: [][]any{
					{
						int64(1), "Test Project", "SKU-A", "US", stringPointer("ASIN-A"), stringPointer("Prod A"),
						0.20, 20, 25,
						10, 0,
					},
				},
			},
		},
	}
	store := NewInventoryReplenishmentStore(createDB)
	snap, err := store.CreateSnapshot(ctx, 1, "US", inventory_replenishment.CreateSnapshotRequest{
		Name: stringPointer("Snap-101"),
	}, "admin_op")
	if err != nil {
		t.Fatalf("CreateSnapshot error: %v", err)
	}
	if snap.ID != 101 {
		t.Fatalf("expected snapshot ID 101, got %d", snap.ID)
	}
	if snap.ProjectName != "Test Project" || snap.Country != "US" {
		t.Fatalf("unexpected snapshot fields: %#v", snap)
	}

	// 2. UpdateSnapshot updates name/description
	summaryJSON := `{"sku_count":1}`
	updateDB := &fakeWriteDB{
		fakeDB: &fakeDB{
			row: fakeRow{values: []any{
				int64(101), int64(1), "Test Project", "US", "2026-11-01", true,
				stringPointer("Updated Name"), stringPointer("Updated Desc"),
				stringPointer("2026-11-01"), stringPointer("2026-11-01"),
				stringPointer("2026-11-01"), 1, stringPointer("admin_op"), now, summaryJSON,
			}},
		},
	}
	updateStore := NewInventoryReplenishmentStore(updateDB)
	updated, err := updateStore.UpdateSnapshot(ctx, 101, inventory_replenishment.UpdateSnapshotRequest{
		Name: stringPointer("Updated Name"),
	}, "admin_op")
	if err != nil {
		t.Fatalf("UpdateSnapshot error: %v", err)
	}
	if updated == nil || updated.ID != 101 || updated.Name == nil || *updated.Name != "Updated Name" {
		t.Fatalf("unexpected updated snapshot: %#v", updated)
	}

	// 3. UpdateSnapshot missing returns nil
	missingDB := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}}
	missingStore := NewInventoryReplenishmentStore(missingDB)
	updatedMissing, err := missingStore.UpdateSnapshot(ctx, 999, inventory_replenishment.UpdateSnapshotRequest{}, "admin_op")
	if err != nil || updatedMissing != nil {
		t.Fatalf("expected nil for missing snapshot, got %v, err %v", updatedMissing, err)
	}

	// 4. DeleteSnapshot returns true when rows affected
	deleteDB := &fakeWriteDB{
		fakeDB:  &fakeDB{},
		execTag: pgconn.NewCommandTag("DELETE 1"),
	}
	deleteStore := NewInventoryReplenishmentStore(deleteDB)
	ok, err := deleteStore.DeleteSnapshot(ctx, 101, "admin_op")
	if err != nil || !ok {
		t.Fatalf("expected DeleteSnapshot to succeed, got %v, err %v", ok, err)
	}

	// 5. DeleteSnapshot returns false when 0 rows affected
	deleteZeroDB := &fakeWriteDB{
		fakeDB:  &fakeDB{},
		execTag: pgconn.NewCommandTag("DELETE 0"),
	}
	deleteZeroStore := NewInventoryReplenishmentStore(deleteZeroDB)
	okZero, err := deleteZeroStore.DeleteSnapshot(ctx, 999, "admin_op")
	if err != nil || okZero {
		t.Fatalf("expected DeleteSnapshot to return false for missing, got %v, err %v", okZero, err)
	}
}

func TestInventoryReplenishmentStoreListAnalysisTotalAndRisk(t *testing.T) {
	ctx := context.Background()

	// Analysis test:
	// count(*) returns 250 (so Total is 250, not 1!)
	// row 1: available=0, in_transit=0 -> risk should be 长期断货, NOT hardcoded "healthy"!
	db := &fakeWriteDB{
		fakeDB: &fakeDB{
			row: fakeRow{values: []any{int(250)}}, // count(*)
			rows: &fakeRows{
				batches: [][]any{
					{
						int64(1), "Shop US", "SKU-001", "US", stringPointer("ASIN-001"), stringPointer("Product 1"),
						0.20, 20, 25,
						0, 0, // available=0, in_transit=0
					},
				},
			},
		},
	}
	store := NewInventoryReplenishmentStore(db)
	projID := int64(1)
	resp, err := store.ListAnalysis(ctx, inventory_replenishment.ReplenishmentFilter{
		ProjectID: &projID,
		Page:      1,
		PageSize:  50,
	})
	if err != nil {
		t.Fatalf("ListAnalysis error: %v", err)
	}

	// Verify Total is 250 (from count(*)), NOT len(items) (which is 1)
	if resp.Total != 250 {
		t.Fatalf("expected Total = 250 from count(*), got %d", resp.Total)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(resp.Items))
	}
	// Verify risk is NOT "healthy"
	if resp.Items[0].RiskStatus == "healthy" {
		t.Fatal("expected dynamic risk calculation, not hardcoded healthy")
	}
	if resp.Items[0].RiskStatus != "长期断货" {
		t.Fatalf("expected risk status 长期断货 for 0 inventory/transit, got %s", resp.Items[0].RiskStatus)
	}
	if resp.Summary.OutOfStockRiskCount != 1 {
		t.Fatalf("expected OutOfStockRiskCount = 1, got %d", resp.Summary.OutOfStockRiskCount)
	}
}

func TestInventoryReplenishmentStoreUpdateSetting(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()

	db := &fakeWriteDB{
		fakeDB: &fakeDB{
			row: fakeRow{values: []any{
				int64(7), int64(1), "Test Proj", "SKU-1", "US", stringPointer("ASIN-1"),
				15, 30, 0.25, 90, now,
			}},
		},
	}
	store := NewInventoryReplenishmentStore(db)

	safety := 0.25
	lead := 15
	shipping := 30
	target := 90
	item, err := store.UpdateSetting(ctx, 1, "SKU-1", inventory_replenishment.InventoryReplenishmentSettingUpdate{
		Country:            "US",
		ASIN:               stringPointer("ASIN-1"),
		SafetyFactor:       &safety,
		ProductionLeadDays: &lead,
		ShippingDays:       &shipping,
		TargetDays:         &target,
	}, "operator_a")
	if err != nil {
		t.Fatalf("UpdateSetting error: %v", err)
	}
	if item.ProjectID != 1 || item.SKU != "SKU-1" || item.Country != "US" || item.SafetyFactor != 0.25 {
		t.Fatalf("unexpected setting item: %#v", item)
	}
}

func TestInventoryReplenishmentStoreSnapshotSQLSyntaxAndSubqueries(t *testing.T) {
	ctx := context.Background()

	// Verify listAnalysisFromSnapshot parses coalesce(p.product_name, '') cleanly
	snapshotDate := "2026-11-01"
	projID := int64(1)
	db := &fakeWriteDB{
		fakeDB: &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: []any{int(1)}}, // count(*)
			},
			rows: &fakeRows{
				batches: [][]any{
					{
						int64(1), "Shop US", "SKU-001", "US", stringPointer("ASIN-001"), stringPointer("Product 1"),
						10, 5,
						1.0, 1.0, 1.0, 1.0, 1.0,
						0.20, 20, 25,
						1.0, 10, stringPointer("2026-11-10"), stringPointer("2026-11-15"),
						stringPointer("2026-11-05"), stringPointer("2026-11-20"), stringPointer("2026-11-10"),
						100, "健康库存", stringPointer("2026-11-10"),
					},
				},
			},
		},
	}
	store := NewInventoryReplenishmentStore(db)
	resp, err := store.ListAnalysis(ctx, inventory_replenishment.ReplenishmentFilter{
		ProjectID:    &projID,
		SnapshotDate: &snapshotDate,
		Page:         1,
		PageSize:     50,
	})
	if err != nil {
		t.Fatalf("ListAnalysis from snapshot error: %v", err)
	}
	if len(resp.Items) != 1 || resp.Items[0].ProductName == nil || *resp.Items[0].ProductName != "Product 1" {
		t.Fatalf("unexpected snapshot analysis items: %#v", resp.Items)
	}
}

func TestStage10B1InventoryReplenishmentSnapshotDetailReadsRealRows(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 8, 3, 4, 5, 123000000, time.FixedZone("CST", 8*60*60))
	summaryJSON := `{"sku_count":1,"out_of_stock_risk_count":0,"healthy_count":1,"slow_moving_count":0,"pending_data_count":0,"total_available_inventory":10,"total_in_transit_quantity":2}`
	snapshotDB := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: []any{
		int64(42), int64(1), "Shop US", "US", "2026-11-08", true,
		stringPointer("Morning"), stringPointer("note"),
		stringPointer("2026-11-07"), stringPointer("2026-11-06"), stringPointer("2026-11-05"),
		1, stringPointer("alice"), now, summaryJSON,
	}}}}
	snapshot, err := NewInventoryReplenishmentStore(snapshotDB).GetSnapshot(ctx, 42)
	if err != nil {
		t.Fatalf("GetSnapshot error: %v", err)
	}
	if snapshot == nil || snapshot.Summary.SKUCount != 1 || snapshot.CreatedAt != "2026-11-08T03:04:05.123000+08:00" {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}

	itemDB := &fakeWriteDB{fakeDB: &fakeDB{rows: &fakeRows{batches: [][]any{{
		0, "FAMILY/BLUE/01", stringPointer("B001"), 10, 2,
		1.5, 0.0, 2.5, 3.5, 4.5,
		0.2, 20, 25,
		0.0, 10.0,
		stringPointer("2026-11-20"), stringPointer("2026-11-22"),
		stringPointer("2026-11-10"), stringPointer("2026-11-18"), stringPointer("2026-11-12"),
		100, "健康库存", stringPointer("2026-11-20"),
	}}}}}
	items, err := NewInventoryReplenishmentStore(itemDB).ListSnapshotItems(ctx, 42)
	if err != nil {
		t.Fatalf("ListSnapshotItems error: %v", err)
	}
	if len(items) != 1 || items[0].SKU != "FAMILY/BLUE/01" || items[0].DMS14 != nil || items[0].WeightedDMS != nil {
		t.Fatalf("unexpected detail items: %#v", items)
	}
}

func TestStage10B1InventoryReplenishmentSnapshotItemsPageFilters(t *testing.T) {
	ctx := context.Background()
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: []any{int(2)}},
		rows: &fakeRows{batches: [][]any{{
			"FAMILY/BLUE/01", stringPointer("B001"), stringPointer("Blue Shirt"),
			10, 2,
			1.5, 1.0, 2.5, 3.5, 4.5,
			0.2, 20, 25,
			2.0, 10.0,
			stringPointer("2026-11-20"), stringPointer("2026-11-22"),
			stringPointer("2026-11-10"), stringPointer("2026-11-18"), stringPointer("2026-11-12"),
			100, "健康库存", stringPointer("2026-11-20"),
		}}},
	}}
	store := NewInventoryReplenishmentStore(db)
	keyword := "blue"
	risk := "健康库存"
	resp, err := store.ListSnapshotItemsPage(ctx, &inventory_replenishment.InventoryReplenishmentSnapshotListItem{
		ID:          42,
		ProjectID:   1,
		ProjectName: "Shop US",
		Country:     "US",
		Summary: inventory_replenishment.InventoryReplenishmentSnapshotSummary{
			SKUCount: 1,
		},
	}, inventory_replenishment.SnapshotItemsFilter{
		Keyword:       &keyword,
		RiskStatus:    &risk,
		InTransitOnly: true,
		Page:          2,
		PageSize:      10,
	})
	if err != nil {
		t.Fatalf("ListSnapshotItemsPage error: %v", err)
	}
	if resp.Total != 2 || resp.Page != 2 || resp.PageSize != 10 || resp.HasNext {
		t.Fatalf("unexpected page metadata: %#v", resp)
	}
	if len(resp.Items) != 1 || resp.Items[0].ProductName == nil || *resp.Items[0].ProductName != "Blue Shirt" {
		t.Fatalf("unexpected page items: %#v", resp.Items)
	}
	if resp.Items[0].TargetDays != 90 || resp.Items[0].InventoryState != "unknown" || resp.Items[0].ReplenishmentAction != "NO_ACTION" {
		t.Fatalf("snapshot list defaults not populated: %#v", resp.Items[0])
	}
	if resp.Summary.StateDistribution == nil || resp.Summary.ActionDistribution == nil || resp.Summary.StateActionMatrix == nil {
		t.Fatalf("summary maps must be initialized: %#v", resp.Summary)
	}
	if len(db.queryRowCalls) != 1 || len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d/%d", len(db.queryRowCalls), len(db.queryCalls))
	}
	if !strings.Contains(db.queryCalls[0].sql, "left join lateral") ||
		!strings.Contains(db.queryCalls[0].sql, "i.in_transit_quantity > 0") {
		t.Fatalf("snapshot items query missing real-table filter/join: %s", db.queryCalls[0].sql)
	}
	if got := db.queryCalls[0].args[len(db.queryCalls[0].args)-2:]; !assertWriteArgsEqual(got, []any{10, 10}) {
		t.Fatalf("snapshot items limit/offset args = %#v, want [10 10]", got)
	}
}
