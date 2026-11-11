package shipment_schedules

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

// maxShipmentCSVImportBytes caps shipment CSV uploads at 20 MiB. The FastAPI
// implementation of the same upload family already enforces a 20 MB limit
// (backend/app/api/v1/endpoints/sku_info.py: max_size = 20 * 1024 * 1024), so the
// Go gateway must not accept unbounded bodies that would OOM the process.
const maxShipmentCSVImportBytes int64 = 20 << 20

const shipmentCSVTooLargeDetail = "文件大小不能超过 20MB"

type Handler struct {
	store    Store
	auditor  audit.Service
	projects ProjectReader
}

func NewHandler(store Store, auditor audit.Service, projectReaders ...ProjectReader) *Handler {
	var pr ProjectReader
	if len(projectReaders) > 0 {
		pr = projectReaders[0]
	}
	return &Handler{store: store, auditor: auditor, projects: pr}
}

func (h *Handler) checkAccess(ctx context.Context, projectID int64, identity auth.UserContext) error {
	if identity.IsAdmin {
		return nil
	}
	if strings.TrimSpace(identity.Operator) == "" {
		return ErrForbidden
	}
	if h.projects != nil {
		p, err := h.projects.GetProject(ctx, projectID)
		if err != nil {
			return err
		}
		if p == nil {
			return ErrNotFound
		}
		if !projects.CanAccessProject(*p, identity.Operator, false) {
			return ErrForbidden
		}
	}
	return nil
}

func (h *Handler) parseFilter(r *http.Request) ShipmentFilter {
	query := r.URL.Query()
	var projectID *int64
	if v, err := strconv.ParseInt(query.Get("project_id"), 10, 64); err == nil && v > 0 {
		projectID = &v
	}
	var country, keyword, shipmentStatus, startDate, endDate *string
	if v := strings.TrimSpace(query.Get("country")); v != "" {
		country = &v
	}
	if v := strings.TrimSpace(query.Get("keyword")); v != "" {
		keyword = &v
	}
	if v := strings.TrimSpace(query.Get("shipment_status")); v != "" {
		shipmentStatus = &v
	}
	if v := strings.TrimSpace(query.Get("start_date")); v != "" {
		startDate = &v
	}
	if v := strings.TrimSpace(query.Get("end_date")); v != "" {
		endDate = &v
	}
	page := 1
	if v, err := strconv.Atoi(query.Get("page")); err == nil && v >= 1 {
		page = v
	}
	pageSize := 20
	if v, err := strconv.Atoi(query.Get("page_size")); err == nil && v >= 1 {
		pageSize = v
	}
	includeTotal := strings.ToLower(query.Get("include_total")) == "true" || query.Get("include_total") == "1"

	identity, _ := auth.UserContextFromContext(r.Context())
	return ShipmentFilter{
		ProjectID:      projectID,
		Operator:       identity.Operator,
		IsAdmin:        identity.IsAdmin,
		Country:        country,
		Keyword:        keyword,
		ShipmentStatus: shipmentStatus,
		StartDate:      startDate,
		EndDate:        endDate,
		Page:           page,
		PageSize:       pageSize,
		IncludeTotal:   includeTotal,
	}
}

func (h *Handler) ListShipmentSchedules(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if filter.ProjectID != nil {
		if err := h.checkAccess(r.Context(), *filter.ProjectID, identity); err != nil {
			if errors.Is(err, ErrForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			if errors.Is(err, ErrNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else if !identity.IsAdmin && h.projects != nil {
		accessible, err := h.projects.ListManage(r.Context(), identity.Operator, false, false)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(accessible) == 0 {
			zero := 0
			_ = httpapi.WriteJSON(w, http.StatusOK, ShipmentScheduleListResponse{
				Items:    []ShipmentScheduleListItem{},
				Page:     filter.Page,
				PageSize: filter.PageSize,
				Total:    &zero,
				HasNext:  false,
			})
			return
		}
		for _, p := range accessible {
			filter.ProjectIDs = append(filter.ProjectIDs, p.ID)
		}
	}
	resp, err := h.store.ListShipmentSchedules(r.Context(), filter)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) SummarizeShipmentScheduleCosts(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if filter.ProjectID != nil {
		if err := h.checkAccess(r.Context(), *filter.ProjectID, identity); err != nil {
			if errors.Is(err, ErrForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			if errors.Is(err, ErrNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else if !identity.IsAdmin && h.projects != nil {
		accessible, err := h.projects.ListManage(r.Context(), identity.Operator, false, false)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(accessible) == 0 {
			_ = httpapi.WriteJSON(w, http.StatusOK, ShipmentScheduleCostSummary{})
			return
		}
		for _, p := range accessible {
			filter.ProjectIDs = append(filter.ProjectIDs, p.ID)
		}
	}
	summary, err := h.store.SummarizeCosts(r.Context(), filter.ProjectID, filter.ProjectIDs, filter.Country, filter.StartDate, filter.EndDate)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, summary)
}

func (h *Handler) ListShipmentSkuSummary(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if filter.ProjectID != nil {
		if err := h.checkAccess(r.Context(), *filter.ProjectID, identity); err != nil {
			if errors.Is(err, ErrForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			if errors.Is(err, ErrNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	summary, err := h.store.ListSkuSummary(r.Context(), filter.ProjectID, filter.Country, filter.StartDate, filter.EndDate)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, summary)
}

func (h *Handler) ListShipmentFbaBoxDetails(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	query := r.URL.Query()
	var projectIDs []int64
	for _, val := range query["project_ids"] {
		for _, part := range strings.Split(val, ",") {
			part = strings.TrimSpace(part)
			if id, err := strconv.ParseInt(part, 10, 64); err == nil {
				projectIDs = append(projectIDs, id)
				if err := h.checkAccess(r.Context(), id, identity); err != nil {
					if errors.Is(err, ErrForbidden) {
						httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
						return
					}
					if errors.Is(err, ErrNotFound) {
						httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
						return
					}
					httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
					return
				}
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
	var shipmentNos []string
	for _, key := range []string{"shipment_no", "shipment_nos"} {
		for _, val := range query[key] {
			for _, part := range strings.Split(val, ",") {
				part = strings.TrimSpace(part)
				if part != "" {
					shipmentNos = append(shipmentNos, part)
				}
			}
		}
	}
	if len(shipmentNos) == 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "shipment_no is required")
		return
	}

	if len(projectIDs) == 0 && !identity.IsAdmin && h.projects != nil {
		accessible, err := h.projects.ListManage(r.Context(), identity.Operator, false, false)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(accessible) == 0 {
			_ = httpapi.WriteJSON(w, http.StatusOK, ShipmentFbaBoxDetailResponse{
				ProjectIDs:   []int64{},
				ProjectNames: []string{},
				Countries:    []string{},
				ShipmentNos:  []string{},
				Items:        []ShipmentFbaBoxDetailItem{},
			})
			return
		}
		for _, p := range accessible {
			projectIDs = append(projectIDs, p.ID)
		}
	}

	details, err := h.store.ListFbaBoxDetails(r.Context(), projectIDs, countries, shipmentNos)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	found := make(map[string]bool, len(details.ShipmentNos))
	for _, shipmentNo := range details.ShipmentNos {
		found[shipmentNo] = true
	}
	missing := make([]string, 0)
	for _, shipmentNo := range shipmentNos {
		if !found[shipmentNo] {
			missing = append(missing, shipmentNo)
		}
	}
	if len(missing) > 0 {
		httpapi.WriteDetail(w, http.StatusNotFound, "未找到对应的 FBA 货件编号: "+strings.Join(missing, "、"))
		return
	}

	if !identity.IsAdmin {
		for _, pid := range details.ProjectIDs {
			if err := h.checkAccess(r.Context(), pid, identity); err != nil {
				if errors.Is(err, ErrForbidden) {
					httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
					return
				}
				if errors.Is(err, ErrNotFound) {
					httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
					return
				}
				httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, details)
}

func requireShipmentBatchQuery(w http.ResponseWriter, r *http.Request) bool {
	query := r.URL.Query()
	projectID, err := strconv.ParseInt(strings.TrimSpace(query.Get("project_id")), 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id is required and must be greater than 0")
		return false
	}
	if strings.TrimSpace(query.Get("country")) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country is required")
		return false
	}
	return true
}

func (h *Handler) ListShipmentBatches(w http.ResponseWriter, r *http.Request) {
	if !requireShipmentBatchQuery(w, r) {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if filter.ProjectID != nil {
		if err := h.checkAccess(r.Context(), *filter.ProjectID, identity); err != nil {
			if errors.Is(err, ErrForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			if errors.Is(err, ErrNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else if !identity.IsAdmin && h.projects != nil {
		accessible, err := h.projects.ListManage(r.Context(), identity.Operator, false, false)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(accessible) == 0 {
			_ = httpapi.WriteJSON(w, http.StatusOK, []string{})
			return
		}
		for _, p := range accessible {
			filter.ProjectIDs = append(filter.ProjectIDs, p.ID)
		}
	}
	batches, err := h.store.ListBatches(r.Context(), filter.ProjectID, filter.ProjectIDs, filter.Country)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if batches == nil {
		batches = []string{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{"batches": batches})
}

func (h *Handler) HideShipmentBatch(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if strings.TrimSpace(identity.Operator) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "缺少操作者信息")
		return
	}
	var req ShipmentBatchHiddenDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if err := h.checkAccess(r.Context(), req.ProjectID, identity); err != nil {
		if errors.Is(err, ErrForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok, err := h.store.HideBatch(r.Context(), req)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.auditor != nil {
		entry := audit.Entry{
			Action:     "shipment_schedules.batches.hide",
			TargetType: "shipment_batch_dropdown_hidden",
			Operator:   &identity.Operator,
			AfterJSON:  req,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{"deleted": ok})
}

func (h *Handler) GetShipmentScheduleDetail(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	idStr := chi.URLParam(r, "schedule_id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid schedule_id")
		return
	}
	detail, err := h.store.GetShipmentSchedule(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if detail == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "排期不存在")
		return
	}
	if err := h.checkAccess(r.Context(), detail.ProjectID, identity); err != nil {
		if errors.Is(err, ErrForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (h *Handler) CreateShipmentSchedule(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var create ShipmentScheduleCreate
	if err := json.NewDecoder(r.Body).Decode(&create); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if err := h.checkAccess(r.Context(), create.ProjectID, identity); err != nil {
		if errors.Is(err, ErrForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	detail, err := h.store.CreateShipmentSchedule(r.Context(), create, identity.Operator)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", detail.ID)
		entry := audit.Entry{
			Action:     "shipment_schedules.create",
			TargetType: "shipment_schedule",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  detail,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (h *Handler) UpdateShipmentSchedule(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	idStr := chi.URLParam(r, "schedule_id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid schedule_id")
		return
	}
	before, _ := h.store.GetShipmentSchedule(r.Context(), id)
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "排期不存在")
		return
	}
	if err := h.checkAccess(r.Context(), before.ProjectID, identity); err != nil {
		if errors.Is(err, ErrForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	var update ShipmentScheduleUpdate
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if update.ProjectID > 0 && update.ProjectID != before.ProjectID {
		if err := h.checkAccess(r.Context(), update.ProjectID, identity); err != nil {
			if errors.Is(err, ErrForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
				return
			}
			httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	detail, err := h.store.UpdateShipmentSchedule(r.Context(), id, update, identity.Operator)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if detail == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "排期不存在")
		return
	}
	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "shipment_schedules.update",
			TargetType: "shipment_schedule",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			BeforeJSON: before,
			AfterJSON:  detail,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (h *Handler) DeleteShipmentSchedule(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	idStr := chi.URLParam(r, "schedule_id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid schedule_id")
		return
	}
	before, _ := h.store.GetShipmentSchedule(r.Context(), id)
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "排期不存在")
		return
	}
	if err := h.checkAccess(r.Context(), before.ProjectID, identity); err != nil {
		if errors.Is(err, ErrForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok, err := h.store.DeleteShipmentSchedule(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		httpapi.WriteDetail(w, http.StatusNotFound, "排期不存在")
		return
	}
	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "shipment_schedules.delete",
			TargetType: "shipment_schedule",
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
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (h *Handler) ImportShipmentSchedulesCSV(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	r.Body = http.MaxBytesReader(w, r.Body, maxShipmentCSVImportBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, shipmentCSVTooLargeDetail)
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
	resp, err := h.store.ImportSchedulesCSV(r.Context(), data, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "400") || strings.Contains(err.Error(), "缺少") || strings.Contains(err.Error(), "不存在") || strings.Contains(err.Error(), "已存在") {
			httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.auditor != nil {
		filename := ""
		if header != nil {
			filename = header.Filename
		}
		entry := audit.Entry{
			Action:     "shipment_schedules.import_csv",
			TargetType: "shipment_schedule",
			Operator:   &identity.Operator,
			AfterJSON: map[string]any{
				"filename":     filename,
				"inserted":     resp.Inserted,
				"shipment_nos": resp.ShipmentNos,
			},
			Result: "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ImportShipmentScheduleItemsCSV(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	idStr := chi.URLParam(r, "schedule_id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid schedule_id")
		return
	}
	before, _ := h.store.GetShipmentSchedule(r.Context(), id)
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "排期不存在")
		return
	}
	if err := h.checkAccess(r.Context(), before.ProjectID, identity); err != nil {
		if errors.Is(err, ErrForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxShipmentCSVImportBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, shipmentCSVTooLargeDetail)
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
	resp, err := h.store.ImportItemsCSV(r.Context(), id, data, identity.Operator)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if strings.Contains(err.Error(), "400") || strings.Contains(err.Error(), "缺少") || strings.Contains(err.Error(), "不匹配") || strings.Contains(err.Error(), "不一致") {
			httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", id)
		filename := ""
		if header != nil {
			filename = header.Filename
		}
		entry := audit.Entry{
			Action:     "shipment_schedules.items.import_csv",
			TargetType: "shipment_schedule_item",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON: map[string]any{
				"filename": filename,
				"resp":     resp,
			},
			Result: "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) CalculateShipmentScheduleCosts(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	idStr := chi.URLParam(r, "schedule_id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid schedule_id")
		return
	}
	before, _ := h.store.GetShipmentSchedule(r.Context(), id)
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "排期不存在")
		return
	}
	if err := h.checkAccess(r.Context(), before.ProjectID, identity); err != nil {
		if errors.Is(err, ErrForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	var req ShipmentCostCalculateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	detail, err := h.store.CalculateCosts(r.Context(), id, req)
	if err != nil {
		if errors.Is(err, ErrForbidden) || strings.Contains(err.Error(), "403") {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.auditor != nil {
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "shipment_schedules.calculate_costs",
			TargetType: "shipment_schedule",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			BeforeJSON: before,
			AfterJSON:  detail,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		if err := h.auditor.LogAction(r.Context(), entry); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}
