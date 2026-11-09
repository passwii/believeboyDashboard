package store

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/daily_analysis"
)

func TestDailyAnalysisStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()

	// 1. Admin always succeeds
	adminStore := NewDailyAnalysisStore(&fakeDB{})
	if err := adminStore.VerifyProjectAccess(ctx, 1, "any_op", true); err != nil {
		t.Fatalf("expected admin to succeed, got %v", err)
	}

	// 2. Project not found
	missingStore := NewDailyAnalysisStore(&fakeDB{row: fakeRow{err: pgx.ErrNoRows}})
	if err := missingStore.VerifyProjectAccess(ctx, 999, "alice", false); !errors.Is(err, daily_analysis.ErrProjectNotFound) {
		t.Fatalf("expected ErrProjectNotFound, got %v", err)
	}

	// 3. Empty operator forbidden
	foundDB := &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice, bob"),
		stringPointer("charlie"),
	}}}
	foundStore := NewDailyAnalysisStore(foundDB)
	if err := foundStore.VerifyProjectAccess(ctx, 1, "", false); !errors.Is(err, daily_analysis.ErrProjectForbidden) {
		t.Fatalf("expected ErrProjectForbidden for empty operator, got %v", err)
	}

	// 4. Authorized operator in project_operator
	if err := foundStore.VerifyProjectAccess(ctx, 1, "alice", false); err != nil {
		t.Fatalf("expected alice to be authorized, got %v", err)
	}

	// 5. Authorized operator in assistant_operator
	if err := foundStore.VerifyProjectAccess(ctx, 1, "charlie", false); err != nil {
		t.Fatalf("expected charlie to be authorized, got %v", err)
	}

	// 6. Unauthorized operator
	if err := foundStore.VerifyProjectAccess(ctx, 1, "david", false); !errors.Is(err, daily_analysis.ErrProjectForbidden) {
		t.Fatalf("expected david to be forbidden, got %v", err)
	}
}

func TestDailyAnalysisStoreAccessibleProjectIDs(t *testing.T) {
	ctx := context.Background()

	// 1. Admin gets all active projects
	adminDB := &fakeDB{
		rows: &fakeRows{
			batches: [][]any{
				{int64(1)},
				{int64(2)},
			},
		},
	}
	adminStore := NewDailyAnalysisStore(adminDB)
	ids, err := adminStore.AccessibleProjectIDs(ctx, "", true)
	if err != nil || len(ids) != 2 || ids[0] != 1 || ids[1] != 2 {
		t.Fatalf("unexpected admin accessible IDs: %v, err: %v", ids, err)
	}

	// 2. Non-admin empty operator -> empty list
	ids, err = adminStore.AccessibleProjectIDs(ctx, "", false)
	if err != nil || len(ids) != 0 {
		t.Fatalf("expected empty ids for empty operator, got %v", ids)
	}

	// 3. Non-admin operator filtering
	userDB := &fakeDB{
		rows: &fakeRows{
			batches: [][]any{
				{int64(10), "alice、bob", "charlie"},
				{int64(20), "david", "eve"},
				{int64(30), "frank", "bob"},
			},
		},
	}
	userStore := NewDailyAnalysisStore(userDB)
	ids, err = userStore.AccessibleProjectIDs(ctx, "bob", false)
	if err != nil || len(ids) != 2 || ids[0] != 10 || ids[1] != 30 {
		t.Fatalf("expected projects [10, 30] for bob, got %v, err: %v", ids, err)
	}
}

func TestDailyAnalysisAggregationAndMath(t *testing.T) {
	store := NewDailyAnalysisStore(&fakeDB{})

	buckets := map[string]*dailyMetricBucket{
		"2026-11-01\x00SKU-A": {
			orderQty:            10,
			pendingOrderQty:     2,
			salesAmount:         100.0,
			impressions:         1000,
			clicks:              50,
			adSpend:             25.0,
			adOrders:            5,
			availableQty:        30,
			pageViews:           200,
			unitsOrdered:        15,
			sessions:            180,
			businessSalesAmount: 110.0,
		},
		"2026-11-01\x00SKU-B": {
			orderQty:            5,
			pendingOrderQty:     1,
			salesAmount:         50.0,
			impressions:         500,
			clicks:              25,
			adSpend:             10.0,
			adOrders:            2,
			availableQty:        20,
			pageViews:           100,
			unitsOrdered:        5,
			sessions:            90,
			businessSalesAmount: 55.0,
		},
	}

	detail, summary := store.aggregateBuckets(buckets, nil)
	if len(detail) != 2 {
		t.Fatalf("expected 2 detail rows, got %d", len(detail))
	}
	if len(summary) != 1 {
		t.Fatalf("expected 1 summary row, got %d", len(summary))
	}

	sum := summary[0]
	if sum.Date != "2026-11-01" {
		t.Errorf("date = %s, want 2026-11-01", sum.Date)
	}
	if sum.OrderQty != 15 || sum.PendingOrderQty != 3 {
		t.Errorf("orders = %d, pending = %d, want 15 and 3", sum.OrderQty, sum.PendingOrderQty)
	}
	if sum.SalesAmount != 150.0 {
		t.Errorf("sales = %f, want 150.0", sum.SalesAmount)
	}
	if sum.Clicks != 75 || sum.AdSpend != 35.0 {
		t.Errorf("clicks = %d, adSpend = %f, want 75 and 35.0", sum.Clicks, sum.AdSpend)
	}
	// CPC: 35 / 75 = 0.46666... -> 0.47
	if sum.CPC != 0.47 {
		t.Errorf("CPC = %f, want 0.47", sum.CPC)
	}
	// Conversion rate: unitsOrdered (20) / pageViews (300) = 0.0666... -> 0.07
	if sum.ConversionRate != 0.07 {
		t.Errorf("ConversionRate = %f, want 0.07", sum.ConversionRate)
	}

	// Filter by SKU-A
	skuA := "SKU-A"
	detailFiltered, summaryFiltered := store.aggregateBuckets(buckets, &skuA)
	if len(detailFiltered) != 1 || detailFiltered[0].SKU != "SKU-A" {
		t.Fatalf("expected only SKU-A, got %+v", detailFiltered)
	}
	if len(summaryFiltered) != 1 || summaryFiltered[0].OrderQty != 10 {
		t.Fatalf("expected SKU-A only summary, got %+v", summaryFiltered)
	}
}

func TestDailyAnalysisConversionToUSD(t *testing.T) {
	buckets := map[string]*dailyMetricBucket{
		"2026-11-01\x00SKU-A": {
			salesAmount:         100.0,
			adSpend:             20.0,
			businessSalesAmount: 90.0,
		},
	}
	factors := map[string]map[string]float64{
		"DE": {
			"2026-11": 1.10, // 1 EUR = 1.10 USD
		},
	}

	convertBucketAmountsToUSD(buckets, "DE", factors)
	b := buckets["2026-11-01\x00SKU-A"]
	if b.salesAmount != 110.0 {
		t.Errorf("salesAmount = %f, want 110.0", b.salesAmount)
	}
	if b.adSpend != 22.0 {
		t.Errorf("adSpend = %f, want 22.0", b.adSpend)
	}
	if b.businessSalesAmount != 99.0 {
		t.Errorf("businessSalesAmount = %f, want 99.0", b.businessSalesAmount)
	}
}

func TestDateAndMonthRangeHelpers(t *testing.T) {
	dates := generateDateRange("2026-11-01", "2026-11-03")
	if len(dates) != 3 || dates[0] != "2026-11-01" || dates[2] != "2026-11-03" {
		t.Fatalf("unexpected dates: %v", dates)
	}

	months := yearMonthsInRange("2026-10-15", "2026-12-05")
	if len(months) != 3 || months[0] != "2026-10" || months[1] != "2026-11" || months[2] != "2026-12" {
		t.Fatalf("unexpected yearMonths: %v", months)
	}
}
