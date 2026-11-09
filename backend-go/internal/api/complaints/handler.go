package complaints

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

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

func (h *Handler) GetOverview(w http.ResponseWriter, r *http.Request) {
	date := strings.TrimSpace(r.URL.Query().Get("date"))
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	var country *string
	if v := strings.TrimSpace(r.URL.Query().Get("country")); v != "" {
		upper := strings.ToUpper(v)
		country = &upper
	}
	overview, err := h.store.GetOverview(r.Context(), date, country)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, overview)
}

func (h *Handler) ListComplaints(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	query := r.URL.Query()
	var date, category, status, country, keyword, firstMessageDate *string
	if v := strings.TrimSpace(query.Get("date")); v != "" {
		date = &v
	}
	if v := strings.TrimSpace(query.Get("category")); v != "" {
		category = &v
	}
	if v := strings.TrimSpace(query.Get("status")); v != "" {
		status = &v
	}
	if v := strings.TrimSpace(query.Get("country")); v != "" {
		upper := strings.ToUpper(v)
		country = &upper
	}
	if v := strings.TrimSpace(query.Get("keyword")); v != "" {
		keyword = &v
	}
	if v := strings.TrimSpace(query.Get("first_message_date")); v != "" {
		firstMessageDate = &v
	}
	var projectID *int64
	if v, err := strconv.ParseInt(query.Get("project_id"), 10, 64); err == nil && v > 0 {
		projectID = &v
	}

	if projectID != nil && !identity.IsAdmin {
		err := h.store.VerifyProjectAccess(r.Context(), *projectID, identity.Operator, identity.IsAdmin)
		if err != nil {
			if errors.Is(err, ErrProjectNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			if errors.Is(err, ErrProjectForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	sort := query.Get("sort")
	if sort == "" {
		sort = "sla_asc"
	}
	page := 1
	if v, err := strconv.Atoi(query.Get("page")); err == nil && v >= 1 {
		page = v
	}
	pageSize := 20
	if v, err := strconv.Atoi(query.Get("page_size")); err == nil && v >= 1 {
		pageSize = v
	}

	filter := ComplaintFilter{
		Date:             date,
		ProjectID:        projectID,
		Category:         category,
		Status:           status,
		Country:          country,
		Keyword:          keyword,
		FirstMessageDate: firstMessageDate,
		Sort:             sort,
		Page:             page,
		PageSize:         pageSize,
		Operator:         identity.Operator,
		IsAdmin:          identity.IsAdmin,
	}
	resp, err := h.store.ListComplaints(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetComplaint(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	id, err := strconv.ParseInt(chi.URLParam(r, "complaint_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid complaint_id")
		return
	}
	detail, err := h.store.GetComplaint(r.Context(), id)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if detail == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("客诉 %d 不存在", id))
		return
	}

	if !identity.IsAdmin {
		err := h.store.VerifyProjectAccess(r.Context(), detail.ProjectID, identity.Operator, identity.IsAdmin)
		if err != nil {
			if errors.Is(err, ErrProjectForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (h *Handler) PatchComplaint(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	id, err := strconv.ParseInt(chi.URLParam(r, "complaint_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid complaint_id")
		return
	}

	existing, err := h.store.GetComplaint(r.Context(), id)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("客诉 %d 不存在", id))
		return
	}

	if !identity.IsAdmin {
		err := h.store.VerifyProjectAccess(r.Context(), existing.ProjectID, identity.Operator, identity.IsAdmin)
		if err != nil {
			if errors.Is(err, ErrProjectForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	var req ComplaintPatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}

	if req.Status != nil && *req.Status != existing.Status {
		if !CanTransition(existing.Status, *req.Status) {
			httpapi.WriteDetail(w, http.StatusBadRequest, fmt.Sprintf("非法状态流转：%s → %s", existing.Status, *req.Status))
			return
		}
	}

	updated, err := h.store.PatchComplaint(r.Context(), id, req, identity.Operator)
	if err != nil {
		if strings.Contains(err.Error(), "409") {
			httpapi.WriteDetail(w, http.StatusConflict, err.Error())
			return
		}
		if strings.Contains(err.Error(), "400") {
			httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
			return
		}
		if strings.Contains(err.Error(), "404") {
			httpapi.WriteDetail(w, http.StatusNotFound, err.Error())
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("客诉 %d 不存在", id))
		return
	}

	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "complaint_center.status_change",
			TargetType: "complaint",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
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
