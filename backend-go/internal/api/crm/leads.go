package crm

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (handler *Handler) ListLeads(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	scope, err := validateScope(r.URL.Query().Get("scope"), "all", "mine", "sea")
	if err != nil {
		WriteError(w, err)
		return
	}
	scope = ResolveScope(scope, identity.IsAdmin)
	page, pageSize, err := parsePage(r, 20, maxLeadPageSize)
	if err != nil {
		WriteError(w, err)
		return
	}
	filters, err := parseFilters(r.URL.Query().Get("filters"))
	if err != nil {
		WriteError(w, err)
		return
	}
	sortBy := r.URL.Query().Get("sort_by")
	if sortBy == "" {
		sortBy = "updated_at"
	}
	sortOrder := r.URL.Query().Get("sort_order")
	if sortOrder == "" {
		sortOrder = "desc"
	}
	result, err := handler.store.ListLeads(r.Context(), LeadListFilter{
		Scope:     scope,
		Keyword:   optionalString(r.URL.Query().Get("keyword")),
		Filters:   filters,
		SortBy:    sortBy,
		SortOrder: sortOrder,
		Page:      page,
		PageSize:  pageSize,
	}, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Items = ensureSlice(result.Items)
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) ExportLeads(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	scope, err := validateScope(r.URL.Query().Get("scope"), "all", "mine", "sea")
	if err != nil {
		WriteError(w, err)
		return
	}
	scope = ResolveScope(scope, identity.IsAdmin)
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format != "" && format != "csv" && format != "xlsx" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "format must be csv or xlsx")
		return
	}
	result, err := handler.store.ListLeads(r.Context(), LeadListFilter{
		Scope:     scope,
		Keyword:   optionalString(r.URL.Query().Get("keyword")),
		SortBy:    "updated_at",
		SortOrder: "desc",
		Page:      1,
		PageSize:  100000,
	}, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if format == "xlsx" {
		rows := leadXLSXRows(result.Items)
		data, buildErr := buildXLSX(rows)
		if buildErr != nil {
			WriteError(w, NewAPIError(http.StatusInternalServerError, "导出失败"))
			return
		}
		filename := "线索_" + todayShanghai() + ".xlsx"
		writeXLSX(w, filename, data)
		return
	}
	writeCSV(w, "线索_"+todayShanghai()+".csv", buildLeadCSV(result.Items))
}

func (handler *Handler) CreateLead(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	var input LeadCreateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateLength(input.Name, 1, 100, "name"); err != nil {
		WriteError(w, err)
		return
	}
	if input.Status == "" {
		input.Status = "new"
	}
	if input.Intent == "" {
		input.Intent = "medium"
	}
	if err := validateDateString(input.ExpectedCloseDate, "expected_close_date"); err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.CreateLead(r.Context(), input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (handler *Handler) GetLead(w http.ResponseWriter, r *http.Request) {
	leadID, err := parsePathID(r, "lead_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.GetLead(r.Context(), leadID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Lead not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) UpdateLead(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	leadID, err := parsePathID(r, "lead_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetLead(r.Context(), leadID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Lead not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input LeadUpdateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.Name.Set && input.Name.Value != nil {
		trimmed := strings.TrimSpace(*input.Name.Value)
		input.Name.Value = &trimmed
		if err := validateLength(trimmed, 1, 100, "name"); err != nil {
			WriteError(w, err)
			return
		}
	}
	if input.ExpectedCloseDate.Set {
		if err := validateDateString(input.ExpectedCloseDate.Value, "expected_close_date"); err != nil {
			WriteError(w, err)
			return
		}
	}
	item, err := handler.store.UpdateLead(r.Context(), leadID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) BatchTransferLeads(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	var input BatchTransferInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if len(input.IDs) < 1 || strings.TrimSpace(input.ToOwnerID) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "ids and to_owner_id are required")
		return
	}
	if err := handler.store.BatchTransferLeads(r.Context(), input.IDs, input.ToOwnerID, identity.UserID); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) BatchMoveLeadsToPool(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	var input BatchIDsInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if len(input.IDs) < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "ids must contain at least 1 entry")
		return
	}
	if err := handler.store.BatchMoveLeadsToPool(r.Context(), input.IDs, identity.UserID, identity.IsAdmin, identity.UserID); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) ClaimLead(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	leadID, err := parsePathID(r, "lead_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.ClaimLead(r.Context(), leadID, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusConflict, "Lead not in pool")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) ConvertLead(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	leadID, err := parsePathID(r, "lead_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetLead(r.Context(), leadID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Lead not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input *ConvertLeadInput
	if r.Body != nil && r.ContentLength != 0 {
		input = &ConvertLeadInput{}
		if err := decodeJSON(r, input, false); err != nil {
			WriteError(w, err)
			return
		}
		if input.Name != nil {
			trimmed := strings.TrimSpace(*input.Name)
			input.Name = &trimmed
		}
	}
	item, err := handler.store.ConvertLead(r.Context(), leadID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) ListFollows(w http.ResponseWriter, r *http.Request) {
	entityType := strings.TrimSpace(r.URL.Query().Get("entity_type"))
	if entityType != "customer" && entityType != "lead" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "entity_type must be customer or lead")
		return
	}
	entityID, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("entity_id")), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "entity_id is required")
		return
	}
	items, err := handler.store.ListFollows(r.Context(), entityType, entityID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (handler *Handler) CreateFollow(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	var input FollowCreateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.EntityType != "customer" && input.EntityType != "lead" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "entity_type must be customer or lead")
		return
	}
	if input.EntityID < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "entity_id must be greater than 0")
		return
	}
	if strings.TrimSpace(input.Content) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "content must contain at least 1 character")
		return
	}
	if input.Type == "" {
		input.Type = "note"
	}
	item, err := handler.store.CreateFollow(r.Context(), input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (handler *Handler) ListFollowUps(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	scope, err := validateScope(r.URL.Query().Get("scope"), "mine", "all", "sea")
	if err != nil {
		WriteError(w, err)
		return
	}
	scope = ResolveScope(scope, identity.IsAdmin)
	result, err := handler.store.ListFollowUps(r.Context(), scope, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Overdue = ensureSlice(result.Overdue)
	result.Today = ensureSlice(result.Today)
	result.ThisWeek = ensureSlice(result.ThisWeek)
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) ListAuditLogs(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	page, pageSize, err := parsePage(r, 20, maxAuditPageSize)
	if err != nil {
		WriteError(w, err)
		return
	}
	entityID, err := parseOptionalIntQuery(r, "entity_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	entityIDs, err := parseOptionalIntList(r, "entity_ids")
	if err != nil {
		WriteError(w, err)
		return
	}
	result, err := handler.store.ListAuditLogs(r.Context(), AuditLogFilter{
		EntityType:  optionalString(r.URL.Query().Get("entity_type")),
		EntityID:    entityID,
		EntityTypes: parseOptionalStringList(r.URL.Query()["entity_types"]),
		EntityIDs:   entityIDs,
		ActorID:     optionalString(r.URL.Query().Get("actor_id")),
		Action:      optionalString(r.URL.Query().Get("action")),
		Page:        page,
		PageSize:    pageSize,
	})
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Items = ensureSlice(result.Items)
	writeJSON(w, http.StatusOK, result)
}

func leadXLSXRows(items []Lead) [][]string {
	rows := [][]string{{
		"联系人名", "公司", "电话", "微信", "来源", "对象类型", "意向服务",
		"状态", "意向度", "负责人", "下次跟进", "创建时间",
	}}
	for _, item := range items {
		rows = append(rows, []string{
			item.Name,
			pointerValue(item.Company),
			pointerValue(item.Phone),
			pointerValue(item.Wechat),
			pointerValue(item.Source),
			pointerValue(item.CustomerType),
			pointerValue(item.InterestedService),
			item.Status,
			item.Intent,
			pointerValue(item.OwnerName),
			formatCSVTime(item.NextFollowAt),
			formatCSVTime(&item.CreatedAt),
		})
	}
	return rows
}
