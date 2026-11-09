package digital_display

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestDigitalDisplayHandlerSuccessAndValidation(t *testing.T) {
	now := time.Date(2026, 11, 8, 3, 4, 5, 0, time.UTC)
	topReason := "有缺陷"
	store := &fakeDigitalDisplayStore{response: Response{
		ProjectID:   4,
		ProjectName: "润茗",
		Country:     "DE",
		ServerTime:  "2026-11-08",
		Sales: SalesSnapshot{
			TodayOrderQty:           3,
			TodaySalesAmount:        124.5,
			TodaySessions:           20,
			TodayOrderedSalesAmount: 300,
			PrevOrderQty:            8,
			PrevSalesAmount:         500,
			PrevSessions:            20,
		},
		SalesTrend: []SalesTrendItem{
			{Date: "2026-11-08", OrderQty: 3, SalesAmount: 124.5, Sessions: 20},
		},
		Inventory: InventorySnapshot{SKUCount: 2, OutOfStockCount: 1, AvailableQty: 30},
		Shipments: ShipmentSnapshot{InTransitCount: 1, InTransitQty: 10},
		Returns: ReturnSnapshot{
			TotalReturns:  1,
			TotalQuantity: 2,
			ReturnRate:    5,
			TopReason:     &topReason,
		},
		Ads: AdSnapshot{
			PeriodSpend:       50,
			PeriodSales:       200,
			PeriodROAS:        4,
			PeriodACOS:        25,
			PeriodCTR:         1,
			PeriodImpressions: 1000,
			PeriodClicks:      10,
		},
	}}
	handler := NewHandler(store, WithNow(func() time.Time { return now }))
	request := withDigitalDisplayURLParam(
		httptest.NewRequest(
			http.MethodGet,
			"/api/v1/digital-display/4?country=德国&days=7",
			nil,
		),
		"4",
	)
	response := httptest.NewRecorder()
	handler.GetDigitalDisplay(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", response.Code, response.Body.String())
	}
	if store.projectID != 4 || store.country != "DE" || store.days != 7 || !store.now.Equal(now) {
		t.Fatalf(
			"store call = (%d, %q, %d, %s)",
			store.projectID,
			store.country,
			store.days,
			store.now,
		)
	}
	if got := response.Body.String(); got !=
		`{"project_id":4,"project_name":"润茗","country":"DE","server_time":"2026-11-08","sales":{"today_order_qty":3,"today_sales_amount":124.5,"today_sessions":20,"today_ordered_sales_amount":300,"prev_order_qty":8,"prev_sales_amount":500,"prev_sessions":20},"sales_trend":[{"date":"2026-11-08","order_qty":3,"sales_amount":124.5,"sessions":20}],"inventory":{"sku_count":2,"out_of_stock_count":1,"available_qty":30},"shipments":{"in_transit_count":1,"in_transit_qty":10},"returns":{"total_returns":1,"total_quantity":2,"return_rate":5,"top_reason":"有缺陷"},"ads":{"period_spend":50,"period_sales":200,"period_roas":4,"period_acos":25,"period_ctr":1,"period_impressions":1000,"period_clicks":10,"period_orders":0}}` {
		t.Errorf("body = %s", got)
	}
}

func TestDigitalDisplayHandlerRejectsInvalidDaysAndMissingProject(t *testing.T) {
	t.Run("invalid days", func(t *testing.T) {
		store := &fakeDigitalDisplayStore{}
		handler := NewHandler(store)
		request := withDigitalDisplayURLParam(
			httptest.NewRequest(http.MethodGet, "/api/v1/digital-display/4?days=2", nil),
			"4",
		)
		response := httptest.NewRecorder()
		handler.GetDigitalDisplay(response, request)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422; body = %s", response.Code, response.Body.String())
		}
		if store.called {
			t.Fatal("store should not be called for invalid days")
		}
	})

	t.Run("missing project", func(t *testing.T) {
		store := &fakeDigitalDisplayStore{err: ErrProjectNotFound}
		handler := NewHandler(store)
		request := withDigitalDisplayURLParam(
			httptest.NewRequest(http.MethodGet, "/api/v1/digital-display/99", nil),
			"99",
		)
		response := httptest.NewRecorder()
		handler.GetDigitalDisplay(response, request)
		if response.Code != http.StatusNotFound || response.Body.String() != `{"detail":"项目不存在"}` {
			t.Fatalf("response = (%d, %s)", response.Code, response.Body.String())
		}
	})
}

func TestDigitalDisplayRegistrarRequiresAPIKey(t *testing.T) {
	store := &fakeDigitalDisplayStore{response: Response{SalesTrend: []SalesTrendItem{}}}
	router := chi.NewRouter()
	registrar := NewRegistrar(store)
	if got := registrar.ModuleName(); got != "digital_display" {
		t.Fatalf("module name = %q", got)
	}
	registrar.RegisterRoutes(
		router,
		auth.RequireAPIKey("master-key", "proxy-secret", nil),
	)

	for name, headers := range map[string]map[string]string{
		"missing": nil,
		"invalid": {"X-API-Key": "bad-key"},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/digital-display/4", nil)
			for key, value := range headers {
				request.Header.Set(key, value)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			want := http.StatusUnauthorized
			if name == "invalid" {
				want = http.StatusForbidden
			}
			if response.Code != want {
				t.Fatalf("status = %d, want %d; body = %s", response.Code, want, response.Body.String())
			}
		})
	}
}

type fakeDigitalDisplayStore struct {
	response  Response
	err       error
	called    bool
	projectID int64
	country   string
	days      int
	now       time.Time
}

func (s *fakeDigitalDisplayStore) BuildDigitalDisplay(
	_ context.Context,
	projectID int64,
	country string,
	days int,
	now time.Time,
) (Response, error) {
	s.called = true
	s.projectID = projectID
	s.country = country
	s.days = days
	s.now = now
	return s.response, s.err
}

func withDigitalDisplayURLParam(request *http.Request, projectID string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("project_id", projectID)
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}
