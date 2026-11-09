package daily_analysis

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store Store
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) GetDailyAnalysis(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	query := r.URL.Query()
	projectIDStr := query.Get("project_id")
	if projectIDStr == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "field required: project_id")
		return
	}
	projectID, err := strconv.ParseInt(projectIDStr, 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a valid positive integer")
		return
	}

	startDate := strings.TrimSpace(query.Get("start_date"))
	endDate := strings.TrimSpace(query.Get("end_date"))
	if err := validateDateRange(startDate, endDate); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	country := normalizeCountry(query.Get("country"))
	var sku *string
	if s := strings.TrimSpace(query.Get("sku")); s != "" {
		sku = &s
	}

	if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return
	}

	resp, err := h.store.GetDailyAnalysis(r.Context(), projectID, country, startDate, endDate, sku)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetDailyAnalysisAll(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	query := r.URL.Query()
	projectIDsParam := strings.TrimSpace(query.Get("project_ids"))
	if projectIDsParam == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "at least one project_id is required")
		return
	}

	startDate := strings.TrimSpace(query.Get("start_date"))
	endDate := strings.TrimSpace(query.Get("end_date"))
	if err := validateDateRange(startDate, endDate); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	country := normalizeCountry(query.Get("country"))
	var sku *string
	if s := strings.TrimSpace(query.Get("sku")); s != "" {
		sku = &s
	}

	includeDetail := true
	if raw := strings.ToLower(strings.TrimSpace(query.Get("include_detail"))); raw == "false" || raw == "0" {
		includeDetail = false
	}

	var ids []int64
	if strings.ToLower(projectIDsParam) == "all" {
		accessible, err := h.store.AccessibleProjectIDs(r.Context(), identity.Operator, identity.IsAdmin)
		if err != nil {
			httpapi.WriteInternalServerError(w)
			return
		}
		ids = accessible
	} else {
		parts := strings.Split(projectIDsParam, ",")
		parsedIDs := make([]int64, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			id, err := strconv.ParseInt(part, 10, 64)
			if err != nil {
				httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_ids must be comma-separated integers")
				return
			}
			parsedIDs = append(parsedIDs, id)
		}
		if len(parsedIDs) == 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "at least one project_id is required")
			return
		}
		for _, pid := range parsedIDs {
			if err := h.store.VerifyProjectAccess(r.Context(), pid, identity.Operator, identity.IsAdmin); err != nil {
				h.writeAccessError(w, err)
				return
			}
		}
		ids = parsedIDs
	}

	normalizedIDs := deduplicateAndSort(ids)
	if len(normalizedIDs) == 0 {
		emptyResp := &DailyAnalysisAllProjectsResponse{
			SummaryRows: []DailyAnalysisSummaryRow{},
			DetailRows:  []DailyAnalysisDetailRow{},
			AvailableDates: map[string][]string{
				"sales_report":      {},
				"ad_product_report": {},
				"inventory_report":  {},
				"business_report":   {},
			},
			ProjectBreakdown: map[int64]ProjectBreakdownBlock{},
		}
		_ = httpapi.WriteJSON(w, http.StatusOK, emptyResp)
		return
	}

	resp, err := h.store.GetDailyAnalysisAll(r.Context(), normalizedIDs, country, startDate, endDate, sku, includeDetail)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetDailyAnalysisAllCountries(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	query := r.URL.Query()
	projectIDStr := query.Get("project_id")
	if projectIDStr == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "field required: project_id")
		return
	}
	projectID, err := strconv.ParseInt(projectIDStr, 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a valid positive integer")
		return
	}

	startDate := strings.TrimSpace(query.Get("start_date"))
	endDate := strings.TrimSpace(query.Get("end_date"))
	if err := validateDateRange(startDate, endDate); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return
	}

	resp, err := h.store.GetDailyAnalysisAllCountries(r.Context(), projectID, startDate, endDate)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		if errors.Is(err, ErrExchangeRateMissing) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetDailyAnalysisAllProjectsCountries(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	query := r.URL.Query()
	projectIDsParam := strings.TrimSpace(query.Get("project_ids"))
	if projectIDsParam == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "at least one project_id is required")
		return
	}

	startDate := strings.TrimSpace(query.Get("start_date"))
	endDate := strings.TrimSpace(query.Get("end_date"))
	if err := validateDateRange(startDate, endDate); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	parts := strings.Split(projectIDsParam, ",")
	parsedIDs := make([]int64, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_ids must be comma-separated integers")
			return
		}
		parsedIDs = append(parsedIDs, id)
	}
	if len(parsedIDs) == 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "at least one project_id is required")
		return
	}

	for _, pid := range parsedIDs {
		if err := h.store.VerifyProjectAccess(r.Context(), pid, identity.Operator, identity.IsAdmin); err != nil {
			h.writeAccessError(w, err)
			return
		}
	}

	normalizedIDs := deduplicateAndSort(parsedIDs)
	resp, err := h.store.GetDailyAnalysisAllProjectsCountries(r.Context(), normalizedIDs, startDate, endDate)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		if errors.Is(err, ErrExchangeRateMissing) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) writeAccessError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	default:
		httpapi.WriteInternalServerError(w)
	}
}

func validateDateRange(startDate, endDate string) error {
	if len(startDate) != 10 || len(endDate) != 10 {
		return errors.New("date must be in YYYY-MM-DD format")
	}
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return errors.New("start_date must be in YYYY-MM-DD format")
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return errors.New("end_date must be in YYYY-MM-DD format")
	}
	if start.After(end) {
		return errors.New("start_date cannot be greater than end_date")
	}
	return nil
}

func normalizeCountry(country string) string {
	c := strings.ToUpper(strings.TrimSpace(country))
	if c == "" {
		return "US"
	}
	if c == "GB" {
		return "UK"
	}
	return c
}

func deduplicateAndSort(ids []int64) []int64 {
	seen := make(map[int64]bool, len(ids))
	result := make([]int64, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}
