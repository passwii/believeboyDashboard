package new_product_calculations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type handlerStore struct {
	verifyErr  error
	listResult ListResponse
	listFilter ListFilter
	getItem    *NewProductCalculationItem
	getErr     error
	upsertItem *NewProductCalculationItem
	upsertErr  error
	projectID  int64
	projectErr error
	deleted    bool
	deleteErr  error

	verifyCalls int
	getType     string
	upsertInput CreateRequest
}

func (s *handlerStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	s.verifyCalls++
	return s.verifyErr
}

func (s *handlerStore) List(_ context.Context, filter ListFilter) (ListResponse, error) {
	s.listFilter = filter
	return s.listResult, nil
}

func (s *handlerStore) Get(_ context.Context, _ int64, _ string, calculationType string) (*NewProductCalculationItem, error) {
	s.getType = calculationType
	return s.getItem, s.getErr
}

func (s *handlerStore) Upsert(_ context.Context, input CreateRequest, _ string) (*NewProductCalculationItem, error) {
	s.upsertInput = input
	return s.upsertItem, s.upsertErr
}

func (s *handlerStore) ProjectID(context.Context, int64) (int64, error) {
	return s.projectID, s.projectErr
}

func (s *handlerStore) Delete(context.Context, int64) (bool, error) {
	return s.deleted, s.deleteErr
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

type handlerAuditor struct {
	entries []audit.Entry
	err     error
}

func (a *handlerAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return a.err
}

func (a *handlerAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return a.err
}
func (*handlerAuditor) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

func testRouter(s Store, auditor audit.Service) *chi.Mux {
	router := chi.NewRouter()
	NewRegistrar(s, auditor).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func testIdentity(admin bool, operator string) context.Context {
	return auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "test-user",
		Operator: operator,
		IsAdmin:  admin,
	})
}

func testRequest(router http.Handler, method, target, body string, admin bool, operator string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, bytes.NewBufferString(body)).WithContext(testIdentity(admin, operator))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func testItem() *NewProductCalculationItem {
	return &NewProductCalculationItem{
		ID:                 11,
		ProjectID:          7,
		ProjectName:        "北美项目",
		SKU:                "SKU-1",
		Country:            testStringPointer("US"),
		CalculationType:    "profit_calc",
		SalePriceUSD:       20,
		TargetProfitRate:   testFloatPointer(0.25),
		USDToRMBRate:       7.1,
		USDToRMBRateSource: "2026-11",
		Fees: NewProductCalculationFees{
			TotalFeeUSD:       6,
			AdvertisingFeeUSD: 2,
		},
		Profit: NewProductCalculationProfit{
			DDPCostUSD:         5,
			VATUSD:             1,
			ProfitAfterVATRate: testFloatPointer(0.2),
		},
	}
}

func TestListDefaultsPaginationAndScopesUnfilteredRequestsToOperator(t *testing.T) {
	s := &handlerStore{listResult: ListResponse{Items: []NewProductCalculationItem{*testItem()}, Total: 1}}
	rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodGet,
		"/api/v1/new-product-calculations?calculation_type=profit_calc&country=US", "", false, "林一")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET list status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if s.listFilter.Page != 1 || s.listFilter.PageSize != 200 {
		t.Errorf("pagination = (%d, %d), want (1, 200)", s.listFilter.Page, s.listFilter.PageSize)
	}
	if s.listFilter.ProjectID != nil || s.listFilter.Operator != "林一" || s.listFilter.IsAdmin {
		t.Errorf("list filter = %#v, want unrestricted project filter scoped to operator 林一", s.listFilter)
	}
	if s.listFilter.CalculationType == nil || *s.listFilter.CalculationType != "profit_calc" ||
		s.listFilter.Country == nil || *s.listFilter.Country != "US" {
		t.Errorf("list filters = %#v, want calculation_type and country filters", s.listFilter)
	}
	var body ListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if body.Total != 1 || body.Page != 1 || body.PageSize != 200 || len(body.Items) != 1 {
		t.Errorf("list response = %#v, want item and native pagination envelope", body)
	}
}

func TestListRejectsPageSizeAboveMaximum(t *testing.T) {
	rec := testRequest(testRouter(&handlerStore{}, &handlerAuditor{}), http.MethodGet,
		"/api/v1/new-product-calculations?page_size=501", "", true, "admin")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
}

func TestListProjectAccessDistinguishesForbiddenAndMissing(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want int
	}{
		{name: "forbidden", err: ErrProjectForbidden, want: http.StatusForbidden},
		{name: "missing project", err: ErrProjectNotFound, want: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &handlerStore{verifyErr: test.err}
			rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodGet,
				"/api/v1/new-product-calculations?project_id=7", "", false, "operator")
			if rec.Code != test.want {
				t.Fatalf("GET list status = %d, want %d: %s", rec.Code, test.want, rec.Body.String())
			}
			if s.verifyCalls != 1 {
				t.Errorf("VerifyProjectAccess calls = %d, want 1", s.verifyCalls)
			}
		})
	}
}

func TestGetUsesDefaultCalculationTypeAndDerivesAnchor(t *testing.T) {
	s := &handlerStore{getItem: testItem()}
	rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodGet,
		"/api/v1/new-product-calculations/7/SKU-1", "", false, "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET detail status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if s.getType != "profit_calc" {
		t.Errorf("calculation_type = %q, want profit_calc", s.getType)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode item: %v", err)
	}
	anchor, ok := body["anchor"].(map[string]any)
	if !ok {
		t.Fatalf("anchor = %#v, want derived anchor object", body["anchor"])
	}
	if anchor["breakeven_advertising_rate"] != 0.55 ||
		anchor["non_ad_fee_usd"] != 4.0 ||
		anchor["max_ad_spend_per_unit_usd"] != 11.0 ||
		anchor["target_advertising_rate"] != 0.3 {
		t.Errorf("anchor = %#v, want Python-derived values", anchor)
	}
	if anchor["breakeven_advertising_rate_after_vat"] != 0.5 {
		t.Errorf("after-VAT anchor = %#v, want 0.5", anchor["breakeven_advertising_rate_after_vat"])
	}
}

func TestAnchorRetainsTargetMarginWhenSalePriceIsNotPositive(t *testing.T) {
	item := testItem()
	item.SalePriceUSD = 0
	anchor := deriveAnchor(item)
	if anchor.BreakevenAdvertisingRate != nil ||
		anchor.TargetAdvertisingRate != nil ||
		anchor.MaxAdSpendPerUnitUSD != nil {
		t.Fatalf("zero-price anchor = %#v, want no price-derived rates or spend", anchor)
	}
	if anchor.TargetNetMargin == nil || *anchor.TargetNetMargin != 0.25 {
		t.Errorf("target_net_margin = %#v, want 0.25 even without a sale price", anchor.TargetNetMargin)
	}
}

func TestAnchorUsesDecimalHalfUpRounding(t *testing.T) {
	item := testItem()
	item.SalePriceUSD = 1.60
	item.Fees.TotalFeeUSD = 0
	item.Fees.AdvertisingFeeUSD = 0
	item.Profit.DDPCostUSD = 1.59
	item.TargetProfitRate = nil
	item.Profit.ProfitAfterVATRate = nil

	anchor := deriveAnchor(item)
	if anchor.BreakevenAdvertisingRate == nil ||
		*anchor.BreakevenAdvertisingRate != 0.0063 {
		t.Fatalf("breakeven = %#v, want decimal HALF_UP 0.0063", anchor.BreakevenAdvertisingRate)
	}
}

func TestGetReturnsProjectAndRecordNotFound(t *testing.T) {
	for _, test := range []struct {
		name       string
		verifyErr  error
		getItem    *NewProductCalculationItem
		wantStatus int
	}{
		{name: "project forbidden", verifyErr: ErrProjectForbidden, wantStatus: http.StatusForbidden},
		{name: "project missing", verifyErr: ErrProjectNotFound, wantStatus: http.StatusNotFound},
		{name: "record missing", wantStatus: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &handlerStore{verifyErr: test.verifyErr, getItem: test.getItem}
			rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodGet,
				"/api/v1/new-product-calculations/7/missing?calculation_type=profit_reverse", "", false, "operator")
			if rec.Code != test.wantStatus {
				t.Fatalf("GET detail status = %d, want %d: %s", rec.Code, test.wantStatus, rec.Body.String())
			}
			if test.verifyErr == nil && s.getType != "profit_reverse" {
				t.Errorf("calculation_type = %q, want profit_reverse", s.getType)
			}
		})
	}
}

func TestUpsertReturnsCreatedAndLogsExactAction(t *testing.T) {
	s := &handlerStore{upsertItem: testItem()}
	auditor := &handlerAuditor{}
	rec := testRequest(testRouter(s, auditor), http.MethodPost, "/api/v1/new-product-calculations",
		testCreateBody, false, "operator")
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST upsert status = %d, want 201: %s", rec.Code, rec.Body.String())
	}
	if s.upsertInput.ProjectID != 7 || s.upsertInput.CalculationType != "profit_calc" {
		t.Errorf("upsert input = %#v, want project 7 and default calculation type", s.upsertInput)
	}
	if len(auditor.entries) != 1 || auditor.entries[0].Action != "pricing_calculation.new_product_calculation.upsert" {
		t.Fatalf("audit entries = %#v, want exact upsert action", auditor.entries)
	}
	if auditor.entries[0].TargetType != "new_product_calculation" || auditor.entries[0].TargetID == nil ||
		*auditor.entries[0].TargetID != "11" {
		t.Errorf("audit target = %#v, want persisted snapshot 11", auditor.entries[0])
	}
}

func TestUpsertRejectsInvalidBodyAndReturns500OnAuditFailure(t *testing.T) {
	s := &handlerStore{upsertItem: testItem()}
	rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodPost,
		"/api/v1/new-product-calculations", `{"project_id":7}`, true, "admin")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("POST incomplete body status = %d, want 422", rec.Code)
	}
	if s.verifyCalls != 0 {
		t.Errorf("VerifyProjectAccess calls = %d, want no writes for invalid input", s.verifyCalls)
	}

	auditor := &handlerAuditor{err: errors.New("audit unavailable")}
	rec = testRequest(testRouter(s, auditor), http.MethodPost,
		"/api/v1/new-product-calculations", testCreateBody, true, "admin")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("POST audit failure status = %d, want 500", rec.Code)
	}
	if s.upsertInput.ProjectID != 0 {
		t.Errorf("upsert committed after audit failure: %#v", s.upsertInput)
	}
}

func TestUpsertRejectsNullForNonNullableDefaultedFields(t *testing.T) {
	for _, field := range []string{
		"calculation_type", "delivery_fee_usd", "inbound_config_fee_manual_usd",
		"storage_fee_manual_usd", "vat_usd", "warnings",
	} {
		t.Run(field, func(t *testing.T) {
			var body map[string]json.RawMessage
			if err := json.Unmarshal([]byte(testCreateBody), &body); err != nil {
				t.Fatalf("decode create fixture: %v", err)
			}
			body[field] = json.RawMessage("null")
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("encode create fixture: %v", err)
			}
			s := &handlerStore{upsertItem: testItem()}
			rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodPost,
				"/api/v1/new-product-calculations", string(raw), true, "admin")
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("POST null %s status = %d, want 422", field, rec.Code)
			}
			if s.verifyCalls != 0 {
				t.Errorf("VerifyProjectAccess calls = %d, want no access check after invalid body", s.verifyCalls)
			}
		})
	}
}

func TestUpsertRejectsProjectAccessErrors(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want int
	}{
		{name: "forbidden", err: ErrProjectForbidden, want: http.StatusForbidden},
		{name: "project missing", err: ErrProjectNotFound, want: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &handlerStore{verifyErr: test.err, upsertItem: testItem()}
			rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodPost,
				"/api/v1/new-product-calculations", testCreateBody, false, "operator")
			if rec.Code != test.want {
				t.Fatalf("POST upsert status = %d, want %d: %s", rec.Code, test.want, rec.Body.String())
			}
		})
	}
}

func TestUpsertMapsCalculationErrors(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want int
	}{
		{name: "missing product", err: ErrProductNotFound, want: http.StatusNotFound},
		{name: "invalid calculation", err: ErrInvalidCalculation, want: http.StatusUnprocessableEntity},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &handlerStore{upsertErr: test.err}
			rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodPost,
				"/api/v1/new-product-calculations", testCreateBody, false, "operator")
			if rec.Code != test.want {
				t.Fatalf("POST status = %d, want %d: %s", rec.Code, test.want, rec.Body.String())
			}
		})
	}
}

func TestDeleteReturns204AuditsAndHandlesAccessErrors(t *testing.T) {
	s := &handlerStore{projectID: 7, deleted: true}
	auditor := &handlerAuditor{}
	rec := testRequest(testRouter(s, auditor), http.MethodDelete,
		"/api/v1/new-product-calculations/11", "", false, "operator")
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("DELETE response = (%d, %q), want empty 204", rec.Code, rec.Body.String())
	}
	if len(auditor.entries) != 1 || auditor.entries[0].Action != "pricing_calculation.new_product_calculation.delete" {
		t.Fatalf("audit entries = %#v, want exact delete action", auditor.entries)
	}

	missing := &handlerStore{projectErr: ErrNotFound}
	rec = testRequest(testRouter(missing, &handlerAuditor{}), http.MethodDelete,
		"/api/v1/new-product-calculations/999", "", true, "admin")
	if rec.Code != http.StatusNotFound {
		t.Errorf("DELETE missing status = %d, want 404", rec.Code)
	}

	forbidden := &handlerStore{projectID: 7, verifyErr: ErrProjectForbidden}
	rec = testRequest(testRouter(forbidden, &handlerAuditor{}), http.MethodDelete,
		"/api/v1/new-product-calculations/11", "", false, "operator")
	if rec.Code != http.StatusForbidden {
		t.Errorf("DELETE forbidden status = %d, want 403", rec.Code)
	}

	auditFailure := &handlerAuditor{err: errors.New("audit unavailable")}
	rec = testRequest(testRouter(&handlerStore{projectID: 7, deleted: true}, auditFailure), http.MethodDelete,
		"/api/v1/new-product-calculations/11", "", true, "admin")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("DELETE audit failure status = %d, want 500", rec.Code)
	}
}

func TestDeleteReturns404WhenDeleteFindsNoRow(t *testing.T) {
	s := &handlerStore{projectID: 7, deleted: false}
	rec := testRequest(testRouter(s, &handlerAuditor{}), http.MethodDelete,
		"/api/v1/new-product-calculations/11", "", true, "admin")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("DELETE missing row status = %d, want 404", rec.Code)
	}
}

var testCreateBody = `{
  "project_id":7,"project_name":"北美项目","sku":"SKU-1","package_length_cm":10,
  "package_width_cm":8,"package_height_cm":4,"weight_kg":0.4,
  "fob_product_cost_rmb":30,"first_leg_cost_rmb":5,"ddp_cost_rmb":35,"ddp_cost_usd":5,
  "sale_price_usd":20,"advertising_rate":0.1,"return_loss_rate":0.04,"storage_months":1,
  "inbound_placement_mode":"single_destination","usd_to_rmb_rate":7.1,
  "usd_to_rmb_rate_source":"monthly","size_tier":"small_standard",
  "size_tier_label":"小号标准件","price_band":"under_10","price_band_label":"$10 以下",
  "longest_side_in":4,"middle_side_in":3,"shortest_side_in":2,
  "length_plus_girth_in":14,"volume_cubic_in":24,"volume_cubic_ft":0.000014,
  "product_weight_lb":0.88,"product_weight_oz":14.08,"dimensional_weight_lb":0.01,
  "chargeable_weight_lb":0.88,"chargeable_weight_oz":14.08,"chargeable_weight_rule":"实重",
  "fulfillment_fee_rule_label":"配送费规则","inbound_config_fee_rule_label":"入库配置费规则",
  "storage_fee_rule_label":"仓储费规则","referral_fee_usd":3,"advertising_fee_usd":2,
  "return_loss_usd":0.8,"fba_fulfillment_fee_usd":4,"inbound_config_fee_usd":0.3,
  "storage_fee_usd":0.2,"total_fee_usd":6,"payout_usd":14,"profit_usd":9,
  "profit_rate":0.45,"warnings":["尺寸需复核","促销期费率"]
}`

func testStringPointer(value string) *string  { return &value }
func testFloatPointer(value float64) *float64 { return &value }
