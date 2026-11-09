package agent

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/return_analysis"
)

func (h *Handler) GetReturnOverview(w http.ResponseWriter, r *http.Request) {
	if h.stores.Returns == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	startDate := strings.TrimSpace(r.URL.Query().Get("start_date"))
	endDate := strings.TrimSpace(r.URL.Query().Get("end_date"))
	if _, err := time.Parse("2006-01-02", startDate); err != nil {
		writeValidationError(w, "start_date 必须是 YYYY-MM-DD", nil)
		return
	}
	if _, err := time.Parse("2006-01-02", endDate); err != nil {
		writeValidationError(w, "end_date 必须是 YYYY-MM-DD", nil)
		return
	}
	resp, err := h.stores.Returns.GetReturnAnalysis(r.Context(), returnFilterFromRequest(r, projectID, startDate, endDate))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !parseBoolQuery(r, "include_comments") {
		for index := range resp.FeedbackRows {
			resp.FeedbackRows[index].CustomerComment = ""
		}
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetReturnAggregate(w http.ResponseWriter, r *http.Request) {
	if h.stores.Returns == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	period, err := parseAgentPeriod(
		r.URL.Query().Get("period"),
		optionalStringQuery(r, "start_date"),
		optionalStringQuery(r, "end_date"),
		h.options.now(),
	)
	if err != nil {
		writeValidationError(w, err.Error(), nil)
		return
	}
	resp, err := h.stores.Returns.GetReturnAnalysis(
		r.Context(),
		returnFilterFromRequest(r, projectID, period.StartDate, period.EndDate),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	limit := 50
	if parsed, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && parsed > 0 {
		limit = parsed
	}
	if limit > 500 {
		limit = 500
	}
	rows := resp.RankingRows
	if len(rows) > limit {
		rows = rows[:limit]
	}
	writeOK(w, map[string]any{
		"project_id": projectID,
		"period":     period,
		"country":    resp.Country,
		"data":       rows,
		"summary":    resp.Summary,
	}, "")
}

func (h *Handler) GetReturnRaw(w http.ResponseWriter, r *http.Request) {
	if h.stores.Returns == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	period, err := parseAgentPeriod(
		r.URL.Query().Get("period"),
		optionalStringQuery(r, "start_date"),
		optionalStringQuery(r, "end_date"),
		h.options.now(),
	)
	if err != nil {
		writeValidationError(w, err.Error(), nil)
		return
	}
	limit, offset := parseLimitOffset(r, 10000, 50000)
	rows, err := h.stores.Returns.GetRawRows(
		r.Context(),
		returnFilterFromRequest(r, projectID, period.StartDate, period.EndDate),
		limit,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	rows = paginate(rows, offset/limit+1, limit)
	writeOK(w, map[string]any{
		"project_id": projectID,
		"period":     period,
		"country":    strings.ToUpper(firstNonEmpty(r.URL.Query().Get("country"), "US")),
		"data":       rows,
		"summary": map[string]any{
			"total_rows": len(rows),
			"date_range": []string{period.StartDate, period.EndDate},
		},
	}, "")
}

func (h *Handler) GetReturnSKU(w http.ResponseWriter, r *http.Request) {
	if h.stores.Returns == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	startDate := strings.TrimSpace(r.URL.Query().Get("start_date"))
	endDate := strings.TrimSpace(r.URL.Query().Get("end_date"))
	if _, err := time.Parse("2006-01-02", startDate); err != nil {
		writeValidationError(w, "start_date 必须是 YYYY-MM-DD", nil)
		return
	}
	if _, err := time.Parse("2006-01-02", endDate); err != nil {
		writeValidationError(w, "end_date 必须是 YYYY-MM-DD", nil)
		return
	}
	sku := chiURLParam(r, "sku")
	filter := returnFilterFromRequest(r, projectID, startDate, endDate)
	filter.SKU = &sku
	resp, err := h.stores.Returns.GetReturnAnalysis(r.Context(), filter)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	for _, row := range resp.RankingRows {
		if strings.EqualFold(strings.TrimSpace(row.SKU), strings.TrimSpace(sku)) {
			writeOK(w, row, "")
			return
		}
	}
	writeOK(w, nil, "")
}

func (h *Handler) GetReturnCoverage(w http.ResponseWriter, r *http.Request) {
	if h.stores.Returns == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	country := strings.ToUpper(firstNonEmpty(r.URL.Query().Get("country"), "US"))
	startDate := h.options.now().UTC().AddDate(0, -1, 0).Format("2006-01-02")
	endDate := h.options.now().UTC().Format("2006-01-02")
	resp, err := h.stores.Returns.GetReturnAnalysis(r.Context(), return_analysis.ReturnAnalysisFilter{
		ProjectID: projectID,
		Country:   country,
		StartDate: startDate,
		EndDate:   endDate,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, map[string]any{
		"project_id":     projectID,
		"country":        country,
		"data_available": resp.Summary.DataAvailable,
		"data_span":      resp.Summary.DataSpan,
		"start_date":     startDate,
		"end_date":       endDate,
	}, "")
}

func returnFilterFromRequest(
	r *http.Request,
	projectID int64,
	startDate, endDate string,
) return_analysis.ReturnAnalysisFilter {
	return return_analysis.ReturnAnalysisFilter{
		ProjectID: projectID,
		Country:   strings.ToUpper(firstNonEmpty(r.URL.Query().Get("country"), "US")),
		StartDate: startDate,
		EndDate:   endDate,
		SKU:       optionalStringQuery(r, "sku"),
	}
}

func (h *Handler) ListReplenishmentAnalysis(w http.ResponseWriter, r *http.Request) {
	if h.stores.Replenishment == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	page, pageSize := parsePage(r, 20, 200)
	resp, err := h.stores.Replenishment.ListAnalysis(
		r.Context(),
		replenishmentFilterFromRequest(r, projectID, page, pageSize),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetReplenishmentSKU(w http.ResponseWriter, r *http.Request) {
	if h.stores.Replenishment == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	sku := strings.ToLower(strings.TrimSpace(chiURLParam(r, "sku")))
	filter := replenishmentFilterFromRequest(r, projectID, 1, 200)
	filter.Keyword = &sku
	resp, err := h.stores.Replenishment.ListAnalysis(r.Context(), filter)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	for _, item := range resp.Items {
		if strings.EqualFold(strings.TrimSpace(item.SKU), sku) {
			writeOK(w, item, "")
			return
		}
	}
	writeOK(w, nil, "")
}

func (h *Handler) GetReplenishmentSummary(w http.ResponseWriter, r *http.Request) {
	if h.stores.Replenishment == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Replenishment.ListAnalysis(
		r.Context(),
		replenishmentFilterFromRequest(r, projectID, 1, 1),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, map[string]any{
		"project_id": projectID,
		"country":    strings.ToUpper(firstNonEmpty(r.URL.Query().Get("country"), "US")),
		"as_of_date": h.options.now().UTC().Format("2006-01-02"),
		"summary":    resp.Summary,
	}, "")
}

func (h *Handler) GetReplenishmentCoverage(w http.ResponseWriter, r *http.Request) {
	if h.stores.Replenishment == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	country := strings.ToUpper(firstNonEmpty(r.URL.Query().Get("country"), "US"))
	options, err := h.stores.Replenishment.ListSnapshotOptions(r.Context(), &projectID, &country)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	analysis, err := h.stores.Replenishment.ListAnalysis(
		r.Context(),
		replenishmentFilterFromRequest(r, projectID, 1, 1),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	unknownRate := 0.0
	if analysis.Summary.SKUCount > 0 {
		unknownRate = float64(analysis.Summary.UnknownCount) / float64(analysis.Summary.SKUCount)
	}
	writeOK(w, map[string]any{
		"project_id":       projectID,
		"country":          country,
		"as_of_date":       h.options.now().UTC().Format("2006-01-02"),
		"snapshot_options": options,
		"inventory_snapshot": map[string]any{
			"available_options_count": len(options),
		},
		"unknown_rate": unknownRate,
	}, "")
}

func (h *Handler) ListReplenishmentSettings(w http.ResponseWriter, r *http.Request) {
	if h.stores.Replenishment == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Replenishment.ListAnalysis(
		r.Context(),
		replenishmentFilterFromRequest(r, projectID, 1, 200),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	skuFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("sku")))
	items := make([]inventory_replenishment.InventoryReplenishmentSettingItem, 0, len(resp.Items))
	for _, item := range resp.Items {
		if skuFilter != "" && !strings.Contains(strings.ToLower(item.SKU), skuFilter) {
			continue
		}
		items = append(items, inventory_replenishment.InventoryReplenishmentSettingItem{
			ProjectID:          item.ProjectID,
			ProjectName:        item.ProjectName,
			SKU:                item.SKU,
			Country:            item.Country,
			ASIN:               item.ASIN,
			SafetyFactor:       item.SafetyFactor,
			ProductionLeadDays: item.ProductionLeadDays,
			ShippingDays:       item.ShippingDays,
		})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].SKU < items[j].SKU })
	writeOK(w, map[string]any{"items": items}, "")
}

func replenishmentFilterFromRequest(
	r *http.Request,
	projectID int64,
	page, pageSize int,
) inventory_replenishment.ReplenishmentFilter {
	country := strings.ToUpper(firstNonEmpty(r.URL.Query().Get("country"), "US"))
	return inventory_replenishment.ReplenishmentFilter{
		ProjectID:    &projectID,
		Country:      &country,
		RiskStatus:   optionalStringQuery(r, "risk_status"),
		Keyword:      optionalStringQuery(r, "keyword"),
		SnapshotDate: optionalStringQuery(r, "report_date"),
		Page:         page,
		PageSize:     pageSize,
		Operator:     "",
		IsAdmin:      true,
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
