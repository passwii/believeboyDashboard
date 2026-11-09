package shop_calculation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type handlerStore struct {
	verifyErr      error
	accessibleIDs  []int64
	accessibleErr  error
	listItems      []ShopCalculationItem
	listTotal      int
	listErr        error
	historyItems   []ShopCalculationItem
	historyErr     error
	appended       ShopCalculationItem
	appendErr      error
	appendRequest  ShopCalculationCreateRequest
	appendOperator string
	projectID      int64
	projectIDErr   error
	deleted        bool
	deleteErr      error
	aggregate      ShopCalculationAggregate
	aggregateErr   error
	listFilter     ShopCalculationListFilter
	historyFilter  ShopCalculationHistoryFilter
	verifyCalls    int
	listCalls      int
	historyCalls   int
	appendCalls    int
	projectIDCalls int
	deleteCalls    int
}

func (s *handlerStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	s.verifyCalls++
	return s.verifyErr
}

func (s *handlerStore) AccessibleProjectIDs(context.Context, string) ([]int64, error) {
	return s.accessibleIDs, s.accessibleErr
}

func (s *handlerStore) List(_ context.Context, filter ShopCalculationListFilter) ([]ShopCalculationItem, int, error) {
	s.listCalls++
	s.listFilter = filter
	return s.listItems, s.listTotal, s.listErr
}

func (s *handlerStore) History(_ context.Context, filter ShopCalculationHistoryFilter) ([]ShopCalculationItem, error) {
	s.historyCalls++
	s.historyFilter = filter
	return s.historyItems, s.historyErr
}

func (s *handlerStore) Append(_ context.Context, request ShopCalculationCreateRequest, operator string) (ShopCalculationItem, error) {
	s.appendCalls++
	s.appendRequest = request
	s.appendOperator = operator
	return s.appended, s.appendErr
}

func (s *handlerStore) ProjectIDForItem(context.Context, int64) (int64, error) {
	s.projectIDCalls++
	return s.projectID, s.projectIDErr
}

func (s *handlerStore) DeleteGroup(context.Context, int64) (bool, error) {
	s.deleteCalls++
	return s.deleted, s.deleteErr
}

func (s *handlerStore) AggregateCurrent(context.Context, int64, string) (ShopCalculationAggregate, error) {
	return s.aggregate, s.aggregateErr
}

func (s *handlerStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	next := *s
	if err := fn(ctx, nil, &next); err != nil {
		return err
	}
	*s = next
	return nil
}

type failingAudit struct {
	err error
}

func (a failingAudit) LogAction(context.Context, audit.Entry) error { return a.err }
func (a failingAudit) LogActionTx(context.Context, pgx.Tx, audit.Entry) error {
	return a.err
}
func (a failingAudit) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return a.err
}

func testRequest() ShopCalculationCreateRequest {
	observedAt := time.Date(2026, 11, 7, 10, 11, 12, 0, time.UTC)
	return ShopCalculationCreateRequest{
		ProjectID: 7, ProjectName: "Test Shop", SKU: "SKU-1", ASIN: stringPointer("B000000001"),
		Country: "US", AccountingType: "profit_calc",
		PackageLengthCM: 20, PackageWidthCM: 10, PackageHeightCM: 5, WeightKG: 0.5,
		FOBProductCostRMB: 50, FirstLegCostRMB: 8, DDPCostRMB: 70, DDPCostUSD: 10,
		SalePriceUSD: 30, AdvertisingRate: 0.1, ReturnLossRate: 0.04, StorageMonths: 1,
		InboundPlacementMode: "single_destination",
		USDToRMBRate:         7, USDToRMBRateSource: "manual",
		SizeTier: "small_standard", SizeTierLabel: "Small standard",
		PriceBand: "under_10", PriceBandLabel: "Under $10",
		LongestSideIn: 8, MiddleSideIn: 4, ShortestSideIn: 2,
		LengthPlusGirthIn: 20, VolumeCubicIn: 64, VolumeCubicFt: 0.037,
		ProductWeightLB: 1.1, ProductWeightOZ: 17.6, DimensionalWeightLB: 0.4,
		ChargeableWeightLB: 1.1, ChargeableWeightOZ: 17.6, ChargeableWeightRule: "actual",
		FulfillmentFeeRuleLabel: "rule-a", InboundConfigFeeRuleLabel: "rule-b",
		StorageFeeRuleLabel: "rule-c",
		ReferralFeeUSD:      4.5, AdvertisingFeeUSD: 3, ReturnLossUSD: 1.2,
		FBAFulfillmentFeeUSD: 4, InboundConfigFeeUSD: 0.5, StorageFeeUSD: 0.2,
		TotalFeeUSD: 13.4, DeliveryFeeUSD: 0.3, InboundConfigFeeManualUSD: 0.2,
		StorageFeeManualUSD: 0.1, PlatformFeeUSD: 4.5,
		PayoutUSD: 16.6, ProfitUSD: 6.6, ProfitRate: 0.22,
		VATUSD: 0, Warnings: []string{"manual check"}, Notes: stringPointer("note"),
		ObservedAt: &observedAt,
	}
}

func testItem() ShopCalculationItem {
	request := testRequest()
	observedAt := *request.ObservedAt
	return ShopCalculationItem{
		ID: 11, ProjectID: request.ProjectID, ProjectName: request.ProjectName, SKU: request.SKU,
		Country: request.Country, AccountingType: request.AccountingType,
		SalePriceUSD: request.SalePriceUSD, DDPCostRMB: request.DDPCostRMB,
		DDPCostUSD: request.DDPCostUSD,
		ObservedAt: observedAt, CreatedAt: observedAt, UpdatedAt: observedAt, Source: "manual",
		Dimensions: ShopCalculationDimensions{LongestSideIn: 8},
		Weights:    ShopCalculationWeight{ProductWeightLB: 1.1},
		Fees:       ShopCalculationFees{TotalFeeUSD: 13.4, AdvertisingFeeUSD: 3},
		Profit:     ShopCalculationProfit{DDPCostUSD: 10, ProfitUSD: 6.6, ProfitRate: 0.22},
	}
}

func testRouter(store *handlerStore, auditor audit.Service) *chi.Mux {
	router := chi.NewRouter()
	NewRegistrar(store, auditor).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func TestListWithoutProjectRestrictsNonAdminToAccessibleProjects(t *testing.T) {
	store := &handlerStore{
		accessibleIDs: []int64{2, 4},
		listItems:     []ShopCalculationItem{testItem()},
		listTotal:     1,
	}
	router := testRouter(store, nil)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shop-calculation?country=US&page=2&page_size=10", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if store.listCalls != 1 || store.listFilter.ProjectID != nil {
		t.Fatalf("list filter = %#v, calls=%d", store.listFilter, store.listCalls)
	}
	if !reflect.DeepEqual(store.listFilter.ProjectIDs, []int64{2, 4}) {
		t.Fatalf("project ids = %v, want [2 4]", store.listFilter.ProjectIDs)
	}
	if store.listFilter.Country == nil || *store.listFilter.Country != "US" ||
		store.listFilter.Page != 2 || store.listFilter.PageSize != 10 {
		t.Fatalf("query filters not forwarded: %#v", store.listFilter)
	}
	var response ShopCalculationListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Total != 1 || response.Page != 2 || response.PageSize != 10 || len(response.Items) != 1 {
		t.Fatalf("unexpected list response: %#v", response)
	}
}

func TestListRejectsForbiddenProjectBeforeReading(t *testing.T) {
	store := &handlerStore{verifyErr: ErrProjectForbidden}
	router := testRouter(store, nil)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shop-calculation?project_id=9", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || store.listCalls != 0 {
		t.Fatalf("status=%d listCalls=%d body=%s; want 403 and no read", rec.Code, store.listCalls, rec.Body.String())
	}
}

func TestListRejectsExplicitEmptyProjectAndPaginationValues(t *testing.T) {
	store := &handlerStore{}
	router := testRouter(store, nil)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{IsAdmin: true})
	for _, path := range []string{
		"/api/v1/shop-calculation?project_id=",
		"/api/v1/shop-calculation?page=",
		"/api/v1/shop-calculation?page_size=",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s status = %d, want 422", path, rec.Code)
		}
	}
	if store.listCalls != 0 {
		t.Fatalf("List called %d times for invalid query values", store.listCalls)
	}
}

func TestHistoryRequiresProjectAndForbidsUnassignedOperator(t *testing.T) {
	store := &handlerStore{verifyErr: ErrProjectForbidden}
	router := testRouter(store, nil)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/shop-calculation/history", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing project_id status = %d, want 422", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/shop-calculation/history?project_id=9&sku=SKU-1&country=US&include_deleted=true", nil).WithContext(ctx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || store.historyCalls != 0 {
		t.Fatalf("status=%d historyCalls=%d; want 403 and no read", rec.Code, store.historyCalls)
	}
}

func TestAggregateReturnsCurrentStoreTotals(t *testing.T) {
	store := &handlerStore{
		aggregate: ShopCalculationAggregate{
			RevenueUSD:         1200,
			PlatformFeesUSD:    240,
			ProcurementCostRMB: 600,
			DDPCostRMB:         4200,
			DDPCostUSD:         600,
			ProfitUSD:          360,
			GrossMarginRate:    0.3,
		},
	}
	router := testRouter(store, nil)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/shop-calculation/aggregate?project_id=7&country=us",
		nil,
	).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var got ShopCalculationAggregate
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode aggregate: %v", err)
	}
	if got.ProjectID != 7 || got.Country != "US" || got.RevenueUSD != 1200 ||
		got.PlatformFeesUSD != 240 || got.ProcurementCostRMB != 600 ||
		got.DDPCostRMB != 4200 || got.DDPCostUSD != 600 ||
		got.ProfitUSD != 360 || got.GrossMarginRate != 0.3 {
		t.Fatalf("aggregate = %#v", got)
	}
}

func TestDeleteChecksProjectAccessBeforeSoftDeleting(t *testing.T) {
	store := &handlerStore{projectID: 7, verifyErr: ErrProjectForbidden}
	router := testRouter(store, nil)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/shop-calculation/11", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || store.deleteCalls != 0 {
		t.Fatalf("status=%d deleteCalls=%d; want 403 and no mutation", rec.Code, store.deleteCalls)
	}
}

func TestCreateRejectsNullForDefaultedNonNullableFields(t *testing.T) {
	store := &handlerStore{}
	router := testRouter(store, nil)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{IsAdmin: true})
	body, err := json.Marshal(testRequest())
	if err != nil {
		t.Fatal(err)
	}
	body = bytes.Replace(body, []byte(`"accounting_type":"profit_calc"`), []byte(`"accounting_type":null`), 1)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/shop-calculation", bytes.NewReader(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity || store.appendCalls != 0 {
		t.Fatalf("status=%d appendCalls=%d body=%s; want 422 without append", rec.Code, store.appendCalls, rec.Body.String())
	}
}

func TestCreateAppendAndDeleteAuditActions(t *testing.T) {
	store := &handlerStore{
		appended:  testItem(),
		projectID: 7,
		deleted:   true,
	}
	auditor := audit.NewMockService()
	router := testRouter(store, auditor)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})

	body, err := json.Marshal(testRequest())
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/shop-calculation", strings.NewReader(string(body))).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want 201: %s", rec.Code, rec.Body.String())
	}
	if store.appendCalls != 1 || store.appendOperator != "alice" {
		t.Fatalf("append calls=%d operator=%q", store.appendCalls, store.appendOperator)
	}
	if store.appendRequest.Source != "manual" || store.appendRequest.ObservedAt == nil {
		t.Fatalf("append defaults/observed_at = %#v", store.appendRequest)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "pricing_calculation.shop_calculation.append" {
		t.Fatalf("append audit entries = %#v", auditor.Entries)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/shop-calculation/11", nil).WithContext(ctx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("DELETE response = %d %q, want empty 204", rec.Code, rec.Body.String())
	}
	if store.projectIDCalls != 1 || store.deleteCalls != 1 {
		t.Fatalf("project lookup=%d delete=%d", store.projectIDCalls, store.deleteCalls)
	}
	if len(auditor.Entries) != 2 || auditor.Entries[1].Action != "pricing_calculation.shop_calculation.delete" {
		t.Fatalf("delete audit entries = %#v", auditor.Entries)
	}
}

func TestCreateAndDeleteReturn500WhenAuditFails(t *testing.T) {
	store := &handlerStore{appended: testItem(), projectID: 7, deleted: true}
	router := testRouter(store, failingAudit{err: errors.New("audit unavailable")})
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})
	body, err := json.Marshal(testRequest())
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/shop-calculation", strings.NewReader(string(body))).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("POST status = %d, want 500", rec.Code)
	}
	if store.appendCalls != 0 {
		t.Fatalf("append commits = %d, want transaction rollback after audit failure", store.appendCalls)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/shop-calculation/11", nil).WithContext(ctx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("DELETE status = %d, want 500", rec.Code)
	}
}

func TestDeleteMissingItemReturnsNotFound(t *testing.T) {
	store := &handlerStore{projectIDErr: ErrNotFound}
	router := testRouter(store, nil)
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{IsAdmin: true})
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/shop-calculation/44", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound || store.deleteCalls != 0 {
		t.Fatalf("status=%d deleteCalls=%d; want 404 and no delete", rec.Code, store.deleteCalls)
	}
}

func TestDeriveAnchorMatchesPricingAnchorFormula(t *testing.T) {
	item := testItem()
	item.SalePriceUSD = 10
	item.Fees.TotalFeeUSD = 4.12
	item.Fees.AdvertisingFeeUSD = 0.60
	item.Profit.DDPCostUSD = 2
	item.Profit.VATUSD = 0.30
	afterVATRate := 0.1
	item.Profit.ProfitAfterVATRate = &afterVATRate

	anchor := DeriveAnchor(item)
	if anchor == nil || anchor.NonAdFeeUSD == nil || *anchor.NonAdFeeUSD != 3.52 {
		t.Fatalf("non-ad fee = %#v, want 3.52", anchor)
	}
	if anchor.BreakevenAdvertisingRate == nil || *anchor.BreakevenAdvertisingRate != 0.448 {
		t.Fatalf("breakeven = %#v, want 0.448", anchor.BreakevenAdvertisingRate)
	}
	if anchor.BreakevenAdvertisingRateAfterVAT == nil || *anchor.BreakevenAdvertisingRateAfterVAT != 0.418 {
		t.Fatalf("after-VAT breakeven = %#v, want 0.418", anchor.BreakevenAdvertisingRateAfterVAT)
	}
	if anchor.MaxAdSpendPerUnitUSD == nil || *anchor.MaxAdSpendPerUnitUSD != 4.48 {
		t.Fatalf("max ad spend = %#v, want 4.48", anchor.MaxAdSpendPerUnitUSD)
	}
	if anchor.Basis.ObservedAt == nil || anchor.Basis.USDToRMBRate == nil ||
		anchor.Basis.USDToRMBRateSource == nil {
		t.Fatalf("anchor basis missing observed rate metadata: %#v", anchor.Basis)
	}
}

func TestDeriveAnchorRoundsRatioHalfUp(t *testing.T) {
	item := testItem()
	item.SalePriceUSD = 40
	item.Fees.TotalFeeUSD = 0.01
	item.Fees.AdvertisingFeeUSD = 0
	item.Profit.DDPCostUSD = 0

	anchor := DeriveAnchor(item)
	if anchor.BreakevenAdvertisingRate == nil || *anchor.BreakevenAdvertisingRate != 0.9998 {
		t.Fatalf("breakeven = %#v, want ROUND_HALF_UP value 0.9998", anchor.BreakevenAdvertisingRate)
	}
}

func stringPointer(value string) *string { return &value }
