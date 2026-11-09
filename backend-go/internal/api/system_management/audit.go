package system_management

import (
	"net/http"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) ListAuditLogs(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	page, ok := parsePageQuery(w, r, "page", 1, 1, 0)
	if !ok {
		return
	}
	pageSize, ok := parsePageQuery(w, r, "page_size", 20, 1, 100)
	if !ok {
		return
	}
	filter := AuditLogFilter{
		Page:       page,
		PageSize:   pageSize,
		Operator:   normalizedQuery(r, "operator"),
		Action:     normalizedQuery(r, "action"),
		TargetType: normalizedQuery(r, "target_type"),
		Result:     normalizedQuery(r, "result"),
		Keyword:    normalizedQuery(r, "keyword"),
	}
	result, err := h.store.ListAuditLogs(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if result.Items == nil {
		result.Items = make([]AuditLogItem, 0)
	}
	result.Page = page
	result.PageSize = pageSize
	logOperator := normalizedQuery(r, "operator")
	if logOperator == "" {
		logOperator = "all"
	}
	_ = operator
	_ = logOperator
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) AuditLogSummary(w http.ResponseWriter, r *http.Request) {
	_, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	filter := AuditLogFilter{
		Operator:   normalizedQuery(r, "operator"),
		Action:     normalizedQuery(r, "action"),
		TargetType: normalizedQuery(r, "target_type"),
		Result:     normalizedQuery(r, "result"),
		Keyword:    normalizedQuery(r, "keyword"),
	}
	result, err := h.store.AuditLogSummary(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if result.Modules == nil {
		result.Modules = make([]AuditModuleSummary, 0)
	}
	if result.TopActions == nil {
		result.TopActions = make([]AuditActionSummary, 0)
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) ListAgentAccessLogs(w http.ResponseWriter, r *http.Request) {
	_, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	page, ok := parsePageQuery(w, r, "page", 1, 1, 0)
	if !ok {
		return
	}
	pageSize, ok := parsePageQuery(w, r, "page_size", 50, 1, 200)
	if !ok {
		return
	}
	statusCode, ok := parseOptionalStatusQuery(w, r)
	if !ok {
		return
	}
	dateFrom, ok := parseOptionalDateQuery(w, r, "date_from")
	if !ok {
		return
	}
	dateTo, ok := parseOptionalDateQuery(w, r, "date_to")
	if !ok {
		return
	}
	projectID, ok := parseOptionalPositiveIntQuery(w, r, "project_id")
	if !ok {
		return
	}
	filter := AgentAccessLogFilter{
		Page:          page,
		PageSize:      pageSize,
		Keyword:       normalizedQuery(r, "keyword"),
		Method:        normalizedQuery(r, "method"),
		StatusCode:    statusCode,
		Result:        normalizedQuery(r, "result"),
		DateFrom:      dateFrom,
		DateTo:        dateTo,
		ProjectID:     projectID,
		OperationType: normalizedQuery(r, "operation_type"),
		Country:       normalizedQuery(r, "country"),
	}
	result, err := h.store.ListAgentAccessLogs(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if result.Items == nil {
		result.Items = make([]AgentAccessLogItem, 0)
	}
	result.Page = page
	result.PageSize = pageSize
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) AgentAccessLogSummary(w http.ResponseWriter, r *http.Request) {
	_, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	statusCode, ok := parseOptionalStatusQuery(w, r)
	if !ok {
		return
	}
	dateFrom, ok := parseOptionalDateQuery(w, r, "date_from")
	if !ok {
		return
	}
	dateTo, ok := parseOptionalDateQuery(w, r, "date_to")
	if !ok {
		return
	}
	projectID, ok := parseOptionalPositiveIntQuery(w, r, "project_id")
	if !ok {
		return
	}
	filter := AgentAccessLogFilter{
		Keyword:       normalizedQuery(r, "keyword"),
		Method:        normalizedQuery(r, "method"),
		StatusCode:    statusCode,
		Result:        normalizedQuery(r, "result"),
		DateFrom:      dateFrom,
		DateTo:        dateTo,
		ProjectID:     projectID,
		OperationType: normalizedQuery(r, "operation_type"),
		Country:       normalizedQuery(r, "country"),
	}
	result, err := h.store.AgentAccessLogSummary(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if result.TopAgents == nil {
		result.TopAgents = make([]AgentAccessSummaryItem, 0)
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) ListAgentOperationLogs(w http.ResponseWriter, r *http.Request) {
	_, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	page, ok := parsePageQuery(w, r, "page", 1, 1, 0)
	if !ok {
		return
	}
	pageSize, ok := parsePageQuery(w, r, "page_size", 50, 1, 200)
	if !ok {
		return
	}
	dateFrom, ok := parseOptionalDateQuery(w, r, "date_from")
	if !ok {
		return
	}
	dateTo, ok := parseOptionalDateQuery(w, r, "date_to")
	if !ok {
		return
	}
	projectID, ok := parseOptionalPositiveIntQuery(w, r, "project_id")
	if !ok {
		return
	}
	filter := AgentOperationLogFilter{
		Page:      page,
		PageSize:  pageSize,
		AgentID:   normalizedQuery(r, "agent_id"),
		ProjectID: projectID,
		Action:    normalizedQuery(r, "action"),
		Result:    normalizedQuery(r, "result"),
		DateFrom:  dateFrom,
		DateTo:    dateTo,
		Keyword:   normalizedQuery(r, "keyword"),
	}
	result, err := h.store.ListAgentOperationLogs(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if result.Items == nil {
		result.Items = make([]AgentOperationLogItem, 0)
	}
	result.Page = page
	result.PageSize = pageSize
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) AgentOperationLogSummary(w http.ResponseWriter, r *http.Request) {
	_, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	dateFrom, ok := parseOptionalDateQuery(w, r, "date_from")
	if !ok {
		return
	}
	dateTo, ok := parseOptionalDateQuery(w, r, "date_to")
	if !ok {
		return
	}
	projectID, ok := parseOptionalPositiveIntQuery(w, r, "project_id")
	if !ok {
		return
	}
	filter := AgentOperationLogFilter{
		AgentID:   normalizedQuery(r, "agent_id"),
		ProjectID: projectID,
		Action:    normalizedQuery(r, "action"),
		Result:    normalizedQuery(r, "result"),
		DateFrom:  dateFrom,
		DateTo:    dateTo,
		Keyword:   normalizedQuery(r, "keyword"),
	}
	result, err := h.store.AgentOperationLogSummary(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if result.TopAgents == nil {
		result.TopAgents = make([]AgentOperationSummaryItem, 0)
	}
	if result.TopActions == nil {
		result.TopActions = make([]AgentOperationActionSummaryItem, 0)
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}
