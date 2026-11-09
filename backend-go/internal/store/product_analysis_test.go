package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis"
)

func TestProductAnalysisStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()
	adminStore := NewProductAnalysisStore(&productAnalysisTestDB{
		row: productAnalysisTestRow{values: []any{nil, nil}},
	})
	if err := adminStore.VerifyProjectAccess(ctx, 1, "", true); err != nil {
		t.Fatalf("admin access error = %v", err)
	}

	missingStore := NewProductAnalysisStore(&productAnalysisTestDB{row: productAnalysisTestRow{err: pgx.ErrNoRows}})
	if err := missingStore.VerifyProjectAccess(ctx, 9, "alice", false); !errors.Is(
		err,
		product_analysis.ErrProjectNotFound,
	) {
		t.Fatalf("missing project error = %v", err)
	}
	if err := missingStore.VerifyProjectAccess(ctx, 9, "", true); !errors.Is(
		err,
		product_analysis.ErrProjectNotFound,
	) {
		t.Fatalf("admin missing project error = %v", err)
	}

	projectOperator := "alice"
	assistantOperator := "bob"
	foundDB := &productAnalysisTestDB{row: productAnalysisTestRow{values: []any{
		&projectOperator,
		&assistantOperator,
	}}}
	foundStore := NewProductAnalysisStore(foundDB)
	if err := foundStore.VerifyProjectAccess(ctx, 1, "alice", false); err != nil {
		t.Fatalf("operator access error = %v", err)
	}
	if err := foundStore.VerifyProjectAccess(ctx, 1, "bob", false); err != nil {
		t.Fatalf("assistant access error = %v", err)
	}
	if err := foundStore.VerifyProjectAccess(ctx, 1, "eve", false); !errors.Is(
		err,
		product_analysis.ErrProjectForbidden,
	) {
		t.Fatalf("forbidden operator error = %v", err)
	}
	if err := foundStore.VerifyProjectAccess(ctx, 1, "", false); !errors.Is(
		err,
		product_analysis.ErrProjectForbidden,
	) {
		t.Fatalf("empty operator error = %v", err)
	}
}

func TestProductAnalysisStoreProjectLookups(t *testing.T) {
	ctx := context.Background()
	store := NewProductAnalysisStore(&productAnalysisTestDB{
		rowsQueue: []pgx.Row{
			productAnalysisTestRow{values: []any{int64(7)}},
			productAnalysisTestRow{values: []any{int64(7)}},
		},
	})
	projectID, err := store.ProjectIDByName(ctx, " Project A ")
	if err != nil || projectID != 7 {
		t.Fatalf("ProjectIDByName() = %d, %v", projectID, err)
	}
	sourceProjectID, err := store.SourceProjectID(ctx, 11)
	if err != nil || sourceProjectID != 7 {
		t.Fatalf("SourceProjectID() = %d, %v", sourceProjectID, err)
	}

	missing := NewProductAnalysisStore(&productAnalysisTestDB{
		rowsQueue: []pgx.Row{
			productAnalysisTestRow{err: pgx.ErrNoRows},
			productAnalysisTestRow{err: pgx.ErrNoRows},
		},
	})
	if _, err := missing.ProjectIDByName(ctx, "missing"); !errors.Is(
		err,
		product_analysis.ErrProjectNotFound,
	) {
		t.Fatalf("missing ProjectIDByName error = %v", err)
	}
	if _, err := missing.SourceProjectID(ctx, 99); !errors.Is(err, product_analysis.ErrNotFound) {
		t.Fatalf("missing SourceProjectID error = %v", err)
	}
}

func TestProductAnalysisStoreExposesProductionEngineForFullDB(t *testing.T) {
	store := NewProductAnalysisStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	if store.CalculationEngine() == nil {
		t.Fatal("FullDB-backed ProductAnalysisStore must expose a calculation engine")
	}
}

func TestProductAnalysisListSourcesScopesProjectAndUsesAdTable(t *testing.T) {
	originalFilename := "ad.xlsx"
	createdAt := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	db := &productAnalysisTestDB{
		rowsQueueQuery: []Rows{&productAnalysisTestRows{batches: [][]any{{
			int64(21),
			int64(7),
			time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC),
			time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC),
			time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
			int64(2),
			true,
			nil,
			"upload-21",
			"/safe/ad.xlsx",
			&originalFilename,
			"ad.xlsx",
			"ad.xlsx",
			"2048",
			nil,
			"success",
			nil,
			"alice",
			createdAt,
			createdAt,
		}}}},
	}
	reportType := "ad_product_report"
	store := NewProductAnalysisStore(db)
	items, err := store.ListSources(context.Background(), product_analysis.SourceFilter{
		ProjectIDs:  []int64{7, 9},
		ReportType:  &reportType,
		CurrentOnly: true,
	})
	if err != nil {
		t.Fatalf("ListSources() error = %v", err)
	}
	if len(items) != 1 || items[0].ID != 21 || items[0].ReportType != "ad_product_report" {
		t.Fatalf("items = %#v", items)
	}
	if items[0].FileSizeBytes == nil || *items[0].FileSizeBytes != 2048 {
		t.Fatalf("file size = %#v", items[0].FileSizeBytes)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("queries = %d, want 1 ad-table query", len(db.queryCalls))
	}
	call := db.queryCalls[0]
	if !strings.Contains(call.sql, "from public.ad_upload_files") ||
		!strings.Contains(call.sql, "project_id = any($1)") ||
		!strings.Contains(call.sql, "report_type = 'ad_promoted_product_report'") {
		t.Fatalf("ad source SQL = %s", call.sql)
	}
	if len(call.args) != 1 {
		t.Fatalf("args = %#v", call.args)
	}
	ids, ok := call.args[0].([]int64)
	if !ok || len(ids) != 2 || ids[0] != 7 {
		t.Fatalf("project scope args = %#v", call.args[0])
	}
}

func TestProductAnalysisListSourcesReturnsEmptyForEmptyScope(t *testing.T) {
	store := NewProductAnalysisStore(&productAnalysisTestDB{})
	items, err := store.ListSources(context.Background(), product_analysis.SourceFilter{
		ProjectIDs:  []int64{},
		ProjectID:   nil,
		CurrentOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("items = %#v, want empty", items)
	}
}

func TestProductAnalysisSourceRowsFilterScopeAndPagination(t *testing.T) {
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	reportDate := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	periodStart := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	periodEnd := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	originalFilename := "payment.csv"
	fileSHA := strings.Repeat("a", 64)
	createdBy := "alice"
	transactionAt := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	orderID := "ORDER-1"
	sku := "SKU-1"
	asin := "ASIN-1"
	scopeReason := ""

	db := &productAnalysisTestDB{
		rowsQueue: []pgx.Row{
			productAnalysisTestRow{values: []any{
				int64(12),
				int64(7),
				"payment_report",
				reportDate,
				periodStart,
				periodEnd,
				nil,
				int64(2),
				true,
				nil,
				"upload-12",
				"/safe/payment.csv",
				&originalFilename,
				"payment.csv",
				"payment.csv",
				"payment.csv",
				"1024",
				&fileSHA,
				"success",
				nil,
				int64(2),
				int64(2),
				&createdBy,
				createdAt,
				createdAt,
			}},
		},
		rowsQueueQuery: []Rows{&productAnalysisTestRows{batches: [][]any{
			{
				int64(1),
				transactionAt,
				"Order",
				&orderID,
				&sku,
				&asin,
				int64(2),
				productAnalysisTestNumeric("10.00"),
				productAnalysisTestNumeric("1.00"),
				productAnalysisTestNumeric("0.00"),
				productAnalysisTestNumeric("0.00"),
				productAnalysisTestNumeric("-2.00"),
				productAnalysisTestNumeric("-1.00"),
				productAnalysisTestNumeric("8.00"),
				"included_product",
				&scopeReason,
				[]byte(`{"type":"Order"}`),
			},
			{
				int64(2),
				transactionAt,
				"Order",
				&orderID,
				&sku,
				&asin,
				int64(1),
				productAnalysisTestNumeric("5.00"),
				productAnalysisTestNumeric("0.00"),
				productAnalysisTestNumeric("0.00"),
				productAnalysisTestNumeric("0.00"),
				productAnalysisTestNumeric("-1.00"),
				productAnalysisTestNumeric("-0.50"),
				productAnalysisTestNumeric("3.50"),
				"included_product",
				&scopeReason,
				[]byte(`{"type":"Order","row":2}`),
			},
		}}},
	}
	store := NewProductAnalysisStore(db)
	response, err := store.GetSourceRows(ctx, 12, 1, 1, false)
	if err != nil {
		t.Fatalf("GetSourceRows() error = %v", err)
	}
	if response == nil || response.HasNext != true || len(response.Rows) != 1 {
		t.Fatalf("response = %#v", response)
	}
	if response.Rows[0]["scope_status"] != "included_product" {
		t.Fatalf("row = %#v", response.Rows[0])
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %#v", db.queryCalls)
	}
	rowQuery := db.queryCalls[len(db.queryCalls)-1]
	if !strings.Contains(rowQuery.sql, "from public.analysis_payment_rows") ||
		!strings.Contains(rowQuery.sql, "scope_status = 'included_product'") ||
		!strings.Contains(rowQuery.sql, "offset $2 limit $3") {
		t.Fatalf("payment row SQL = %s", rowQuery.sql)
	}
	if len(rowQuery.args) != 3 || rowQuery.args[1] != int64(0) {
		t.Fatalf("payment args = %#v", rowQuery.args)
	}
}

func TestProductAnalysisPT1DetailsJoinUsesProductCostsAndPagination(t *testing.T) {
	sku := "SKU-1"
	asin := "ASIN-1"
	db := &productAnalysisTestDB{
		rowsQueueQuery: []Rows{&productAnalysisTestRows{batches: [][]any{
			{
				int64(1),
				int64(1),
				&sku,
				&asin,
				int64(4),
				[]byte(`{"SKU":"SKU-1","利润":12.5}`),
			},
			{
				int64(2),
				int64(2),
				&sku,
				&asin,
				int64(5),
				[]byte(`{"SKU":"SKU-1","利润":8.5}`),
			},
		}}},
	}
	store := NewProductAnalysisStore(db)
	details, err := store.ListPT1Details(
		context.Background(),
		product_analysis.PT1CalculationItem{
			ID: 11, ProjectID: 7, ProjectName: "Project A",
			ReportStartDate: "2026-10-26", ReportEndDate: "2026-11-01",
			Version: 1,
		},
		"US",
		1,
		1,
	)
	if err != nil {
		t.Fatalf("ListPT1Details() error = %v", err)
	}
	if details.HasNext != true || len(details.Rows) != 1 {
		t.Fatalf("details = %#v", details)
	}
	call := db.queryCalls[0]
	if !strings.Contains(call.sql, "from public.product_costs pc") ||
		!strings.Contains(call.sql, "pc.is_active = true") ||
		!strings.Contains(call.sql, "lower(coalesce(pc.sku, '')") ||
		!strings.Contains(call.sql, "d.pt1_calculation_id = $3 and d.country = $4") {
		t.Fatalf("details SQL = %s", call.sql)
	}
}

func TestProductAnalysisAvailabilityWeeklyRules(t *testing.T) {
	startDate := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	endDate := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	businessDaily := productAnalysisDateSet{
		"2026-10-26": {},
		"2026-10-27": {},
	}
	adDaily := productAnalysisDateSet{
		"2026-10-26": {},
		"2026-10-27": {},
	}
	inventoryDaily := productAnalysisDateSet{
		"2026-10-26": {},
		"2026-10-27": {},
	}
	businessPeriods := []productAnalysisCoverage{{
		StartDate: "2026-10-26",
		EndDate:   "2026-11-01",
		SourceID:  30,
		CoveredDates: productAnalysisIntersectCoverage(
			startDate,
			endDate,
			startDate,
			endDate,
		),
	}}
	adPeriods := []productAnalysisCoverage{{
		StartDate: "2026-10-26",
		EndDate:   "2026-11-01",
		SourceID:  31,
		CoveredDates: productAnalysisIntersectCoverage(
			startDate,
			endDate,
			startDate,
			endDate,
		),
	}}
	paymentDaily := []productAnalysisPaymentDaily{
		{Date: "2026-10-26", RowCount: 2},
		{Date: "2026-10-28", RowCount: 0},
	}

	check := productAnalysisBuildAvailability(
		startDate,
		endDate,
		businessDaily,
		adDaily,
		inventoryDaily,
		businessPeriods,
		adPeriods,
		paymentDaily,
		nil,
	)
	if len(check.WeeklyAvailability) != 1 {
		t.Fatalf("weekly availability = %#v", check.WeeklyAvailability)
	}
	week := check.WeeklyAvailability[0]
	if !week.CanCalculate || week.PaymentCovered || !week.IsPartial {
		t.Fatalf("week = %#v", week)
	}
	if !week.BusinessPeriodicCovered || !week.ADPeriodicCovered {
		t.Fatalf("periodic coverage flags = %#v", week)
	}
	if len(check.PaymentObjectiveEmptyDates) != 1 ||
		check.PaymentObjectiveEmptyDates[0] != "2026-10-28" {
		t.Fatalf("payment objective empty dates = %#v", check.PaymentObjectiveEmptyDates)
	}
	if check.PaymentFullPeriodCovered {
		t.Fatal("payment should not be fully covered without a positive period/daily row")
	}
	if !check.HasMinimumData {
		t.Fatal("periodic business/ad coverage should make calculation possible")
	}
	if len(check.BusinessPeriodicOnlyMissing) != 5 {
		t.Fatalf("business periodic-only missing = %#v", check.BusinessPeriodicOnlyMissing)
	}
}

func TestProductAnalysisAvailabilityMissingAndFullPayment(t *testing.T) {
	startDate := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	endDate := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	check := productAnalysisBuildAvailability(
		startDate,
		endDate,
		productAnalysisDateSet{},
		productAnalysisDateSet{},
		productAnalysisDateSet{},
		nil,
		nil,
		[]productAnalysisPaymentDaily{
			{Date: "2026-10-26", RowCount: 1},
			{Date: "2026-10-27", RowCount: 1},
		},
		[]productAnalysisCoverage{{
			StartDate: "2026-10-26",
			EndDate:   "2026-10-27",
			SourceID:  40,
			CoveredDates: productAnalysisDateSet{
				"2026-10-26": {},
				"2026-10-27": {},
			},
			RowCount: 1,
		}},
	)
	if len(check.BusinessReportMissing) != 2 || len(check.ADReportMissing) != 2 {
		t.Fatalf("missing arrays = %#v", check)
	}
	if !check.PaymentFullPeriodCovered {
		t.Fatal("payment should be fully covered")
	}
	if check.HasMinimumData {
		t.Fatal("no business/ad source should not be calculable")
	}
	if len(check.PaymentPeriodsOverlapping) != 1 {
		t.Fatalf("payment overlaps = %#v", check.PaymentPeriodsOverlapping)
	}
}

func TestProductAnalysisStoreCheckAvailabilityQueriesRealTables(t *testing.T) {
	startDate := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	endDate := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	db := &productAnalysisTestDB{
		rowsQueueQuery: []Rows{
			&productAnalysisTestRows{batches: [][]any{
				{time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)},
				{time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)},
			}},
			&productAnalysisTestRows{batches: [][]any{
				{time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)},
			}},
			&productAnalysisTestRows{batches: [][]any{
				{time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)},
				{time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)},
			}},
			&productAnalysisTestRows{batches: [][]any{
				{
					time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC),
					time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
					int64(30),
				},
			}},
			&productAnalysisTestRows{batches: [][]any{
				{
					time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC),
					time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
					int64(31),
				},
			}},
			&productAnalysisTestRows{batches: [][]any{
				{time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC), 2},
				{time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC), 1},
			}},
			&productAnalysisTestRows{batches: [][]any{
				{
					time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC),
					time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
					int64(40),
					1,
				},
			}},
		},
	}
	store := NewProductAnalysisStore(db)
	check, err := store.CheckAvailability(
		context.Background(),
		7,
		"US",
		startDate,
		endDate,
	)
	if err != nil {
		t.Fatalf("CheckAvailability() error = %v", err)
	}
	if !check.HasMinimumData || len(check.WeeklyAvailability) != 1 {
		t.Fatalf("availability = %#v", check)
	}
	if len(db.queryCalls) != 7 {
		t.Fatalf("query count = %d, want 7", len(db.queryCalls))
	}
	requiredTables := []string{
		"from public.analysis_source_files",
		"from public.analysis_source_files",
		"from public.ad_upload_files f",
		"from public.analysis_source_files",
		"from public.ad_upload_files f",
		"from public.analysis_source_files",
		"from public.analysis_source_files",
	}
	for index, call := range db.queryCalls {
		if !strings.Contains(call.sql, requiredTables[index]) {
			t.Fatalf("query[%d] SQL = %s", index, call.sql)
		}
		if !strings.Contains(call.sql, "project_id = $1") {
			t.Fatalf("query[%d] missing project scope: %s", index, call.sql)
		}
		if len(call.args) == 0 || call.args[0] != int64(7) {
			t.Fatalf("query[%d] args = %#v", index, call.args)
		}
	}
}

func TestProductAnalysisOverviewMatchesProductionFormula(t *testing.T) {
	startDate := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	endDate := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	payload := productAnalysisBuildOverview(
		startDate,
		endDate,
		[]productAnalysisCost{{
			SKU: "SKU-1", ASIN: "ASIN-1", FOB: 1, FirstLeg: 0.2,
		}},
		map[string]productAnalysisBusinessTotals{
			"ASIN-1": {
				PageViews: 100, UnitsOrdered: 10, Sessions: 80, SalesAmount: 200,
			},
		},
		map[string]productAnalysisADTotals{
			"SKU-1": {
				Impressions: 1000, Clicks: 50, Orders: 2, Spend: 20, Sales: 80,
			},
		},
		map[string]productAnalysisPaymentTotals{
			"SKU-1": {
				ActualSalesUnits: 8, ActualSales: 160,
				ActualRefundUnits: 1, ActualRefund: 20,
				Commission: 16, FBAFees: 8,
			},
		},
	)
	if payload.RowCount != 1 || len(payload.Details) != 1 {
		t.Fatalf("payload row count = %d, details=%d", payload.RowCount, len(payload.Details))
	}
	detail := payload.Details[0]
	want := map[string]float64{
		"总转化":    0.1,
		"广告点击率":  0.05,
		"广告单占比":  0.2,
		"广告转化率":  0.04,
		"CPC":    0.4,
		"ACOS":   0.25,
		"SP占比":   0.1,
		"自然流量占比": 0.5,
		"自然单转化":  0.16,
		"产品FOB":  8,
		"销售头程":   1.6,
		"总成本":    33.6,
		"利润":     86.4,
		"平均售价":   20,
		"退款率":    0.125,
	}
	for key, expected := range want {
		actual := productAnalysisAnyFloat(detail[key])
		if math.Abs(actual-expected) > 1e-9 {
			t.Fatalf("%s = %v, want %v; detail=%#v", key, actual, expected, detail)
		}
	}
	if detail["日期"] != "20261026-1101" ||
		detail["SKU"] != "SKU-1" ||
		detail["ASIN"] != "ASIN-1" {
		t.Fatalf("identity fields = %#v", detail)
	}
	if payload.Summary["SKU"] != "汇总" ||
		productAnalysisAnyFloat(payload.Summary["总成本"]) != 33.6 ||
		productAnalysisAnyFloat(payload.Summary["利润"]) != 86.4 {
		t.Fatalf("summary = %#v", payload.Summary)
	}
}

func TestProductAnalysisCalculationEngineRejectsUnsafeFiles(t *testing.T) {
	root := t.TempDir()
	reportDir := filepath.Join(root, reportTempDirectory)
	if err := os.MkdirAll(reportDir, 0o700); err != nil {
		t.Fatal(err)
	}
	validPath := filepath.Join(reportDir, "valid.csv")
	if err := os.WriteFile(validPath, []byte("a,b\n1,2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	outsidePath := filepath.Join(t.TempDir(), "outside.csv")
	if err := os.WriteFile(outsidePath, []byte("a,b\n1,2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(reportDir, "link.csv")
	if err := os.Symlink(outsidePath, symlinkPath); err != nil {
		t.Fatal(err)
	}

	engine := &productAnalysisCalculationEngine{uploadRoot: root}
	resolved, err := engine.resolveTempFile("valid.csv", false)
	canonicalValid, canonicalErr := filepath.EvalSymlinks(validPath)
	if canonicalErr != nil {
		t.Fatal(canonicalErr)
	}
	if err != nil || resolved != canonicalValid {
		t.Fatalf("valid temp file = %q, %v", resolved, err)
	}
	for _, tempID := range []string{"../valid.csv", "folder/valid.csv", "link.csv"} {
		if _, err := engine.resolveTempFile(tempID, false); err == nil {
			t.Fatalf("temp id %q should be rejected", tempID)
		}
	}
	if _, err := engine.resolveSourceFile(validPath); err != nil {
		t.Fatalf("controlled source path error = %v", err)
	}
	if _, err := engine.resolveSourceFile(outsidePath); err == nil {
		t.Fatal("source path outside upload root should be rejected")
	}
	if _, err := engine.resolveSourceFile(symlinkPath); err == nil {
		t.Fatal("source symlink should be rejected")
	}
}

func TestProductAnalysisLocalizedNumbersMatchReportLocales(t *testing.T) {
	tests := []struct {
		raw    string
		german bool
		want   float64
	}{
		{raw: "US$1,234.56", want: 1234.56},
		{raw: "1.234,56 €", german: true, want: 1234.56},
		{raw: "(42.50)", want: -42.5},
		{raw: "1.234,50 €", german: true, want: 1234.5},
	}
	for _, test := range tests {
		got := productAnalysisParseLocalizedNumber(test.raw, test.german)
		if math.Abs(got-test.want) > 1e-9 {
			t.Fatalf("parse %q german=%v = %v, want %v", test.raw, test.german, got, test.want)
		}
	}
}

type productAnalysisTestQueryCall struct {
	sql  string
	args []any
}

type productAnalysisTestDB struct {
	row            pgx.Row
	rows           Rows
	rowsQueue      []pgx.Row
	rowsQueueQuery []Rows
	queryCalls     []productAnalysisTestQueryCall
	queryRowCalls  []productAnalysisTestQueryCall
	pingErr        error
}

func (db *productAnalysisTestDB) Query(
	_ context.Context,
	sql string,
	args ...any,
) (Rows, error) {
	db.queryCalls = append(db.queryCalls, productAnalysisTestQueryCall{sql: sql, args: args})
	if len(db.rowsQueueQuery) > 0 {
		next := db.rowsQueueQuery[0]
		db.rowsQueueQuery = db.rowsQueueQuery[1:]
		return next, nil
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &productAnalysisTestRows{}, nil
}

func (db *productAnalysisTestDB) QueryRow(
	_ context.Context,
	sql string,
	args ...any,
) pgx.Row {
	db.queryRowCalls = append(db.queryRowCalls, productAnalysisTestQueryCall{sql: sql, args: args})
	if len(db.rowsQueue) > 0 {
		next := db.rowsQueue[0]
		db.rowsQueue = db.rowsQueue[1:]
		return next
	}
	if db.row != nil {
		return db.row
	}
	return productAnalysisTestRow{err: pgx.ErrNoRows}
}

func (*productAnalysisTestDB) Ping(context.Context) error {
	return nil
}

type productAnalysisTestRow struct {
	values []any
	err    error
}

func (row productAnalysisTestRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	return productAnalysisTestScanValues(dest, row.values)
}

type productAnalysisTestRows struct {
	batches [][]any
	index   int
	err     error
}

func (rows *productAnalysisTestRows) Next() bool {
	if rows.index >= len(rows.batches) {
		return false
	}
	rows.index++
	return true
}

func (rows *productAnalysisTestRows) Scan(dest ...any) error {
	if rows.index == 0 || rows.index > len(rows.batches) {
		return errors.New("scan called outside row")
	}
	return productAnalysisTestScanValues(dest, rows.batches[rows.index-1])
}

func (rows *productAnalysisTestRows) Err() error { return rows.err }
func (*productAnalysisTestRows) Close()          {}

func productAnalysisTestScanValues(dest, values []any) error {
	if len(dest) != len(values) {
		return fmt.Errorf("scan destination count mismatch: dest=%d values=%d", len(dest), len(values))
	}
	for index, target := range dest {
		value := values[index]
		switch typed := target.(type) {
		case *int:
			switch number := value.(type) {
			case int:
				*typed = number
			case int64:
				*typed = int(number)
			default:
				return fmt.Errorf("value %d is %T, want int", index, value)
			}
		case *int64:
			switch number := value.(type) {
			case int64:
				*typed = number
			case int:
				*typed = int64(number)
			default:
				return fmt.Errorf("value %d is %T, want int64", index, value)
			}
		case *string:
			text, ok := value.(string)
			if !ok {
				return fmt.Errorf("value %d is %T, want string", index, value)
			}
			*typed = text
		case *bool:
			boolean, ok := value.(bool)
			if !ok {
				return fmt.Errorf("value %d is %T, want bool", index, value)
			}
			*typed = boolean
		case **string:
			if value == nil {
				*typed = nil
				continue
			}
			switch text := value.(type) {
			case string:
				*typed = &text
			case *string:
				*typed = text
			default:
				return fmt.Errorf("value %d is %T, want string pointer", index, value)
			}
		case *time.Time:
			if value == nil {
				*typed = time.Time{}
				continue
			}
			switch timestamp := value.(type) {
			case time.Time:
				*typed = timestamp
			case *time.Time:
				*typed = *timestamp
			default:
				return fmt.Errorf("value %d is %T, want time.Time", index, value)
			}
		case **time.Time:
			if value == nil {
				*typed = nil
				continue
			}
			switch timestamp := value.(type) {
			case time.Time:
				*typed = &timestamp
			case *time.Time:
				*typed = timestamp
			default:
				return fmt.Errorf("value %d is %T, want time.Time pointer", index, value)
			}
		case *pgtype.Numeric:
			number, ok := value.(pgtype.Numeric)
			if !ok {
				return fmt.Errorf("value %d is %T, want pgtype.Numeric", index, value)
			}
			*typed = number
		case *[]byte:
			if value == nil {
				*typed = nil
				continue
			}
			content, ok := value.([]byte)
			if !ok {
				return fmt.Errorf("value %d is %T, want []byte", index, value)
			}
			*typed = content
		default:
			return fmt.Errorf("unsupported scan destination %T", target)
		}
	}
	return nil
}

func productAnalysisTestNumeric(raw string) pgtype.Numeric {
	var number pgtype.Numeric
	if err := number.Scan(raw); err != nil {
		panic(err)
	}
	return number
}

func TestProductAnalysisCalculationEngineBLFTestRollback(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("GO_API_TEST_DATABASE_URL is not set")
	}
	if !strings.Contains(databaseURL, "BLF_test") {
		t.Fatalf("refusing to run rollback test outside BLF_test: %s", databaseURL)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect BLF_test: %v", err)
	}
	defer pool.Close()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin rollback transaction: %v", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	projectName := fmt.Sprintf("stage8d-calc-rollback-%d", time.Now().UnixNano())
	var projectID int64
	if err := tx.QueryRow(
		ctx,
		`insert into public.projects (project_name, sort_order, project_operator, country)
		 values ($1, 1, 'stage8d-operator', 'US')
		 returning id`,
		projectName,
	).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	if _, err := tx.Exec(
		ctx,
		`insert into public.product_costs (
		   project_id, project_name, sku, asin, fob_unit_cost,
		   first_leg_cost_rmb, country, is_active, sort_order
		 ) values ($1, $2, 'SKU-1', 'ASIN-1', 7, 1.4, 'US', true, 1)`,
		projectID,
		projectName,
	); err != nil {
		t.Fatalf("insert product cost: %v", err)
	}
	if _, err := tx.Exec(
		ctx,
		`insert into public.exchange_rates (currency, year_month, rate)
		 values ('USD', '2026-10', 7)`,
	); err != nil {
		t.Fatalf("insert exchange rate: %v", err)
	}

	var businessSourceID int64
	if err := tx.QueryRow(
		ctx,
		`insert into public.analysis_source_files (
		   project_id, report_type, country, report_date, period_start_date,
		   period_end_date, version, is_current, upload_file_id,
		   upload_file_path, stored_filename, logical_filename, storage_key,
		   ingestion_status, row_count_total, row_count_included
		 ) values (
		   $1, 'business_report', 'US', null, '2026-10-26'::date,
		   '2026-11-01'::date, 1, true, 'business-source',
		   '/tmp/business.csv', 'business.csv', 'business.csv', 'business.csv',
		   'success', 1, 1
		 ) returning id`,
		projectID,
	).Scan(&businessSourceID); err != nil {
		t.Fatalf("insert business source: %v", err)
	}
	if _, err := tx.Exec(
		ctx,
		`insert into public.analysis_business_rows (
		   source_file_id, source_row_no, asin, page_views, units_ordered,
		   sessions, ordered_sales_amount, raw_row
		 ) values ($1, 1, 'ASIN-1', 100, 10, 80, 200, '{}'::json)`,
		businessSourceID,
	); err != nil {
		t.Fatalf("insert business row: %v", err)
	}

	var paymentSourceID int64
	if err := tx.QueryRow(
		ctx,
		`insert into public.analysis_source_files (
		   project_id, report_type, country, report_date, period_start_date,
		   period_end_date, version, is_current, upload_file_id,
		   upload_file_path, stored_filename, logical_filename, storage_key,
		   ingestion_status, row_count_total, row_count_included
		 ) values (
		   $1, 'payment_report', 'US', null, '2026-10-26'::date,
		   '2026-11-01'::date, 1, true, 'payment-source',
		   '/tmp/payment.csv', 'payment.csv', 'payment.csv', 'payment.csv',
		   'success', 2, 2
		 ) returning id`,
		projectID,
	).Scan(&paymentSourceID); err != nil {
		t.Fatalf("insert payment source: %v", err)
	}
	paymentRows := []struct {
		rowNo       int
		txType      string
		quantity    int
		product     float64
		shipping    float64
		promotional float64
		other       float64
		sellingFees float64
		fbaFees     float64
	}{
		{1, "Order", 8, 150, 5, 5, 0, -16, -8},
		{2, "Refund", -1, -20, 0, 0, 0, 0, 0},
	}
	for _, row := range paymentRows {
		if _, err := tx.Exec(
			ctx,
			`insert into public.analysis_payment_rows (
			   source_file_id, source_row_no, transaction_type, sku, asin,
			   quantity, product_sales, shipping_credits, promotional_rebates,
			   other_amount, selling_fees, fba_fees, total_amount,
			   scope_status, raw_row
			 ) values (
			   $1, $2, $3, 'SKU-1', 'ASIN-1', $4, $5, $6, $7, $8, $9,
			   $10, 0, 'included_product', '{}'::json
			 )`,
			paymentSourceID,
			row.rowNo,
			row.txType,
			row.quantity,
			row.product,
			row.shipping,
			row.promotional,
			row.other,
			row.sellingFees,
			row.fbaFees,
		); err != nil {
			t.Fatalf("insert payment row %d: %v", row.rowNo, err)
		}
	}

	var adSourceID int64
	if err := tx.QueryRow(
		ctx,
		`insert into public.ad_upload_files (
		   project_id, project_name, report_type, report_label, country,
		   period_start_date, period_end_date, version, is_current,
		   upload_file_id, upload_file_path, stored_filename,
		   logical_filename, file_extension, recognition_status,
		   ingestion_status, matched_columns, warnings, recognition_payload
		 ) values (
		   $1, $2, 'ad_promoted_product_report', 'rollback-ad', 'US',
		   '2026-10-26'::date, '2026-11-01'::date, 1, true,
		   'ad-source', '/tmp/ad.xlsx', 'ad.xlsx', 'ad.xlsx', '.xlsx',
		   'recognized', 'saved', '[]'::json, '[]'::json, '{}'::json
		 ) returning id`,
		projectID,
		projectName,
	).Scan(&adSourceID); err != nil {
		t.Fatalf("insert ad source: %v", err)
	}
	if _, err := tx.Exec(
		ctx,
		`insert into public.ad_upload_promoted_product_rows (
		   source_file_id, source_row_no, report_start_date, report_end_date,
		   ad_sku, ad_asin, impressions, clicks, orders_7d, spend, sales_7d,
		   scope_status, raw_row
		 ) values (
		   $1, 1, '2026-10-26'::date, '2026-11-01'::date,
		   'SKU-1', 'ASIN-1', 1000, 50, 2, 20, 80,
		   'included_product', '{}'::json
		 )`,
		adSourceID,
	); err != nil {
		t.Fatalf("insert ad row: %v", err)
	}

	uploadRoot := t.TempDir()
	reportTempDir := filepath.Join(uploadRoot, reportTempDirectory)
	adTempDir := filepath.Join(uploadRoot, "_ad_upload_tmp")
	if err := os.MkdirAll(reportTempDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(adTempDir, 0o700); err != nil {
		t.Fatal(err)
	}
	businessCSV := "（子）ASIN,页面浏览量 - 总计,已订购商品数量,会话数 - 总计,已订购商品销售额\n" +
		"ASIN-1,100,10,80,$200.00\n"
	if err := os.WriteFile(
		filepath.Join(reportTempDir, "business.csv"),
		[]byte(businessCSV),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	paymentCSV := "date/time,settlement id,type,order id,sku,quantity,product sales,shipping credits,promotional rebates,other,selling fees,fba fees\n" +
		"2026-10-27,1,Order,ORDER-1,SKU-1,8,150,5,5,0,-16,-8\n" +
		"2026-10-28,2,Refund,ORDER-1,SKU-1,-1,-20,0,0,0,0,0\n"
	if err := os.WriteFile(
		filepath.Join(reportTempDir, "payment.csv"),
		[]byte(paymentCSV),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	adXLSX, err := buildSimpleXLSXSheet("推广的商品", [][]string{
		{
			"开始日期", "结束日期", "广告活动名称", "广告组名称", "广告SKU",
			"广告ASIN", "展示量", "点击量", "花费", "7天总销售额",
			"7天总订单数(#)", "7天总销售量(#)",
		},
		{
			"2026-10-26", "2026-11-01", "Campaign", "Ad group", "SKU-1",
			"ASIN-1", "1000", "50", "20", "80", "2", "2",
		},
	})
	if err != nil {
		t.Fatalf("build ad xlsx: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(adTempDir, "ad.xlsx"),
		adXLSX,
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	engine := NewProductAnalysisCalculationEngine(NewTxDB(tx), uploadRoot)
	preview, err := engine.Preview(
		ctx,
		product_analysis.PreviewRequest{
			ProjectID:          projectID,
			Country:            "US",
			StartDate:          "2026-10-26",
			EndDate:            "2026-11-01",
			BusinessTempFileID: stringPointer("business.csv"),
			PaymentTempFileID:  stringPointer("payment.csv"),
			ADTempFileID:       stringPointer("ad.xlsx"),
		},
		product_analysis.Principal{Operator: "stage8d-operator", IsAdmin: true},
	)
	if err != nil {
		t.Fatalf("calculation Preview(): %v", err)
	}
	if preview.TotalPeriods != 1 ||
		preview.Periods[0].Persisted ||
		productAnalysisAnyFloat(preview.Periods[0].Summary["利润"]) != 86.4 {
		t.Fatalf("preview = %#v", preview)
	}

	uploadResult, err := engine.UploadSources(
		ctx,
		product_analysis.UploadSourcesRequest{
			ProjectName:     projectName,
			Country:         "US",
			ReportStartDate: "2026-10-26",
			ReportEndDate:   "2026-11-01",
			FileIDs: map[string]string{
				"business_report":   "business.csv",
				"payment_report":    "payment.csv",
				"ad_product_report": "ad.xlsx",
			},
			ResolvedFilePaths: map[string]string{
				"business_report":   filepath.Join(reportTempDir, "business.csv"),
				"payment_report":    filepath.Join(reportTempDir, "payment.csv"),
				"ad_product_report": filepath.Join(adTempDir, "ad.xlsx"),
			},
		},
		product_analysis.Principal{Operator: "stage8d-operator", IsAdmin: true},
	)
	if err != nil {
		t.Fatalf("UploadSources(): %v", err)
	}
	if len(uploadResult.Outcomes) != 3 {
		t.Fatalf("upload outcomes = %#v", uploadResult.Outcomes)
	}
	for _, outcome := range uploadResult.Outcomes {
		if !outcome.Success || outcome.SourceID == nil {
			t.Fatalf("upload outcome failed = %#v", outcome)
		}
	}
	outsideSource := filepath.Join(t.TempDir(), "outside.csv")
	if err := os.WriteFile(outsideSource, []byte(businessCSV), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = engine.UploadSources(
		ctx,
		product_analysis.UploadSourcesRequest{
			ProjectName:     projectName,
			Country:         "US",
			ReportStartDate: "2026-10-26",
			ReportEndDate:   "2026-11-01",
			FileIDs:         map[string]string{"business_report": "outside.csv"},
			ResolvedFilePaths: map[string]string{
				"business_report": outsideSource,
			},
		},
		product_analysis.Principal{Operator: "stage8d-operator", IsAdmin: true},
	)
	var statusErr *product_analysis.StatusError
	if !errors.As(err, &statusErr) || statusErr.Status != 400 {
		t.Fatalf("outside upload root error = %v, want 400", err)
	}

	result, err := engine.Run(
		ctx,
		product_analysis.RunRequest{
			ProjectID:   projectID,
			Country:     "US",
			StartDate:   "2026-10-26",
			EndDate:     "2026-11-01",
			CurrentOnly: true,
		},
		product_analysis.Principal{Operator: "stage8d-operator", IsAdmin: true},
	)
	if err != nil {
		t.Fatalf("calculation Run(): %v", err)
	}
	if result.TotalPeriods != 1 || len(result.Periods) != 1 || !result.Periods[0].Persisted {
		t.Fatalf("result = %#v", result)
	}
	summary := result.Periods[0].Summary
	if productAnalysisAnyFloat(summary["利润"]) != 86.4 ||
		productAnalysisAnyFloat(summary["总成本"]) != 33.6 ||
		productAnalysisAnyFloat(summary["实际销售额"]) != 160 {
		t.Fatalf("summary = %#v", summary)
	}
	recomputeResult, err := engine.RecomputeWeekly(
		ctx,
		product_analysis.WeeklyRecomputeRequest{
			ProjectID:   projectID,
			Country:     "US",
			StartDate:   stringPointer("2026-10-26"),
			EndDate:     stringPointer("2026-11-01"),
			CurrentOnly: true,
		},
		product_analysis.Principal{Operator: "stage8d-operator", IsAdmin: true},
	)
	if err != nil {
		t.Fatalf("RecomputeWeekly(): %v", err)
	}
	if recomputeResult.Recomputed != 1 ||
		len(recomputeResult.Periods) != 1 ||
		recomputeResult.Periods[0].Version != 2 {
		t.Fatalf("weekly recompute = %#v", recomputeResult)
	}
	triggerResult, err := engine.TriggerRecompute(
		ctx,
		product_analysis.TriggerRecomputeRequest{
			ProjectID:       projectID,
			Country:         "US",
			PeriodStartDate: "2026-10-26",
			PeriodEndDate:   "2026-11-01",
		},
		product_analysis.Principal{Operator: "stage8d-operator", IsAdmin: true},
	)
	if err != nil {
		t.Fatalf("TriggerRecompute(): %v", err)
	}
	if productAnalysisAnyFloat(triggerResult["version"]) != 3 {
		t.Fatalf("trigger result = %#v", triggerResult)
	}
	var pt1Count, detailCount int
	if err := tx.QueryRow(
		ctx,
		`select count(*) from public.analysis_pt1_calculation where project_id = $1`,
		projectID,
	).Scan(&pt1Count); err != nil {
		t.Fatalf("count PT1: %v", err)
	}
	if err := tx.QueryRow(
		ctx,
		`select count(*)
		 from public.analysis_pt_sku_details d
		 join public.analysis_pt1_calculation p on p.id = d.pt1_calculation_id
		 where p.project_id = $1`,
		projectID,
	).Scan(&detailCount); err != nil {
		t.Fatalf("count details: %v", err)
	}
	if pt1Count != 3 || detailCount != 3 {
		t.Fatalf("persisted counts = pt1:%d details:%d", pt1Count, detailCount)
	}

	if _, err := tx.Exec(
		ctx,
		`delete from public.analysis_pt1_calculation where project_id = $1`,
		projectID,
	); err != nil {
		t.Fatalf("clear successful PT1: %v", err)
	}
	failingEngine := NewProductAnalysisCalculationEngine(
		&productAnalysisFailDetailDB{FullDB: NewTxDB(tx)},
		t.TempDir(),
	)
	if _, err := failingEngine.Run(
		ctx,
		product_analysis.RunRequest{
			ProjectID:   projectID,
			Country:     "US",
			StartDate:   "2026-10-26",
			EndDate:     "2026-11-01",
			CurrentOnly: true,
		},
		product_analysis.Principal{Operator: "stage8d-operator", IsAdmin: true},
	); err == nil {
		t.Fatal("forced detail insert failure should fail the calculation")
	}
	if err := tx.QueryRow(
		ctx,
		`select count(*) from public.analysis_pt1_calculation where project_id = $1`,
		projectID,
	).Scan(&pt1Count); err != nil {
		t.Fatalf("count PT1 after forced failure: %v", err)
	}
	if pt1Count != 0 {
		t.Fatalf("failed calculation left %d PT1 rows behind", pt1Count)
	}

	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("outer rollback: %v", err)
	}
	if err := pool.QueryRow(
		ctx,
		`select count(*) from public.projects where id = $1`,
		projectID,
	).Scan(&pt1Count); err != nil {
		t.Fatalf("count rolled-back project: %v", err)
	}
	if pt1Count != 0 {
		t.Fatalf("outer rollback left %d project rows", pt1Count)
	}
}

type productAnalysisFailDetailDB struct {
	FullDB
}

func (db *productAnalysisFailDetailDB) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := db.FullDB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &productAnalysisFailDetailTx{Tx: tx}, nil
}

type productAnalysisFailDetailTx struct {
	pgx.Tx
}

func (tx *productAnalysisFailDetailTx) Exec(
	ctx context.Context,
	sql string,
	args ...any,
) (pgconn.CommandTag, error) {
	if strings.Contains(
		strings.ToLower(sql),
		"insert into public.analysis_pt_sku_details",
	) {
		return pgconn.CommandTag{}, errors.New("forced detail insert failure")
	}
	return tx.Tx.Exec(ctx, sql, args...)
}
