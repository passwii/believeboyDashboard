package store

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation"
)

func TestPricingCalculationStoreUsesLatestExchangeRateForCurrency(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: []any{numericFromString("7.12345678"), "2026-10"}},
	}}
	value, month, err := NewPricingCalculationStore(db).GetLatestExchangeRate(context.Background(), "EUR")
	if err != nil {
		t.Fatalf("GetLatestExchangeRate() error = %v", err)
	}
	if value != 7.12345678 || month != "2026-10" {
		t.Fatalf("rate = %v, %q, want 7.12345678, 2026-10", value, month)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "from public.exchange_rates") ||
		!strings.Contains(query, "order by year_month desc, id desc") ||
		!strings.Contains(query, "limit 1") {
		t.Fatalf("rate SQL = %s, want latest rate ordered by month and id", query)
	}
	if !assertWriteArgsEqual(db.queryRowCalls[0].args, []any{"EUR"}) {
		t.Fatalf("rate args = %#v, want EUR", db.queryRowCalls[0].args)
	}
}

func TestPricingCalculationStoreReturnsMissingRateSentinel(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}}
	_, _, err := NewPricingCalculationStore(db).GetLatestExchangeRate(context.Background(), "USD")
	if !errors.Is(err, pricing_calculation.ErrExchangeRateNotFound) {
		t.Fatalf("GetLatestExchangeRate() error = %v, want ErrExchangeRateNotFound", err)
	}
}

func TestPricingCalculationStoreReadsHistoricalShippingSummary(t *testing.T) {
	value := numericFromString("8.125")
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: []any{value}}}}
	got, err := NewPricingCalculationStore(db).GetHistoricalShippingCost(context.Background(), 19, "SKU-19")
	if err != nil {
		t.Fatalf("GetHistoricalShippingCost() error = %v", err)
	}
	if got == nil || *got != 8.125 {
		t.Fatalf("historical cost = %v, want 8.125", got)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "public.shipment_sku_summaries") ||
		!strings.Contains(query, "average_logistics_unit_price") ||
		!strings.Contains(query, "project_id = $1") ||
		!strings.Contains(query, "sku = $2") {
		t.Fatalf("historical shipping SQL = %s, want project and SKU summary lookup", query)
	}
	if !assertWriteArgsEqual(db.queryRowCalls[0].args, []any{int64(19), "SKU-19"}) {
		t.Fatalf("historical shipping args = %#v", db.queryRowCalls[0].args)
	}
}

func TestPricingCalculationStoreVerifiesProjectOperatorAndAssistant(t *testing.T) {
	tests := []struct {
		name      string
		projectOp string
		assistant string
		operator  string
		wantErr   error
	}{
		{name: "operator", projectOp: "alice, bob", operator: "bob"},
		{name: "assistant", assistant: "assistant-one", operator: "assistant-one"},
		{name: "unassigned", projectOp: "alice", assistant: "assistant-one", operator: "mallory", wantErr: pricing_calculation.ErrProjectForbidden},
		{name: "empty operator", projectOp: "alice", operator: "", wantErr: pricing_calculation.ErrProjectForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: []any{
				pgtype.Text{String: tt.projectOp, Valid: tt.projectOp != ""},
				pgtype.Text{String: tt.assistant, Valid: tt.assistant != ""},
			}}}}
			err := NewPricingCalculationStore(db).VerifyProjectAccess(context.Background(), 7, tt.operator, false)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("VerifyProjectAccess() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestPricingCalculationStoreCreatePersistsRunFields(t *testing.T) {
	db := &fakeWriteDB{
		fakeDB: &fakeDB{row: pricingRunFakeRow{}},
	}
	item := pricing_calculation.RunItem{
		Country: "US", ProductName: "Persisted product", CalculationType: "profit_calc",
		PackageLengthCM: 10, PackageWidthCM: 10, PackageHeightCM: 10, WeightKG: 0.5,
		FOBProductCostRMB: 20, FirstLegCostRMB: 5, SalePriceUSD: 20,
		CommissionRate: 0.15, AdvertisingRate: 0.12, ReturnLossRate: 0.04,
		StorageMonths: 1, InboundPlacementMode: "single_destination",
		USDToRMBRate: 7.2, USDToRMBRateSource: "manual",
		SizeTier: "large_standard", SizeTierLabel: "大号标准尺寸",
		PriceBand: "between_10_50", PriceBandLabel: "售价 $10 ~ $50",
		Dimensions: pricing_calculation.PricingCalculationDimensions{LongestSideIn: 3.937},
		Weights:    pricing_calculation.PricingCalculationWeights{ChargeableWeightRule: "商品重量与体积重量取大值"},
		Fees:       pricing_calculation.PricingCalculationFees{TotalFeeUSD: 11.75},
		Profit:     pricing_calculation.PricingCalculationProfit{ProfitUSD: 4.78, ProfitRate: 0.239},
		Warnings:   []string{"warning"},
	}
	created, err := NewPricingCalculationStore(db).CreateRun(context.Background(), item)
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if created.ID != 42 {
		t.Fatalf("created id = %d, want 42", created.ID)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "insert into public.pricing_calculation_runs") ||
		!strings.Contains(query, "returning") {
		t.Fatalf("create SQL = %s, want INSERT RETURNING", query)
	}
	args := db.queryRowCalls[0].args
	if len(args) != 62 {
		t.Fatalf("create args count = %d, want 62", len(args))
	}
	assertSQLPlaceholderCount(t, db.queryRowCalls[0].sql, len(args))
	if args[1] != item.ProductName || args[0] != item.Country {
		t.Fatalf("create args = %#v, want country and product fields", args)
	}
}

func TestPricingCalculationStoreListFiltersCreatedByAndSearch(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row:            fakeRow{values: []any{int(2)}},
		rowsQueueQuery: []Rows{&fakeRows{batches: [][]any{}}},
	}}
	filter := pricing_calculation.RunListFilter{
		Page: 2, PageSize: 10, ExcludeProjectID: true, Country: "US", Keyword: "bottle",
		Operator: "alice", IsAdmin: false,
	}
	rows, total, err := NewPricingCalculationStore(db).ListRuns(context.Background(), filter)
	if err != nil {
		t.Fatalf("ListRuns() error = %v", err)
	}
	if len(rows) != 0 || total != 2 {
		t.Fatalf("ListRuns() = %d rows, total %d; want empty rows and total 2", len(rows), total)
	}
	if len(db.queryRowCalls) != 1 || len(db.queryCalls) != 1 {
		t.Fatalf("query counts = %d/%d, want count and items queries", len(db.queryRowCalls), len(db.queryCalls))
	}
	for _, query := range []string{db.queryRowCalls[0].sql, db.queryCalls[0].sql} {
		lower := strings.ToLower(query)
		for _, fragment := range []string{"created_by", "project_id is null", "ilike", "country"} {
			if !strings.Contains(lower, fragment) {
				t.Errorf("list SQL missing %q: %s", fragment, lower)
			}
		}
	}
	if db.queryCalls[0].args[len(db.queryCalls[0].args)-2] != 10 ||
		db.queryCalls[0].args[len(db.queryCalls[0].args)-1] != 10 {
		t.Fatalf("page args = %#v, want offset 10 and limit 10", db.queryCalls[0].args)
	}
}

func TestPricingCalculationStoreDeleteUsesRunID(t *testing.T) {
	db := &fakeWriteDB{
		fakeDB:  &fakeDB{},
		execTag: pgconn.NewCommandTag("DELETE 1"),
	}
	deleted, err := NewPricingCalculationStore(db).DeleteRun(context.Background(), 42)
	if err != nil || !deleted {
		t.Fatalf("DeleteRun() = %v, %v, want true, nil", deleted, err)
	}
	if len(db.execCalls) != 1 || !strings.Contains(strings.ToLower(db.execCalls[0].sql), "delete from public.pricing_calculation_runs") {
		t.Fatalf("DELETE calls = %#v", db.execCalls)
	}
	if !assertWriteArgsEqual(db.execCalls[0].args, []any{int64(42)}) {
		t.Fatalf("DELETE args = %#v, want run id 42", db.execCalls[0].args)
	}
}

type pricingRunFakeRow struct{}

func assertSQLPlaceholderCount(t *testing.T, query string, want int) {
	t.Helper()
	placeholderPattern := regexp.MustCompile(`\$(\d+)`)
	matches := placeholderPattern.FindAllStringSubmatch(query, -1)
	seen := make(map[int]bool, len(matches))
	maximum := 0
	for _, match := range matches {
		index, err := strconv.Atoi(match[1])
		if err != nil {
			t.Fatalf("invalid SQL placeholder %q: %v", match[0], err)
		}
		seen[index] = true
		if index > maximum {
			maximum = index
		}
	}
	if len(seen) != want || maximum != want {
		t.Fatalf("SQL placeholders have %d unique entries up to $%d, want $1 through $%d", len(seen), maximum, want)
	}
	for index := 1; index <= want; index++ {
		if !seen[index] {
			t.Fatalf("SQL is missing placeholder $%d", index)
		}
	}
}

func (pricingRunFakeRow) Scan(dest ...any) error {
	for _, target := range dest {
		switch value := target.(type) {
		case *int64:
			*value = 42
		case *int:
			*value = 1
		case *float64:
			*value = 1
		case *string:
			*value = "persisted"
		case *pgtype.Text:
			*value = pgtype.Text{String: "persisted", Valid: true}
		case *pgtype.Int8:
			*value = pgtype.Int8{Int64: 7, Valid: true}
		case *pgtype.Float8:
			*value = pgtype.Float8{Float64: 1, Valid: true}
		case *[]byte:
			*value = []byte("[]")
		case *time.Time:
			*value = time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
		default:
			return errors.New("unexpected pricing run scan destination")
		}
	}
	return nil
}
