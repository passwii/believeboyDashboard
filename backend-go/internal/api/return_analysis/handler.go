package return_analysis

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxRawRows = 50000

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

func validateDateFormat(dateStr string) bool {
	if len(dateStr) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", dateStr)
	return err == nil
}

func (h *Handler) GetReturnAnalysis(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	q := r.URL.Query()
	projectID, err := strconv.ParseInt(q.Get("project_id"), 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
		return
	}

	startDate := q.Get("start_date")
	endDate := q.Get("end_date")
	if !validateDateFormat(startDate) || !validateDateFormat(endDate) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "日期格式不合法，应为 YYYY-MM-DD")
		return
	}

	country := strings.TrimSpace(q.Get("country"))
	if country == "" {
		country = "US"
	}

	var skuPtr *string
	if s := q.Get("sku"); s != "" {
		skuPtr = &s
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, false); err != nil {
			if errors.Is(err, ErrProjectNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	filter := ReturnAnalysisFilter{
		ProjectID: projectID,
		Country:   country,
		StartDate: startDate,
		EndDate:   endDate,
		SKU:       skuPtr,
		Operator:  identity.Operator,
		IsAdmin:   identity.IsAdmin,
	}

	resp, err := h.store.GetReturnAnalysis(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetRawRows(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	q := r.URL.Query()
	projectID, err := strconv.ParseInt(q.Get("project_id"), 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
		return
	}

	startDate := q.Get("start_date")
	endDate := q.Get("end_date")
	if !validateDateFormat(startDate) || !validateDateFormat(endDate) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "日期格式不合法，应为 YYYY-MM-DD")
		return
	}

	country := strings.TrimSpace(q.Get("country"))
	if country == "" {
		country = "US"
	}

	var skuPtr *string
	if s := q.Get("sku"); s != "" {
		skuPtr = &s
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, false); err != nil {
			if errors.Is(err, ErrProjectNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	filter := ReturnAnalysisFilter{
		ProjectID: projectID,
		Country:   country,
		StartDate: startDate,
		EndDate:   endDate,
		SKU:       skuPtr,
		Operator:  identity.Operator,
		IsAdmin:   identity.IsAdmin,
	}

	rows, err := h.store.GetRawRows(r.Context(), filter, maxRawRows+1)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if len(rows) > maxRawRows {
		httpapi.WriteDetail(w, http.StatusBadRequest, "所选周期原始退货行超过上限 50000 条，请缩小日期范围后重试")
		return
	}

	if rows == nil {
		rows = []ReturnRawRowItem{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, ReturnRawRowsResponse{
		ProjectID: projectID,
		Country:   country,
		StartDate: startDate,
		EndDate:   endDate,
		RowCount:  len(rows),
		Rows:      rows,
	})
}
