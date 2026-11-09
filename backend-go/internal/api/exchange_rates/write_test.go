package exchange_rates

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type writeFakeStore struct {
	*fakeStore
	insertInput ExchangeRate
	insertRow   *ExchangeRate
	insertErr   error
	updateID    int64
	updateInput ExchangeRate
	updateRow   *ExchangeRate
	updateErr   error
	deleteID    int64
	deleteOK    bool
	deleteErr   error
}

func (s *writeFakeStore) Insert(_ context.Context, input ExchangeRate) (*ExchangeRate, error) {
	s.insertInput = input
	return s.insertRow, s.insertErr
}

func (s *writeFakeStore) Update(_ context.Context, id int64, input ExchangeRate) (*ExchangeRate, error) {
	s.updateID = id
	s.updateInput = input
	return s.updateRow, s.updateErr
}

func (s *writeFakeStore) Delete(_ context.Context, id int64) (bool, error) {
	s.deleteID = id
	return s.deleteOK, s.deleteErr
}

func TestCreateExchangeRateValidatesAndReturnsCreatedItem(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 123000000, time.UTC)
	store := &writeFakeStore{
		fakeStore: &fakeStore{},
		insertRow: &ExchangeRate{
			ID: 4, Currency: "USD", YearMonth: "2026-03", Rate: 7.1,
			NoteImages: []map[string]any{}, CreatedAt: createdAt, UpdatedAt: createdAt,
		},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates", strings.NewReader(
		`{"currency":"USD","year_month":"2026-3","rate":7.1}`,
	))

	NewHandler(store).CreateExchangeRate(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	if store.insertInput.Currency != "USD" || store.insertInput.YearMonth != "2026-03" ||
		store.insertInput.Rate != 7.1 || store.insertInput.NoteImages == nil {
		t.Errorf("Insert input = %#v, want normalized fields and empty image list", store.insertInput)
	}
	var got ExchangeRateItem
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID != 4 || got.Currency != "USD" || got.YearMonth != "2026-03" ||
		got.CreatedAt != "2026-11-07T01:02:03.123000Z" {
		t.Errorf("response = %#v, want created item with httpapi timestamp", got)
	}
}

func TestCreateExchangeRateRejectsDuplicateAndInvalidPayload(t *testing.T) {
	duplicate := &writeFakeStore{
		fakeStore: &fakeStore{resolveRow: &ExchangeRate{ID: 2, Currency: "USD", YearMonth: "2026-03"}},
	}
	rec := httptest.NewRecorder()
	NewHandler(duplicate).CreateExchangeRate(
		rec,
		httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates", strings.NewReader(
			`{"currency":"USD","year_month":"2026-03","rate":7.1}`,
		)),
	)
	assertResponse(t, rec, http.StatusConflict, `{"detail":"Exchange rate for this currency and month already exists"}`)

	for _, body := range []string{
		`{"currency":"USD","year_month":"2026-03","rate":0}`,
		`{"currency":"USD","year_month":"bad","rate":7.1}`,
		`{"currency":"USD","rate":7.1}`,
		`not-json`,
	} {
		t.Run(body, func(t *testing.T) {
			store := &writeFakeStore{fakeStore: &fakeStore{}}
			rec := httptest.NewRecorder()
			NewHandler(store).CreateExchangeRate(
				rec,
				httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates", strings.NewReader(body)),
			)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Errorf("status = %d, want 422; body = %s", rec.Code, rec.Body.String())
			}
			if store.insertInput.Currency != "" {
				t.Errorf("Insert called with invalid payload: %#v", store.insertInput)
			}
		})
	}
}

func TestUpdateExchangeRateMergesPartialFieldsAndDetectsConflict(t *testing.T) {
	store := &writeFakeStore{
		fakeStore: &fakeStore{
			getRow: &ExchangeRate{
				ID: 7, Currency: "USD", CurrencyName: stringPtr("US Dollar"),
				YearMonth: "2026-02", Rate: 7.0, Description: stringPtr("old"),
				NoteImages: []map[string]any{{"id": "old"}},
			},
		},
		updateRow: &ExchangeRate{ID: 7, Currency: "USD", YearMonth: "2026-03", Rate: 7.2},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/exchange-rates/7", strings.NewReader(
		`{"month":3,"rate":7.2}`,
	))
	req = withRouteParam(req, "exchange_rate_id", "7")
	NewHandler(store).UpdateExchangeRate(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.updateID != 7 || store.updateInput.Currency != "USD" ||
		store.updateInput.YearMonth != "2026-03" || store.updateInput.Rate != 7.2 ||
		store.updateInput.Description == nil || *store.updateInput.Description != "old" ||
		len(store.updateInput.NoteImages) != 1 {
		t.Errorf("Update input = %#v, want merged current values", store.updateInput)
	}

	conflict := &writeFakeStore{
		fakeStore: &fakeStore{
			getRow:     &ExchangeRate{ID: 7, Currency: "USD", YearMonth: "2026-02", Rate: 7.0},
			resolveRow: &ExchangeRate{ID: 8, Currency: "USD", YearMonth: "2026-03"},
		},
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/v1/exchange-rates/7", strings.NewReader(`{"year_month":"2026-03"}`))
	req = withRouteParam(req, "exchange_rate_id", "7")
	NewHandler(conflict).UpdateExchangeRate(rec, req)
	assertResponse(t, rec, http.StatusConflict, `{"detail":"Exchange rate for this currency and month already exists"}`)
}

func TestDeleteExchangeRateReturnsNoContentAndNotFound(t *testing.T) {
	for _, tt := range []struct {
		name       string
		deleted    bool
		wantStatus int
		wantBody   string
	}{
		{name: "deleted", deleted: true, wantStatus: http.StatusNoContent},
		{name: "missing", wantStatus: http.StatusNotFound, wantBody: `{"detail":"Exchange rate not found"}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := &writeFakeStore{
				fakeStore: &fakeStore{getRow: &ExchangeRate{ID: 9}},
				deleteOK:  tt.deleted,
			}
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodDelete, "/api/v1/exchange-rates/9", nil)
			req = withRouteParam(req, "exchange_rate_id", "9")
			NewHandler(store).DeleteExchangeRate(rec, req)
			if rec.Code != tt.wantStatus || rec.Body.String() != tt.wantBody {
				t.Errorf("response = %d %q, want %d %q", rec.Code, rec.Body.String(), tt.wantStatus, tt.wantBody)
			}
		})
	}
}

func TestExchangeRateWriteRoutesApplyMiddleware(t *testing.T) {
	store := &writeFakeStore{
		fakeStore: &fakeStore{},
		insertRow: &ExchangeRate{ID: 1, Currency: "USD", YearMonth: "2026-03"},
	}
	router := chi.NewRouter()
	NewHandler(store).RegisterWriteRoutes(router, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Write-Auth", "checked")
			next.ServeHTTP(w, r)
		})
	})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates", strings.NewReader(
		`{"currency":"USD","year_month":"2026-03","rate":7.1}`,
	)))
	if rec.Code != http.StatusCreated || rec.Header().Get("X-Write-Auth") != "checked" {
		t.Errorf("registered write route = %d, auth header %q", rec.Code, rec.Header().Get("X-Write-Auth"))
	}
}

func TestExchangeRateWriteStoreErrorsReturnInternalServerError(t *testing.T) {
	store := &writeFakeStore{fakeStore: &fakeStore{resolveErr: errors.New("db down")}}
	rec := httptest.NewRecorder()
	NewHandler(store).CreateExchangeRate(
		rec,
		httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates", strings.NewReader(
			`{"currency":"USD","year_month":"2026-03","rate":7.1}`,
		)),
	)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func assertResponse(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status || rec.Body.String() != body {
		t.Errorf("response = %d %q, want %d %q", rec.Code, rec.Body.String(), status, body)
	}
}
