package store

import (
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation_snapshots"
)

func TestScanSnapshotListRowParsesSummaryAndTimestamps(t *testing.T) {
	snapshotDate := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	createdAt := time.Date(2026, 11, 8, 8, 1, 2, 123456000, time.UTC)
	row := fakeRow{values: []any{
		int64(9), int64(7), "US Shop", "US", snapshotDate, (*string)(nil), (*string)(nil),
		3, (*string)(nil), createdAt, `{"total":3,"calculated":3,"profitable":2,"passRate":66.6666667}`,
	}}

	item, err := scanSnapshotListRow(row)
	if err != nil {
		t.Fatalf("scanSnapshotListRow() error = %v", err)
	}
	if item.Summary.Total != 3 || item.Summary.Profitable != 2 {
		t.Fatalf("summary = %#v", item.Summary)
	}
	if item.SnapshotDate != "2026-11-08T08:00:00Z" {
		t.Errorf("SnapshotDate = %q", item.SnapshotDate)
	}
	if item.CreatedAt != "2026-11-08T08:01:02.123456Z" {
		t.Errorf("CreatedAt = %q", item.CreatedAt)
	}
}

func TestSnapshotAnchorUsesEngineRounding(t *testing.T) {
	afterVAT := 0.2
	item := pricing_calculation_snapshots.SnapshotItem{
		SalePriceUSD:       19.99,
		USDToRMBRate:       7.2,
		USDToRMBRateSource: "manual",
		ObservedAt:         "2026-11-08T08:00:00Z",
		Fees: pricing_calculation_snapshots.SnapshotFees{
			TotalFeeUSD:       10.20,
			AdvertisingFeeUSD: 2.40,
		},
		Profit: pricing_calculation_snapshots.SnapshotProfit{
			DDPCostUSD:         4.20,
			VATUSD:             1.50,
			ProfitAfterVATRate: &afterVAT,
		},
	}

	anchor := snapshotAnchor(item)
	if anchor == nil || anchor.BreakevenAdvertisingRate == nil {
		t.Fatal("expected anchor")
	}
	if got := *anchor.BreakevenAdvertisingRate; got != 0.3997 {
		t.Errorf("breakeven = %v, want 0.3997", got)
	}
	if anchor.NonAdFeeUSD == nil || *anchor.NonAdFeeUSD != 7.8 {
		t.Errorf("non-ad fee = %v, want 7.8", anchor.NonAdFeeUSD)
	}
	if anchor.MaxAdSpendPerUnitUSD == nil || *anchor.MaxAdSpendPerUnitUSD != 7.99 {
		t.Errorf("max ad spend = %v, want 7.99", anchor.MaxAdSpendPerUnitUSD)
	}
	if anchor.BreakevenAdvertisingRateAfterVAT == nil {
		t.Fatal("expected after-VAT breakeven")
	}
}

func TestSnapshotAnchorUsesDecimalHalfUpAtTie(t *testing.T) {
	anchor := snapshotAnchor(pricing_calculation_snapshots.SnapshotItem{
		SalePriceUSD: 1.60,
		Fees: pricing_calculation_snapshots.SnapshotFees{
			TotalFeeUSD:       0,
			AdvertisingFeeUSD: 0,
		},
		Profit: pricing_calculation_snapshots.SnapshotProfit{DDPCostUSD: 1.59},
	})
	if anchor == nil || anchor.BreakevenAdvertisingRate == nil {
		t.Fatal("expected anchor")
	}
	if got := *anchor.BreakevenAdvertisingRate; got != 0.0063 {
		t.Fatalf("breakeven = %v, want decimal HALF_UP 0.0063", got)
	}
}
