package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_ledger"
)

func TestInventoryLedgerStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()

	// 1. Admin always succeeds
	adminStore := NewInventoryLedgerStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	if err := adminStore.VerifyProjectAccess(ctx, 1, "any_op", true); err != nil {
		t.Fatalf("expected admin to succeed, got %v", err)
	}

	// 2. Project not found returns ErrProjectNotFound
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	missingStore := NewInventoryLedgerStore(&fakeWriteDB{fakeDB: missingDB})
	if err := missingStore.VerifyProjectAccess(ctx, 999, "alice", false); !errors.Is(err, inventory_ledger.ErrProjectNotFound) {
		t.Fatalf("expected ErrProjectNotFound, got %v", err)
	}

	// 3. Empty operator returns ErrProjectForbidden
	foundDB := &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice, bob"),
		stringPointer("charlie"),
	}}}
	foundStore := NewInventoryLedgerStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "", false); !errors.Is(err, inventory_ledger.ErrProjectForbidden) {
		t.Fatalf("expected ErrProjectForbidden for empty op, got %v", err)
	}

	// 4. Authorized operator in project_operator succeeds
	foundDB = &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}
	foundStore = NewInventoryLedgerStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "alice", false); err != nil {
		t.Fatalf("expected alice to be allowed, got %v", err)
	}

	// 5. Authorized operator in assistant_operator succeeds
	foundDB = &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}
	foundStore = NewInventoryLedgerStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "charlie", false); err != nil {
		t.Fatalf("expected charlie to be allowed, got %v", err)
	}

	// 6. Unauthorized operator returns ErrProjectForbidden
	foundDB = &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}
	foundStore = NewInventoryLedgerStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "eve", false); !errors.Is(err, inventory_ledger.ErrProjectForbidden) {
		t.Fatalf("expected ErrProjectForbidden for eve, got %v", err)
	}
}

func TestInventoryLedgerParsePeriodAndRealCalendarDays(t *testing.T) {
	// July: 31 days (not 28!)
	_, start, end := parsePeriod("2026-07")
	if start != "2026-07-01" || end != "2026-07-31" {
		t.Fatalf("expected 2026-07-01 to 2026-07-31, got %s to %s", start, end)
	}

	// April: 30 days
	_, start, end = parsePeriod("2026-04-01")
	if start != "2026-04-01" || end != "2026-04-30" {
		t.Fatalf("expected 2026-04-01 to 2026-04-30, got %s to %s", start, end)
	}

	// Feb 2026 (non leap): 28 days
	_, start, end = parsePeriod("2026-02")
	if start != "2026-02-01" || end != "2026-02-28" {
		t.Fatalf("expected 2026-02-01 to 2026-02-28, got %s to %s", start, end)
	}

	// Feb 2024 (leap year): 29 days
	_, start, end = parsePeriod("2024-02")
	if start != "2024-02-01" || end != "2024-02-29" {
		t.Fatalf("expected 2024-02-01 to 2024-02-29, got %s to %s", start, end)
	}
}

func TestInventoryLedgerPrevPeriod(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	_, prevStart, prevEnd := prevPeriod(t1)
	if prevStart != "2025-12-01" || prevEnd != "2025-12-31" {
		t.Fatalf("expected 2025-12-01 to 2025-12-31, got %s to %s", prevStart, prevEnd)
	}

	t2 := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	_, prevStart, prevEnd = prevPeriod(t2)
	if prevStart != "2026-02-01" || prevEnd != "2026-02-28" {
		t.Fatalf("expected 2026-02-01 to 2026-02-28, got %s to %s", prevStart, prevEnd)
	}
}

func TestInventoryLedgerConsistencyPendingWhenNoData(t *testing.T) {
	ctx := context.Background()
	// When summaryCount == 0 and detailCount == 0 -> PENDING
	db := &fakeDB{row: fakeRow{values: []any{0}}}
	s := NewInventoryLedgerStore(&fakeWriteDB{fakeDB: db})

	res, err := s.GetConsistency(ctx, 1, nil, "2026-10")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Status != "PENDING" || res.MismatchCount != 0 {
		t.Fatalf("expected PENDING with 0 mismatches, got %s, count=%d", res.Status, res.MismatchCount)
	}
}

func TestInventoryLedgerCountryMismatchReturnsEmpty(t *testing.T) {
	ctx := context.Background()
	// Project has country "US", request has country "UK" -> mismatch
	db := &fakeDB{row: fakeRow{values: []any{stringPointer("US")}}}
	s := NewInventoryLedgerStore(&fakeWriteDB{fakeDB: db})

	uk := "UK"
	months, err := s.ListMonths(ctx, 1, &uk)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(months.Months) != 0 {
		t.Fatalf("expected empty months for mismatched country, got %d", len(months.Months))
	}

	snap, err := s.GetSnapshot(ctx, 1, &uk, "2026-10")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.TotalQty != 0 || len(snap.SKUs) != 0 {
		t.Fatalf("expected empty snapshot, got %v", snap)
	}
}

func TestInventoryLedgerConsistencyUnionOfKeysAndMismatches(t *testing.T) {
	ctx := context.Background()

	// 1st row: summaryCount = 2
	// 2nd row: detailCount = 2
	// 3rd query: summaryRows has SKU-A (start 50, end 45 -> delta -5) and SKU-C (start 0, end 10 -> delta 10)
	summaryRows := &fakeRows{
		batches: [][]any{
			{"SKU-A", "LAX1", "SELLABLE", -5},
			{"SKU-C", "PHX3", "SELLABLE", 10},
		},
	}
	// 4th query: detailRows has SKU-A (sum -5, matches summary) and SKU-B (sum 2, only in detail)
	detailRows := &fakeRows{
		batches: [][]any{
			{"SKU-A", "LAX1", "SELLABLE", -5},
			{"SKU-B", "STL3", "SELLABLE", 2},
		},
	}

	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{2}}, // summaryCount
			fakeRow{values: []any{2}}, // detailCount
		},
		rows: summaryRows,
	}

	db.rowsQueueQuery = []Rows{summaryRows, detailRows}
	s := NewInventoryLedgerStore(&fakeWriteDB{fakeDB: db})

	res, err := s.GetConsistency(ctx, 1, nil, "2026-10")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.Status != "MISMATCH" {
		t.Fatalf("expected MISMATCH, got %s", res.Status)
	}

	// Union of keys:
	// SKU-A: delta -5, detail -5 -> matched
	// SKU-B: only in detail -> mismatch (detail=2, summary=0, diff=2)
	// SKU-C: only in summary -> mismatch (detail=0, summary=10, diff=-10)
	if res.MismatchCount != 2 {
		t.Fatalf("expected 2 mismatches, got %d: %+v", res.MismatchCount, res.Mismatches)
	}

	m0 := res.Mismatches[0]
	if m0.MSKU != "SKU-B" || m0.DetailQuantity != 2 || m0.SummaryDelta != 0 || m0.Diff != 2 {
		t.Fatalf("unexpected mismatch 0: %+v", m0)
	}
	m1 := res.Mismatches[1]
	if m1.MSKU != "SKU-C" || m1.DetailQuantity != 0 || m1.SummaryDelta != 10 || m1.Diff != -10 {
		t.Fatalf("unexpected mismatch 1: %+v", m1)
	}
}

func TestInventoryLedgerConsistencyReturnsErrorOnQueryFailure(t *testing.T) {
	ctx := context.Background()

	// QueryRow returns error
	db := &fakeDB{
		row: fakeRow{err: errors.New("db connection lost")},
	}
	s := NewInventoryLedgerStore(&fakeWriteDB{fakeDB: db})

	_, err := s.GetConsistency(ctx, 1, nil, "2026-10")
	if err == nil || !strings.Contains(err.Error(), "db connection lost") {
		t.Fatalf("expected db connection lost error, got: %v", err)
	}
}
