package pricing_calculation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type pricingTestStore struct {
	latestRate      float64
	latestMonth     string
	rateCurrencies  []string
	historicalCost  *float64
	verifyErr       error
	created         []RunItem
	listed          []RunItem
	listFilter      RunListFilter
	run             *RunItem
	deleted         bool
	updated         *RunItem
	deleteCalls     int
	updateCalls     int
	historicalCalls int
}

func (s *pricingTestStore) GetLatestExchangeRate(_ context.Context, currency string) (float64, string, error) {
	s.rateCurrencies = append(s.rateCurrencies, currency)
	if s.latestRate == 0 {
		return 0, "", ErrExchangeRateNotFound
	}
	return s.latestRate, s.latestMonth, nil
}

func (s *pricingTestStore) GetHistoricalShippingCost(_ context.Context, _ int64, _ string) (*float64, error) {
	s.historicalCalls++
	return s.historicalCost, nil
}

func (s *pricingTestStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return s.verifyErr
}

func (s *pricingTestStore) CreateRun(_ context.Context, item RunItem) (RunItem, error) {
	item.ID = int64(len(s.created) + 1)
	if item.CreatedAt == "" {
		item.CreatedAt = "2026-11-08T00:00:00Z"
	}
	if item.UpdatedAt == "" {
		item.UpdatedAt = item.CreatedAt
	}
	s.created = append(s.created, item)
	s.run = &item
	return item, nil
}

func (s *pricingTestStore) ListRuns(_ context.Context, filter RunListFilter) ([]RunItem, int, error) {
	s.listFilter = filter
	return s.listed, len(s.listed), nil
}

func (s *pricingTestStore) GetRun(context.Context, int64) (*RunItem, error) {
	return s.run, nil
}

func (s *pricingTestStore) DeleteRun(context.Context, int64) (bool, error) {
	s.deleteCalls++
	return s.deleted, nil
}

func (s *pricingTestStore) UpdateRun(_ context.Context, _ int64, item RunItem) (*RunItem, error) {
	s.updateCalls++
	s.updated = &item
	return s.updated, nil
}

func (s *pricingTestStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	next := *s
	next.created = append([]RunItem(nil), s.created...)
	if err := fn(ctx, nil, &next); err != nil {
		return err
	}
	*s = next
	return nil
}

type pricingFailingAuditor struct {
	err     error
	entries []audit.Entry
}

func (a *pricingFailingAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return a.err
}

func (a *pricingFailingAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return a.err
}
func (*pricingFailingAuditor) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

func TestPricingCalculationQuoteRoutesAndAuditActions(t *testing.T) {
	store := &pricingTestStore{latestRate: 7.2, latestMonth: "2026-10"}
	auditor := audit.NewMockService()
	router := pricingRouter(store, auditor)
	operator := userContext("alice", false)

	fbaBody := `{
		"country":"US","product_name":"FBA item",
		"package_length_cm":10,"package_width_cm":10,"package_height_cm":10,"weight_kg":0.5,
		"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,"sale_price_usd":20,
		"project_id":7,"sku":"SKU-1","use_historical_shipping_cost":false
	}`
	fba := perform(router, operator, http.MethodPost, "/api/v1/pricing-calculation/quote", fbaBody)
	if fba.Code != http.StatusOK {
		t.Fatalf("FBA status = %d, want 200; body=%s", fba.Code, fba.Body.String())
	}
	if !strings.Contains(fba.Body.String(), `"fba_fulfillment_fee_usd":5.04`) ||
		!strings.Contains(fba.Body.String(), `"usd_to_rmb_rate_source":"system:2026-10"`) {
		t.Fatalf("FBA response does not match pricing contract: %s", fba.Body.String())
	}
	if strings.Contains(fba.Body.String(), `"productName"`) || strings.Contains(fba.Body.String(), `"fbaFulfillmentFeeUsd"`) {
		t.Fatalf("response contains camelCase fields: %s", fba.Body.String())
	}

	fbmBody := `{
		"country":"US","product_name":"FBM item",
		"package_length_cm":10,"package_width_cm":10,"package_height_cm":10,"weight_kg":0.5,
		"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,
		"full_container_quantity":100,"full_container_price_rmb":10000,"delivery_fee_usd":5.5,
		"sale_price_usd":20
	}`
	fbm := perform(router, operator, http.MethodPost, "/api/v1/pricing-calculation/fbm-quote", fbmBody)
	if fbm.Code != http.StatusOK {
		t.Fatalf("FBM status = %d, want 200; body=%s", fbm.Code, fbm.Body.String())
	}
	if !strings.Contains(fbm.Body.String(), `"calculation_type":"fbm_calc"`) ||
		!strings.Contains(fbm.Body.String(), `"delivery_fee_usd":5.5`) ||
		!strings.Contains(fbm.Body.String(), `"fba_fulfillment_fee_usd":5.5`) {
		t.Fatalf("FBM response missing calculation fields: %s", fbm.Body.String())
	}
	fbmWithoutDelivery := strings.Replace(fbmBody, `"delivery_fee_usd":5.5,`, "", 1)
	missingDelivery := perform(router, operator, http.MethodPost, "/api/v1/pricing-calculation/fbm-quote", fbmWithoutDelivery)
	if missingDelivery.Code != http.StatusUnprocessableEntity {
		t.Fatalf("FBM without delivery status = %d, want 422; body=%s", missingDelivery.Code, missingDelivery.Body.String())
	}

	euBody := `{
		"country":"DE","product_name":"EU item",
		"package_length_cm":10,"package_width_cm":10,"package_height_cm":10,"weight_kg":0.5,
		"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,"sale_price_usd":100,
		"delivery_fee_usd":5,"inbound_config_fee_usd":0.5,"storage_fee_usd":0.2
	}`
	eu := perform(router, operator, http.MethodPost, "/api/v1/pricing-calculation/eu-quote", euBody)
	if eu.Code != http.StatusOK {
		t.Fatalf("EU status = %d, want 200; body=%s", eu.Code, eu.Body.String())
	}
	if !strings.Contains(eu.Body.String(), `"vat_usd":15.97`) ||
		!strings.Contains(eu.Body.String(), `"profit_after_vat_usd":43.98`) {
		t.Fatalf("EU response missing VAT values: %s", eu.Body.String())
	}

	wantCurrencies := []string{"USD", "USD", "EUR"}
	if len(store.rateCurrencies) != len(wantCurrencies) {
		t.Fatalf("rate currency lookups = %#v, want %#v", store.rateCurrencies, wantCurrencies)
	}
	for i := range wantCurrencies {
		if store.rateCurrencies[i] != wantCurrencies[i] {
			t.Fatalf("rate currency lookups = %#v, want %#v", store.rateCurrencies, wantCurrencies)
		}
	}
	wantActions := []string{
		"pricing_calculation.run.create",
		"pricing_calculation.run.create",
		"pricing_calculation.run.create_eu",
	}
	if len(auditor.Entries) != len(wantActions) {
		t.Fatalf("audit entries = %#v, want %d", auditor.Entries, len(wantActions))
	}
	for i, action := range wantActions {
		if auditor.Entries[i].Action != action {
			t.Errorf("audit[%d].Action = %q, want %q", i, auditor.Entries[i].Action, action)
		}
	}
}

func TestPricingCalculationRejectsProjectAccessBeforeCreatingRun(t *testing.T) {
	store := &pricingTestStore{latestRate: 7.2, latestMonth: "2026-10", verifyErr: ErrProjectForbidden}
	auditor := audit.NewMockService()
	router := pricingRouter(store, auditor)
	body := `{
		"country":"US","product_name":"Restricted",
		"package_length_cm":10,"package_width_cm":10,"package_height_cm":10,"weight_kg":0.5,
		"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,"sale_price_usd":20,"project_id":7
	}`

	rec := perform(router, userContext("bob", false), http.MethodPost, "/api/v1/pricing-calculation/quote", body)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body=%s", rec.Code, rec.Body.String())
	}
	if len(store.created) != 0 || len(auditor.Entries) != 0 {
		t.Fatalf("forbidden request wrote data: created=%d audits=%d", len(store.created), len(auditor.Entries))
	}
}

func TestPricingCalculationReverseRoutesUseRealSolvers(t *testing.T) {
	store := &pricingTestStore{latestRate: 7.2, latestMonth: "2026-10"}
	auditor := audit.NewMockService()
	router := pricingRouter(store, auditor)
	operator := userContext("alice", false)

	reverseBody := `{
		"country":"US","product_name":"Reverse item",
		"package_length_cm":10,"package_width_cm":8,"package_height_cm":5,"weight_kg":0.5,
		"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,"target_profit_rate":0.25
	}`
	reverse := perform(router, operator, http.MethodPost,
		"/api/v1/pricing-calculation/reverse-quote", reverseBody)
	if reverse.Code != http.StatusOK {
		t.Fatalf("reverse status = %d, want 200; body=%s", reverse.Code, reverse.Body.String())
	}
	if !strings.Contains(reverse.Body.String(), `"calculation_type":"profit_reverse"`) ||
		!strings.Contains(reverse.Body.String(), `"sale_price_usd":`) {
		t.Fatalf("reverse response missing solved result: %s", reverse.Body.String())
	}

	costBody := `{
		"country":"US","product_name":"Cost reverse item",
		"package_length_cm":10,"package_width_cm":8,"package_height_cm":5,"weight_kg":0.5,
		"first_leg_cost_rmb":5,"sale_price_usd":30,"target_profit_rate":0.2
	}`
	cost := perform(router, operator, http.MethodPost,
		"/api/v1/pricing-calculation/reverse-cost", costBody)
	if cost.Code != http.StatusOK {
		t.Fatalf("cost reverse status = %d, want 200; body=%s", cost.Code, cost.Body.String())
	}
	if !strings.Contains(cost.Body.String(), `"calculation_type":"cost_reverse"`) ||
		!strings.Contains(cost.Body.String(), `"fob_product_cost_rmb":`) {
		t.Fatalf("cost reverse response missing solved result: %s", cost.Body.String())
	}
	if len(store.created) != 2 || len(auditor.Entries) != 2 {
		t.Fatalf("created/audited = %d/%d, want 2/2", len(store.created), len(auditor.Entries))
	}
	for _, entry := range auditor.Entries {
		if entry.Action != "pricing_calculation.run.create" {
			t.Errorf("audit action = %q, want create", entry.Action)
		}
	}
}

func TestPricingCalculationAuditFailureReturns500(t *testing.T) {
	store := &pricingTestStore{latestRate: 7.2, latestMonth: "2026-10"}
	auditor := &pricingFailingAuditor{err: errors.New("audit database unavailable")}
	router := pricingRouter(store, auditor)
	body := `{
		"country":"US","product_name":"Audit failure",
		"package_length_cm":10,"package_width_cm":10,"package_height_cm":10,"weight_kg":0.5,
		"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,"sale_price_usd":20
	}`

	rec := perform(router, userContext("alice", false), http.MethodPost, "/api/v1/pricing-calculation/quote", body)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if len(store.created) != 0 || len(auditor.entries) != 1 {
		t.Fatalf("committed creates/audit attempts = %d/%d, want 0/1 after rollback", len(store.created), len(auditor.entries))
	}
}

func TestPricingCalculationListScopesNonAdminAndSerializesSnakeCase(t *testing.T) {
	store := &pricingTestStore{
		listed: []RunItem{{
			ID: 4, Country: "US", ProductName: "My run", CalculationType: "profit_calc",
			CreatedAt: "2026-11-08T00:00:00Z", UpdatedAt: "2026-11-08T00:00:00Z",
		}},
	}
	router := pricingRouter(store, audit.NewMockService())
	rec := perform(router, userContext("alice", false), http.MethodGet,
		"/api/v1/pricing-calculation/runs?page=2&page_size=20&exclude_project_id=false&country=US&keyword=run", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if store.listFilter.Operator != "alice" || store.listFilter.IsAdmin {
		t.Fatalf("list identity = %#v, want alice non-admin", store.listFilter)
	}
	if store.listFilter.Page != 2 || store.listFilter.PageSize != 20 ||
		store.listFilter.ExcludeProjectID || store.listFilter.Country != "US" ||
		store.listFilter.Keyword != "run" {
		t.Fatalf("list filter = %#v, want query parameters forwarded", store.listFilter)
	}
	var response RunListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	if response.Total != 1 || response.Page != 2 || len(response.Items) != 1 {
		t.Fatalf("list response = %#v", response)
	}
	if !strings.Contains(rec.Body.String(), `"calculation_type"`) || strings.Contains(rec.Body.String(), `"calculationType"`) {
		t.Fatalf("list response does not use snake_case: %s", rec.Body.String())
	}
}

func TestPricingCalculationDeleteOwnershipAndRecalculateAudit(t *testing.T) {
	run := testRun("alice")
	store := &pricingTestStore{run: &run, deleted: true}
	auditor := audit.NewMockService()
	router := pricingRouter(store, auditor)

	forbidden := perform(router, userContext("bob", false), http.MethodDelete,
		"/api/v1/pricing-calculation/runs/8", "")
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("foreign delete status = %d, want 403", forbidden.Code)
	}
	if store.deleteCalls != 0 {
		t.Fatalf("delete calls = %d, want 0 for foreign run", store.deleteCalls)
	}

	deleted := perform(router, userContext("alice", false), http.MethodDelete,
		"/api/v1/pricing-calculation/runs/8", "")
	if deleted.Code != http.StatusNoContent || deleted.Body.Len() != 0 {
		t.Fatalf("delete response = %d %q, want empty 204", deleted.Code, deleted.Body.String())
	}

	recalculated := perform(router, userContext("alice", false), http.MethodPost,
		"/api/v1/pricing-calculation/runs/8/recalculate", "")
	if recalculated.Code != http.StatusOK {
		t.Fatalf("recalculate status = %d, want 200; body=%s", recalculated.Code, recalculated.Body.String())
	}
	if store.updateCalls != 1 {
		t.Fatalf("update calls = %d, want 1", store.updateCalls)
	}
	if len(auditor.Entries) != 2 ||
		auditor.Entries[0].Action != "pricing_calculation.run.delete" ||
		auditor.Entries[1].Action != "pricing_calculation.run.recalculate" {
		t.Fatalf("audit entries = %#v, want delete and recalculate", auditor.Entries)
	}
}

func TestRecalculateUsesSavedCalculationType(t *testing.T) {
	fbm := testRun("alice")
	fbm.CalculationType = "fbm_calc"
	fbm.FullContainerQuantity = 100
	fbm.FullContainerPriceRMB = 10000
	fbm.DeliveryFeeUSD = 5.5
	fbmResult, err := recalculateRun(fbm)
	if err != nil {
		t.Fatalf("recalculate FBM error = %v", err)
	}
	if fbmResult.CalculationType != "fbm_calc" || fbmResult.Fees.FBAFulfillmentFeeUSD != 0 ||
		fbmResult.Fees.DeliveryFeeUSD != 5.5 {
		t.Fatalf("FBM result = %#v, want FBM fee semantics", fbmResult)
	}

	eu := testRun("alice")
	eu.Country = "DE"
	eu.CalculationType = "eu_accounting"
	eu.DeliveryFeeUSD = 5
	eu.Fees.InboundConfigFeeUSD = 0.5
	eu.Fees.StorageFeeUSD = 0.2
	euResult, err := recalculateRun(eu)
	if err != nil {
		t.Fatalf("recalculate EU error = %v", err)
	}
	if euResult.CalculationType != "eu_accounting" || euResult.Profit.VATUSD <= 0 {
		t.Fatalf("EU result = %#v, want EU VAT semantics", euResult)
	}
}

func TestRecalculationPreservesSystemExchangeRateSource(t *testing.T) {
	run := testRun("alice")
	run.USDToRMBRateSource = "system:2026-10"
	calculated, err := recalculateRun(run)
	if err != nil {
		t.Fatalf("recalculateRun() error = %v", err)
	}
	updated := applyRecalculation(run, calculated)
	if updated.USDToRMBRateSource != "system:2026-10" {
		t.Fatalf("rate source = %q, want preserved system provenance", updated.USDToRMBRateSource)
	}
}

func pricingRouter(store Store, auditor audit.Service) *chi.Mux {
	router := chi.NewRouter()
	NewRegistrar(store, auditor).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func perform(router http.Handler, ctx context.Context, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func userContext(operator string, isAdmin bool) context.Context {
	return auth.WithUserContext(context.Background(), auth.UserContext{Operator: operator, IsAdmin: isAdmin})
}

func testRun(createdBy string) RunItem {
	one := 1.0
	return RunItem{
		ID: 8, Country: "US", ProductName: "Existing run", CalculationType: "profit_calc",
		PackageLengthCM: 10, PackageWidthCM: 10, PackageHeightCM: 10, WeightKG: 0.5,
		FOBProductCostRMB: 20, FirstLegCostRMB: 5, SalePriceUSD: 20,
		CommissionRate: 0.15, AdvertisingRate: 0.12, ReturnLossRate: 0.04,
		StorageMonths: 1, InboundPlacementMode: "single_destination",
		USDToRMBRate: 7.2, USDToRMBRateSource: "manual",
		SizeTier: "large_standard", SizeTierLabel: "大号标准尺寸",
		PriceBand: "between_10_50", PriceBandLabel: "售价 $10 ~ $50",
		Weights: PricingCalculationWeights{ChargeableWeightRule: "商品重量与体积重量取大值"},
		Fees:    PricingCalculationFees{}, Profit: PricingCalculationProfit{ProfitRate: one},
		CreatedBy: &createdBy, CreatedAt: "2026-11-08T00:00:00Z", UpdatedAt: "2026-11-08T00:00:00Z",
	}
}

var _ Store = (*pricingTestStore)(nil)
