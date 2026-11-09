package system_management

import (
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) ListOperatorPerformance(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	month, ok := parseReportMonth(w, r.URL.Query().Get("report_month"))
	if !ok {
		return
	}
	var projectID *int64
	if raw := normalizedQuery(r, "project_id"); raw != "" {
		parsed, ok := parseOptionalIntQuery(w, r, "project_id")
		if !ok {
			return
		}
		if parsed != nil && *parsed > 0 {
			projectID = parsed
		}
	}
	items, err := h.store.ListOperatorPerformance(r.Context(), month, projectID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]OperatorPerformanceItem, 0)
	}
	h.logView(
		r,
		"operator.performance.view",
		"operator_performance_record",
		operator,
		map[string]any{
			"report_month": month,
			"project_id":   projectID,
			"count":        len(items),
		},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, OperatorPerformanceResponse{
		ReportMonth: month,
		Items:       items,
	})
}

func (h *Handler) UpsertOperatorPerformance(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body OperatorPerformanceUpsertRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	for i := range body.Items {
		item := &body.Items[i]
		month, valid := reportMonthOrDetail(item.ReportMonth)
		if !valid {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_month must be in YYYY-MM format")
			return
		}
		item.ReportMonth = month
		item.ProjectName = strings.TrimSpace(item.ProjectName)
		item.PersonName = strings.TrimSpace(item.PersonName)
		item.RoleType = strings.TrimSpace(item.RoleType)
		if item.WeekIndex < 1 || item.WeekIndex > 5 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "week_index must be between 1 and 5")
			return
		}
		if item.ProjectID <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
			return
		}
		if !validTextLength(item.ProjectName, 1, 255) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_name must contain 1 to 255 characters")
			return
		}
		if !validTextLength(item.PersonName, 1, 255) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "person_name is required")
			return
		}
		if !validTextLength(item.RoleType, 1, 32) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "role_type is required")
			return
		}
		if item.Score < 0 || item.Score > 100 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "score must be between 0 and 100")
			return
		}
		note, valid := normalizedOptionalText(item.Note, 500)
		if !valid {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "note must be at most 500 characters")
			return
		}
		item.Note = note
	}

	month, items, err := h.store.UpsertOperatorPerformance(r.Context(), body.Items, operator)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]OperatorPerformanceItem, 0)
	}
	if !h.logAction(r, audit.Entry{
		Action:     "operator.performance.upsert",
		TargetType: "operator_performance_record",
		Operator:   operator,
		AfterJSON:  map[string]any{"incoming_items": len(body.Items)},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, OperatorPerformanceResponse{
		ReportMonth: month,
		Items:       items,
	})
}

func (h *Handler) CreateClientAction(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body ClientActionRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Action = strings.TrimSpace(body.Action)
	body.TargetType = strings.TrimSpace(body.TargetType)
	if body.Result == "" {
		body.Result = "success"
	}
	body.Result = strings.ToLower(strings.TrimSpace(body.Result))
	if !validTextLength(body.Action, 1, 128) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "action must contain 1 to 128 characters")
		return
	}
	if !validTextLength(body.TargetType, 1, 64) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "target_type must contain 1 to 64 characters")
		return
	}
	if body.TargetID != nil {
		targetID := strings.TrimSpace(*body.TargetID)
		if !validTextLength(targetID, 0, 128) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "target_id must be at most 128 characters")
			return
		}
		if targetID == "" {
			body.TargetID = nil
		} else {
			body.TargetID = &targetID
		}
	}
	if body.Result != "success" && body.Result != "failure" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "result must be success or failure")
		return
	}
	if body.After != nil {
		switch body.After.(type) {
		case map[string]any, []any:
		default:
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "after must be an object, array, or null")
			return
		}
	}
	if body.ErrorMessage != nil {
		errorMessage := strings.TrimSpace(*body.ErrorMessage)
		if !validTextLength(errorMessage, 0, 4000) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "error_message must be at most 4000 characters")
			return
		}
		if errorMessage == "" {
			body.ErrorMessage = nil
		} else {
			body.ErrorMessage = &errorMessage
		}
	}
	if !h.logAction(r, audit.Entry{
		Action:       body.Action,
		TargetType:   body.TargetType,
		TargetID:     body.TargetID,
		Operator:     operator,
		Result:       body.Result,
		AfterJSON:    body.After,
		ErrorMessage: body.ErrorMessage,
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func reportMonthOrDetail(value string) (string, bool) {
	normalized := strings.TrimSpace(value)
	return normalized, reportMonthPattern.MatchString(normalized)
}
