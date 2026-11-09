package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/category_research"
)

func TestCategoryResearchStoreListAndGet(t *testing.T) {
	ctx := context.Background()
	now := time.Now()

	// 1. Get Dataset Not Found
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store := NewCategoryResearchStore(&fakeWriteDB{fakeDB: missingDB})
	if _, err := store.GetDataset(ctx, 999); !errors.Is(err, category_research.ErrDatasetNotFound) {
		t.Fatalf("expected ErrDatasetNotFound, got %v", err)
	}

	// 2. Get Dataset Found
	foundDB := &fakeDB{
		row: fakeRow{
			values: []any{
				int64(1), "US", "yoga mat", "瑜伽垫", 1, true,
				&now, "file-1", "path/file.xlsx", categoryTestStringPtr("data.xlsx"), "data.xlsx",
				categoryTestIntPtr(1024), categoryTestStringPtr("sha256"), "success", categoryTestStringPtr(""), "2026-11-08",
				50, 100, categoryTestStringPtr("{}"), categoryTestStringPtr("tester"),
				&now, &now,
			},
		},
	}
	store = NewCategoryResearchStore(&fakeWriteDB{fakeDB: foundDB})
	ds, err := store.GetDataset(ctx, 1)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if ds.ID != 1 || ds.CategoryKeywordEn != "yoga mat" || ds.Marketplace != "US" {
		t.Fatalf("unexpected dataset: %+v", ds)
	}
	if ds.DataYear == nil || *ds.DataYear != 2026 || ds.DataMonth == nil || *ds.DataMonth != 11 || ds.DataDay == nil || *ds.DataDay != 8 {
		t.Fatalf("dataset date parts = year:%v month:%v day:%v", ds.DataYear, ds.DataMonth, ds.DataDay)
	}
}

func TestCategoryResearchStoreOverviewAndTrends(t *testing.T) {
	ctx := context.Background()
	now := time.Now()

	datasetRow := fakeRow{
		values: []any{
			int64(1), "US", "yoga mat", "瑜伽垫", 1, true,
			&now, "file-1", "path/file.xlsx", categoryTestStringPtr("data.xlsx"), "data.xlsx",
			categoryTestIntPtr(1024), categoryTestStringPtr("sha256"), "success", categoryTestStringPtr(""), "2026-11-08",
			50, 100, categoryTestStringPtr("{}"), categoryTestStringPtr("tester"),
			&now, &now,
		},
	}

	prodRows := &categoryTestRows{
		batches: [][]any{
			{
				int64(10), 4, categoryTestStringPtr("B001"), (*string)(nil),
				categoryTestStringPtr("Yoga Mat"), categoryTestStringPtr("Brand A"),
				categoryTestStringPtr("Seller A"), float64PointerLocal(25.0), 100,
				float64PointerLocal(2500.0), float64PointerLocal(4.5), 50,
				categoryTestStringPtr("2026-01-01"), categoryTestIntPtr(90),
				float64PointerLocal(5.5), categoryTestStringPtr("FBA"),
				(*string)(nil), (*int)(nil), (*bool)(nil), (*bool)(nil), (*bool)(nil), (*string)(nil),
				false, true, categoryTestStringPtr("{}"), categoryTestStringPtr("{}"),
			},
		},
	}
	trendRows := &categoryTestRows{
		batches: [][]any{{"B001", (*string)(nil), "2026-01", 100}},
	}

	mockDB := &fakeDB{
		row:            datasetRow,
		rowsQueueQuery: []Rows{prodRows, trendRows},
	}
	store := NewCategoryResearchStore(&fakeWriteDB{fakeDB: mockDB})

	overview, err := store.GetDatasetOverview(ctx, 1, "default", "")
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if overview.Kpis.SampleCount != 1 || overview.Kpis.TotalMonthlySales != 100 {
		t.Fatalf("unexpected overview kpis: %+v", overview.Kpis)
	}
	if len(overview.BrandSalesShare) != 1 || overview.BrandSalesShare[0].Share != 1 {
		t.Fatalf("brand share should be a 0..1 fraction: %+v", overview.BrandSalesShare)
	}
	if len(overview.AvailableAsins) != 1 || overview.AvailableAsins[0] != "B001" {
		t.Fatalf("available ASINs = %+v", overview.AvailableAsins)
	}
}

func TestCategoryResearchStoreRecomputeUpdatesPersistedMetrics(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	datasetRow := fakeRow{values: []any{
		int64(1), "US", "yoga mat", "瑜伽垫", 1, true,
		&now, "file-1", "path/file.xlsx", categoryTestStringPtr("data.xlsx"), "data.xlsx",
		categoryTestIntPtr(1024), categoryTestStringPtr("sha256"), "success", categoryTestStringPtr(""), "2026-11-08",
		2, 3, categoryTestStringPtr(`{"invalid_price_count":1}`), categoryTestStringPtr("tester"),
		&now, &now,
	}}
	countsRow := fakeRow{values: []any{4, 6, 1, 2, 3}}
	writeDB := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{datasetRow, countsRow}}}
	store := NewCategoryResearchStore(writeDB)

	resp, err := store.RecomputeDataset(ctx, 1)
	if err != nil {
		t.Fatalf("recompute: %v", err)
	}
	if resp.RowCountProducts != 4 || resp.RowCountTrends != 6 {
		t.Fatalf("response = %+v", resp)
	}
	if got := anyInt(resp.QualityWarnings["missing_fba_fee_count"]); got != 2 {
		t.Fatalf("missing FBA count = %d", got)
	}
	if got := anyInt(resp.QualityWarnings["missing_trend_for_asin_count"]); got != 3 {
		t.Fatalf("missing trend count = %d", got)
	}
	if len(writeDB.execCalls) != 1 || !strings.Contains(writeDB.execCalls[0].sql, "row_count_products = $1") {
		t.Fatalf("update calls = %#v", writeDB.execCalls)
	}
	if len(writeDB.queryRowCalls) != 2 || !strings.Contains(writeDB.queryRowCalls[1].sql, "count(distinct p.asin)") {
		t.Fatalf("query row calls = %#v", writeDB.queryRowCalls)
	}
}
