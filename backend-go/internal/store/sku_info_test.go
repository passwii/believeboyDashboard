package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/sku_info"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func TestSkuMarketplaceURL(t *testing.T) {
	url := sku_info.BuildMarketplaceURL("US", "B012345678")
	if url == nil || *url != "https://www.amazon.com/dp/B012345678" {
		t.Fatalf("unexpected marketplace url: %v", url)
	}
	urlDE := sku_info.BuildMarketplaceURL("DE", "B012345678")
	if urlDE == nil || *urlDE != "https://www.amazon.de/dp/B012345678" {
		t.Fatalf("unexpected marketplace url: %v", urlDE)
	}
}

func TestSkuStoreProjectNotFoundRejectsFallback(t *testing.T) {
	ctx := context.Background()
	// Mock DB returns pgx.ErrNoRows for project lookup
	db := &fakeDB{
		row: fakeRow{err: pgx.ErrNoRows},
	}
	store := NewSkuStore(&fakeWriteDB{fakeDB: db})

	_, _, err := store.CreateOrUpdateSkuRecord(ctx, sku_info.SkuRecordCreate{
		ProjectName: "NonExistentProject",
		SKU:         "SKU-001",
		ASIN:        "B001",
	}, "alice")

	if err == nil {
		t.Fatal("expected error for non-existent project, got nil")
	}
	if !strings.Contains(err.Error(), "404") && !strings.Contains(err.Error(), "项目不存在") {
		t.Fatalf("expected 404/项目不存在 error, got: %v", err)
	}
}

func TestSkuStoreBulkUpsertAtomicRollback(t *testing.T) {
	ctx := context.Background()
	// Mock DB that returns a valid project for 1st call, but ErrNoRows for 2nd call
	skuRow := fakeRow{
		values: []any{
			true, int64(1), int64(10), "ProjectA", "SKU1", "ASIN1", (*string)(nil), (*string)(nil), (*string)(nil),
			10.0, 5.0, 10.0, 10.0, 10.0, 1.0, 20.0, 20.0, 20.0, 10.0, 10,
			"CNY", "US", 1, true, (*string)(nil), (*time.Time)(nil), (*string)(nil),
			(*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil),
			(*time.Time)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil),
			(*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*time.Time)(nil), (*string)(nil),
		},
	}
	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{int64(10)}}, // 1st project lookup: found
			fakeRow{values: []any{1}},         // sort_order
			skuRow,                            // upsert returning
			fakeRow{err: pgx.ErrNoRows},       // 2nd project lookup: not found!
		},
	}
	store := NewSkuStore(&fakeWriteDB{fakeDB: db})

	bulk := sku_info.SkuRecordBulkCreate{
		Items: []sku_info.SkuRecordCreate{
			{ProjectName: "ProjectA", SKU: "SKU1", ASIN: "ASIN1"},
			{ProjectName: "BadProject", SKU: "SKU2", ASIN: "ASIN2"},
		},
	}

	_, err := store.BulkCreateOrUpdateSkuRecords(ctx, bulk, "alice")
	if err == nil {
		t.Fatal("expected bulk upsert to fail atomically, got nil")
	}
	if !strings.Contains(err.Error(), "404") && !strings.Contains(err.Error(), "项目不存在") {
		t.Fatalf("expected project not found error, got: %v", err)
	}
}

func TestSkuStoreUpdateAllFields(t *testing.T) {
	ctx := context.Background()
	skuRow := fakeRow{
		values: []any{
			int64(1), int64(10), "ProjectA", "SKU-UPD", "ASIN-UPD", (*string)(nil), (*string)(nil), (*string)(nil),
			12.5, 6.2, 15.0, 12.0, 8.0, 0.95, 40.0, 30.0, 25.0, 12.5, 24,
			"USD", "DE", 2, true, (*string)(nil), (*time.Time)(nil), (*string)(nil),
			(*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil),
			(*time.Time)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil),
			(*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil), (*time.Time)(nil), (*string)(nil),
		},
	}
	db := &fakeDB{
		row: skuRow,
	}
	writeDB := &fakeWriteDB{fakeDB: db, execTag: pgconn.NewCommandTag("UPDATE 1")}
	store := NewSkuStore(writeDB)

	l := 15.0
	w := 12.0
	h := 8.0
	wt := 0.95
	cl := 40.0
	cw := 30.0
	ch := 25.0
	cwt := 12.5
	units := 24
	curr := "USD"
	country := "DE"
	title := "Awesome Product"
	bullet1 := "Feature 1"
	desc := "Full description"

	update := sku_info.SkuRecordUpdate{
		PackageLengthCM:    &l,
		PackageWidthCM:     &w,
		PackageHeightCM:    &h,
		WeightKG:           &wt,
		CartonLengthCM:     &cl,
		CartonWidthCM:      &cw,
		CartonHeightCM:     &ch,
		CartonWeightKG:     &cwt,
		UnitsPerCarton:     &units,
		Currency:           &curr,
		Country:            &country,
		ListingTitle:       &title,
		ListingBullet1:     &bullet1,
		ListingDescription: &desc,
		SkuFactoryInfo:     map[string]string{"factory": "Factory A"},
	}

	item, err := store.UpdateSkuRecord(ctx, 1, update, "admin_op")
	if err != nil {
		t.Fatalf("UpdateSkuRecord error: %v", err)
	}
	if item == nil {
		t.Fatal("expected updated item, got nil")
	}

	// Verify that the UPDATE statement included all field assignments
	if len(writeDB.execCalls) == 0 {
		t.Fatal("expected at least 1 Exec call")
	}
	updateSQL := writeDB.execCalls[0].sql
	for _, field := range []string{
		"package_length_cm", "package_width_cm", "package_height_cm", "weight_kg",
		"carton_length_cm", "carton_width_cm", "carton_height_cm", "carton_weight_kg",
		"units_per_carton", "currency", "country", "listing_title", "listing_bullet_1",
		"listing_description", "sku_factory_info", "listing_copy_updated_at",
	} {
		if !strings.Contains(updateSQL, field) {
			t.Errorf("UPDATE SQL missing field %q: %s", field, updateSQL)
		}
	}
}

func TestSkuStoreSetFnskuLabelCommitsMutationAndAuditAtomically(t *testing.T) {
	oldKey := "sku-info/fnsku-labels/10/1/old.pdf"
	newKey := "sku-info/fnsku-labels/10/1/new.pdf"
	db := &stage10EProjectDB{
		fakeWriteDB: &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
			fakeRow{values: []any{"SKU1", stringTestPointer(oldKey)}},
			fakeRow{values: stage10ESKUMediaScanValues("SKU1", stringTestPointer(newKey))},
		}}},
	}
	store := NewSkuStore(db)

	item, previous, err := store.SetFnskuLabel(
		context.Background(),
		1,
		newKey,
		"https://cdn.example.com/new.pdf",
		audit.Entry{
			Action:     "sku_info.upload_fnsku_label",
			TargetType: "sku_info",
			Operator:   stringTestPointer("alice"),
		},
	)
	if err != nil {
		t.Fatalf("SetFnskuLabel() error = %v", err)
	}
	if item == nil || item.ID != 1 || item.FnskuLabelR2Key == nil ||
		*item.FnskuLabelR2Key != newKey {
		t.Fatalf("item = %#v", item)
	}
	if previous == nil || *previous != oldKey {
		t.Fatalf("previous = %#v, want old key", previous)
	}
	if !db.committed {
		t.Fatal("transaction did not commit")
	}
	if len(db.execCalls) != 2 ||
		!strings.Contains(db.execCalls[1].sql, "operation_audit_logs") {
		t.Fatalf("exec calls = %#v, want update + audit", db.execCalls)
	}
}

func TestSkuStoreSetFnskuLabelRollsBackWhenAuditFails(t *testing.T) {
	db := &stage10EProjectDB{
		fakeWriteDB: &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
			fakeRow{values: []any{"SKU1", (*string)(nil)}},
			fakeRow{values: stage10ESKUMediaScanValues("SKU1", nil)},
		}}},
	}
	store := NewSkuStore(db, stage10EFailingAudit{})
	_, _, err := store.SetFnskuLabel(
		context.Background(),
		1,
		"new.pdf",
		"https://cdn.example.com/new.pdf",
		audit.Entry{Action: "sku_info.upload_fnsku_label"},
	)
	if err == nil || !strings.Contains(err.Error(), "audit unavailable") {
		t.Fatalf("SetFnskuLabel() error = %v, want audit failure", err)
	}
	if !db.rolledBack || db.committed {
		t.Fatalf("committed/rolledBack = %v/%v, want rollback", db.committed, db.rolledBack)
	}
}

func stage10ESKUMediaScanValues(sku string, labelKey *string) []any {
	return []any{
		int64(1), int64(10), "ProjectA", sku, "ASIN1",
		stringTestPointer("X00ABCDEFG"), (*string)(nil), (*string)(nil),
		10.0, 5.0, 10.0, 10.0, 10.0, 1.0, 20.0, 20.0, 20.0, 10.0, 10,
		"CNY", "US", 1, true, (*string)(nil), (*time.Time)(nil), (*string)(nil),
		labelKey, (*string)(nil),
		(*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil),
		(*time.Time)(nil), (*string)(nil),
		(*string)(nil), (*string)(nil), (*string)(nil), (*string)(nil),
		(*string)(nil), (*string)(nil),
		(*string)(nil), (*string)(nil), (*time.Time)(nil), (*string)(nil),
	}
}
