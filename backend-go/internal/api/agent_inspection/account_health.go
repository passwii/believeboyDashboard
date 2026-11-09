package agent_inspection

import (
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

var historyOrderByWhitelist = map[string]bool{
	"week_start": true, "project_name": true, "account_health_rating": true,
	"compliance_total": true, "submitted_at": true,
	"negative_feedback": true, "a2z_claims": true, "chargeback_claims": true,
	"late_shipment_rate": true, "pre_fulfillment_cancel_rate": true,
	"valid_tracking_rate": true, "on_time_delivery_rate": true,
	"ip_infringement": true, "ip_complaints": true,
	"product_authenticity_complaints": true, "product_condition_complaints": true,
	"food_product_safety": true, "listing_policy_violations": true,
	"restricted_product_violations": true, "review_policy_violations": true,
	"other_policy_violations": true, "regulatory_compliance": true,
}

func (h *Handler) AccountHealthPeriods(w http.ResponseWriter, r *http.Request) {
	limit, err := parseBoundedInt(r.URL.Query().Get("limit"), 20, 1, 100, "limit")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	offset, err := parseNonNegativeInt(r.URL.Query().Get("offset"), "offset")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	countries, err := normalizeCountries(r.URL.Query().Get("country"), true)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	page, err := h.store.ListPeriods(r.Context(), PeriodListFilter{
		Limit: limit, Offset: offset, Countries: countries,
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if page.Items == nil {
		page.Items = []Period{}
	}
	writeSuccess(w, page, nil)
}

func (h *Handler) AccountHealthCurrentPeriod(w http.ResponseWriter, r *http.Request) {
	if _, err := normalizeCountries(r.URL.Query().Get("country"), true); err != nil {
		writeAPIError(w, err)
		return
	}
	period, err := h.store.GetCurrentPeriod(r.Context(), h.now())
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if period == nil {
		notFoundError(w, "当前没有巡检周期（本周周期尚未创建）")
		return
	}
	writeSuccess(w, period, nil)
}

func (h *Handler) AccountHealthOverview(w http.ResponseWriter, r *http.Request) {
	periodID, ok := parsePathID(w, r, "period_id")
	if !ok {
		return
	}
	countries, err := normalizeCountries(r.URL.Query().Get("country"), true)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	allProjects, projectIDs, err := credentialProjectScope(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	overview, err := h.store.GetOverview(r.Context(), OverviewFilter{
		PeriodID: periodID, Countries: countries,
		AllProjects: allProjects, ProjectIDs: projectIDs, Now: h.now(),
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if overview == nil {
		notFoundError(w, "巡检周期不存在")
		return
	}
	if overview.Items == nil {
		overview.Items = []AccountHealthRow{}
	}
	writeSuccess(w, overview, nil)
}

func (h *Handler) AccountHealthProjectReport(w http.ResponseWriter, r *http.Request) {
	periodID, ok := parsePathID(w, r, "period_id")
	if !ok {
		return
	}
	projectID, ok := parsePathID(w, r, "project_id")
	if !ok {
		return
	}
	rawCountry := strings.TrimSpace(r.URL.Query().Get("country"))
	var country string
	if rawCountry != "" {
		normalized, err := normalizeCountries(rawCountry, false)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		if len(normalized) != 1 {
			writeAPIError(w, validationFailure("country 只接受单个站点"))
			return
		}
		country = normalized[0]
	}
	includeSummary, err := parseBool(r.URL.Query().Get("include_summary"), false, "include_summary")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	period, err := h.store.GetPeriod(r.Context(), periodID)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if period == nil {
		notFoundError(w, "巡检周期不存在")
		return
	}
	project, err := h.store.GetProject(r.Context(), projectID)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if project == nil {
		notFoundError(w, "项目不存在")
		return
	}
	if country != "" && project.Country != country {
		notFoundError(w, "项目不属于指定国家")
		return
	}
	reportCountry := country
	if reportCountry == "" {
		reportCountry = project.Country
	}
	report, err := h.store.GetReport(r.Context(), periodID, projectID, reportCountry)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if report == nil {
		notFoundError(w, "周期项目无巡检报告")
		return
	}
	row := accountHealthRow(*period, *project, report)
	payload := accountHealthMap(row)
	if includeSummary {
		payload["status_summary"] = report.StatusSummary
	}
	writeSuccess(w, payload, nil)
}

func (h *Handler) AccountHealthHistory(w http.ResponseWriter, r *http.Request) {
	limit, err := parseBoundedInt(r.URL.Query().Get("limit"), 50, 1, 200, "limit")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	offset, err := parseNonNegativeInt(r.URL.Query().Get("offset"), "offset")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	periodID, err := parseOptionalPositiveID(r.URL.Query().Get("period_id"), "period_id")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	projectID, err := parseOptionalPositiveID(r.URL.Query().Get("project_id"), "project_id")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	orderBy := strings.TrimSpace(r.URL.Query().Get("order_by"))
	if orderBy == "" {
		orderBy = "week_start"
	}
	if !historyOrderByWhitelist[orderBy] {
		writeAPIError(w, validationFailure("order_by 不在允许的排序字段白名单内"))
		return
	}
	orderDir := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("order_dir")))
	if orderDir == "" {
		orderDir = "desc"
	}
	if orderDir != "asc" && orderDir != "desc" {
		writeAPIError(w, validationFailure("order_dir must be asc or desc"))
		return
	}
	countries, err := normalizeCountries(r.URL.Query().Get("country"), true)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	allProjects, projectIDs, err := credentialProjectScope(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if projectID != nil && !allProjects {
		allowed := false
		for _, id := range projectIDs {
			if id == *projectID {
				allowed = true
				break
			}
		}
		if !allowed {
			agentauth.WriteError(
				w,
				http.StatusForbidden,
				agentauth.ErrorCodeAgentProjectOutOfScope,
				agentauth.DetailProjectNotInScope,
			)
			return
		}
	}
	page, err := h.store.ListHistory(r.Context(), HistoryFilter{
		PeriodID: periodID, ProjectID: projectID, Limit: limit, Offset: offset,
		OrderBy: orderBy, OrderDir: orderDir, Countries: countries,
		AllProjects: allProjects, ProjectIDs: projectIDs,
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if page.Items == nil {
		page.Items = []HistoryItem{}
	}
	writeSuccess(w, page, nil)
}
