package sku_info

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

// maxSKUImportBytes caps SKU CSV uploads at 20 MiB. The FastAPI implementation of
// the same upload family already enforces a 20 MB limit
// (backend/app/api/v1/endpoints/sku_info.py: max_size = 20 * 1024 * 1024), so the
// Go gateway must not accept unbounded bodies that would OOM the process.
const maxSKUImportBytes int64 = 20 << 20

const skuImportTooLargeDetail = "文件大小不能超过 20MB"

type Handler struct {
	store    Store
	auditor  audit.Service
	projects ProjectReader
	blobs    BlobStore
}

func NewHandler(store Store, auditor audit.Service, projectReaders ...ProjectReader) *Handler {
	var pr ProjectReader
	if len(projectReaders) > 0 {
		pr = projectReaders[0]
	}
	return &Handler{store: store, auditor: auditor, projects: pr}
}

func (h *Handler) WithBlobStore(blobs BlobStore) *Handler {
	if h != nil {
		h.blobs = blobs
	}
	return h
}

func (h *Handler) checkProjectAccess(ctx context.Context, projectID int64, projectName string, identity auth.UserContext) error {
	if identity.IsAdmin {
		return nil
	}
	if strings.TrimSpace(identity.Operator) == "" {
		return errors.New("403: 无权限访问该项目")
	}
	if h.projects == nil {
		return errors.New("403: 无法校验项目权限")
	}
	if h.projects != nil {
		var p *projects.ProjectItem
		var err error
		if projectID > 0 {
			p, err = h.projects.GetProject(ctx, projectID)
		} else if strings.TrimSpace(projectName) != "" {
			p, err = h.projects.GetProjectByName(ctx, projectName)
		}
		if err != nil {
			return err
		}
		if p == nil {
			return errors.New("404: 项目不存在")
		}
		if !projects.CanAccessProject(*p, identity.Operator, false) {
			return errors.New("403: 无权限访问该项目")
		}
	}
	return nil
}

func (h *Handler) parseFilter(r *http.Request, identity auth.UserContext) SkuFilter {
	query := r.URL.Query()
	var projectName, sku, asin, country *string
	if v := strings.TrimSpace(query.Get("project_name")); v != "" {
		projectName = &v
	}
	if v := strings.TrimSpace(query.Get("sku")); v != "" {
		sku = &v
	}
	if v := strings.TrimSpace(query.Get("asin")); v != "" {
		asin = &v
	}
	if v := strings.TrimSpace(query.Get("country")); v != "" {
		country = &v
	}
	var isActive *bool
	if v := strings.TrimSpace(query.Get("is_active")); v != "" {
		b := strings.ToLower(v) == "true" || v == "1"
		isActive = &b
	}
	page := 1
	if v, err := strconv.Atoi(query.Get("page")); err == nil && v >= 1 {
		page = v
	}
	pageSize := 10000
	if v, err := strconv.Atoi(query.Get("page_size")); err == nil && v >= 1 {
		pageSize = v
		if pageSize > 100000 {
			pageSize = 100000
		}
	}
	includeTotal := strings.ToLower(query.Get("include_total")) == "true" || query.Get("include_total") == "1"

	return SkuFilter{
		ProjectName:  projectName,
		SKU:          sku,
		ASIN:         asin,
		Country:      country,
		IsActive:     isActive,
		Page:         page,
		PageSize:     pageSize,
		IncludeTotal: includeTotal,
		Operator:     identity.Operator,
		IsAdmin:      identity.IsAdmin,
	}
}

func (h *Handler) ListSkuRecords(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r, identity)
	page, err := h.store.ListSkuRecords(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, page)
}

func (h *Handler) CreateSkuRecord(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var req SkuRecordCreate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if strings.TrimSpace(req.ProjectName) == "" || strings.TrimSpace(req.SKU) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_name and sku are required")
		return
	}

	if err := h.checkProjectAccess(r.Context(), 0, req.ProjectName, identity); err != nil {
		if strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "404") {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	item, action, err := h.store.CreateOrUpdateSkuRecord(r.Context(), req, identity.Operator)
	if err != nil {
		if strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "项目不存在") {
			httpapi.WriteDetail(w, http.StatusNotFound, err.Error())
			return
		}
		if strings.Contains(err.Error(), "400") || strings.Contains(err.Error(), "422") {
			httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", item.ID)
		entry := audit.Entry{
			Action:     "sku_info.create",
			TargetType: "sku_info",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  item,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, SkuRecordUpsertResponse{
		Item:   item,
		Action: action,
	})
}

func (h *Handler) BulkCreateSkuRecords(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var req SkuRecordBulkCreate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}

	checkedProjects := make(map[string]bool)
	for _, it := range req.Items {
		projName := strings.TrimSpace(it.ProjectName)
		if projName == "" {
			continue
		}
		if checkedProjects[projName] {
			continue
		}
		if err := h.checkProjectAccess(r.Context(), 0, projName, identity); err != nil {
			if strings.Contains(err.Error(), "403") {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			if strings.Contains(err.Error(), "404") {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
		checkedProjects[projName] = true
	}

	resp, err := h.store.BulkCreateOrUpdateSkuRecords(r.Context(), req, identity.Operator)
	if err != nil {
		if strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "项目不存在") {
			httpapi.WriteDetail(w, http.StatusNotFound, err.Error())
			return
		}
		if strings.Contains(err.Error(), "400") || strings.Contains(err.Error(), "422") {
			httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		entry := audit.Entry{
			Action:     "sku_info.bulk_upsert",
			TargetType: "sku_info",
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) UpdateSkuRecord(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	idStr := chi.URLParam(r, "sku_record_id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid sku_record_id")
		return
	}
	var req SkuRecordUpdate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}

	before, _ := h.store.GetSkuRecord(r.Context(), id)
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "SKU 记录不存在")
		return
	}
	if err := h.checkProjectAccess(r.Context(), before.ProjectID, before.ProjectName, identity); err != nil {
		if strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "404") {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	updated, err := h.store.UpdateSkuRecord(r.Context(), id, req, identity.Operator)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "SKU 记录不存在")
		return
	}

	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "sku_info.update",
			TargetType: "sku_info",
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

func (h *Handler) DeleteSkuRecord(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	idStr := chi.URLParam(r, "sku_record_id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid sku_record_id")
		return
	}
	before, _ := h.store.GetSkuRecord(r.Context(), id)
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "SKU 记录不存在")
		return
	}
	if err := h.checkProjectAccess(r.Context(), before.ProjectID, before.ProjectName, identity); err != nil {
		if strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "404") {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok, err := h.store.DeleteSkuRecord(r.Context(), id)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		httpapi.WriteDetail(w, http.StatusNotFound, "SKU 记录不存在")
		return
	}

	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "sku_info.delete",
			TargetType: "sku_info",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			BeforeJSON: before,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{"deleted": true, "id": id})
}

func (h *Handler) MoveSkuRecord(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	idStr := chi.URLParam(r, "sku_record_id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid sku_record_id")
		return
	}
	var req SkuRecordSortMove
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if req.Direction != "up" && req.Direction != "down" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "direction must be 'up' or 'down'")
		return
	}
	before, _ := h.store.GetSkuRecord(r.Context(), id)
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "SKU 记录不存在")
		return
	}
	if err := h.checkProjectAccess(r.Context(), before.ProjectID, before.ProjectName, identity); err != nil {
		if strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "404") {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	item, err := h.store.MoveSkuRecord(r.Context(), id, req.Direction)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "SKU 记录不存在")
		return
	}

	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "sku_info.move_sort",
			TargetType: "sku_info",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  item,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) ImportCSV(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	r.Body = http.MaxBytesReader(w, r.Body, maxSKUImportBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, skuImportTooLargeDetail)
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file in multipart form")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		return
	}
	projectName := r.FormValue("project_name")
	if err := h.checkProjectAccess(r.Context(), 0, projectName, identity); err != nil {
		if strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "404") {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp, err := h.store.ImportCSV(r.Context(), projectName, data, identity.Operator)
	if err != nil {
		if strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "项目不存在") {
			httpapi.WriteDetail(w, http.StatusNotFound, err.Error())
			return
		}
		if strings.Contains(err.Error(), "400") || strings.Contains(err.Error(), "422") {
			httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		entry := audit.Entry{
			Action:     "sku_info.import_csv",
			TargetType: "sku_info",
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ExportCSV(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r, identity)
	filename, csvBytes, err := h.store.ExportCSV(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(csvBytes)
}

func (h *Handler) RecalculateFirstLegCosts(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var req SkuRecordFirstLegRecalculateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if strings.TrimSpace(req.ProjectName) == "" || req.UnitPricePerKgRMB <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_name and valid unit_price_per_kg_rmb are required")
		return
	}
	if err := h.checkProjectAccess(r.Context(), 0, req.ProjectName, identity); err != nil {
		if strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "404") {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	count, err := h.store.RecalculateFirstLegCosts(r.Context(), req)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := SkuRecordFirstLegRecalculateResponse{
		Updated:           count,
		UnitPricePerKgRMB: req.UnitPricePerKgRMB,
	}

	if h.auditor != nil {
		entry := audit.Entry{
			Action:     "sku_info.recalculate_first_leg_costs",
			TargetType: "sku_info",
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) SyncFirstLegFromShipment(w http.ResponseWriter, r *http.Request) {
	projectName := r.URL.Query().Get("project_name")
	country := r.URL.Query().Get("country")
	count, err := h.store.SyncFirstLegFromShipment(r.Context(), projectName, country)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{"updated": count})
}

func (h *Handler) BatchParseFactoryInfo(w http.ResponseWriter, r *http.Request) {
	var req ParseFactoryInfoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ParseFactoryInfoResponse{
		Result: map[string]string{},
		Raw:    req.Description,
	})
}

func (h *Handler) BatchUpdateFactoryInfo(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var req BatchUpdateFactoryInfoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if len(req.SKUIDs) > 0 {
		projectIDs, err := h.store.GetProjectIDsBySkuIDs(r.Context(), req.SKUIDs)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(projectIDs) != len(req.SKUIDs) {
			var missing []int64
			for _, id := range req.SKUIDs {
				if _, ok := projectIDs[id]; !ok {
					missing = append(missing, id)
				}
			}
			httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("部分 SKU 不存在: %v", missing))
			return
		}
		for _, pid := range projectIDs {
			if err := h.checkProjectAccess(r.Context(), pid, "", identity); err != nil {
				if strings.Contains(err.Error(), "403") {
					httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
					return
				}
				httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
	}
	updated, ids, err := h.store.BatchUpdateFactoryInfo(r.Context(), req, identity.Operator)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := BatchUpdateFactoryInfoResponse{
		Updated: updated,
		SKUIDs:  ids,
	}

	if h.auditor != nil {
		entry := audit.Entry{
			Action:     "sku_info.batch_update_factory_info",
			TargetType: "sku_info",
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) BatchUpdateListingCopy(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var req BatchUpdateListingCopyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if len(req.Items) > 0 {
		var ids []int64
		for _, it := range req.Items {
			ids = append(ids, it.ID)
		}
		projectIDs, err := h.store.GetProjectIDsBySkuIDs(r.Context(), ids)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, pid := range projectIDs {
			if err := h.checkProjectAccess(r.Context(), pid, "", identity); err != nil {
				if strings.Contains(err.Error(), "403") {
					httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
					return
				}
				httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
	}
	updated, skipped, ids, err := h.store.BatchUpdateListingCopy(r.Context(), req, identity.Operator)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := BatchUpdateListingCopyResponse{
		Updated:    updated,
		Skipped:    skipped,
		UpdatedIDs: ids,
	}

	if h.auditor != nil {
		entry := audit.Entry{
			Action:     "sku_info.batch_update_listing_copy",
			TargetType: "sku_info",
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetFnskuLabelsBySkus(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var req GetFnskuLabelsBySkusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if err := h.checkProjectAccess(r.Context(), 0, req.ProjectName, identity); err != nil {
		if strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "404") {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	records, err := h.store.GetFnskuLabelsBySkus(r.Context(), req.ProjectName, req.SKUs)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if records == nil {
		records = []SkuRecordFnskuLabelItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, FnskuLabelsResponse{
		SkuRecords: records,
	})
}
