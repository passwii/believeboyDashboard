package contract

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage3APricingStore struct{}

func (stage3APricingStore) GetLatestExchangeRate(context.Context, string) (float64, string, error) {
	return 7.2, "2026-10", nil
}
func (stage3APricingStore) GetHistoricalShippingCost(context.Context, int64, string) (*float64, error) {
	return nil, nil
}
func (stage3APricingStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (stage3APricingStore) CreateRun(_ context.Context, item pricing_calculation.RunItem) (pricing_calculation.RunItem, error) {
	item.ID = 42
	item.CreatedAt = "2026-11-08T00:00:00Z"
	item.UpdatedAt = item.CreatedAt
	return item, nil
}
func (stage3APricingStore) ListRuns(context.Context, pricing_calculation.RunListFilter) ([]pricing_calculation.RunItem, int, error) {
	return []pricing_calculation.RunItem{}, 0, nil
}
func (stage3APricingStore) GetRun(context.Context, int64) (*pricing_calculation.RunItem, error) {
	return nil, nil
}
func (stage3APricingStore) DeleteRun(context.Context, int64) (bool, error) {
	return true, nil
}
func (stage3APricingStore) UpdateRun(context.Context, int64, pricing_calculation.RunItem) (*pricing_calculation.RunItem, error) {
	return nil, nil
}
func (stage3APricingStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, pricing_calculation.Store) error,
) error {
	return fn(ctx, nil, stage3APricingStore{})
}

func TestStage3APricingQuoteWireContract(t *testing.T) {
	registrar := pricing_calculation.NewRegistrar(stage3APricingStore{}, audit.NewMockService())
	if registrar.ModuleName() != "pricing_calculation" {
		t.Fatalf("ModuleName() = %q, want pricing_calculation", registrar.ModuleName())
	}
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	body := `{
		"country":"US","product_name":"Contract item",
		"package_length_cm":10,"package_width_cm":10,"package_height_cm":10,"weight_kg":0.5,
		"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,"sale_price_usd":20
	}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/pricing-calculation/quote", strings.NewReader(body))
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{Operator: "contract-user"}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
	for _, field := range []string{
		`"product_name"`,
		`"calculation_type"`,
		`"usd_to_rmb_rate_source"`,
		`"fba_fulfillment_fee_usd"`,
		`"profit_after_vat_usd"`,
		`"created_at"`,
	} {
		if !strings.Contains(response.Body.String(), field) {
			t.Errorf("response missing %s: %s", field, response.Body.String())
		}
	}
	for _, camelCase := range []string{`"productName"`, `"calculationType"`, `"createdAt"`} {
		if strings.Contains(response.Body.String(), camelCase) {
			t.Errorf("response contains %s: %s", camelCase, response.Body.String())
		}
	}

	for _, test := range []struct {
		path string
		body string
	}{
		{
			path: "/api/v1/pricing-calculation/reverse-quote",
			body: `{
				"country":"US","product_name":"Reverse",
				"package_length_cm":10,"package_width_cm":8,"package_height_cm":5,"weight_kg":0.5,
				"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,"target_profit_rate":0.25
			}`,
		},
		{
			path: "/api/v1/pricing-calculation/reverse-cost",
			body: `{
				"country":"US","product_name":"Cost reverse",
				"package_length_cm":10,"package_width_cm":8,"package_height_cm":5,"weight_kg":0.5,
				"first_leg_cost_rmb":5,"sale_price_usd":30,"target_profit_rate":0.2
			}`,
		},
	} {
		request = httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
		request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{Operator: "contract-user"}))
		response = httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Errorf("%s status = %d, want 200; body=%s", test.path, response.Code, response.Body.String())
		}
	}
}
