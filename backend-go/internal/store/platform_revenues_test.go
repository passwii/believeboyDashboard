package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/platform_revenues"
)

func TestPlatformRevenueStoreVerifyAccess(t *testing.T) {
	ctx := context.Background()

	// 1. Admin passes
	store := NewPlatformRevenueStore(&fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: []any{nil, nil}}}})
	if err := store.VerifyProjectAccess(ctx, 1, "op", true); err != nil {
		t.Fatalf("expected admin to pass, got %v", err)
	}

	// 2. Project not found
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store = NewPlatformRevenueStore(&fakeWriteDB{fakeDB: missingDB})
	if err := store.VerifyProjectAccess(ctx, 1, "op", false); !errors.Is(err, platform_revenues.ErrProjectNotFound) {
		t.Fatalf("expected ErrProjectNotFound, got %v", err)
	}

	// 3. Operator allowed
	foundDB := &fakeDB{row: fakeRow{values: []any{
		categoryTestStringPtr("alice、bob"),
		categoryTestStringPtr("charlie"),
	}}}
	store = NewPlatformRevenueStore(&fakeWriteDB{fakeDB: foundDB})
	if err := store.VerifyProjectAccess(ctx, 1, "alice", false); err != nil {
		t.Fatalf("expected alice to pass, got %v", err)
	}

	// 4. Operator forbidden
	foundDB = &fakeDB{row: fakeRow{values: []any{
		categoryTestStringPtr("alice、bob"),
		categoryTestStringPtr("charlie"),
	}}}
	store = NewPlatformRevenueStore(&fakeWriteDB{fakeDB: foundDB})
	if err := store.VerifyProjectAccess(ctx, 1, "eve", false); !errors.Is(err, platform_revenues.ErrProjectForbidden) {
		t.Fatalf("expected ErrProjectForbidden, got %v", err)
	}
}

func TestPlatformRevenueStoreGetRevenue(t *testing.T) {
	ctx := context.Background()

	// 1. Not found
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store := NewPlatformRevenueStore(&fakeWriteDB{fakeDB: missingDB})
	if _, err := store.GetRevenue(ctx, 999, "op", true); !errors.Is(err, platform_revenues.ErrRevenueNotFound) {
		t.Fatalf("expected ErrRevenueNotFound, got %v", err)
	}

	// 2. Found (Admin)
	now := time.Now()
	rate := 7.2
	foundDB := &fakeDB{row: fakeRow{values: []any{
		int64(1), int64(10), "TestProj", "US", "2026-11-08",
		123.45, "USD", &rate, "订单回款", categoryTestStringPtr("note"),
		categoryTestStringPtr("[]"), categoryTestStringPtr("key"), categoryTestStringPtr("url"),
		"creator", now, now,
	}}}
	store = NewPlatformRevenueStore(&fakeWriteDB{fakeDB: foundDB})
	item, err := store.GetRevenue(ctx, 1, "op", true)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if item.ID != 1 || item.Amount != 123.45 {
		t.Fatalf("unexpected item: %+v", item)
	}
}

func TestPlatformRevenueStoreSavePaymentScreenshot(t *testing.T) {
	ctx := context.Background()
	store := NewPlatformRevenueStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'}
	resp, err := store.SavePaymentScreenshot(ctx, "../../Shop US", "../../receipt.png", "image/png", png)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if resp.Filename != "receipt.png" || resp.Size != int64(len(png)) {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if strings.Contains(resp.Key, "..") || strings.Contains(resp.Key, "/Shop_US/") {
		t.Fatalf("unsafe screenshot key: %q", resp.Key)
	}
	if _, err := store.SavePaymentScreenshot(ctx, "Shop", "receipt.png", "image/png", []byte("sample")); err == nil {
		t.Fatal("expected image content mismatch to be rejected")
	}
	if _, err := store.SavePaymentScreenshot(ctx, "Shop", "receipt.png", "application/pdf", png); err == nil {
		t.Fatal("expected unsupported content type to be rejected")
	}
}

func TestPlatformRevenueAccessibleProjectsSQLUsesSingleQuotedRegex(t *testing.T) {
	if strings.Contains(accessibleProjectIDsSQL, `"`) {
		t.Fatalf("accessible-project SQL must not use double-quoted regex literals: %s", accessibleProjectIDsSQL)
	}
	if !strings.Contains(accessibleProjectIDsSQL, "E'[、,，;\\n\\r]+'") {
		t.Fatalf("missing single-quoted E-string regex: %s", accessibleProjectIDsSQL)
	}
	db := &fakeDB{rows: &fakeRows{}}
	store := NewPlatformRevenueStore(&fakeWriteDB{fakeDB: db})
	if _, err := store.AccessibleProjectIDs(context.Background(), "alice"); err != nil {
		t.Fatalf("accessible projects: %v", err)
	}
	if len(db.queryCalls) != 1 || db.queryCalls[0].args[0] != "alice" {
		t.Fatalf("query calls = %#v", db.queryCalls)
	}
}

func TestPlatformRevenueAccessibleProjectsSQLPreparesAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Prepare(ctx, "platform_revenue_accessible_projects", accessibleProjectIDsSQL); err != nil {
		t.Fatalf("prepare accessible projects SQL: %v", err)
	}
}
