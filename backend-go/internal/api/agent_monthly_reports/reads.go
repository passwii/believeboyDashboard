package agent_monthly_reports

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	projectID, ok := h.parseProjectQuery(w, r)
	if !ok {
		return
	}
	var country, month *string
	if value := strings.TrimSpace(r.URL.Query().Get("country")); value != "" {
		country = &value
	}
	if value := strings.TrimSpace(r.URL.Query().Get("month")); value != "" {
		month = &value
	}
	includeHistory, err := parseAgentMonthlyBool(
		r.URL.Query().Get("include_history"),
		false,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	items, err := h.store.ListAgentMonthlyReports(r.Context(), store.AgentMonthlyReportListFilter{
		ProjectID:      projectID,
		Country:        country,
		ReportMonth:    month,
		IncludeHistory: includeHistory,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	response := make([]MonthlyReportItem, 0, len(items))
	for _, item := range items {
		response = append(response, agentMonthlyItem(item))
	}
	writeSuccess(w, http.StatusOK, response, nil, nil)
}

func (h *Handler) FinancialSeries(w http.ResponseWriter, r *http.Request) {
	projectID, ok := h.parseProjectQuery(w, r)
	if !ok {
		return
	}
	country := strings.TrimSpace(r.URL.Query().Get("country"))
	if country == "" {
		country = "US"
	}
	var startMonth, endMonth *string
	if value := strings.TrimSpace(r.URL.Query().Get("start_month")); value != "" {
		startMonth = &value
	}
	if value := strings.TrimSpace(r.URL.Query().Get("end_month")); value != "" {
		endMonth = &value
	}
	fillMissing, err := parseAgentMonthlyBool(r.URL.Query().Get("fill_missing"), true)
	if err != nil {
		writeError(w, err)
		return
	}
	series, err := h.store.GetAgentMonthlyFinancialSeries(
		r.Context(),
		store.AgentMonthlyFinancialSeriesFilter{
			ProjectID:   projectID,
			Country:     country,
			StartMonth:  startMonth,
			EndMonth:    endMonth,
			FillMissing: fillMissing,
		},
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, series, nil, nil)
}

func (h *Handler) AccountingDetail(w http.ResponseWriter, r *http.Request) {
	filter, ok := h.parseAccountingFilter(w, r)
	if !ok {
		return
	}
	detail, err := h.store.GetAgentMonthlyAccountingDetail(r.Context(), filter)
	if err != nil {
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, detail, nil, nil)
}

func (h *Handler) ExportAccountingDetail(w http.ResponseWriter, r *http.Request) {
	filter, ok := h.parseAccountingFilter(w, r)
	if !ok {
		return
	}
	file, err := h.store.ExportAgentMonthlyAccountingDetail(
		r.Context(),
		filter,
		h.auditEntry(r, ""),
	)
	if err != nil {
		writeError(w, err)
		return
	}
	h.writeFileContent(w, file)
}

func (h *Handler) parseAccountingFilter(
	w http.ResponseWriter,
	r *http.Request,
) (store.AgentMonthlyAccountingFilter, bool) {
	projectID, ok := h.parseProjectQuery(w, r)
	if !ok {
		return store.AgentMonthlyAccountingFilter{}, false
	}
	country := strings.TrimSpace(r.URL.Query().Get("country"))
	if country == "" {
		country = "US"
	}
	month := strings.TrimSpace(r.URL.Query().Get("report_month"))
	if len(month) != 7 {
		writeValidationError(w, map[string]any{
			"loc":  []string{"query", "report_month"},
			"msg":  "report_month must be YYYY-MM",
			"type": "value_error",
		})
		return store.AgentMonthlyAccountingFilter{}, false
	}
	return store.AgentMonthlyAccountingFilter{
		ProjectID:   projectID,
		Country:     country,
		ReportMonth: month,
	}, true
}

func (h *Handler) GetDetail(w http.ResponseWriter, r *http.Request) {
	reportID, ok := h.parsePathID(w, r, "report_id")
	if !ok {
		return
	}
	detail, err := h.store.GetAgentMonthlyReport(r.Context(), reportID)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, detail.Report.ProjectID, false) {
		return
	}
	response := MonthlyReportDetail{
		Report: agentMonthlyItem(detail.Report),
		PT3:    detail.PT3,
		PT4:    detail.PT4,
	}
	writeSuccess(w, http.StatusOK, response, nil, nil)
}

func (h *Handler) DownloadReport(w http.ResponseWriter, r *http.Request) {
	reportID, ok := h.parsePathID(w, r, "report_id")
	if !ok {
		return
	}
	projectID, err := h.store.GetAgentMonthlyReportProjectID(r.Context(), reportID)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, projectID, false) {
		return
	}
	file, err := h.store.ExportAgentMonthlyReport(
		r.Context(),
		reportID,
		h.auditEntry(r, ""),
	)
	if err != nil {
		writeError(w, err)
		return
	}
	h.writeStoredFile(w, r, file)
}

func (h *Handler) ReconciliationHistory(w http.ResponseWriter, r *http.Request) {
	reportID, ok := h.parsePathID(w, r, "report_id")
	if !ok {
		return
	}
	projectID, err := h.store.GetAgentMonthlyReportProjectID(r.Context(), reportID)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, projectID, true) {
		return
	}
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 200 {
			writeValidationError(w, map[string]any{
				"loc":  []string{"query", "limit"},
				"msg":  "limit must be between 1 and 200",
				"type": "value_error",
			})
			return
		}
		limit = value
	}
	offset := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			writeValidationError(w, map[string]any{
				"loc":  []string{"query", "offset"},
				"msg":  "offset must be a non-negative integer",
				"type": "value_error",
			})
			return
		}
		offset = value
	}
	history, err := h.store.GetAgentMonthlyReconciliationHistory(
		r.Context(),
		reportID,
		limit,
		offset,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, history, nil, nil)
}
