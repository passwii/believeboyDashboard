package exchange_rates

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ExchangeRate struct {
	ID           int64
	Currency     string
	CurrencyName *string
	YearMonth    string
	Rate         float64
	Description  *string
	NoteImages   []map[string]any
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type Store interface {
	List(
		ctx context.Context,
		currency *string,
		yearMonth *string,
		page int,
		pageSize int,
	) ([]ExchangeRate, int, error)
	Resolve(ctx context.Context, currency string, yearMonth string) (*ExchangeRate, error)
	ListOptionRows(ctx context.Context) ([]ExchangeRate, error)
	Get(ctx context.Context, id int64) (*ExchangeRate, error)
}

type Handler struct {
	store Store
}

type exchangeRateListResponse struct {
	Items    []ExchangeRateItem `json:"items"`
	Total    int                `json:"total"`
	Page     pageValue          `json:"page"`
	PageSize int                `json:"page_size"`
}

type pageValue struct {
	value    int
	rawValue string
}

func (p pageValue) MarshalJSON() ([]byte, error) {
	if p.rawValue != "" {
		return []byte(p.rawValue), nil
	}
	return json.Marshal(p.value)
}

type ExchangeRateItem struct {
	ID           int64            `json:"id"`
	Currency     string           `json:"currency"`
	CurrencyName *string          `json:"currency_name"`
	YearMonth    string           `json:"year_month"`
	Rate         float64          `json:"rate"`
	Description  *string          `json:"description"`
	NoteImages   []map[string]any `json:"note_images"`
	CreatedAt    string           `json:"created_at"`
	UpdatedAt    string           `json:"updated_at"`
}

type resolveResponse struct {
	Currency    string           `json:"currency"`
	YearMonth   string           `json:"year_month"`
	Rate        *float64         `json:"rate"`
	Description *string          `json:"description"`
	NoteImages  []map[string]any `json:"note_images"`
	Source      string           `json:"source"`
}

type exchangeRateOptionsResponse struct {
	Currencies []ExchangeRateOption `json:"currencies"`
	Years      []ExchangeRateOption `json:"years"`
	Months     []ExchangeRateOption `json:"months"`
}

type ExchangeRateOption struct {
	Value any    `json:"value"`
	Label string `json:"label"`
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) ListExchangeRates(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	page, ok := parseIntegerQuery(w, lastQueryValue(query, "page"), 1, "page")
	if !ok {
		return
	}
	pageSize, ok := parseIntegerQuery(w, lastQueryValue(query, "page_size"), 50, "page_size")
	if !ok {
		return
	}
	page = max(page, 1)
	pageSize = min(max(pageSize, 1), 200)

	var yearMonth *string
	if raw := lastQueryValue(query, "year_month"); raw != "" {
		normalized, err := normalizeYearMonth(raw)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		yearMonth = &normalized
	}
	var currency *string
	if raw := lastQueryValue(query, "currency"); raw != "" {
		value := strings.TrimSpace(raw)
		currency = &value
	}

	rows, total, err := h.store.List(r.Context(), currency, yearMonth, page, pageSize)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	items := make([]ExchangeRateItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, serializeItem(row))
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, exchangeRateListResponse{
		Items:    items,
		Total:    total,
		Page:     pageResponseValue(lastQueryValue(query, "page"), page),
		PageSize: pageSize,
	})
}

func (h *Handler) ResolveExchangeRate(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	currencyValues, currencyPresent := query["currency"]
	if !currencyPresent {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, missingCurrencyError())
		return
	}
	currency := ""
	if len(currencyValues) > 0 {
		currency = currencyValues[len(currencyValues)-1]
	}
	currency = strings.ToUpper(strings.TrimSpace(currency))

	yearMonth := lastQueryValue(query, "year_month")
	if yearMonth == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "year_month is required")
		return
	}
	normalizedYearMonth, err := normalizeYearMonth(yearMonth)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	row, err := h.store.Resolve(r.Context(), currency, normalizedYearMonth)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if row == nil {
		_ = httpapi.WriteJSON(w, http.StatusOK, resolveResponse{
			Currency:   currency,
			YearMonth:  normalizedYearMonth,
			Rate:       nil,
			NoteImages: []map[string]any{},
			Source:     "not_found",
		})
		return
	}

	rate := row.Rate
	source := "fallback"
	if row.YearMonth == normalizedYearMonth {
		source = "exact"
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resolveResponse{
		Currency:    row.Currency,
		YearMonth:   row.YearMonth,
		Rate:        &rate,
		Description: row.Description,
		NoteImages:  normalizeNoteImages(row.NoteImages),
		Source:      source,
	})
}

func (h *Handler) ExchangeRateOptions(w http.ResponseWriter, r *http.Request) {
	rows, err := h.store.ListOptionRows(r.Context())
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	currencies := make([]ExchangeRateOption, 0)
	seenCurrencies := make(map[string]bool)
	seenYears := make(map[int]bool)
	for _, row := range rows {
		if !seenCurrencies[row.Currency] {
			seenCurrencies[row.Currency] = true
			labelValue := row.Currency
			if row.CurrencyName != nil && *row.CurrencyName != "" {
				labelValue = *row.CurrencyName
			}
			currencies = append(currencies, ExchangeRateOption{
				Value: row.Currency,
				Label: row.Currency + " - " + labelValue,
			})
		}
		if year, err := strconv.Atoi(strings.SplitN(row.YearMonth, "-", 2)[0]); err == nil {
			seenYears[year] = true
		}
	}

	years := make([]int, 0, len(seenYears))
	for year := range seenYears {
		years = append(years, year)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(years)))
	yearOptions := make([]ExchangeRateOption, 0, len(years))
	for _, year := range years {
		yearOptions = append(yearOptions, ExchangeRateOption{
			Value: year,
			Label: strconv.Itoa(year) + "年",
		})
	}

	months := make([]ExchangeRateOption, 0, 12)
	for month := 1; month <= 12; month++ {
		months = append(months, ExchangeRateOption{
			Value: month,
			Label: strconv.Itoa(month) + "月",
		})
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, exchangeRateOptionsResponse{
		Currencies: currencies,
		Years:      yearOptions,
		Months:     months,
	})
}

func (h *Handler) GetExchangeRate(w http.ResponseWriter, r *http.Request) {
	rawID := chi.URLParam(r, "exchange_rate_id")
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, integerParsingError("exchange_rate_id", rawID, "path"))
		return
	}

	row, err := h.store.Get(r.Context(), id)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if row == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Exchange rate not found")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializeItem(*row))
}

func serializeItem(row ExchangeRate) ExchangeRateItem {
	return ExchangeRateItem{
		ID:           row.ID,
		Currency:     row.Currency,
		CurrencyName: row.CurrencyName,
		YearMonth:    row.YearMonth,
		Rate:         row.Rate,
		Description:  row.Description,
		NoteImages:   normalizeNoteImages(row.NoteImages),
		CreatedAt:    isoformat(row.CreatedAt),
		UpdatedAt:    isoformat(row.UpdatedAt),
	}
}

func normalizeNoteImages(images []map[string]any) []map[string]any {
	if len(images) == 0 {
		return []map[string]any{}
	}
	normalized := make([]map[string]any, 0, len(images))
	for _, item := range images {
		id, idOK := item["id"].(string)
		url, urlOK := item["url"].(string)
		filename, filenameOK := item["filename"].(string)
		id = strings.TrimSpace(id)
		url = strings.TrimSpace(url)
		filename = strings.TrimSpace(filename)
		if !idOK || !urlOK || !filenameOK || id == "" || url == "" || filename == "" {
			continue
		}

		contentType, _ := item["content_type"].(string)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		uploadedAt, _ := item["uploaded_at"].(string)
		if uploadedAt == "" {
			uploadedAt = "1970-01-01T00:00:00+00:00"
		}

		normalized = append(normalized, map[string]any{
			"id":            id,
			"url":           url,
			"thumbnail_url": optionalString(item["thumbnail_url"]),
			"r2_key":        optionalString(item["r2_key"]),
			"thumbnail_key": optionalString(item["thumbnail_key"]),
			"filename":      filename,
			"content_type":  strings.TrimSpace(contentType),
			"size":          nonNegativeSize(item["size"]),
			"uploaded_at":   strings.TrimSpace(uploadedAt),
		})
	}
	return normalized
}

func optionalString(value any) *string {
	if value == nil {
		return nil
	}
	text, ok := value.(string)
	if !ok {
		return nil
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	return &text
}

func nonNegativeSize(value any) int64 {
	switch number := value.(type) {
	case float64:
		return max(int64(number), 0)
	case int:
		return max(int64(number), 0)
	case int64:
		return max(number, 0)
	case json.Number:
		parsed, err := number.Int64()
		if err != nil {
			return 0
		}
		return max(parsed, 0)
	default:
		return 0
	}
}

var (
	errInvalidYearMonth = errors.New("year_month must be YYYY-MM")
)

func normalizeYearMonth(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	parts := strings.Split(value, "-")
	if len(parts) != 2 {
		return "", errInvalidYearMonth
	}
	year, err := strconv.Atoi(parts[0])
	if err != nil {
		return "", errInvalidYearMonth
	}
	month, err := strconv.Atoi(parts[1])
	if err != nil {
		return "", errInvalidYearMonth
	}
	if year < 1900 || year > 9999 {
		return "", errors.New("year must be between 1900 and 9999")
	}
	if month < 1 || month > 12 {
		return "", errors.New("month must be between 1 and 12")
	}
	return strconv.Itoa(year) + "-" + leftPad(month, 2), nil
}

func leftPad(value, width int) string {
	raw := strconv.Itoa(value)
	for len(raw) < width {
		raw = "0" + raw
	}
	return raw
}

func parseIntegerQuery(w http.ResponseWriter, raw string, fallback int, name string) (int, bool) {
	if raw == "" {
		return fallback, true
	}
	raw = strings.TrimSpace(raw)
	value, err := strconv.Atoi(raw)
	if err != nil {
		digits := strings.TrimPrefix(raw, "+")
		if strings.Contains(digits, "__") ||
			strings.HasPrefix(digits, "_") ||
			strings.HasSuffix(digits, "_") {
			httpapi.WriteJSON(w, http.StatusUnprocessableEntity, integerParsingError(name, raw, "query"))
			return 0, false
		}
		if strings.HasPrefix(digits, "-") {
			digits = strings.TrimPrefix(digits, "-")
			digits = strings.ReplaceAll(digits, "_", "")
			if !isDigits(digits) {
				httpapi.WriteJSON(w, http.StatusUnprocessableEntity, integerParsingError(name, raw, "query"))
				return 0, false
			}
			if parsed, parseErr := strconv.Atoi(digits); parseErr == nil {
				return -parsed, true
			}
			return -maxInt, true
		}
		digits = strings.ReplaceAll(digits, "_", "")
		if dot := strings.IndexByte(digits, '.'); dot >= 0 {
			fraction := digits[dot+1:]
			if fraction != "" && strings.Trim(fraction, "0") == "" {
				digits = digits[:dot]
			}
		}
		if isDigits(digits) {
			if parsed, parseErr := strconv.Atoi(digits); parseErr == nil {
				return parsed, true
			}
			return maxInt, true
		}
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, integerParsingError(name, raw, "query"))
		return 0, false
	}
	return value, true
}

const maxInt = int(^uint(0) >> 1)

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func pageResponseValue(raw string, page int) pageValue {
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "+"))
	if raw == "" || strings.HasPrefix(raw, "-") {
		return pageValue{value: page}
	}
	digits := strings.ReplaceAll(raw, "_", "")
	if dot := strings.IndexByte(digits, '.'); dot >= 0 {
		fraction := digits[dot+1:]
		if fraction != "" && strings.Trim(fraction, "0") == "" {
			digits = digits[:dot]
		}
	}
	if isDigits(digits) && page == maxInt {
		return pageValue{rawValue: digits}
	}
	return pageValue{value: page}
}

func lastQueryValue(query url.Values, key string) string {
	values := query[key]
	if len(values) == 0 {
		return ""
	}
	return values[len(values)-1]
}

func missingCurrencyError() map[string]any {
	return map[string]any{
		"detail": []map[string]any{{
			"type":  "missing",
			"loc":   []any{"query", "currency"},
			"msg":   "Field required",
			"input": nil,
		}},
	}
}

func integerParsingError(name, input, location string) map[string]any {
	return map[string]any{
		"detail": []map[string]any{{
			"type":  "int_parsing",
			"loc":   []any{location, name},
			"msg":   "Input should be a valid integer, unable to parse string as an integer",
			"input": input,
		}},
	}
}

func isoformat(value time.Time) string {
	if value.IsZero() {
		return "0001-01-01T00:00:00+00:00"
	}
	value = value.UTC()
	base := value.Format("2006-01-02T15:04:05")
	if value.Nanosecond() != 0 {
		base += "." + formatFraction(value.Nanosecond())
	}
	return base + "+00:00"
}

func formatFraction(nanoseconds int) string {
	fraction := strings.TrimRight(leftPad(nanoseconds, 9), "0")
	for len(fraction) < 6 {
		fraction += "0"
	}
	return fraction
}
