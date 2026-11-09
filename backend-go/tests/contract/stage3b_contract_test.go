package contract

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage3BStore struct {
	item        *new_product_calculations.NewProductCalculationItem
	listFilter  new_product_calculations.ListFilter
	getType     string
	upsertInput new_product_calculations.CreateRequest
	verifyErr   error
	projectID   int64
	projectErr  error
	deleted     bool
}

func (s *stage3BStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return s.verifyErr
}

func (s *stage3BStore) List(_ context.Context, filter new_product_calculations.ListFilter) (new_product_calculations.ListResponse, error) {
	s.listFilter = filter
	items := []new_product_calculations.NewProductCalculationItem{}
	if s.item != nil {
		items = append(items, *s.item)
	}
	return new_product_calculations.ListResponse{Items: items, Total: len(items), Page: filter.Page, PageSize: filter.PageSize}, nil
}

func (s *stage3BStore) Get(_ context.Context, _ int64, _ string, calculationType string) (*new_product_calculations.NewProductCalculationItem, error) {
	s.getType = calculationType
	return s.item, nil
}

func (s *stage3BStore) Upsert(_ context.Context, input new_product_calculations.CreateRequest, _ string) (*new_product_calculations.NewProductCalculationItem, error) {
	s.upsertInput = input
	return s.item, nil
}

func (s *stage3BStore) ProjectID(context.Context, int64) (int64, error) {
	return s.projectID, s.projectErr
}

func (s *stage3BStore) Delete(context.Context, int64) (bool, error) {
	return s.deleted, nil
}

func (s *stage3BStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, new_product_calculations.Store) error,
) error {
	next := *s
	if err := fn(ctx, nil, &next); err != nil {
		return err
	}
	*s = next
	return nil
}

type stage3BAuditor struct {
	entries []audit.Entry
	err     error
}

func (a *stage3BAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return a.err
}

func (a *stage3BAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return a.err
}
func (*stage3BAuditor) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

func TestStage3BNewProductCalculationWireContract(t *testing.T) {
	now := time.Date(2026, 11, 8, 9, 30, 0, 0, time.UTC)
	item := &new_product_calculations.NewProductCalculationItem{
		ID:                        41,
		ProjectID:                 7,
		ProjectName:               "北美项目",
		SKU:                       "SKU-中文",
		ASIN:                      stage3BString("B0TEST"),
		Country:                   stage3BString("US"),
		CalculationType:           "profit_calc",
		PackageLengthCM:           10,
		PackageWidthCM:            8,
		PackageHeightCM:           4,
		WeightKG:                  0.4,
		FOBProductCostRMB:         30,
		FirstLegCostRMB:           5,
		DDPCostRMB:                35,
		DDPCostUSD:                5,
		SalePriceUSD:              20,
		TargetProfitRate:          stage3BFloat(0.25),
		AdvertisingRate:           0.1,
		ReturnLossRate:            0.04,
		StorageMonths:             1,
		InboundPlacementMode:      "single_destination",
		USDToRMBRate:              7.1,
		USDToRMBRateSource:        "monthly",
		SizeTier:                  "small_standard",
		SizeTierLabel:             "小号标准件",
		PriceBand:                 "under_10",
		PriceBandLabel:            "$10 以下",
		FulfillmentFeeRuleLabel:   "配送费规则",
		InboundConfigFeeRuleLabel: "入库配置费规则",
		StorageFeeRuleLabel:       "仓储费规则",
		Dimensions: new_product_calculations.NewProductCalculationDimensions{
			LongestSideIn: 4, MiddleSideIn: 3, ShortestSideIn: 2,
			LengthPlusGirthIn: 14, VolumeCubicIn: 24, VolumeCubicFt: 0.000014,
		},
		Weights: new_product_calculations.NewProductCalculationWeight{
			ProductWeightLB: 0.88, ProductWeightOZ: 14.08,
			DimensionalWeightLB: 0.01, ChargeableWeightLB: 0.88,
			ChargeableWeightOZ: 14.08, ChargeableWeightRule: "实重",
		},
		Fees: new_product_calculations.NewProductCalculationFees{
			ReferralFeeUSD: 3, AdvertisingFeeUSD: 2, ReturnLossUSD: 0.8,
			FBAFulfillmentFeeUSD: 4, InboundConfigFeeUSD: 0.3,
			StorageFeeUSD: 0.2, TotalFeeUSD: 6,
		},
		Profit: new_product_calculations.NewProductCalculationProfit{
			DDPCostRMB: 35, DDPCostUSD: 5, PayoutUSD: 14,
			ProfitUSD: 9, ProfitRate: 0.45,
		},
		Warnings:  []string{"尺寸需复核", "促销期费率"},
		CreatedAt: now,
		UpdatedAt: now,
	}
	store := &stage3BStore{item: item, projectID: 7, deleted: true}
	auditor := &stage3BAuditor{}
	router := chi.NewRouter()
	registrar := new_product_calculations.NewRegistrar(store, auditor)
	if registrar.ModuleName() != "new_product_calculations" {
		t.Fatalf("ModuleName() = %q, want new_product_calculations", registrar.ModuleName())
	}
	registrar.RegisterRoutes(router, stage3BPassthrough)
	identity := auth.UserContext{UserID: "operator-1", Operator: "林一", IsAdmin: true}

	list := stage3BRequest(router, http.MethodGet, "/api/v1/new-product-calculations", "", identity)
	assertStage3BKeys(t, list, http.StatusOK, []string{"items", "total", "page", "page_size"})
	if store.listFilter.Page != 1 || store.listFilter.PageSize != 200 || !store.listFilter.IsAdmin {
		t.Errorf("list filter = %#v, want default pagination and admin visibility", store.listFilter)
	}
	var page map[string]any
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	items, ok := page["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("list items = %#v, want one item", page["items"])
	}
	assertStage3BItemKeys(t, items[0].(map[string]any))

	detail := stage3BRequest(router, http.MethodGet,
		"/api/v1/new-product-calculations/7/SKU-%E4%B8%AD%E6%96%87", "", identity)
	assertStage3BItemKeys(t, decodeStage3BMap(t, detail, http.StatusOK))
	if store.getType != "profit_calc" {
		t.Errorf("detail calculation_type = %q, want profit_calc", store.getType)
	}

	created := stage3BRequest(router, http.MethodPost, "/api/v1/new-product-calculations", stage3BCreateBody, identity)
	assertStage3BItemKeys(t, decodeStage3BMap(t, created, http.StatusCreated))
	if store.upsertInput.ProjectID != 7 || store.upsertInput.CalculationType != "profit_calc" {
		t.Errorf("upsert request = %#v, want project and default calculation type", store.upsertInput)
	}
	if len(auditor.entries) != 1 ||
		auditor.entries[0].Action != "pricing_calculation.new_product_calculation.upsert" {
		t.Fatalf("audit entries = %#v, want native upsert action", auditor.entries)
	}

	deleted := stage3BRequest(router, http.MethodDelete, "/api/v1/new-product-calculations/41", "", identity)
	if deleted.Code != http.StatusNoContent || deleted.Body.Len() != 0 {
		t.Fatalf("DELETE response = (%d, %q), want empty 204", deleted.Code, deleted.Body.String())
	}
	if len(auditor.entries) != 2 ||
		auditor.entries[1].Action != "pricing_calculation.new_product_calculation.delete" {
		t.Fatalf("delete audit = %#v, want native delete action", auditor.entries)
	}
}

func TestStage3BNewProductCalculationProjectNotFoundAndForbidden(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want int
	}{
		{name: "not found", err: new_product_calculations.ErrProjectNotFound, want: http.StatusNotFound},
		{name: "forbidden", err: new_product_calculations.ErrProjectForbidden, want: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &stage3BStore{verifyErr: test.err}
			router := chi.NewRouter()
			new_product_calculations.NewRegistrar(store, &stage3BAuditor{}).RegisterRoutes(router, stage3BPassthrough)
			rec := stage3BRequest(router, http.MethodGet,
				"/api/v1/new-product-calculations/7/SKU", "", auth.UserContext{Operator: "another"})
			if rec.Code != test.want {
				t.Fatalf("GET detail status = %d, want %d: %s", rec.Code, test.want, rec.Body.String())
			}
		})
	}
}

func stage3BRequest(router http.Handler, method, target, body string, identity auth.UserContext) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req = req.WithContext(auth.WithUserContext(req.Context(), identity))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func stage3BPassthrough(next http.Handler) http.Handler { return next }

func decodeStage3BMap(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int) map[string]any {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d: %s", rec.Code, wantStatus, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response object: %v", err)
	}
	return body
}

func assertStage3BKeys(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, keys []string) {
	t.Helper()
	body := decodeStage3BMap(t, rec, wantStatus)
	got := stage3BMapKeys(body)
	sort.Strings(keys)
	if !reflect.DeepEqual(got, keys) {
		t.Errorf("response keys = %v, want %v", got, keys)
	}
}

func assertStage3BItemKeys(t *testing.T, item map[string]any) {
	t.Helper()
	want := []string{
		"advertising_rate", "anchor", "asin", "calculation_type", "country", "created_at",
		"created_by", "ddp_cost_rmb", "ddp_cost_usd", "dimensions", "fees",
		"first_leg_cost_rmb", "fob_product_cost_rmb", "fulfillment_fee_rule_label",
		"id", "inbound_config_fee_rule_label", "inbound_placement_mode", "notes",
		"observed_at", "package_height_cm", "package_length_cm", "package_width_cm",
		"price_band", "price_band_label", "profit", "project_id", "project_name",
		"return_loss_rate", "sale_price_usd", "size_tier", "size_tier_label", "sku",
		"source", "storage_fee_rule_label", "storage_months", "target_profit_rate",
		"updated_at", "usd_to_rmb_rate", "usd_to_rmb_rate_source", "warnings",
		"weight_kg", "weights",
	}
	if got := stage3BMapKeys(item); !reflect.DeepEqual(got, want) {
		t.Errorf("item keys = %v, want %v", got, want)
	}
	if item["sku"] != "SKU-中文" || item["warnings"] == nil {
		t.Errorf("item = %#v, want Chinese SKU and warnings", item)
	}
	if warnings, ok := item["warnings"].([]any); !ok ||
		!reflect.DeepEqual(warnings, []any{"尺寸需复核", "促销期费率"}) {
		t.Errorf("warnings = %#v, want original Chinese warning strings", item["warnings"])
	}
	if item["anchor"] == nil {
		t.Error("anchor is null, want derived anchor block")
	}
	assertStage3BObjectKeys(t, item, "dimensions", []string{
		"longest_side_in", "middle_side_in", "shortest_side_in",
		"length_plus_girth_in", "volume_cubic_in", "volume_cubic_ft",
	})
	assertStage3BObjectKeys(t, item, "weights", []string{
		"product_weight_lb", "product_weight_oz", "dimensional_weight_lb",
		"chargeable_weight_lb", "chargeable_weight_oz", "chargeable_weight_rule",
	})
	if weights, ok := item["weights"].(map[string]any); !ok || weights["chargeable_weight_rule"] != "实重" {
		t.Errorf("weights = %#v, want unchanged Chinese rule string", item["weights"])
	}
	assertStage3BObjectKeys(t, item, "fees", []string{
		"referral_fee_usd", "advertising_fee_usd", "return_loss_usd",
		"fba_fulfillment_fee_usd", "inbound_config_fee_usd", "storage_fee_usd",
		"total_fee_usd", "delivery_fee_usd", "inbound_config_fee_manual_usd",
		"storage_fee_manual_usd",
	})
	assertStage3BObjectKeys(t, item, "profit", []string{
		"ddp_cost_rmb", "ddp_cost_usd", "payout_usd", "profit_usd", "profit_rate",
		"vat_usd", "profit_after_vat_usd", "profit_after_vat_rate",
	})
	assertStage3BObjectKeys(t, item, "anchor", []string{
		"breakeven_advertising_rate", "non_ad_fee_usd", "max_ad_spend_per_unit_usd",
		"breakeven_advertising_rate_after_vat", "target_net_margin",
		"target_advertising_rate", "basis",
	})
	assertStage3BObjectKeys(t, item["anchor"].(map[string]any), "basis", []string{
		"observed_at", "usd_to_rmb_rate", "usd_to_rmb_rate_source",
	})
	if fees, ok := item["fees"].(map[string]any); ok {
		if _, hasUnexpectedField := fees["platform_fee_usd"]; hasUnexpectedField {
			t.Error("fees includes platform_fee_usd, which is outside NewProductCalculationItem")
		}
	}
}

func assertStage3BObjectKeys(t *testing.T, parent map[string]any, field string, want []string) {
	t.Helper()
	object, ok := parent[field].(map[string]any)
	if !ok {
		t.Fatalf("%s = %#v, want object", field, parent[field])
	}
	sort.Strings(want)
	if got := stage3BMapKeys(object); !reflect.DeepEqual(got, want) {
		t.Errorf("%s keys = %v, want %v", field, got, want)
	}
}

func stage3BMapKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stage3BString(value string) *string  { return &value }
func stage3BFloat(value float64) *float64 { return &value }

var stage3BCreateBody = `{
  "project_id":7,"project_name":"北美项目","sku":"SKU-中文","asin":"B0TEST","country":"US",
  "package_length_cm":10,"package_width_cm":8,"package_height_cm":4,"weight_kg":0.4,
  "fob_product_cost_rmb":30,"first_leg_cost_rmb":5,"ddp_cost_rmb":35,"ddp_cost_usd":5,
  "sale_price_usd":20,"advertising_rate":0.1,"return_loss_rate":0.04,"storage_months":1,
  "inbound_placement_mode":"single_destination","usd_to_rmb_rate":7.1,
  "usd_to_rmb_rate_source":"monthly","size_tier":"small_standard","size_tier_label":"小号标准件",
  "price_band":"under_10","price_band_label":"$10 以下","longest_side_in":4,
  "middle_side_in":3,"shortest_side_in":2,"length_plus_girth_in":14,
  "volume_cubic_in":24,"volume_cubic_ft":0.000014,"product_weight_lb":0.88,
  "product_weight_oz":14.08,"dimensional_weight_lb":0.01,"chargeable_weight_lb":0.88,
  "chargeable_weight_oz":14.08,"chargeable_weight_rule":"实重",
  "fulfillment_fee_rule_label":"配送费规则","inbound_config_fee_rule_label":"入库配置费规则",
  "storage_fee_rule_label":"仓储费规则","referral_fee_usd":3,"advertising_fee_usd":2,
  "return_loss_usd":0.8,"fba_fulfillment_fee_usd":4,"inbound_config_fee_usd":0.3,
  "storage_fee_usd":0.2,"total_fee_usd":6,"payout_usd":14,"profit_usd":9,
  "profit_rate":0.45,"warnings":["尺寸需复核","促销期费率"]
}`
