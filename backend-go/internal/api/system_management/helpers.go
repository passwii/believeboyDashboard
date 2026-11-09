package system_management

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

var (
	ErrExchangeRateNotFound = errors.New("exchange rate not found")
	ErrNotFound             = errors.New("not found")
	reportMonthPattern      = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)
	yearPattern             = regexp.MustCompile(`^\d{4}$`)
	datePattern             = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

type Handler struct {
	store       Store
	auditor     audit.Service
	cache       CacheClearer
	databaseURL string
	now         func() time.Time
}

func newHandler(
	store Store,
	auditor audit.Service,
	optionValues ...Option,
) *Handler {
	cfg := options{now: time.Now}
	for _, option := range optionValues {
		if option != nil {
			option(&cfg)
		}
	}
	return &Handler{
		store:       store,
		auditor:     auditor,
		cache:       cfg.cache,
		databaseURL: cfg.databaseURL,
		now:         cfg.now,
	}
}

func requireAdminOperator(
	w http.ResponseWriter,
	r *http.Request,
) (*string, bool) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return nil, false
	}
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
		return nil, false
	}
	operator := strings.TrimSpace(identity.Operator)
	if operator == "" {
		operator = strings.TrimSpace(identity.Name)
	}
	if operator == "" {
		operator = strings.TrimSpace(identity.Email)
	}
	if operator == "" {
		return nil, true
	}
	return &operator, true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
	if err := decoder.Decode(target); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON body")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON body")
		return false
	}
	return true
}

func parsePageQuery(
	w http.ResponseWriter,
	r *http.Request,
	name string,
	defaultValue int,
	minimum int,
	maximum int,
) (int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return defaultValue, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || (maximum > 0 && value > maximum) {
		httpapi.WriteDetail(
			w,
			http.StatusUnprocessableEntity,
			fmt.Sprintf("%s must be an integer between %d and %d", name, minimum, maximum),
		)
		return 0, false
	}
	return value, true
}

func parseOptionalPositiveIntQuery(
	w http.ResponseWriter,
	r *http.Request,
	name string,
) (*int64, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, true
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		httpapi.WriteDetail(
			w,
			http.StatusUnprocessableEntity,
			name+" must be a positive integer",
		)
		return nil, false
	}
	return &value, true
}

func parseOptionalIntQuery(
	w http.ResponseWriter,
	r *http.Request,
	name string,
) (*int64, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, true
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		httpapi.WriteDetail(
			w,
			http.StatusUnprocessableEntity,
			name+" must be an integer",
		)
		return nil, false
	}
	return &value, true
}

func parseOptionalStatusQuery(
	w http.ResponseWriter,
	r *http.Request,
) (*int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("status_code"))
	if raw == "" {
		return nil, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 100 || value > 599 {
		httpapi.WriteDetail(
			w,
			http.StatusUnprocessableEntity,
			"status_code must be an integer between 100 and 599",
		)
		return nil, false
	}
	return &value, true
}

func parseOptionalDateQuery(
	w http.ResponseWriter,
	r *http.Request,
	name string,
) (string, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return "", true
	}
	if !datePattern.MatchString(raw) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be YYYY-MM-DD")
		return "", false
	}
	if _, err := time.Parse("2006-01-02", raw); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be YYYY-MM-DD")
		return "", false
	}
	return raw, true
}

func parseOptionalBoolQuery(
	w http.ResponseWriter,
	r *http.Request,
	name string,
	defaultValue bool,
) (bool, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return defaultValue, true
	}
	var value bool
	switch strings.ToLower(raw) {
	case "1", "true", "t", "on", "y", "yes":
		value = true
	case "0", "false", "f", "off", "n", "no":
		value = false
	default:
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be a boolean")
		return false, false
	}
	return value, true
}

func parseReportMonth(w http.ResponseWriter, value string) (string, bool) {
	normalized := strings.TrimSpace(value)
	if !reportMonthPattern.MatchString(normalized) {
		httpapi.WriteDetail(
			w,
			http.StatusUnprocessableEntity,
			"report_month must be in YYYY-MM format",
		)
		return "", false
	}
	return normalized, true
}

func parseYear(w http.ResponseWriter, value string) (string, bool) {
	normalized := strings.TrimSpace(value)
	if !yearPattern.MatchString(normalized) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "year must be in YYYY format")
		return "", false
	}
	return normalized, true
}

func normalizedQuery(r *http.Request, name string) string {
	return strings.TrimSpace(r.URL.Query().Get(name))
}

func optionalQuery(r *http.Request, name string) *string {
	value := normalizedQuery(r, name)
	if value == "" {
		return nil
	}
	return &value
}

func validTextLength(value string, minimum, maximum int) bool {
	length := utf8.RuneCountInString(value)
	return length >= minimum && length <= maximum
}

func normalizedOptionalText(value *string, maximum int) (*string, bool) {
	if value == nil {
		return nil, true
	}
	normalized := strings.TrimSpace(*value)
	if utf8.RuneCountInString(normalized) > maximum {
		return nil, false
	}
	if normalized == "" {
		return nil, true
	}
	return &normalized, true
}

func validIncomeCategory(value string) bool {
	return value == "operator" || value == "assistant"
}

func validRecordPaymentStatus(value string) bool {
	return value == "paid" || value == "unpaid"
}

func validProjectPaymentStatus(value string) bool {
	return value == "paid" || value == "partial" || value == "unpaid"
}

func validRatioSource(value string) bool {
	return value == "rule" || value == "manual"
}

func validDataStatus(value DataLifecycleStatus) bool {
	switch value {
	case DataStatusActive, DataStatusMaintenance, DataStatusReadOnly, DataStatusPaused:
		return true
	default:
		return false
	}
}

func stringPointer(value string) *string {
	return &value
}

func int64Pointer(value int64) *string {
	text := strconv.FormatInt(value, 10)
	return &text
}

func parsePathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be a positive integer")
		return 0, false
	}
	return value, true
}

func responseTimestamp(value time.Time) string {
	return systemTimestamp(value)
}

func systemTimestamp(value time.Time) string {
	return value.Local().Truncate(time.Second).Format("2006-01-02T15:04:05-07:00")
}

func (h *Handler) logAction(r *http.Request, entry audit.Entry) bool {
	if h.auditor == nil {
		return false
	}
	entry.PopulateFromRequest(r)
	return h.auditor.LogAction(r.Context(), entry) == nil
}

func (h *Handler) logView(
	r *http.Request,
	action string,
	targetType string,
	operator *string,
	after any,
) {
	if h.auditor == nil {
		return
	}
	_ = h.auditor.LogView(r.Context(), action, targetType, operator, after, r)
}

func finiteNonNegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}
