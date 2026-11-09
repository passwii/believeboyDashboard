package crm

import (
	"mime"
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (handler *Handler) ListCustomers(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	scope, err := validateScope(r.URL.Query().Get("scope"), "all", "mine", "sea")
	if err != nil {
		WriteError(w, err)
		return
	}
	scope = ResolveScope(scope, identity.IsAdmin)
	page, pageSize, err := parsePage(r, 20, maxCustomerPageSize)
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
	result, err := handler.store.ListCustomers(r.Context(), CustomerListFilter{
		Scope:     scope,
		Keyword:   optionalString(r.URL.Query().Get("keyword")),
		Filters:   filters,
		SortBy:    sortBy,
		SortOrder: sortOrder,
		Page:      page,
		PageSize:  pageSize,
	}, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Items = ensureSlice(result.Items)
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) ExportCustomers(w http.ResponseWriter, r *http.Request) {
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
	result, err := handler.store.ListCustomers(r.Context(), CustomerListFilter{
		Scope:     scope,
		Keyword:   optionalString(r.URL.Query().Get("keyword")),
		SortBy:    "updated_at",
		SortOrder: "desc",
		Page:      1,
		PageSize:  100000,
	}, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	filename := "客户_" + todayShanghai() + ".csv"
	if format == "xlsx" {
		rows := customerXLSXRows(result.Items)
		data, buildErr := buildXLSX(rows)
		if buildErr != nil {
			WriteError(w, NewAPIError(http.StatusInternalServerError, "导出失败"))
			return
		}
		filename = "客户_" + todayShanghai() + ".xlsx"
		writeXLSX(w, filename, data)
		return
	}
	writeCSV(w, filename, buildCustomerCSV(result.Items))
}

func (handler *Handler) CreateCustomer(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	var input CustomerCreateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateLength(input.Name, 1, 200, "name"); err != nil {
		WriteError(w, err)
		return
	}
	if input.Rating == "" {
		input.Rating = "C"
	}
	if input.Status == "" {
		input.Status = "active"
	}
	if input.ContactName != nil && len([]rune(strings.TrimSpace(*input.ContactName))) > 100 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "contact_name is too long")
		return
	}
	item, err := handler.store.CreateCustomer(r.Context(), input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (handler *Handler) ImportCustomersToSea(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	var request CustomerSeaImportRequest
	contentType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "multipart/") {
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			WriteError(w, malformedMultipart(err))
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file in multipart form")
			return
		}
		defer file.Close()
		data, err := ioReadAllLimited(file, 32<<20)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "文件过大")
			return
		}
		rows, err := parseCustomerImportFile(data, header.Filename)
		if err != nil {
			WriteError(w, err)
			return
		}
		request.Rows = rows
	} else if err := decodeJSON(r, &request, true); err != nil {
		WriteError(w, err)
		return
	}
	if len(request.Rows) < 1 || len(request.Rows) > 1000 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "rows must contain 1 to 1000 entries")
		return
	}
	result, err := handler.store.ImportCustomersToSea(r.Context(), request.Rows, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Failed = ensureSlice(result.Failed)
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) GetCustomer(w http.ResponseWriter, r *http.Request) {
	customerID, err := parsePathID(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.GetCustomer(r.Context(), customerID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Customer not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) UpdateCustomer(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	customerID, err := parsePathID(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetCustomer(r.Context(), customerID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Customer not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input CustomerUpdateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.Name.Set && input.Name.Value != nil {
		trimmed := strings.TrimSpace(*input.Name.Value)
		input.Name.Value = &trimmed
		if err := validateLength(trimmed, 1, 200, "name"); err != nil {
			WriteError(w, err)
			return
		}
	}
	item, err := handler.store.UpdateCustomer(r.Context(), customerID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) UpdateCustomerValueScores(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	customerID, err := parsePathID(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetCustomer(r.Context(), customerID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Customer not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input ValueScoresUpdateInput
	if err := decodeJSON(r, &input, true); err != nil {
		WriteError(w, err)
		return
	}
	for _, score := range []*string{input.ScoreScale, input.ScorePay, input.ScoreFit, input.ScoreCoop} {
		if score != nil {
			switch *score {
			case "A", "B", "C", "D":
			default:
				httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "score must be one of A/B/C/D")
				return
			}
		}
	}
	item, err := handler.store.UpdateCustomerValueScores(r.Context(), customerID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) DeleteCustomer(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	customerID, err := parsePathID(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetCustomer(r.Context(), customerID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Customer not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.store.DeleteCustomer(r.Context(), customerID, identity.UserID); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) BatchTransferCustomers(w http.ResponseWriter, r *http.Request) {
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
	if err := handler.store.BatchTransferCustomers(r.Context(), input.IDs, input.ToOwnerID, identity.UserID); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) BatchMoveCustomersToSea(w http.ResponseWriter, r *http.Request) {
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
	if err := handler.store.BatchMoveCustomersToSea(r.Context(), input.IDs, identity.UserID, identity.IsAdmin, identity.UserID); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) ClaimCustomer(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	customerID, err := parsePathID(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.ClaimCustomer(r.Context(), customerID, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusConflict, "Customer not in sea")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) ListContacts(w http.ResponseWriter, r *http.Request) {
	customerID, err := parsePathID(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	items, err := handler.store.ListContacts(r.Context(), customerID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (handler *Handler) CreateContact(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	customerID, err := parsePathID(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	var input ContactCreateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateLength(input.Name, 1, 100, "name"); err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.CreateContact(r.Context(), customerID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Customer not found")
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (handler *Handler) UpdateContact(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	contactID, err := parsePathID(r, "contact_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	var input ContactUpdateInput
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
	item, err := handler.store.UpdateContact(r.Context(), contactID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Contact not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) DeleteContact(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	contactID, err := parsePathID(r, "contact_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.store.DeleteContact(r.Context(), contactID, identity.UserID); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) ListCRMUsers(w http.ResponseWriter, r *http.Request) {
	items, err := handler.store.ListCRMUsers(r.Context())
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (handler *Handler) GetCRMUser(w http.ResponseWriter, r *http.Request) {
	item, err := handler.store.GetCRMUser(r.Context(), chiURLParam(r, "user_id"))
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) SetCustomerCategories(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	customerID, err := parsePathID(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetCustomer(r.Context(), customerID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "客户不存在")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input CustomerCategoriesInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.SetCustomerCategories(r.Context(), customerID, input.CategoryIDs, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func customerXLSXRows(items []Customer) [][]string {
	rows := [][]string{{
		"名称", "简称", "行业", "对象类型", "意向服务", "评级", "状态", "负责人",
		"主联系人", "主联系人电话", "主联系人微信", "最近跟进", "下次跟进", "创建时间",
	}}
	for _, item := range items {
		rows = append(rows, []string{
			item.Name,
			pointerValue(item.ShortName),
			pointerValue(item.Industry),
			pointerValue(item.CustomerType),
			pointerValue(item.InterestedService),
			item.Rating,
			item.Status,
			pointerValue(item.OwnerName),
			pointerValue(item.ContactName),
			pointerValue(item.ContactPhone),
			pointerValue(item.ContactWechat),
			formatCSVTime(item.LastFollowAt),
			formatCSVTime(item.NextFollowAt),
			formatCSVTime(&item.CreatedAt),
		})
	}
	return rows
}
