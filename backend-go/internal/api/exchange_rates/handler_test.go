package exchange_rates

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestListExchangeRatesClampsPaginationAndSerializesItems(t *testing.T) {
	createdAt := time.Date(2026, 10, 27, 1, 2, 3, 456789000, time.UTC)
	updatedAt := createdAt.Add(time.Minute)
	store := &fakeStore{
		listRows: []ExchangeRate{{
			ID:           7,
			Currency:     "USD",
			CurrencyName: stringPtr("美元"),
			YearMonth:    "2026-10",
			Rate:         7.12345678,
			Description:  stringPtr("月度汇率"),
			NoteImages: []map[string]any{{
				"id":            "image-1",
				"url":           "https://example.com/a.webp",
				"thumbnail_url": "https://example.com/a-thumb.webp",
				"r2_key":        "exchange-rate-notes/images/a.webp",
				"thumbnail_key": "exchange-rate-notes/thumbs/a.webp",
				"filename":      "a.webp",
				"content_type":  "image/webp",
				"size":          float64(123),
				"uploaded_at":   "2026-10-26T00:00:00+00:00",
			}},
			CreatedAt: createdAt,
			UpdatedAt: updatedAt,
		}},
		listTotal: 11,
	}
	handler := NewHandler(store)
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/exchange-rates?currency=USD&year_month=2026-3&page=-9&page_size=999",
		nil,
	)
	rec := httptest.NewRecorder()

	handler.ListExchangeRates(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.listCurrency == nil || *store.listCurrency != "USD" {
		t.Errorf("currency = %#v, want USD", store.listCurrency)
	}
	if store.listYearMonth == nil || *store.listYearMonth != "2026-03" {
		t.Errorf("year_month = %#v, want normalized 2026-03", store.listYearMonth)
	}
	if store.listPage != 1 || store.listPageSize != 200 {
		t.Errorf("pagination = (%d, %d), want (1, 200)", store.listPage, store.listPageSize)
	}

	var got struct {
		Items    []ExchangeRateItem `json:"items"`
		Total    int                `json:"total"`
		Page     json.Number        `json:"page"`
		PageSize int                `json:"page_size"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Total != 11 || got.Page.String() != "1" || got.PageSize != 200 || len(got.Items) != 1 {
		t.Fatalf("response = %#v, want total/page/page_size and one item", got)
	}
	item := got.Items[0]
	if item.ID != 7 || item.Currency != "USD" || item.CurrencyName == nil ||
		*item.CurrencyName != "美元" || item.YearMonth != "2026-10" {
		t.Errorf("item = %#v, want persisted exchange-rate values", item)
	}
	if math.Abs(item.Rate-7.12345678) > 1e-9 {
		t.Errorf("rate = %v, want 7.12345678", item.Rate)
	}
	if item.CreatedAt != "2026-10-27T01:02:03.456789+00:00" {
		t.Errorf("created_at = %q, want ISO-8601 with microseconds and +00:00", item.CreatedAt)
	}
	if item.UpdatedAt != "2026-10-27T01:03:03.456789+00:00" {
		t.Errorf("updated_at = %q, want ISO-8601 with microseconds and +00:00", item.UpdatedAt)
	}
	if len(item.NoteImages) != 1 || item.NoteImages[0]["filename"] != "a.webp" ||
		item.NoteImages[0]["size"] != float64(123) {
		t.Errorf("note_images = %#v, want normalized image", item.NoteImages)
	}
}

func TestListExchangeRatesReturnsEmptyArraysAndNulls(t *testing.T) {
	handler := NewHandler(&fakeStore{})
	rec := httptest.NewRecorder()

	handler.ListExchangeRates(rec, httptest.NewRequest(http.MethodGet, "/api/v1/exchange-rates", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got, want := rec.Body.String(), `{"items":[],"total":0,"page":1,"page_size":50}`; got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}

func TestExchangeRateYearMonthValidationMatchesFastAPI(t *testing.T) {
	tests := []struct {
		path   string
		status int
		body   string
	}{
		{
			path:   "/api/v1/exchange-rates?year_month=2026",
			status: http.StatusUnprocessableEntity,
			body:   `{"detail":"year_month must be YYYY-MM"}`,
		},
		{
			path:   "/api/v1/exchange-rates?year_month=abc-def",
			status: http.StatusUnprocessableEntity,
			body:   `{"detail":"year_month must be YYYY-MM"}`,
		},
		{
			path:   "/api/v1/exchange-rates?year_month=2026-13",
			status: http.StatusUnprocessableEntity,
			body:   `{"detail":"month must be between 1 and 12"}`,
		},
		{
			path:   "/api/v1/exchange-rates?year_month=1899-12",
			status: http.StatusUnprocessableEntity,
			body:   `{"detail":"year must be between 1900 and 9999"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			NewHandler(&fakeStore{}).ListExchangeRates(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
			if rec.Code != tt.status || rec.Body.String() != tt.body {
				t.Errorf("response = %d %s, want %d %s", rec.Code, rec.Body.String(), tt.status, tt.body)
			}
		})
	}
}

func TestListExchangeRatesRejectsNonIntegerPagination(t *testing.T) {
	for _, raw := range []string{"abc", "0x10", "1.5", "--5", "1__0"} {
		t.Run(raw, func(t *testing.T) {
			rec := httptest.NewRecorder()

			NewHandler(&fakeStore{}).ListExchangeRates(
				rec,
				httptest.NewRequest(
					http.MethodGet,
					"/api/v1/exchange-rates?page="+url.QueryEscape(raw),
					nil,
				),
			)

			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422; body = %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"type":"int_parsing"`) {
				t.Errorf("body = %s, want FastAPI validation error shape", rec.Body.String())
			}
		})
	}
}

func TestListExchangeRatesMatchesFastAPIRepeatedAndHugeQueryParams(t *testing.T) {
	store := &fakeStore{}
	rec := httptest.NewRecorder()
	huge := "999999999999999999999999999999999999"
	path := "/api/v1/exchange-rates?currency=USD&currency=EUR&page=+" + huge + "&page_size=" + huge

	NewHandler(store).ListExchangeRates(
		rec,
		httptest.NewRequest(http.MethodGet, path, nil),
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.listCurrency == nil || *store.listCurrency != "EUR" {
		t.Errorf("currency = %#v, want last repeated value EUR", store.listCurrency)
	}
	if store.listPage != maxInt {
		t.Errorf("page = %d, want saturating max int before offset safety", store.listPage)
	}
	if store.listPageSize != 200 {
		t.Errorf("page_size = %d, want huge positive page size clamped to 200", store.listPageSize)
	}
}

func TestResolveExchangeRateUsesLastRepeatedCurrency(t *testing.T) {
	store := &fakeStore{}
	rec := httptest.NewRecorder()

	NewHandler(store).ResolveExchangeRate(
		rec,
		httptest.NewRequest(
			http.MethodGet,
			"/api/v1/exchange-rates/resolve?currency=USD&currency=EUR&year_month=2026-10",
			nil,
		),
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.resolveCurrency != "EUR" {
		t.Errorf("currency = %q, want last repeated value EUR", store.resolveCurrency)
	}
}

func TestListExchangeRatesAcceptsPydanticIntegerSpellings(t *testing.T) {
	tests := []struct {
		page     string
		pageSize string
		wantPage int
		wantSize int
	}{
		{page: "+5", pageSize: "7", wantPage: 5, wantSize: 7},
		{page: " 5 ", pageSize: "7", wantPage: 5, wantSize: 7},
		{page: "1_000", pageSize: "2", wantPage: 1000, wantSize: 2},
		{page: "1.0", pageSize: "2", wantPage: 1, wantSize: 2},
		{page: "1.00", pageSize: "2", wantPage: 1, wantSize: 2},
	}
	for _, tt := range tests {
		t.Run(tt.page, func(t *testing.T) {
			store := &fakeStore{}
			rec := httptest.NewRecorder()
			path := "/api/v1/exchange-rates?page=" + url.QueryEscape(tt.page) +
				"&page_size=" + url.QueryEscape(tt.pageSize)
			NewHandler(store).ListExchangeRates(
				rec,
				httptest.NewRequest(http.MethodGet, path, nil),
			)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
			}
			if store.listPage != tt.wantPage || store.listPageSize != tt.wantSize {
				t.Errorf(
					"pagination = (%d, %d), want (%d, %d)",
					store.listPage,
					store.listPageSize,
					tt.wantPage,
					tt.wantSize,
				)
			}
		})
	}
}

func TestListExchangeRatesPydanticIntegerParityBounds(t *testing.T) {
	hugePositive := "999999999999999999999999999999999999"
	hugeNegative := "-999999999999999999999999999999999999"
	tests := []struct {
		name         string
		query        string
		status       int
		wantPageJSON string
		wantPage     int
		wantPageSize int
	}{
		{name: "leading underscore", query: "page=_10", status: http.StatusUnprocessableEntity},
		{name: "trailing underscore", query: "page=10_", status: http.StatusUnprocessableEntity},
		{name: "double underscore", query: "page=1__0", status: http.StatusUnprocessableEntity},
		{name: "grouped underscore", query: "page=1_000", status: http.StatusOK, wantPageJSON: "1000", wantPage: 1000, wantPageSize: 50},
		{name: "decimal zeroes", query: "page=1.00", status: http.StatusOK, wantPageJSON: "1", wantPage: 1, wantPageSize: 50},
		{name: "plus", query: "page=%2B10", status: http.StatusOK, wantPageJSON: "10", wantPage: 10, wantPageSize: 50},
		{name: "whitespace", query: "page=%2010%20", status: http.StatusOK, wantPageJSON: "10", wantPage: 10, wantPageSize: 50},
		{name: "zero clamps", query: "page=0", status: http.StatusOK, wantPageJSON: "1", wantPage: 1, wantPageSize: 50},
		{name: "negative clamps", query: "page=-1", status: http.StatusOK, wantPageJSON: "1", wantPage: 1, wantPageSize: 50},
		{name: "huge positive keeps response text", query: "page=" + hugePositive, status: http.StatusOK, wantPageJSON: hugePositive, wantPage: maxInt, wantPageSize: 50},
		{name: "huge negative clamps", query: "page=" + hugeNegative, status: http.StatusOK, wantPageJSON: "1", wantPage: 1, wantPageSize: 50},
		{name: "huge negative page size clamps", query: "page=1&page_size=" + hugeNegative, status: http.StatusOK, wantPageJSON: "1", wantPage: 1, wantPageSize: 1},
		{name: "huge positive page size clamps", query: "page=1&page_size=" + hugePositive, status: http.StatusOK, wantPageJSON: "1", wantPage: 1, wantPageSize: 200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{}
			rec := httptest.NewRecorder()
			NewHandler(store).ListExchangeRates(
				rec,
				httptest.NewRequest(http.MethodGet, "/api/v1/exchange-rates?"+tt.query, nil),
			)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.status, rec.Body.String())
			}
			if tt.status != http.StatusOK {
				return
			}
			var got map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			decoder := json.NewDecoder(strings.NewReader(rec.Body.String()))
			decoder.UseNumber()
			var numeric map[string]any
			if err := decoder.Decode(&numeric); err != nil {
				t.Fatalf("decode numeric response: %v", err)
			}
			if numeric["page"].(json.Number).String() != tt.wantPageJSON {
				t.Errorf("page JSON = %s, want %s", numeric["page"].(json.Number), tt.wantPageJSON)
			}
			if store.listPage != tt.wantPage || store.listPageSize != tt.wantPageSize {
				t.Errorf(
					"store pagination = (%d, %d), want (%d, %d)",
					store.listPage,
					store.listPageSize,
					tt.wantPage,
					tt.wantPageSize,
				)
			}
		})
	}
}

func TestResolveExchangeRateReturnsExactFallbackAndNotFound(t *testing.T) {
	tests := []struct {
		name       string
		row        *ExchangeRate
		wantSource string
		wantRate   any
	}{
		{
			name: "exact",
			row: &ExchangeRate{
				Currency:  "USD",
				YearMonth: "2026-10",
				Rate:      7.2,
			},
			wantSource: "exact",
			wantRate:   7.2,
		},
		{
			name: "fallback",
			row: &ExchangeRate{
				Currency:  "USD",
				YearMonth: "2026-09",
				Rate:      7.1,
			},
			wantSource: "fallback",
			wantRate:   7.1,
		},
		{
			name:       "not found",
			row:        nil,
			wantSource: "not_found",
			wantRate:   nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{resolveRow: tt.row}
			rec := httptest.NewRecorder()

			NewHandler(store).ResolveExchangeRate(
				rec,
				httptest.NewRequest(
					http.MethodGet,
					"/api/v1/exchange-rates/resolve?currency=+usd+&year_month=2026-10",
					nil,
				),
			)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
			}
			if store.resolveCurrency != "USD" || store.resolveYearMonth != "2026-10" {
				t.Errorf(
					"store args = (%q, %q), want (USD, 2026-10)",
					store.resolveCurrency,
					store.resolveYearMonth,
				)
			}
			var got map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			wantSearchYearMonth := "2026-10"
			wantResponseYearMonth := wantSearchYearMonth
			if tt.row != nil {
				wantResponseYearMonth = tt.row.YearMonth
			}
			if got["currency"] != "USD" || got["year_month"] != wantResponseYearMonth ||
				got["source"] != tt.wantSource {
				t.Errorf("response = %#v, want normalized source", got)
			}
			if tt.row == nil {
				if got["rate"] != nil || got["description"] != nil {
					t.Errorf("not-found response = %#v, want null rate/description", got)
				}
				images, ok := got["note_images"].([]any)
				if !ok || len(images) != 0 {
					t.Errorf("note_images = %#v, want []", got["note_images"])
				}
			}
		})
	}
}

func TestResolveExchangeRateValidation(t *testing.T) {
	tests := []struct {
		name string
		path string
		body string
	}{
		{
			name: "missing currency",
			path: "/api/v1/exchange-rates/resolve?year_month=2026-10",
			body: `"type":"missing"`,
		},
		{
			name: "missing year_month",
			path: "/api/v1/exchange-rates/resolve?currency=USD",
			body: `{"detail":"year_month is required"}`,
		},
		{
			name: "invalid year_month",
			path: "/api/v1/exchange-rates/resolve?currency=USD&year_month=2026-1-1",
			body: `{"detail":"year_month must be YYYY-MM"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			NewHandler(&fakeStore{}).ResolveExchangeRate(
				rec,
				httptest.NewRequest(http.MethodGet, tt.path, nil),
			)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422; body = %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tt.body) {
				t.Errorf("body = %s, want it to contain %s", rec.Body.String(), tt.body)
			}
		})
	}
}

func TestExchangeRateOptionsDeduplicatesCurrenciesAndSortsYears(t *testing.T) {
	store := &fakeStore{optionRows: []ExchangeRate{
		{Currency: "USD", CurrencyName: stringPtr("美元"), YearMonth: "2025-12"},
		{Currency: "USD", CurrencyName: stringPtr("美元"), YearMonth: "2026-01"},
		{Currency: "EUR", CurrencyName: nil, YearMonth: "2024-03"},
	}}
	rec := httptest.NewRecorder()

	NewHandler(store).ExchangeRateOptions(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/v1/exchange-rates/options", nil),
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got, want := rec.Body.String(), `{"currencies":[{"value":"USD","label":"USD - 美元"},{"value":"EUR","label":"EUR - EUR"}],"years":[{"value":2026,"label":"2026年"},{"value":2025,"label":"2025年"},{"value":2024,"label":"2024年"}],"months":[{"value":1,"label":"1月"},{"value":2,"label":"2月"},{"value":3,"label":"3月"},{"value":4,"label":"4月"},{"value":5,"label":"5月"},{"value":6,"label":"6月"},{"value":7,"label":"7月"},{"value":8,"label":"8月"},{"value":9,"label":"9月"},{"value":10,"label":"10月"},{"value":11,"label":"11月"},{"value":12,"label":"12月"}]}`; got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}

func TestExchangeRateOptionsReturnsEmptyCurrenciesAndYears(t *testing.T) {
	rec := httptest.NewRecorder()

	NewHandler(&fakeStore{}).ExchangeRateOptions(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/v1/exchange-rates/options", nil),
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got exchangeRateOptionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Currencies == nil || len(got.Currencies) != 0 {
		t.Errorf("currencies = %#v, want []", got.Currencies)
	}
	if got.Years == nil || len(got.Years) != 0 {
		t.Errorf("years = %#v, want []", got.Years)
	}
	if len(got.Months) != 12 {
		t.Errorf("months = %#v, want 12 entries", got.Months)
	}
}

func TestGetExchangeRateReturnsNotFoundAndItem(t *testing.T) {
	t.Run("found", func(t *testing.T) {
		store := &fakeStore{getRow: &ExchangeRate{
			ID:        7,
			Currency:  "USD",
			YearMonth: "2026-10",
			Rate:      7.2,
			CreatedAt: time.Date(2026, 10, 27, 1, 2, 3, 0, time.UTC),
			UpdatedAt: time.Date(2026, 10, 27, 1, 2, 4, 0, time.UTC),
		}}
		rec := httptest.NewRecorder()

		req := httptest.NewRequest(http.MethodGet, "/api/v1/exchange-rates/7", nil)
		req = withRouteParam(req, "exchange_rate_id", "7")
		NewHandler(store).GetExchangeRate(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
		}
		if store.getID != 7 {
			t.Errorf("store id = %d, want 7", store.getID)
		}
		if !strings.Contains(rec.Body.String(), `"note_images":[]`) {
			t.Errorf("body = %s, want empty note_images array", rec.Body.String())
		}
	})

	t.Run("not found", func(t *testing.T) {
		store := &fakeStore{}
		rec := httptest.NewRecorder()

		req := httptest.NewRequest(http.MethodGet, "/api/v1/exchange-rates/999", nil)
		req = withRouteParam(req, "exchange_rate_id", "999")
		NewHandler(store).GetExchangeRate(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		if got, want := rec.Body.String(), `{"detail":"Exchange rate not found"}`; got != want {
			t.Errorf("body = %s, want %s", got, want)
		}
	})

	t.Run("invalid id", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/exchange-rates/not-a-number", nil)
		req = withRouteParam(req, "exchange_rate_id", "not-a-number")
		NewHandler(&fakeStore{}).GetExchangeRate(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"type":"int_parsing"`) {
			t.Errorf("body = %s, want FastAPI validation shape", rec.Body.String())
		}
	})
}

func TestExchangeRateStoreErrorsReturn500Detail(t *testing.T) {
	store := &fakeStore{listErr: errors.New("database unavailable")}
	rec := httptest.NewRecorder()

	NewHandler(store).ListExchangeRates(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/v1/exchange-rates", nil),
	)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if got, want := rec.Body.String(), `{"detail":"Internal Server Error"}`; got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}

type fakeStore struct {
	listRows         []ExchangeRate
	listTotal        int
	listErr          error
	listCurrency     *string
	listYearMonth    *string
	listPage         int
	listPageSize     int
	resolveRow       *ExchangeRate
	resolveErr       error
	resolveCurrency  string
	resolveYearMonth string
	optionRows       []ExchangeRate
	optionErr        error
	getRow           *ExchangeRate
	getErr           error
	getID            int64
}

func (s *fakeStore) List(
	_ context.Context,
	currency *string,
	yearMonth *string,
	page int,
	pageSize int,
) ([]ExchangeRate, int, error) {
	s.listCurrency = currency
	s.listYearMonth = yearMonth
	s.listPage = page
	s.listPageSize = pageSize
	return s.listRows, s.listTotal, s.listErr
}

func (s *fakeStore) Resolve(
	_ context.Context,
	currency string,
	yearMonth string,
) (*ExchangeRate, error) {
	s.resolveCurrency = currency
	s.resolveYearMonth = yearMonth
	return s.resolveRow, s.resolveErr
}

func (s *fakeStore) ListOptionRows(context.Context) ([]ExchangeRate, error) {
	return s.optionRows, s.optionErr
}

func (s *fakeStore) Get(_ context.Context, id int64) (*ExchangeRate, error) {
	s.getID = id
	return s.getRow, s.getErr
}

func stringPtr(value string) *string {
	return &value
}

func withRouteParam(req *http.Request, key, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}
