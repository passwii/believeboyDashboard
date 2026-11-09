package exchange_rates

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

var ErrConflict = errors.New("exchange rate already exists")

type WriteStore interface {
	Insert(context.Context, ExchangeRate) (*ExchangeRate, error)
	Update(context.Context, int64, ExchangeRate) (*ExchangeRate, error)
	Delete(context.Context, int64) (bool, error)
}

type CreateRequest struct {
	Currency     string           `json:"currency"`
	CurrencyName *string          `json:"currency_name"`
	YearMonth    *string          `json:"year_month"`
	Year         *int             `json:"year"`
	Month        *int             `json:"month"`
	Rate         float64          `json:"rate"`
	Description  *string          `json:"description"`
	NoteImages   []map[string]any `json:"note_images"`
}

type UpdateRequest struct {
	Currency     *string           `json:"currency"`
	CurrencyName *string           `json:"currency_name"`
	YearMonth    *string           `json:"year_month"`
	Year         *int              `json:"year"`
	Month        *int              `json:"month"`
	Rate         *float64          `json:"rate"`
	Description  *string           `json:"description"`
	NoteImages   *[]map[string]any `json:"note_images"`
}

func (h *Handler) CreateExchangeRate(w http.ResponseWriter, r *http.Request) {
	var request CreateRequest
	if err := decodeExchangeRateBody(r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	currency := strings.TrimSpace(request.Currency)
	if currency == "" || len(currency) > 32 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "currency is required and must be at most 32 characters")
		return
	}
	if request.Rate <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "rate must be > 0")
		return
	}
	yearMonth, err := normalizeCreateYearMonth(request.YearMonth, request.Year, request.Month)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if err := validateNoteImages(request.NoteImages); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	existing, err := h.store.Resolve(r.Context(), currency, yearMonth)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if existing != nil && existing.YearMonth == yearMonth {
		httpapi.WriteDetail(w, http.StatusConflict, "Exchange rate for this currency and month already exists")
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	value := ExchangeRate{
		Currency:     currency,
		CurrencyName: normalizeOptionalText(request.CurrencyName),
		YearMonth:    yearMonth,
		Rate:         request.Rate,
		Description:  normalizeOptionalText(request.Description),
		NoteImages:   request.NoteImages,
	}
	if value.NoteImages == nil {
		value.NoteImages = []map[string]any{}
	}
	created, err := writer.Insert(r.Context(), value)
	if errors.Is(err, ErrConflict) {
		httpapi.WriteDetail(w, http.StatusConflict, "Exchange rate for this currency and month already exists")
		return
	}
	if err != nil || created == nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, serializeItem(*created))
}

func (h *Handler) UpdateExchangeRate(w http.ResponseWriter, r *http.Request) {
	id, ok := exchangeRateID(w, r)
	if !ok {
		return
	}
	current, err := h.store.Get(r.Context(), id)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if current == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Exchange rate not found")
		return
	}
	var request UpdateRequest
	if err := decodeExchangeRateBody(r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}

	value := *current
	if request.Currency != nil {
		value.Currency = strings.TrimSpace(*request.Currency)
		if value.Currency == "" || len(value.Currency) > 32 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "currency must be between 1 and 32 characters")
			return
		}
	}
	if request.CurrencyName != nil {
		value.CurrencyName = normalizeOptionalText(request.CurrencyName)
	}
	if request.YearMonth != nil || request.Year != nil || request.Month != nil {
		yearMonth, err := normalizeUpdatedYearMonth(
			current.YearMonth,
			request.YearMonth,
			request.Year,
			request.Month,
		)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		value.YearMonth = yearMonth
	}
	if request.Rate != nil {
		if *request.Rate <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "rate must be > 0")
			return
		}
		value.Rate = *request.Rate
	}
	if request.Description != nil {
		value.Description = normalizeOptionalText(request.Description)
	}
	if request.NoteImages != nil {
		if err := validateNoteImages(*request.NoteImages); err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		value.NoteImages = *request.NoteImages
	}
	existing, err := h.store.Resolve(r.Context(), value.Currency, value.YearMonth)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if existing != nil && existing.YearMonth == value.YearMonth && existing.ID != id {
		httpapi.WriteDetail(w, http.StatusConflict, "Exchange rate for this currency and month already exists")
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	updated, err := writer.Update(r.Context(), id, value)
	if errors.Is(err, ErrConflict) {
		httpapi.WriteDetail(w, http.StatusConflict, "Exchange rate for this currency and month already exists")
		return
	}
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Exchange rate not found")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializeItem(*updated))
}

func (h *Handler) DeleteExchangeRate(w http.ResponseWriter, r *http.Request) {
	id, ok := exchangeRateID(w, r)
	if !ok {
		return
	}
	current, err := h.store.Get(r.Context(), id)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if current == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Exchange rate not found")
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	deleted, err := writer.Delete(r.Context(), id)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if !deleted {
		httpapi.WriteDetail(w, http.StatusNotFound, "Exchange rate not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) RegisterWriteRoutes(
	router chi.Router,
	authMiddleware func(http.Handler) http.Handler,
) {
	writeRouter := router
	if authMiddleware != nil {
		writeRouter = router.With(authMiddleware)
	}
	writeRouter.Post("/api/v1/exchange-rates", h.CreateExchangeRate)
	writeRouter.Put("/api/v1/exchange-rates/{exchange_rate_id}", h.UpdateExchangeRate)
	writeRouter.Delete("/api/v1/exchange-rates/{exchange_rate_id}", h.DeleteExchangeRate)
	writeRouter.Post("/api/v1/exchange-rates/upload-image", h.UploadImage)
}

func exchangeRateID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := chi.URLParam(r, "exchange_rate_id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		_ = httpapi.WriteJSON(w, http.StatusUnprocessableEntity, integerParsingError("exchange_rate_id", raw, "path"))
		return 0, false
	}
	return id, true
}

func decodeExchangeRateBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func normalizeCreateYearMonth(yearMonth *string, year, month *int) (string, error) {
	if yearMonth != nil && strings.TrimSpace(*yearMonth) != "" {
		return normalizeYearMonth(*yearMonth)
	}
	if year == nil || month == nil {
		return "", errors.New("year_month or year/month is required")
	}
	return normalizeYearMonth(strconv.Itoa(*year) + "-" + strconv.Itoa(*month))
}

func normalizeUpdatedYearMonth(
	current string,
	yearMonth *string,
	year, month *int,
) (string, error) {
	if yearMonth != nil && strings.TrimSpace(*yearMonth) != "" {
		return normalizeYearMonth(*yearMonth)
	}
	parts := strings.SplitN(current, "-", 2)
	if len(parts) != 2 {
		return "", errInvalidYearMonth
	}
	currentYear, yearErr := strconv.Atoi(parts[0])
	currentMonth, monthErr := strconv.Atoi(parts[1])
	if yearErr != nil || monthErr != nil {
		return "", errInvalidYearMonth
	}
	if year != nil {
		currentYear = *year
	}
	if month != nil {
		currentMonth = *month
	}
	return normalizeYearMonth(strconv.Itoa(currentYear) + "-" + strconv.Itoa(currentMonth))
}

func normalizeOptionalText(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func validateNoteImages(images []map[string]any) error {
	for index, image := range images {
		for _, field := range []string{"id", "url", "filename", "content_type", "uploaded_at"} {
			value, ok := image[field].(string)
			if !ok || strings.TrimSpace(value) == "" {
				return errors.New("note_images." + strconv.Itoa(index) + "." + field + " is required")
			}
		}
		size, ok := image["size"].(float64)
		if !ok || size < 0 || size != float64(int64(size)) {
			if intSize, intOK := image["size"].(int); !intOK || intSize < 0 {
				return errors.New("note_images." + strconv.Itoa(index) + ".size must be a non-negative integer")
			}
		}
	}
	return nil
}
