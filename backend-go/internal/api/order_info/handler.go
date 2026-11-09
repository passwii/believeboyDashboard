package order_info

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

func (h *Handler) checkOperator(w http.ResponseWriter, identity auth.UserContext) bool {
	if !identity.IsAdmin && strings.TrimSpace(identity.Operator) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "缺少 X-Operator 头，请重新登录后重试")
		return false
	}
	return true
}

func (h *Handler) parseFilter(r *http.Request, identity auth.UserContext) OrderInfoFilter {
	query := r.URL.Query()

	parseStrList := func(keys ...string) []string {
		var res []string
		for _, k := range keys {
			for _, val := range query[k] {
				for _, part := range strings.Split(val, ",") {
					part = strings.TrimSpace(part)
					if part != "" {
						res = append(res, part)
					}
				}
			}
		}
		return res
	}

	parseIntList := func(keys ...string) []int64 {
		var res []int64
		for _, k := range keys {
			for _, val := range query[k] {
				for _, part := range strings.Split(val, ",") {
					part = strings.TrimSpace(part)
					if part != "" {
						if n, err := strconv.ParseInt(part, 10, 64); err == nil {
							res = append(res, n)
						}
					}
				}
			}
		}
		return res
	}

	parseOptionalStr := func(k string) *string {
		val := strings.TrimSpace(query.Get(k))
		if val == "" {
			return nil
		}
		return &val
	}

	pagination := httpapi.ParsePagination(r, 50, 500)
	sortBy := query.Get("sort_by")
	if sortBy == "" {
		sortBy = "purchase_at_pt"
	}
	sortDir := query.Get("sort_dir")
	if sortDir == "" {
		sortDir = "desc"
	}

	return OrderInfoFilter{
		ProjectIDs:          parseIntList("project_ids", "project_ids[]"),
		FulfillmentChannels: parseStrList("fulfillment_channels", "fulfillment_channels[]"),
		OrderStatuses:       parseStrList("order_statuses", "order_statuses[]"),
		Countries:           parseStrList("countries", "countries[]"),
		Currencies:          parseStrList("currencies", "currencies[]"),
		SKUKeyword:          parseOptionalStr("sku_keyword"),
		OrderIDKeyword:      parseOptionalStr("order_id_keyword"),
		ASINKeyword:         parseOptionalStr("asin_keyword"),
		DateFrom:            parseOptionalStr("date_from"),
		DateTo:              parseOptionalStr("date_to"),
		SortBy:              sortBy,
		SortDir:             sortDir,
		Page:                pagination.Page,
		PageSize:            pagination.PageSize,
		Offset:              pagination.Offset,
		Operator:            identity.Operator,
		IsAdmin:             identity.IsAdmin,
	}
}

func (h *Handler) GetPage(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkOperator(w, identity) {
		return
	}
	filter := h.parseFilter(r, identity)
	data, err := h.store.GetPageData(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, data)
}

func (h *Handler) ListOrders(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkOperator(w, identity) {
		return
	}
	filter := h.parseFilter(r, identity)
	resp, err := h.store.ListOrders(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetStats(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkOperator(w, identity) {
		return
	}
	filter := h.parseFilter(r, identity)
	stats, err := h.store.ComputeStats(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, stats)
}

func (h *Handler) GetOverview(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkOperator(w, identity) {
		return
	}
	filter := h.parseFilter(r, identity)
	overview, err := h.store.GetOverview(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, overview)
}

func (h *Handler) GetFilterOptions(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkOperator(w, identity) {
		return
	}
	opts, err := h.store.CollectFilterOptions(r.Context(), identity.Operator, identity.IsAdmin)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, opts)
}

func (h *Handler) GetLiveStream(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkOperator(w, identity) {
		return
	}
	query := r.URL.Query()
	var projectIDs []int64
	for _, val := range query["project_ids"] {
		for _, part := range strings.Split(val, ",") {
			part = strings.TrimSpace(part)
			if id, err := strconv.ParseInt(part, 10, 64); err == nil {
				projectIDs = append(projectIDs, id)
			}
		}
	}
	var countries []string
	for _, val := range query["countries"] {
		for _, part := range strings.Split(val, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				countries = append(countries, part)
			}
		}
	}
	limit := 20
	if rawLimit := query.Get("limit"); rawLimit != "" {
		if n, err := strconv.Atoi(rawLimit); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 100 {
		limit = 100
	}

	items, err := h.store.QueryLiveStream(r.Context(), projectIDs, countries, limit, identity.Operator, identity.IsAdmin)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if items == nil {
		items = []OrderLiveStreamItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) ExportOrders(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkOperator(w, identity) {
		return
	}
	var req OrderInfoExportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	filter := OrderInfoFilter{
		ProjectIDs:          req.ProjectIDs,
		FulfillmentChannels: req.FulfillmentChannels,
		OrderStatuses:       req.OrderStatuses,
		Countries:           req.Countries,
		Currencies:          req.Currencies,
		SKUKeyword:          req.SKUKeyword,
		OrderIDKeyword:      req.OrderIDKeyword,
		ASINKeyword:         req.ASINKeyword,
		DateFrom:            req.DateFrom,
		DateTo:              req.DateTo,
		Operator:            identity.Operator,
		IsAdmin:             identity.IsAdmin,
	}
	filename, csvBytes, err := h.store.ExportOrders(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := OrderInfoExportResponse{
		Filename:      filename,
		ContentType:   "text/csv; charset=utf-8",
		ContentBase64: base64.StdEncoding.EncodeToString(csvBytes),
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) UpdateOrder(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkOperator(w, identity) {
		return
	}
	orderIDStr := chi.URLParam(r, "order_id")
	orderID, err := strconv.ParseInt(orderIDStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid order_id")
		return
	}
	var update OrderInfoUpdate
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}

	before, err := h.store.GetOrderByID(r.Context(), orderID)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "订单不存在")
		return
	}

	updated, err := h.store.UpdateOrderByID(r.Context(), orderID, update, identity.Operator, identity.IsAdmin)
	if err != nil {
		if strings.Contains(err.Error(), "403") || strings.Contains(err.Error(), "forbidden") || strings.Contains(err.Error(), "无权") {
			httpapi.WriteDetail(w, http.StatusForbidden, err.Error())
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "订单不存在")
		return
	}

	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", orderID)
		entry := audit.Entry{
			Action:     "order_info.update",
			TargetType: "order_info",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			BeforeJSON: before,
			AfterJSON:  updated,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, updated)
}
