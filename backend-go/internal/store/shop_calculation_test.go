package store

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shop_calculation"
)

func TestShopCalculationListCurrentUsesLatestActiveRowPerProjectSKUGroups(t *testing.T) {
	db := &fakeDB{
		row: fakeRow{values: []any{2}},
		rows: &fakeRows{batches: [][]any{
			shopCalculationRowValues(12, 7, "SKU-1", "US", 30, 6.6, 10, nil),
		}},
	}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	country := "US"
	projectID := int64(7)
	items, total, err := store.List(context.Background(), shop_calculation.ShopCalculationListFilter{
		ProjectID: &projectID, Country: &country, Page: 2, PageSize: 10,
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if total != 2 || len(items) != 1 || items[0].ID != 12 {
		t.Fatalf("List() = %#v, total=%d", items, total)
	}
	if len(db.queryRowCalls) != 1 || len(db.queryCalls) != 1 {
		t.Fatalf("queries = %d count + %d item, want 1 each", len(db.queryRowCalls), len(db.queryCalls))
	}
	query := strings.ToLower(db.queryCalls[0].sql)
	for _, fragment := range []string{
		"max(id)", "group by project_id, sku, country", "deleted_at is null",
		"order by observed_at desc, id desc", "offset $",
	} {
		if !strings.Contains(query, fragment) {
			t.Errorf("current-state SQL missing %q: %s", fragment, query)
		}
	}
}

func TestShopCalculationHistoryFiltersProjectSKUAndDeletedRows(t *testing.T) {
	db := &fakeDB{
		rows: &fakeRows{batches: [][]any{
			shopCalculationRowValues(12, 7, "SKU-1", "US", 30, 6.6, 10, nil),
		}},
	}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	items, err := store.History(context.Background(), shop_calculation.ShopCalculationHistoryFilter{
		ProjectID: 7, SKU: shopCalculationStringPointer("SKU-1"), Country: shopCalculationStringPointer("US"),
		IncludeDeleted: true,
	})
	if err != nil {
		t.Fatalf("History() error = %v", err)
	}
	if len(items) != 1 || items[0].ID != 12 {
		t.Fatalf("History() = %#v", items)
	}
	query := strings.ToLower(db.queryCalls[0].sql)
	for _, fragment := range []string{"project_id = $1", "sku = $2", "country = $3", "order by observed_at desc, id desc"} {
		if !strings.Contains(query, fragment) {
			t.Errorf("history SQL missing %q: %s", fragment, query)
		}
	}
	if strings.Contains(query, "deleted_at is null") {
		t.Fatalf("include_deleted history unexpectedly filters tombstones: %s", query)
	}
}

func TestShopCalculationListCanRestrictToAccessibleProjects(t *testing.T) {
	db := &fakeDB{
		row:  fakeRow{values: []any{0}},
		rows: &fakeRows{},
	}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	items, total, err := store.List(context.Background(), shop_calculation.ShopCalculationListFilter{
		ProjectIDs: []int64{7, 9}, Page: 1, PageSize: 20,
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 0 || total != 0 {
		t.Fatalf("List() = %#v, total=%d; want empty", items, total)
	}
	if len(db.queryCalls) != 1 || !strings.Contains(strings.ToLower(db.queryCalls[0].sql), "project_id::bigint = any($1::bigint[])") {
		t.Fatalf("list SQL = %#v, want accessible project ID filter", db.queryCalls)
	}
	if !assertWriteArgsEqual(db.queryCalls[0].args[:1], []any{[]int64{7, 9}}) {
		t.Fatalf("list accessible project args = %#v", db.queryCalls[0].args)
	}
}

func TestShopCalculationAppendPersistsRequestAndReturnsDerivedAnchor(t *testing.T) {
	observedAt := time.Date(2026, 11, 7, 10, 11, 12, 0, time.UTC)
	values := shopCalculationRowValues(20, 7, "SKU-1", "DE", 30, 6.6, 10, nil)
	values[58] = []byte(`["warning"]`)
	values[59] = "saved note"
	values[60] = "alice"
	values[61] = observedAt
	values[62] = "agent_listing_pull"
	values[63] = observedAt
	values[64] = observedAt
	db := &fakeDB{row: fakeRow{values: values}}
	writeDB := &fakeWriteDB{fakeDB: db}
	store := NewShopCalculationStore(writeDB)

	request := shop_calculation.ShopCalculationCreateRequest{
		ProjectID: 7, ProjectName: "DE Shop", SKU: "SKU-1", Country: "DE",
		AccountingType: "eu_accounting", PackageLengthCM: 20, PackageWidthCM: 10,
		PackageHeightCM: 5, WeightKG: 0.5, FOBProductCostRMB: 50, FirstLegCostRMB: 8,
		DDPCostRMB: 70, DDPCostUSD: 10, SalePriceUSD: 30, AdvertisingRate: 0.1,
		ReturnLossRate: 0.04, StorageMonths: 1, InboundPlacementMode: "single_destination",
		USDToRMBRate: 7, USDToRMBRateSource: "manual", SizeTier: "small_standard",
		SizeTierLabel: "Small", PriceBand: "under_10", PriceBandLabel: "Under $10",
		LongestSideIn: 8, MiddleSideIn: 4, ShortestSideIn: 2, LengthPlusGirthIn: 20,
		VolumeCubicIn: 64, VolumeCubicFt: 0.037, ProductWeightLB: 1.1, ProductWeightOZ: 17.6,
		DimensionalWeightLB: 0.4, ChargeableWeightLB: 1.1, ChargeableWeightOZ: 17.6,
		ChargeableWeightRule: "actual", FulfillmentFeeRuleLabel: "fulfillment",
		InboundConfigFeeRuleLabel: "inbound", StorageFeeRuleLabel: "storage",
		ReferralFeeUSD: 4.5, AdvertisingFeeUSD: 3, ReturnLossUSD: 1.2,
		FBAFulfillmentFeeUSD: 4, InboundConfigFeeUSD: 0.5, StorageFeeUSD: 0.2,
		TotalFeeUSD: 13.4, DeliveryFeeUSD: 1.2, InboundConfigFeeManualUSD: 0.4,
		StorageFeeManualUSD: 0.3, PlatformFeeUSD: 4.5, PayoutUSD: 16.6,
		ProfitUSD: 6.6, ProfitRate: 0.22, VATUSD: 2, Warnings: []string{"warning"},
		Notes: shopCalculationStringPointer("saved note"), Source: "agent_listing_pull", ObservedAt: &observedAt,
	}
	item, err := store.Append(context.Background(), request, "alice")
	if err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	if item.ID != 20 || item.Source != "agent_listing_pull" || item.ObservedAt != observedAt {
		t.Fatalf("Append() item = %#v", item)
	}
	if item.Anchor == nil || item.Anchor.Basis.ObservedAt == nil {
		t.Fatalf("Append() did not derive anchor: %#v", item.Anchor)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow calls = %d, want one INSERT RETURNING", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	for _, field := range []string{
		"project_id", "project_name", "sku", "asin", "country", "accounting_type",
		"package_length_cm", "package_width_cm", "package_height_cm", "weight_kg",
		"fob_product_cost_rmb", "first_leg_cost_rmb", "ddp_cost_rmb", "ddp_cost_usd",
		"sale_price_usd", "advertising_rate", "return_loss_rate", "storage_months",
		"inbound_placement_mode", "usd_to_rmb_rate", "usd_to_rmb_rate_source",
		"size_tier", "size_tier_label", "price_band", "price_band_label",
		"longest_side_in", "middle_side_in", "shortest_side_in", "length_plus_girth_in",
		"volume_cubic_in", "volume_cubic_ft", "product_weight_lb", "product_weight_oz",
		"dimensional_weight_lb", "chargeable_weight_lb", "chargeable_weight_oz",
		"chargeable_weight_rule", "fulfillment_fee_rule_label", "inbound_config_fee_rule_label",
		"storage_fee_rule_label", "referral_fee_usd", "advertising_fee_usd", "return_loss_usd",
		"fba_fulfillment_fee_usd", "inbound_config_fee_usd", "storage_fee_usd", "total_fee_usd",
		"delivery_fee_usd", "inbound_config_fee_manual_usd", "storage_fee_manual_usd",
		"platform_fee_usd", "payout_usd", "profit_usd", "profit_rate", "vat_usd",
		"profit_after_vat_usd", "profit_after_vat_rate", "warnings_json", "notes",
		"created_by", "observed_at", "source",
	} {
		if !strings.Contains(query, field) {
			t.Errorf("append SQL missing %q: %s", field, query)
		}
	}
	args := db.queryRowCalls[0].args
	if len(args) != 62 {
		t.Fatalf("append argument count = %d, want 62", len(args))
	}
	for index, want := range map[int]any{
		0: int64(7), 1: "DE Shop", 2: "SKU-1", 4: "DE", 5: "eu_accounting",
		6: float64(20), 10: float64(50), 11: float64(8), 12: float64(70), 13: float64(10),
		14: float64(30), 18: "single_destination", 19: float64(7), 20: "manual",
		25: float64(8), 31: float64(1.1), 37: "fulfillment", 40: float64(4.5),
		46: float64(13.4), 47: float64(1.2), 50: float64(4.5), 51: float64(16.6),
		52: float64(6.6), 53: float64(0.22), 54: float64(2),
		57: []byte(`["warning"]`), 58: shopCalculationStringPointer("saved note"), 59: shopCalculationStringPointer("alice"),
		60: &observedAt, 61: "agent_listing_pull",
	} {
		if !assertWriteArgsEqual([]any{args[index]}, []any{want}) {
			t.Errorf("append arg[%d] = %#v, want %#v", index, args[index], want)
		}
	}
}

func TestShopCalculationAppendDefaultsSourceToManual(t *testing.T) {
	values := shopCalculationRowValues(21, 7, "SKU-2", "US", 20, 4, 8, nil)
	db := &fakeDB{row: fakeRow{values: values}}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	request := minimalShopCalculationRequest()
	request.Source = ""
	item, err := store.Append(context.Background(), request, "")
	if err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	if item.Source != "manual" || db.queryRowCalls[0].args[len(db.queryRowCalls[0].args)-1] != "manual" {
		t.Fatalf("source = %q, args tail=%#v; want manual", item.Source, db.queryRowCalls[0].args[len(db.queryRowCalls[0].args)-2:])
	}
}

func TestShopCalculationDeleteSoftDeletesAllActiveRowsInGroup(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{int64(7)}}}
	writeDB := &fakeWriteDB{fakeDB: db, execTag: pgconn.NewCommandTag("UPDATE 3")}
	store := NewShopCalculationStore(writeDB)
	deleted, err := store.DeleteGroup(context.Background(), 12)
	if err != nil {
		t.Fatalf("DeleteGroup() error = %v", err)
	}
	if !deleted || len(writeDB.execCalls) != 1 {
		t.Fatalf("deleted=%v exec calls=%d", deleted, len(writeDB.execCalls))
	}
	query := strings.ToLower(writeDB.execCalls[0].sql)
	for _, fragment := range []string{"update public.shop_calculation", "project_id", "sku", "country", "deleted_at is null"} {
		if !strings.Contains(query, fragment) {
			t.Errorf("delete SQL missing %q: %s", fragment, query)
		}
	}
}

func TestShopCalculationProjectIDForItemReturnsNotFound(t *testing.T) {
	db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	_, err := store.ProjectIDForItem(context.Background(), 123)
	if !errors.Is(err, shop_calculation.ErrNotFound) {
		t.Fatalf("ProjectIDForItem() error = %v, want ErrNotFound", err)
	}
}

func TestShopCalculationVerifyProjectAccessUsesBothOperatorLists(t *testing.T) {
	projectOperator := "bob"
	assistantOperator := "alice、carol"
	db := &fakeDB{row: fakeRow{values: []any{&projectOperator, &assistantOperator}}}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	if err := store.VerifyProjectAccess(context.Background(), 7, "alice", false); err != nil {
		t.Fatalf("assistant operator should have access: %v", err)
	}
	if len(db.queryRowCalls) != 1 || !strings.Contains(db.queryRowCalls[0].sql, "public.projects") {
		t.Fatalf("project access query = %#v", db.queryRowCalls)
	}
}

func TestShopCalculationAccessibleProjectIDsUsesActiveOperatorAndAssistantAssignments(t *testing.T) {
	db := &fakeDB{
		rows: &fakeRows{batches: [][]any{{int64(7)}, {int64(9)}}},
	}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	ids, err := store.AccessibleProjectIDs(context.Background(), "alice")
	if err != nil {
		t.Fatalf("AccessibleProjectIDs() error = %v", err)
	}
	if len(ids) != 2 || ids[0] != 7 || ids[1] != 9 {
		t.Fatalf("project ids = %v, want [7 9]", ids)
	}
	query := strings.ToLower(db.queryCalls[0].sql)
	for _, fragment := range []string{
		"from public.projects",
		"coalesce(is_active, true)",
		"project_operator",
		"assistant_operator",
		"[:space:]",
	} {
		if !strings.Contains(query, fragment) {
			t.Errorf("accessible projects SQL missing %q: %s", fragment, query)
		}
	}
	if len(db.queryCalls[0].args) != 1 || db.queryCalls[0].args[0] != "alice" {
		t.Fatalf("accessible projects args = %#v", db.queryCalls[0].args)
	}
}

func TestShopCalculationAggregateComputesWeightedMarginFromCurrentState(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{
		float64(100), float64(24), float64(60), float64(300), float64(40),
	}}}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	got, err := store.AggregateCurrent(context.Background(), 7, "US")
	if err != nil {
		t.Fatalf("AggregateCurrent() error = %v", err)
	}
	if got.RevenueUSD != 100 || got.PlatformFeesUSD != 24 ||
		got.ProcurementCostRMB != 60 || got.DDPCostRMB != 300 ||
		got.ProfitUSD != 36 || math.Abs(got.GrossMarginRate-0.36) > 1e-9 {
		t.Fatalf("aggregate = %#v", got)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	for _, fragment := range []string{
		"max(id)", "deleted_at is null", "sum(sale_price_usd)",
		"sum(total_fee_usd)", "sum(fob_product_cost_rmb)",
		"sum(ddp_cost_rmb)", "sum(ddp_cost_usd)",
	} {
		if !strings.Contains(query, fragment) {
			t.Errorf("aggregate SQL missing %q: %s", fragment, query)
		}
	}
}

func TestShopCalculationAggregateReturnsZeroMarginForNoRevenue(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{
		float64(0), float64(0), float64(0), float64(0), float64(0),
	}}}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	got, err := store.AggregateCurrent(context.Background(), 7, "US")
	if err != nil {
		t.Fatalf("AggregateCurrent() error = %v", err)
	}
	if got.GrossMarginRate != 0 {
		t.Fatalf("margin = %v, want 0", got.GrossMarginRate)
	}
}

func TestShopCalculationAggregateWithoutCountryCoversWholeProject(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{
		float64(80), float64(20), float64(40), float64(210), float64(68),
	}}}
	store := NewShopCalculationStore(&fakeWriteDB{fakeDB: db})
	got, err := store.AggregateCurrent(context.Background(), 7, "")
	if err != nil {
		t.Fatalf("AggregateCurrent() error = %v", err)
	}
	if got.ProjectID != 7 || got.Country != "" || got.RevenueUSD != 80 ||
		got.PlatformFeesUSD != 20 || got.ProcurementCostRMB != 40 ||
		got.DDPCostUSD != 68 || got.ProfitUSD != -8 ||
		math.Abs(got.GrossMarginRate-(-0.1)) > 1e-9 {
		t.Fatalf("aggregate = %#v", got)
	}
	if len(db.queryRowCalls[0].args) != 1 {
		t.Fatalf("aggregate args = %#v, want project-only filter", db.queryRowCalls[0].args)
	}
	if strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "country = $2") {
		t.Fatalf("aggregate SQL unexpectedly filters country: %s", db.queryRowCalls[0].sql)
	}
}

func TestShopCalculationProjectAccessDistinguishesMissingAndForbidden(t *testing.T) {
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	missingStore := NewShopCalculationStore(&fakeWriteDB{fakeDB: missingDB})
	if err := missingStore.VerifyProjectAccess(context.Background(), 4, "alice", false); !errors.Is(err, shop_calculation.ErrProjectNotFound) {
		t.Fatalf("missing project error = %v", err)
	}

	operator := "bob"
	assistant := "carol"
	forbiddenDB := &fakeDB{row: fakeRow{values: []any{&operator, &assistant}}}
	forbiddenStore := NewShopCalculationStore(&fakeWriteDB{fakeDB: forbiddenDB})
	if err := forbiddenStore.VerifyProjectAccess(context.Background(), 4, "alice", false); !errors.Is(err, shop_calculation.ErrProjectForbidden) {
		t.Fatalf("forbidden project error = %v", err)
	}
}

func minimalShopCalculationRequest() shop_calculation.ShopCalculationCreateRequest {
	return shop_calculation.ShopCalculationCreateRequest{
		ProjectID: 7, ProjectName: "Test", SKU: "SKU-2", Country: "US",
		PackageLengthCM: 1, PackageWidthCM: 1, PackageHeightCM: 1, WeightKG: 1,
		FOBProductCostRMB: 1, FirstLegCostRMB: 1, DDPCostRMB: 2, DDPCostUSD: 1,
		SalePriceUSD: 10, USDToRMBRate: 7, SizeTier: "standard", SizeTierLabel: "Standard",
		PriceBand: "standard", PriceBandLabel: "Standard", ChargeableWeightRule: "actual",
		FulfillmentFeeRuleLabel: "fulfillment", InboundConfigFeeRuleLabel: "inbound",
		StorageFeeRuleLabel: "storage", USDToRMBRateSource: "manual",
	}
}

func shopCalculationRowValues(id, projectID int64, sku, country string, price, profit, ddpUSD float64, afterVAT *float64) []any {
	now := time.Date(2026, 11, 7, 10, 11, 12, 0, time.UTC)
	var afterVATValue any
	if afterVAT != nil {
		afterVATValue = *afterVAT
	}
	return []any{
		id, projectID, "Test Shop", sku, (*string)(nil), country, "profit_calc",
		20.0, 10.0, 5.0, 0.5,
		50.0, 8.0, 70.0, ddpUSD, price,
		0.1, 0.04, 1.0, "single_destination",
		7.0, "manual", "small_standard", "Small standard", "under_10", "Under $10",
		8.0, 4.0, 2.0, 20.0, 64.0, 0.037,
		1.1, 17.6, 0.4, 1.1, 17.6, "actual",
		"fulfillment", "inbound", "storage",
		4.5, 3.0, 1.2, 4.0, 0.5, 0.2, 13.4,
		0.3, 0.2, 0.1, 4.5,
		16.6, profit, 0.22, 0.0, afterVATValue, afterVAT,
		[]byte(`[]`), (*string)(nil), (*string)(nil),
		now, "manual", now, now,
	}
}

func shopCalculationStringPointer(value string) *string { return &value }
