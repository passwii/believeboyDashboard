package contract

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shop_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage3CStore struct {
	item          shop_calculation.ShopCalculationItem
	listFilter    shop_calculation.ShopCalculationListFilter
	historyFilter shop_calculation.ShopCalculationHistoryFilter
	appendRequest shop_calculation.ShopCalculationCreateRequest
	projectID     int64
	deleted       bool
	aggregate     shop_calculation.ShopCalculationAggregate
}

func (s *stage3CStore) VerifyProjectAccess(context.Context, int64, string, bool) error { return nil }
func (s *stage3CStore) AccessibleProjectIDs(context.Context, string) ([]int64, error) {
	return []int64{7}, nil
}
func (s *stage3CStore) List(_ context.Context, filter shop_calculation.ShopCalculationListFilter) ([]shop_calculation.ShopCalculationItem, int, error) {
	s.listFilter = filter
	return []shop_calculation.ShopCalculationItem{s.item}, 1, nil
}
func (s *stage3CStore) History(_ context.Context, filter shop_calculation.ShopCalculationHistoryFilter) ([]shop_calculation.ShopCalculationItem, error) {
	s.historyFilter = filter
	return []shop_calculation.ShopCalculationItem{s.item}, nil
}
func (s *stage3CStore) Append(_ context.Context, request shop_calculation.ShopCalculationCreateRequest, _ string) (shop_calculation.ShopCalculationItem, error) {
	s.appendRequest = request
	return s.item, nil
}
func (s *stage3CStore) ProjectIDForItem(context.Context, int64) (int64, error) {
	return s.projectID, nil
}
func (s *stage3CStore) DeleteGroup(context.Context, int64) (bool, error) { return s.deleted, nil }
func (s *stage3CStore) AggregateCurrent(context.Context, int64, string) (shop_calculation.ShopCalculationAggregate, error) {
	return s.aggregate, nil
}
func (s *stage3CStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, shop_calculation.Store) error,
) error {
	next := *s
	if err := fn(ctx, nil, &next); err != nil {
		return err
	}
	*s = next
	return nil
}

func TestStage3CShopCalculationWireContract(t *testing.T) {
	now := time.Date(2026, 11, 7, 10, 11, 12, 0, time.UTC)
	store := &stage3CStore{
		projectID: 7,
		deleted:   true,
		aggregate: shop_calculation.ShopCalculationAggregate{
			RevenueUSD: 30, PlatformFeesUSD: 13.4, ProcurementCostRMB: 50,
			DDPCostRMB: 70, DDPCostUSD: 10,
			ProfitUSD: 6.6, GrossMarginRate: 0.22,
		},
		item: shop_calculation.ShopCalculationItem{
			ID: 11, ProjectID: 7, ProjectName: "Test Shop", SKU: "SKU-1", Country: "US",
			SalePriceUSD: 30, ObservedAt: now, CreatedAt: now, UpdatedAt: now, Source: "manual",
			Dimensions: shop_calculation.ShopCalculationDimensions{LongestSideIn: 8},
			Weights:    shop_calculation.ShopCalculationWeight{ProductWeightLB: 1.1},
			Fees:       shop_calculation.ShopCalculationFees{TotalFeeUSD: 13.4},
			Profit:     shop_calculation.ShopCalculationProfit{ProfitUSD: 6.6},
			Anchor: &shop_calculation.PricingAnchor{
				BreakevenAdvertisingRate: stage3CFloatPointer(0.42),
				Basis: shop_calculation.AnchorBasis{
					ObservedAt: &now, USDToRMBRate: stage3CFloatPointer(7),
					USDToRMBRateSource: stage3CStringPointer("manual"),
				},
			},
		},
	}
	auditor := audit.NewMockService()
	router := chi.NewRouter()
	shop_calculation.NewRegistrar(store, auditor).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/shop-calculation?project_id=7&country=US&page=2&page_size=10", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET list status=%d body=%s", rec.Code, rec.Body.String())
	}
	var list shop_calculation.ShopCalculationListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode GET list: %v", err)
	}
	if list.Page != 2 || list.PageSize != 10 || list.Total != 1 ||
		len(list.Items) != 1 || list.Items[0].ID != 11 {
		t.Fatalf("unexpected GET list response: %#v", list)
	}
	if store.listFilter.ProjectID == nil || *store.listFilter.ProjectID != 7 ||
		store.listFilter.Country == nil || *store.listFilter.Country != "US" {
		t.Fatalf("GET list filter = %#v", store.listFilter)
	}
	for _, field := range []string{
		`"total":1`, `"page":2`, `"page_size":10`, `"project_id":7`,
		`"dimensions":{"longest_side_in":8`, `"weights":{"product_weight_lb":1.1`,
		`"fees":{"referral_fee_usd":0`, `"profit":{"ddp_cost_rmb":0`,
		`"anchor":{"breakeven_advertising_rate":0.42`, `"observed_at":`,
	} {
		if !strings.Contains(rec.Body.String(), field) {
			t.Errorf("GET list response missing %s: %s", field, rec.Body.String())
		}
	}
	if strings.Contains(rec.Body.String(), `"pageSize"`) || strings.Contains(rec.Body.String(), `"salePriceUSD"`) {
		t.Fatalf("response contains non-snake-case fields: %s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/shop-calculation/aggregate?project_id=7&country=US", nil).WithContext(ctx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET aggregate status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, field := range []string{
		`"project_id":7`, `"country":"US"`, `"revenue_usd":30`,
		`"platform_fees_usd":13.4`, `"procurement_cost_rmb":50`,
		`"ddp_cost_rmb":70`, `"ddp_cost_usd":10`,
		`"profit_usd":6.6`, `"gross_margin_rate":0.22`,
	} {
		if !strings.Contains(rec.Body.String(), field) {
			t.Errorf("GET aggregate response missing %s: %s", field, rec.Body.String())
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/shop-calculation/history?project_id=7&sku=SKU-1&country=US&include_deleted=true", nil).WithContext(ctx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || store.historyFilter.ProjectID != 7 ||
		store.historyFilter.SKU == nil || *store.historyFilter.SKU != "SKU-1" ||
		!store.historyFilter.IncludeDeleted {
		t.Fatalf("GET history status=%d filter=%#v body=%s", rec.Code, store.historyFilter, rec.Body.String())
	}

	payload := `{"project_id":7,"project_name":"Test Shop","sku":"SKU-1","country":"US","package_length_cm":20,"package_width_cm":10,"package_height_cm":5,"weight_kg":0.5,"fob_product_cost_rmb":50,"first_leg_cost_rmb":8,"ddp_cost_rmb":70,"ddp_cost_usd":10,"sale_price_usd":30,"advertising_rate":0.1,"return_loss_rate":0.04,"storage_months":1,"inbound_placement_mode":"single_destination","usd_to_rmb_rate":7,"usd_to_rmb_rate_source":"manual","size_tier":"small_standard","size_tier_label":"Small","price_band":"under_10","price_band_label":"Under $10","longest_side_in":8,"middle_side_in":4,"shortest_side_in":2,"length_plus_girth_in":20,"volume_cubic_in":64,"volume_cubic_ft":0.037,"product_weight_lb":1.1,"product_weight_oz":17.6,"dimensional_weight_lb":0.4,"chargeable_weight_lb":1.1,"chargeable_weight_oz":17.6,"chargeable_weight_rule":"actual","fulfillment_fee_rule_label":"fulfillment","inbound_config_fee_rule_label":"inbound","storage_fee_rule_label":"storage","referral_fee_usd":4.5,"advertising_fee_usd":3,"return_loss_usd":1.2,"fba_fulfillment_fee_usd":4,"inbound_config_fee_usd":0.5,"storage_fee_usd":0.2,"total_fee_usd":13.4,"payout_usd":16.6,"profit_usd":6.6,"profit_rate":0.22,"source":"","observed_at":"2026-11-07T10:11:12Z"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/shop-calculation", strings.NewReader(payload)).WithContext(ctx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.appendRequest.Source != "manual" || store.appendRequest.ObservedAt == nil ||
		!store.appendRequest.ObservedAt.Equal(now) {
		t.Fatalf("POST persistence input = %#v", store.appendRequest)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "pricing_calculation.shop_calculation.append" {
		t.Fatalf("POST audit = %#v", auditor.Entries)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/shop-calculation/11", nil).WithContext(ctx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("DELETE response=%d %q, want empty 204", rec.Code, rec.Body.String())
	}
	if len(auditor.Entries) != 2 || auditor.Entries[1].Action != "pricing_calculation.shop_calculation.delete" {
		t.Fatalf("DELETE audit = %#v", auditor.Entries)
	}

}

func stage3CFloatPointer(value float64) *float64 { return &value }
func stage3CStringPointer(value string) *string  { return &value }
