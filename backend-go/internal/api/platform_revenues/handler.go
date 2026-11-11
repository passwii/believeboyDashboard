package platform_revenues

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxImageBytes = 10 * 1024 * 1024 // 10MB
)

var allowedImageTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/webp": true,
	"image/gif":  true,
}

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{
		store:   store,
		auditor: auditor,
	}
}

func (h *Handler) ListRevenues(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	q := r.URL.Query()
	page := 1
	if p, err := strconv.Atoi(q.Get("page")); err == nil && p >= 1 {
		page = p
	}
	pageSize := 20
	if ps, err := strconv.Atoi(q.Get("page_size")); err == nil && ps >= 1 {
		pageSize = min(ps, 200)
	}

	var projectID int64
	if pidStr := q.Get("project_id"); pidStr != "" {
		if pid, err := strconv.ParseInt(pidStr, 10, 64); err == nil {
			projectID = pid
		}
	}

	var year int
	if yStr := q.Get("year"); yStr != "" {
		if y, err := strconv.Atoi(yStr); err == nil {
			year = y
		}
	}

	var month int
	if mStr := q.Get("month"); mStr != "" {
		if m, err := strconv.Atoi(mStr); err == nil {
			month = m
		}
	}

	filter := PlatformRevenueFilter{
		ProjectID: projectID,
		Year:      year,
		Month:     month,
		Country:   strings.TrimSpace(q.Get("country")),
		Currency:  strings.TrimSpace(q.Get("currency")),
		Page:      page,
		PageSize:  pageSize,
		Operator:  identity.Operator,
		IsAdmin:   identity.IsAdmin,
	}

	items, total, err := h.store.ListRevenues(r.Context(), filter)
	if err != nil {
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	totalPages := 1
	if total > 0 {
		totalPages = int(math.Ceil(float64(total) / float64(pageSize)))
	}
	if items == nil {
		items = []PlatformRevenueItem{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, PlatformRevenueListResponse{
		Items:      items,
		Total:      total,
		Page:       page,
		PageSize:   pageSize,
		TotalPages: totalPages,
	})
}

func (h *Handler) GetRevenue(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	revenueID, err := strconv.ParseInt(chi.URLParam(r, "revenue_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid revenue_id")
		return
	}

	item, err := h.store.GetRevenue(r.Context(), revenueID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrRevenueNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "回款记录不存在")
			return
		}
		if errors.Is(err, ErrRevenueForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该回款记录")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) CreateRevenue(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	var payload PlatformRevenueCreate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}

	if payload.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
		return
	}
	if strings.TrimSpace(payload.Country) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country is required")
		return
	}
	if payload.Amount <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "amount must be greater than 0")
		return
	}
	if payload.Currency == "" {
		payload.Currency = "USD"
	}
	if payload.RevenueType == "" {
		payload.RevenueType = "订单回款"
	}
	if payload.Attachments == nil {
		payload.Attachments = []PlatformRevenueAttachment{}
	}

	item, err := h.store.CreateRevenue(r.Context(), payload, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限在该项目下创建回款")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(item.ID, 10)
		entry := audit.Entry{
			Action:     "platform_revenues.create",
			TargetType: "platform_revenue",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  map[string]any{"data": payload},
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	_ = httpapi.WriteJSON(w, http.StatusCreated, item)
}

func (h *Handler) UpdateRevenue(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	revenueID, err := strconv.ParseInt(chi.URLParam(r, "revenue_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid revenue_id")
		return
	}

	var payload PlatformRevenueUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}

	item, err := h.store.UpdateRevenue(r.Context(), revenueID, payload, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrRevenueNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "回款记录不存在")
			return
		}
		if errors.Is(err, ErrRevenueForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该回款记录")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(revenueID, 10)
		entry := audit.Entry{
			Action:     "platform_revenues.update",
			TargetType: "platform_revenue",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  map[string]any{"data": payload},
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteRevenue(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	revenueID, err := strconv.ParseInt(chi.URLParam(r, "revenue_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid revenue_id")
		return
	}

	existing, err := h.store.GetRevenue(r.Context(), revenueID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrRevenueNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "回款记录不存在")
			return
		}
		if errors.Is(err, ErrRevenueForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该回款记录")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	err = h.store.DeleteRevenue(r.Context(), revenueID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrRevenueNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "回款记录不存在")
			return
		}
		if errors.Is(err, ErrRevenueForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该回款记录")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(revenueID, 10)
		beforeData := map[string]any{
			"id":            existing.ID,
			"project_id":    existing.ProjectID,
			"project_name":  existing.ProjectName,
			"country":       existing.Country,
			"received_date": existing.ReceivedDate,
			"amount":        fmt.Sprintf("%.2f", existing.Amount),
			"currency":      existing.Currency,
		}
		entry := audit.Entry{
			Action:     "platform_revenues.delete",
			TargetType: "platform_revenue",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			BeforeJSON: map[string]any{"data": beforeData},
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) UploadImage(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxImageBytes); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		return
	}

	projectName := strings.TrimSpace(r.FormValue("project_name"))
	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file in form")
		return
	}
	defer file.Close()

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if !allowedImageTypes[contentType] {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Unsupported file type")
		return
	}

	var buf bytes.Buffer
	lr := io.LimitReader(file, maxImageBytes+1)
	n, err := io.Copy(&buf, lr)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		return
	}
	if n > maxImageBytes {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		return
	}
	if n == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		return
	}

	resp, err := h.store.SavePaymentScreenshot(r.Context(), projectName, header.Filename, contentType, buf.Bytes())
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetProjectCountries(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	projectID, err := strconv.ParseInt(chi.URLParam(r, "project_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid project_id")
		return
	}

	if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
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

	countries, err := h.store.GetProjectCountries(r.Context(), projectID)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if countries == nil {
		countries = []string{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, ProjectCountriesResponse{Countries: countries})
}
