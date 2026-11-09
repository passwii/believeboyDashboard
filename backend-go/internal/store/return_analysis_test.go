package store

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/return_analysis"
)

func TestReturnAnalysisStoreGetReturnAnalysis(t *testing.T) {
	ctx := context.Background()
	now := time.Now()

	// 1. Project Row
	projectRow := fakeRow{values: []any{"Alpha Project"}}
	// 2. Span Row
	spanRow := fakeRow{values: []any{&now, &now}}

	// 3. Return Rows
	returnRows := &fakeRows{
		batches: [][]any{
			{
				int64(1), "2026-10-15", "111-222", "SKU-A", categoryTestStringPtr("B001"), categoryTestStringPtr("Item A"),
				2, categoryTestStringPtr("FC1"), "DEFECTIVE",
				"DEFECTIVE", "Unit returned to inventory", categoryTestStringPtr("LPN1"), "2026-10-15T12:00:00Z",
				categoryTestStringPtr("Damaged on arrival"),
			},
		},
	}

	// 4. Sales Rows
	salesRows := &fakeRows{
		batches: [][]any{
			{"SKU-A", "2026-10-15", 20, 200.0},
		},
	}
	cycleRows := &fakeRows{
		batches: [][]any{
			{"111-222", "SKU-A", "2026-10-10"},
		},
	}

	mockDB := &fakeDB{
		rowsQueue: []pgx.Row{
			projectRow,
			spanRow,
		},
		rowsQueueQuery: []Rows{
			returnRows,
			salesRows,
			cycleRows,
			&fakeRows{},
		},
	}
	store := NewReturnAnalysisStore(&fakeWriteDB{fakeDB: mockDB})

	res, err := store.GetReturnAnalysis(ctx, return_analysis.ReturnAnalysisFilter{
		ProjectID: 1,
		Country:   "US",
		StartDate: "2026-10-01",
		EndDate:   "2026-10-31",
	})
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if res.Summary.TotalQuantity != 2 || res.Summary.TotalReturns != 1 {
		t.Fatalf("unexpected summary: %+v", res.Summary)
	}
	if len(res.RankingRows) != 1 || res.RankingRows[0].SKU != "SKU-A" {
		t.Fatalf("unexpected ranking rows: %+v", res.RankingRows)
	}
	if len(res.ReasonRows) != 1 || res.ReasonRows[0].ReasonDisplay != "有缺陷" {
		t.Fatalf("unexpected reason rows: %+v", res.ReasonRows)
	}
}

func TestReturnAnalysisAggregatesUniqueEventsAndFeedback(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	returnRows := &categoryTestRows{batches: [][]any{
		{
			int64(1), "2026-10-15", "O1", "SKU-A", categoryTestStringPtr("B001"), categoryTestStringPtr("Item A"),
			2, categoryTestStringPtr("FC1"), "DEFECTIVE", "DEFECTIVE", "Pending", categoryTestStringPtr("LPN1"),
			"2026-10-15T12:00:00Z", categoryTestStringPtr("Broken|Broken|Scratched"),
		},
		{
			int64(2), "2026-10-16", "O1", "SKU-A", categoryTestStringPtr("B001"), categoryTestStringPtr("Item A"),
			1, categoryTestStringPtr("FC1"), "DEFECTIVE", "DEFECTIVE", "Pending", categoryTestStringPtr("LPN2"),
			"2026-10-16T12:00:00Z", categoryTestStringPtr("Broken"),
		},
		{
			int64(3), "2026-10-16", "O2", "SKU-B", categoryTestStringPtr("B002"), categoryTestStringPtr("Item B"),
			1, (*string)(nil), "UNWANTED_ITEM", "UNWANTED_ITEM", "Refunded", categoryTestStringPtr("LPN3"),
			"2026-10-16T12:00:00Z", (*string)(nil),
		},
	}}
	salesRows := &categoryTestRows{batches: [][]any{
		{"SKU-A", "2026-10-10", 10, 100.0},
		{"SKU-B", "2026-10-11", 4, 40.0},
	}}
	cycleRows := &categoryTestRows{batches: [][]any{
		{"O1", "SKU-A", "2026-10-10"},
		{"O2", "SKU-B", "2026-10-11"},
	}}
	productCostRows := &categoryTestRows{batches: [][]any{
		{"SKU-A", "Catalog Name A"},
	}}
	mockDB := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"Alpha Project"}},
			fakeRow{values: []any{&now, &now}},
		},
		rowsQueueQuery: []Rows{returnRows, salesRows, cycleRows, productCostRows},
	}
	store := NewReturnAnalysisStore(&fakeWriteDB{fakeDB: mockDB})
	resp, err := store.GetReturnAnalysis(ctx, return_analysis.ReturnAnalysisFilter{
		ProjectID: 1, Country: "US", StartDate: "2026-10-01", EndDate: "2026-10-31",
	})
	if err != nil {
		t.Fatalf("analysis: %v", err)
	}
	if resp.Summary.TotalReturns != 2 || resp.Summary.TotalQuantity != 4 {
		t.Fatalf("summary = %+v", resp.Summary)
	}
	if resp.Summary.TotalSalesQuantity != 14 || resp.Summary.TotalSalesAmount != 140 {
		t.Fatalf("sales summary = %+v", resp.Summary)
	}
	if resp.RankingRows[0].ReturnCount != 1 || resp.RankingRows[0].AvgReturnCycleDays == nil || *resp.RankingRows[0].AvgReturnCycleDays != 5.5 {
		t.Fatalf("ranking = %+v", resp.RankingRows[0])
	}
	if resp.RankingRows[0].ProductName == nil || *resp.RankingRows[0].ProductName != "Catalog Name A" {
		t.Fatalf("catalog product name = %#v", resp.RankingRows[0].ProductName)
	}
	if len(resp.FeedbackRows) != 2 || resp.FeedbackRows[0].CustomerComment != "Broken | Scratched" {
		t.Fatalf("feedback = %+v", resp.FeedbackRows)
	}
	if len(resp.TrendRows) != 2 || resp.TrendRows[0].ReturnCount != 1 || resp.TrendRows[1].ReturnCount != 2 {
		t.Fatalf("trends = %+v", resp.TrendRows)
	}
	if len(resp.FulfillmentCenterRows) != 2 {
		t.Fatalf("fulfillment rows = %+v", resp.FulfillmentCenterRows)
	}
	foundUnknownFC := false
	for _, row := range resp.FulfillmentCenterRows {
		if row.FulfillmentCenterID == "未知仓库" {
			foundUnknownFC = true
		}
	}
	if !foundUnknownFC {
		t.Fatalf("missing unknown fulfillment fallback: %+v", resp.FulfillmentCenterRows)
	}
}

func TestReturnAnalysisSQLPreparesAgainstPostgres(t *testing.T) {
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

	rowConditions := []string{
		"s.project_id = $1", "s.country = $2", "s.report_type = 'return_report'",
		"s.is_current = true", "r.return_date >= $3::date", "r.return_date <= $4::date",
	}
	rawConditions := append(append([]string(nil), rowConditions...), "r.sku = $5")
	salesConditions := []string{
		"so.project_id = $1", "so.country = $2", "so.purchase_date_pt >= $3::date",
		"so.purchase_date_pt <= $4::date", "so.is_counted_sales = true",
		"so.order_status <> 'Cancelled'",
	}
	queries := map[string]string{
		"return_span":  returnAnalysisSpanSQL(),
		"return_rows":  buildReturnAnalysisRowsSQL(rowConditions),
		"return_sales": buildReturnAnalysisSalesSQL(salesConditions, "DE"),
		"return_cycle": returnCycleSalesSQL(),
		"return_skus":  returnSKUProductNamesSQL(),
		"return_raw":   buildReturnRawRowsSQL(rawConditions, 6),
	}
	for name, query := range queries {
		if strings.Contains(query, "coalesce(project_name, )") || strings.Contains(query, "coalesce(sku, )") {
			t.Fatalf("%s contains malformed COALESCE: %s", name, query)
		}
		if _, err := conn.Prepare(ctx, "return_analysis_"+name, query); err != nil {
			t.Fatalf("prepare %s: %v\n%s", name, err, query)
		}
	}
}

func TestReturnAnalysisStoreGetRawRows(t *testing.T) {
	ctx := context.Background()

	rawRows := &fakeRows{
		batches: [][]any{
			{
				"2026-10-15", "2026-10-15T12:00:00Z", "111-222", "SKU-A", categoryTestStringPtr("B001"), categoryTestStringPtr("X001"),
				categoryTestStringPtr("Item A"), 1, categoryTestStringPtr("FC1"), "DEFECTIVE",
				"DEFECTIVE", "Unit returned to inventory", categoryTestStringPtr("LPN1"), categoryTestStringPtr("Broken"),
			},
		},
	}

	mockDB := &fakeDB{
		rows: rawRows,
	}
	store := NewReturnAnalysisStore(&fakeWriteDB{fakeDB: mockDB})

	items, err := store.GetRawRows(ctx, return_analysis.ReturnAnalysisFilter{
		ProjectID: 1,
		Country:   "US",
		StartDate: "2026-10-01",
		EndDate:   "2026-10-31",
	}, 100)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if len(items) != 1 || items[0].SKU != "SKU-A" {
		t.Fatalf("unexpected items: %+v", items)
	}
	if items[0].ReasonDisplay != "有缺陷" || items[0].DispositionDisplay != "有缺陷" || items[0].StatusDisplay != "退回库存" {
		t.Fatalf("translations mismatch: %+v", items[0])
	}
}
