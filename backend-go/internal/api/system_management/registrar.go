package system_management

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(
	store Store,
	auditor audit.Service,
	options ...Option,
) httpserver.ModuleRegistrar {
	return Registrar{handler: newHandler(store, auditor, options...)}
}

func (Registrar) ModuleName() string {
	return "system_management"
}

func (registrar Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	if requireAPIKey == nil {
		requireAPIKey = func(next http.Handler) http.Handler { return next }
	}
	handler := registrar.handler
	route := func(method string, path string, target http.HandlerFunc) {
		switch method {
		case http.MethodGet:
			router.With(requireAPIKey).Get(path, target)
		case http.MethodPost:
			router.With(requireAPIKey).Post(path, target)
		case http.MethodPatch:
			router.With(requireAPIKey).Patch(path, target)
		}
	}

	route(http.MethodGet, "/api/v1/system-management/audit-logs", handler.ListAuditLogs)
	route(http.MethodGet, "/api/v1/system-management/audit-logs/summary", handler.AuditLogSummary)
	route(http.MethodGet, "/api/v1/system-management/agent-access-logs", handler.ListAgentAccessLogs)
	route(http.MethodGet, "/api/v1/system-management/agent-access-logs/summary", handler.AgentAccessLogSummary)
	route(http.MethodGet, "/api/v1/system-management/agent-operation-logs", handler.ListAgentOperationLogs)
	route(http.MethodGet, "/api/v1/system-management/agent-operation-logs/summary", handler.AgentOperationLogSummary)
	route(http.MethodGet, "/api/v1/system-management/operator-management/performance", handler.ListOperatorPerformance)
	route(http.MethodPost, "/api/v1/system-management/operator-management/performance/upsert", handler.UpsertOperatorPerformance)
	route(http.MethodPost, "/api/v1/system-management/operation-audit-logs/client-actions", handler.CreateClientAction)
	route(http.MethodGet, "/api/v1/system-management/data-management/status", handler.DataManagementStatus)
	route(http.MethodGet, "/api/v1/system-management/data-management/overview", handler.DataManagementOverview)
	route(http.MethodPatch, "/api/v1/system-management/data-management/data-status", handler.UpdateDataStatus)
	route(http.MethodPost, "/api/v1/system-management/cache/clear-all", handler.ClearAllCaches)
	route(http.MethodPost, "/api/v1/system-management/commission-management/records/upsert", handler.UpsertCommissionRecords)
	route(http.MethodGet, "/api/v1/system-management/commission-management/records", handler.ListCommissionRecords)
	route(http.MethodPatch, "/api/v1/system-management/commission-management/records/{record_id}/payment-status", handler.UpdateCommissionRecordPayment)
	route(http.MethodGet, "/api/v1/system-management/commission-management/project-months", handler.ListCommissionProjectMonths)
	route(http.MethodPatch, "/api/v1/system-management/commission-management/project-months/{project_month_id}/payment", handler.UpdateCommissionProjectPayment)
	route(http.MethodPost, "/api/v1/system-management/commission-management/ratio-overrides/upsert", handler.UpsertCommissionRatioOverrides)
	route(http.MethodGet, "/api/v1/system-management/commission-management/ratio-overrides", handler.ListCommissionRatioOverrides)
	route(http.MethodGet, "/api/v1/system-management/commission-management/role-assignments", handler.ListProjectRoleAssignments)
	route(http.MethodPost, "/api/v1/system-management/commission-management/role-assignments/upsert", handler.UpsertProjectRoleAssignments)
	route(http.MethodGet, "/api/v1/system-management/commission-management/summary/monthly", handler.CommissionMonthlySummary)
	route(http.MethodGet, "/api/v1/system-management/commission-management/summary/project", handler.CommissionProjectSummary)
	route(http.MethodPost, "/api/v1/system-management/commission-management/recompute", handler.RecomputeCommission)
}
