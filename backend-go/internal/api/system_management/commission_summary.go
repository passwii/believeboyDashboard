package system_management

import (
	"errors"
	"net/http"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) CommissionMonthlySummary(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	year, ok := parseYear(w, r.URL.Query().Get("year"))
	if !ok {
		return
	}
	country := optionalQuery(r, "country")
	items, err := h.store.GetCommissionMonthlySummary(r.Context(), year, country)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]CommissionYearlyMonthlySummaryItem, 0)
	}
	h.logView(
		r,
		"commission.summary.monthly.view",
		"commission_summary",
		operator,
		map[string]any{"year": year, "country": country, "count": len(items)},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, CommissionYearlyMonthlySummaryResponse{
		Year:  year,
		Items: items,
	})
}

func (h *Handler) CommissionProjectSummary(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	year, ok := parseYear(w, r.URL.Query().Get("year"))
	if !ok {
		return
	}
	country := optionalQuery(r, "country")
	items, err := h.store.GetCommissionProjectSummary(r.Context(), year, country)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]CommissionProjectYearlySummaryItem, 0)
	}
	for index := range items {
		if items[index].Months == nil {
			items[index].Months = map[string]CommissionProjectMonthlySummaryMonthItem{}
		}
	}
	h.logView(
		r,
		"commission.summary.project.view",
		"commission_summary",
		operator,
		map[string]any{"year": year, "country": country, "count": len(items)},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, CommissionProjectYearlySummaryResponse{
		Year:  year,
		Items: items,
	})
}

func (h *Handler) RecomputeCommission(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body RecomputeCommissionRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	month, ok := parseReportMonth(w, body.ReportMonth)
	if !ok {
		return
	}
	country := optionalQuery(r, "country")
	now := h.now()
	result, err := h.store.RecomputeCommission(r.Context(), RecomputeCommissionInput{
		ReportMonth: month,
		Country:     country,
		Now:         now,
	})
	if errors.Is(err, ErrExchangeRateNotFound) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "commission.bonus.recompute",
		TargetType: "commission_bonus_record",
		TargetID:   stringPointer(month),
		Operator:   operator,
		AfterJSON: map[string]any{
			"report_month":        month,
			"country":             country,
			"project_month_count": result.ProjectMonthCount,
			"record_count":        result.RecordCount,
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, RecomputeCommissionResponse{
		ReportMonth:       month,
		ProjectMonthCount: result.ProjectMonthCount,
		RecordCount:       result.RecordCount,
		LockedRecordCount: result.LockedRecordCount,
		ComputedAt:        responseTimestamp(now),
	})
}
