package system_management

import (
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) ListCommissionRatioOverrides(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	month, ok := parseReportMonth(w, r.URL.Query().Get("report_month"))
	if !ok {
		return
	}
	items, err := h.store.ListCommissionRatioOverrides(r.Context(), month)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]CommissionRatioOverrideItem, 0)
	}
	h.logView(
		r,
		"commission.ratio_overrides.view",
		"commission_ratio_override",
		operator,
		map[string]any{"report_month": month, "count": len(items)},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, CommissionRatioOverridesResponse{
		ReportMonth: month,
		Items:       items,
	})
}

func (h *Handler) UpsertCommissionRatioOverrides(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body UpsertCommissionRatioOverridesRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	month, ok := parseReportMonth(w, body.ReportMonth)
	if !ok {
		return
	}
	for i := range body.Items {
		item := &body.Items[i]
		item.ProjectName = strings.TrimSpace(item.ProjectName)
		item.PersonName = strings.TrimSpace(item.PersonName)
		item.IncomeCategory = strings.ToLower(strings.TrimSpace(item.IncomeCategory))
		if item.ProjectID <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
			return
		}
		if !validTextLength(item.ProjectName, 1, 255) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_name must contain 1 to 255 characters")
			return
		}
		if !validTextLength(item.PersonName, 1, 255) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "person_name must contain 1 to 255 characters")
			return
		}
		if !validIncomeCategory(item.IncomeCategory) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "income_category must be operator or assistant")
			return
		}
		if !validUnitRate(item.OverrideRatio) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "override_ratio must be between 0 and 1")
			return
		}
		reason, valid := normalizedOptionalText(item.Reason, 500)
		if !valid {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "reason must be at most 500 characters")
			return
		}
		item.Reason = reason
	}
	items, err := h.store.UpsertCommissionRatioOverrides(
		r.Context(),
		month,
		body.Items,
		operator,
	)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]CommissionRatioOverrideItem, 0)
	}
	if !h.logAction(r, audit.Entry{
		Action:     "commission.ratio_overrides.upsert",
		TargetType: "commission_ratio_override",
		TargetID:   stringPointer(month),
		Operator:   operator,
		AfterJSON: map[string]any{
			"report_month":   month,
			"incoming_items": len(body.Items),
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, CommissionRatioOverridesResponse{
		ReportMonth: month,
		Items:       items,
	})
}

func (h *Handler) ListProjectRoleAssignments(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var month *string
	if raw := normalizedQuery(r, "report_month"); raw != "" {
		normalized, valid := parseReportMonth(w, raw)
		if !valid {
			return
		}
		month = &normalized
	}
	projectID, ok := parseOptionalIntQuery(w, r, "project_id")
	if !ok {
		return
	}
	if projectID != nil && *projectID <= 0 {
		projectID = nil
	}
	items, err := h.store.ListProjectRoleAssignments(r.Context(), month, projectID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]ProjectRoleAssignmentItem, 0)
	}
	h.logView(
		r,
		"commission.role_assignments.view",
		"project_role_assignment",
		operator,
		map[string]any{
			"report_month": month,
			"project_id":   projectID,
			"count":        len(items),
		},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, ProjectRoleAssignmentsResponse{Items: items})
}

func (h *Handler) UpsertProjectRoleAssignments(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body UpsertProjectRoleAssignmentsRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	for i := range body.Items {
		item := &body.Items[i]
		fromMonth, valid := parseReportMonth(w, item.EffectiveFromMonth)
		if !valid {
			return
		}
		item.EffectiveFromMonth = fromMonth
		if item.EffectiveToMonth != nil && strings.TrimSpace(*item.EffectiveToMonth) != "" {
			toMonth, valid := parseReportMonth(w, *item.EffectiveToMonth)
			if !valid {
				return
			}
			if toMonth < fromMonth {
				httpapi.WriteDetail(
					w,
					http.StatusUnprocessableEntity,
					"effective_to_month must be >= effective_from_month",
				)
				return
			}
			item.EffectiveToMonth = &toMonth
		} else {
			item.EffectiveToMonth = nil
		}
		item.RoleType = strings.TrimSpace(item.RoleType)
		item.PersonName = strings.TrimSpace(item.PersonName)
		if item.ProjectID <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
			return
		}
		if !validTextLength(item.RoleType, 1, 32) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "role_type is required")
			return
		}
		if !validTextLength(item.PersonName, 1, 255) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "person_name is required")
			return
		}
	}
	items, err := h.store.UpsertProjectRoleAssignments(r.Context(), body.Items)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]ProjectRoleAssignmentItem, 0)
	}
	if !h.logAction(r, audit.Entry{
		Action:     "commission.role_assignments.upsert",
		TargetType: "project_role_assignment",
		Operator:   operator,
		AfterJSON:  map[string]any{"incoming_items": len(body.Items)},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ProjectRoleAssignmentsResponse{Items: items})
}
