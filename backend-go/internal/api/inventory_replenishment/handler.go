package inventory_replenishment

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ProjectReader interface {
	GetProject(ctx context.Context, id int64) (*projects.ProjectItem, error)
	ListManage(ctx context.Context, operator string, isAdmin bool, isLeader bool) ([]projects.ProjectItem, error)
}

type Handler struct {
	store    Store
	auditor  audit.Service
	projects ProjectReader
}

type transactionRunner interface {
	RunInTx(
		ctx context.Context,
		fn func(context.Context, pgx.Tx, Store) error,
	) error
}

var errSnapshotNotFound = errors.New("快照不存在")

func NewHandler(store Store, auditor audit.Service, projectReaders ...ProjectReader) *Handler {
	var pr ProjectReader
	if len(projectReaders) > 0 {
		pr = projectReaders[0]
	}
	return &Handler{store: store, auditor: auditor, projects: pr}
}

func (h *Handler) checkAccess(w http.ResponseWriter, r *http.Request, projectID int64, identity auth.UserContext) bool {
	if identity.IsAdmin {
		return true
	}
	if h.projects != nil {
		p, err := h.projects.GetProject(r.Context(), projectID)
		if err != nil {
			httpapi.WriteInternalServerError(w)
			return false
		}
		if p == nil {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return false
		}
		if !projects.CanAccessProject(*p, identity.Operator, false) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return false
		}
		return true
	}
	err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return false
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return false
		}
		httpapi.WriteInternalServerError(w)
		return false
	}
	return true
}

func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	if runner, ok := h.store.(transactionRunner); ok {
		return runner.RunInTx(ctx, fn)
	}
	return fn(ctx, nil, h.store)
}

func (h *Handler) logActionTx(
	ctx context.Context,
	r *http.Request,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	if h.auditor == nil {
		return nil
	}
	entry.PopulateFromRequest(r)
	if tx != nil {
		return h.auditor.LogActionTx(ctx, tx, entry)
	}
	return h.auditor.LogAction(ctx, entry)
}

func (h *Handler) resolveScope(w http.ResponseWriter, r *http.Request, filter *ReplenishmentFilter, identity auth.UserContext) bool {
	if filter.ProjectID != nil {
		return h.checkAccess(w, r, *filter.ProjectID, identity)
	}
	if identity.IsAdmin {
		return true
	}
	if h.projects != nil {
		accessible, err := h.projects.ListManage(r.Context(), identity.Operator, false, false)
		if err != nil {
			httpapi.WriteInternalServerError(w)
			return false
		}
		if len(accessible) == 0 {
			filter.ProjectIDs = []int64{-1}
			return true
		}
		for _, p := range accessible {
			filter.ProjectIDs = append(filter.ProjectIDs, p.ID)
		}
	}
	return true
}

func requireProjectIDQuery(w http.ResponseWriter, r *http.Request) bool {
	value, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("project_id")), 10, 64)
	if err != nil || value <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id is required and must be greater than 0")
		return false
	}
	return true
}

func (h *Handler) parseFilter(r *http.Request) ReplenishmentFilter {
	identity, _ := auth.UserContextFromContext(r.Context())
	query := r.URL.Query()
	var projectID *int64
	if v, err := strconv.ParseInt(query.Get("project_id"), 10, 64); err == nil && v > 0 {
		projectID = &v
	}
	var country, riskStatus, keyword, snapshotDate *string
	if v := strings.TrimSpace(query.Get("country")); v != "" {
		country = &v
	}
	if v := strings.TrimSpace(query.Get("risk_status")); v != "" {
		riskStatus = &v
	}
	if v := strings.TrimSpace(query.Get("keyword")); v != "" {
		keyword = &v
	}
	if v := strings.TrimSpace(query.Get("snapshot_date")); v != "" {
		snapshotDate = &v
	}
	page := 1
	if v, err := strconv.Atoi(query.Get("page")); err == nil && v >= 1 {
		page = v
	}
	pageSize := 50
	if v, err := strconv.Atoi(query.Get("page_size")); err == nil && v >= 1 {
		pageSize = v
	}
	return ReplenishmentFilter{
		ProjectID:    projectID,
		Country:      country,
		RiskStatus:   riskStatus,
		Keyword:      keyword,
		SnapshotDate: snapshotDate,
		Page:         page,
		PageSize:     pageSize,
		Operator:     identity.Operator,
		IsAdmin:      identity.IsAdmin,
	}
}

func decodeRequestJSON(w http.ResponseWriter, r *http.Request, dst any, strict bool) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func parseSnapshotID(r *http.Request) (int64, error) {
	value := strings.TrimSpace(chi.URLParam(r, "snapshot_id"))
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, errors.New("invalid snapshot_id")
	}
	return id, nil
}

func validateRuneLength(value *string, maximum int) bool {
	return value == nil || utf8.RuneCountInString(*value) <= maximum
}

func normalizeRequestText(value *string, maximum int) *string {
	if value == nil {
		return nil
	}
	text := strings.TrimSpace(*value)
	switch strings.ToLower(text) {
	case "", "nan", "na", "n/a", "null", "none", "-", "--":
		return nil
	}
	runes := []rune(text)
	if len(runes) > maximum {
		runes = runes[:maximum]
	}
	text = string(runes)
	return &text
}

func inventorySettingSKU(r *http.Request) string {
	sku := chi.URLParam(r, "sku")
	if sku == "" {
		sku = chi.URLParam(r, "*")
	}
	return sku
}

func parseSnapshotItemsFilter(r *http.Request) (SnapshotItemsFilter, error) {
	query := r.URL.Query()
	filter := SnapshotItemsFilter{Page: 1, PageSize: 50}
	if value := strings.TrimSpace(query.Get("keyword")); value != "" {
		filter.Keyword = &value
	}
	if value := strings.TrimSpace(query.Get("risk_status")); value != "" {
		filter.RiskStatus = &value
	}
	if raw, ok := query["in_transit_only"]; ok && len(raw) > 0 {
		value, err := strconv.ParseBool(raw[0])
		if err != nil {
			return filter, errors.New("invalid in_transit_only")
		}
		filter.InTransitOnly = value
	}
	if raw, ok := query["page"]; ok && len(raw) > 0 {
		value, err := strconv.Atoi(raw[0])
		if err != nil || value < 1 {
			return filter, errors.New("invalid page")
		}
		filter.Page = value
	}
	if raw, ok := query["page_size"]; ok && len(raw) > 0 {
		value, err := strconv.Atoi(raw[0])
		if err != nil || value < 1 || value > 200 {
			return filter, errors.New("invalid page_size")
		}
		filter.PageSize = value
	}
	return filter, nil
}

func (h *Handler) GetInventoryAnalysis(w http.ResponseWriter, r *http.Request) {
	if !requireProjectIDQuery(w, r) {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if !h.resolveScope(w, r, &filter, identity) {
		return
	}
	if !identity.IsAdmin && filter.ProjectID == nil && len(filter.ProjectIDs) == 1 && filter.ProjectIDs[0] == -1 {
		_ = httpapi.WriteJSON(w, http.StatusOK, InventoryAnalysisResponse{
			Items: []InventoryAnalysisItem{},
			Summary: InventoryAnalysisSummary{
				TotalSKU:                0,
				OutOfStockRiskCount:     0,
				TotalAvailableInventory: 0,
			},
		})
		return
	}
	resp, err := h.store.GetInventoryAnalysis(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ListInventorySnapshotOptions(w http.ResponseWriter, r *http.Request) {
	if !requireProjectIDQuery(w, r) {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if !h.resolveScope(w, r, &filter, identity) {
		return
	}
	if !identity.IsAdmin && filter.ProjectID == nil && len(filter.ProjectIDs) == 1 && filter.ProjectIDs[0] == -1 {
		_ = httpapi.WriteJSON(w, http.StatusOK, []InventorySnapshotOption{})
		return
	}
	opts, err := h.store.ListSnapshotOptions(r.Context(), filter.ProjectID, filter.Country)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if opts == nil {
		opts = []InventorySnapshotOption{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, opts)
}

func (h *Handler) ListInventoryReplenishmentAnalysis(w http.ResponseWriter, r *http.Request) {
	if !requireProjectIDQuery(w, r) {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if !h.resolveScope(w, r, &filter, identity) {
		return
	}
	if !identity.IsAdmin && filter.ProjectID == nil && len(filter.ProjectIDs) == 1 && filter.ProjectIDs[0] == -1 {
		_ = httpapi.WriteJSON(w, http.StatusOK, InventoryReplenishmentListResponse{
			Items:    []InventoryReplenishmentListItem{},
			Page:     filter.Page,
			PageSize: filter.PageSize,
			Total:    0,
			HasNext:  false,
		})
		return
	}
	resp, err := h.store.ListAnalysis(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) UpdateInventoryReplenishmentSetting(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	projectID, err := strconv.ParseInt(chi.URLParam(r, "project_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	if !h.checkAccess(w, r, projectID, identity) {
		return
	}
	sku := strings.TrimSpace(inventorySettingSKU(r))
	skuRunes := []rune(sku)
	if len(skuRunes) == 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "sku 不能为空")
		return
	}
	if len(skuRunes) > 128 {
		sku = string(skuRunes[:128])
	}
	var update InventoryReplenishmentSettingUpdate
	if err := decodeRequestJSON(w, r, &update, false); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if update.ProductionLeadDays == nil || update.ShippingDays == nil || update.SafetyFactor == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "production_lead_days、shipping_days、safety_factor 必填")
		return
	}
	if *update.ProductionLeadDays < 0 || *update.ShippingDays < 0 || *update.SafetyFactor < 0 ||
		math.IsNaN(*update.SafetyFactor) || math.IsInf(*update.SafetyFactor, 0) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "补货参数必须大于等于 0")
		return
	}
	if update.TargetDays != nil && *update.TargetDays < 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "target_days 必须大于等于 0")
		return
	}
	if update.ASIN != nil && utf8.RuneCountInString(*update.ASIN) > 64 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "asin 长度不能超过 64")
		return
	}
	update.ASIN = normalizeRequestText(update.ASIN, 64)
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	switch country {
	case "US", "DE", "UK":
	case "GB":
		country = "UK"
	default:
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country must be one of: US, DE, UK")
		return
	}
	update.Country = country

	var item InventoryReplenishmentSettingItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		updated, err := txStore.UpdateSetting(ctx, projectID, sku, update, identity.Operator)
		if err != nil {
			return err
		}
		item = updated
		targetID := fmt.Sprintf("%d", item.ID)
		entry := audit.Entry{
			Action:     "inventory_replenishment_settings.upsert",
			TargetType: "inventory_replenishment_setting",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON: map[string]any{
				"project_id":           item.ProjectID,
				"sku":                  item.SKU,
				"country":              item.Country,
				"asin":                 item.ASIN,
				"production_lead_days": item.ProductionLeadDays,
				"shipping_days":        item.ShippingDays,
				"safety_factor":        item.SafetyFactor,
				"target_days":          item.TargetDays,
			},
			Result: "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) ListInventoryReplenishmentShipments(w http.ResponseWriter, r *http.Request) {
	if !requireProjectIDQuery(w, r) {
		return
	}
	if strings.TrimSpace(r.URL.Query().Get("sku")) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "sku is required")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if !h.resolveScope(w, r, &filter, identity) {
		return
	}
	if !identity.IsAdmin && filter.ProjectID == nil && len(filter.ProjectIDs) == 1 && filter.ProjectIDs[0] == -1 {
		_ = httpapi.WriteJSON(w, http.StatusOK, InventoryReplenishmentShipmentResponse{Items: []InventoryReplenishmentShipmentItem{}})
		return
	}
	resp, err := h.store.ListShipments(r.Context(), filter.ProjectID, filter.Country)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ListInventoryReplenishmentCalendar(w http.ResponseWriter, r *http.Request) {
	if !requireProjectIDQuery(w, r) {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if !h.resolveScope(w, r, &filter, identity) {
		return
	}
	if !identity.IsAdmin && filter.ProjectID == nil && len(filter.ProjectIDs) == 1 && filter.ProjectIDs[0] == -1 {
		_ = httpapi.WriteJSON(w, http.StatusOK, CalendarResponse{Items: []CalendarRowItem{}})
		return
	}
	resp, err := h.store.ListCalendar(r.Context(), filter.ProjectID, filter.Country)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ListSeasonalReplenishmentAnalysis(w http.ResponseWriter, r *http.Request) {
	if !requireProjectIDQuery(w, r) {
		return
	}
	for _, key := range []string{"from_date", "to_date"} {
		if strings.TrimSpace(r.URL.Query().Get(key)) == "" {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, key+" is required")
			return
		}
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if !h.resolveScope(w, r, &filter, identity) {
		return
	}
	if !identity.IsAdmin && filter.ProjectID == nil && len(filter.ProjectIDs) == 1 && filter.ProjectIDs[0] == -1 {
		_ = httpapi.WriteJSON(w, http.StatusOK, SeasonalReplenishmentListResponse{Items: []SeasonalReplenishmentListItem{}})
		return
	}
	resp, err := h.store.ListSeasonal(r.Context(), filter.ProjectID, filter.Country)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ListInventoryReplenishmentSnapshots(w http.ResponseWriter, r *http.Request) {
	if !requireProjectIDQuery(w, r) {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := h.parseFilter(r)
	if !h.resolveScope(w, r, &filter, identity) {
		return
	}
	if !identity.IsAdmin && filter.ProjectID == nil && len(filter.ProjectIDs) == 1 && filter.ProjectIDs[0] == -1 {
		_ = httpapi.WriteJSON(w, http.StatusOK, []InventoryReplenishmentSnapshotListItem{})
		return
	}
	resp, err := h.store.ListSnapshots(r.Context(), filter.ProjectID, filter.Country)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if resp == nil {
		resp = []InventoryReplenishmentSnapshotListItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) CreateInventoryReplenishmentSnapshot(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	projectID, _ := strconv.ParseInt(r.URL.Query().Get("project_id"), 10, 64)
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id 必须大于 0")
		return
	}
	if !h.checkAccess(w, r, projectID, identity) {
		return
	}
	country := r.URL.Query().Get("country")
	if country == "" {
		country = "US"
	}
	var req CreateSnapshotRequest
	if err := decodeRequestJSON(w, r, &req, false); err != nil && !errors.Is(err, io.EOF) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if !validateRuneLength(req.Name, 255) || !validateRuneLength(req.Description, 512) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "name 或 description 超出长度限制")
		return
	}
	req.Name = normalizeRequestText(req.Name, 255)
	req.Description = normalizeRequestText(req.Description, 512)

	var item InventoryReplenishmentSnapshotListItem
	err := h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		created, err := txStore.CreateSnapshot(ctx, projectID, country, req, identity.Operator)
		if err != nil {
			return err
		}
		item = created
		targetID := fmt.Sprintf("%d", item.ID)
		entry := audit.Entry{
			Action:     "inventory_replenishment_snapshot.create",
			TargetType: "inventory_replenishment_snapshot",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON: map[string]any{
				"project_id": projectID,
				"country":    country,
				"name":       req.Name,
				"row_count":  item.RowCount,
			},
			Result: "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) GetInventoryReplenishmentSnapshot(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	id, err := parseSnapshotID(r)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	snapshot, err := h.store.GetSnapshot(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if snapshot == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "快照不存在")
		return
	}
	if !h.checkAccess(w, r, snapshot.ProjectID, identity) {
		return
	}
	items, err := h.store.ListSnapshotItems(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = []InventoryReplenishmentSnapshotItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, InventoryReplenishmentSnapshotDetail{
		InventoryReplenishmentSnapshotListItem: *snapshot,
		Items:                                  items,
	})
}

func (h *Handler) ListInventoryReplenishmentSnapshotItems(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	id, err := parseSnapshotID(r)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	filter, err := parseSnapshotItemsFilter(r)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid query parameters")
		return
	}
	snapshot, err := h.store.GetSnapshot(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if snapshot == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "快照不存在")
		return
	}
	if !h.checkAccess(w, r, snapshot.ProjectID, identity) {
		return
	}
	resp, err := h.store.ListSnapshotItemsPage(r.Context(), snapshot, filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if resp.Items == nil {
		resp.Items = []InventoryReplenishmentListItem{}
	}
	if resp.Summary.StateDistribution == nil {
		resp.Summary.StateDistribution = map[string]int{}
	}
	if resp.Summary.ActionDistribution == nil {
		resp.Summary.ActionDistribution = map[string]int{}
	}
	if resp.Summary.StateActionMatrix == nil {
		resp.Summary.StateActionMatrix = map[string]map[string]int{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) UpdateInventoryReplenishmentSnapshot(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "仅管理员可修改快照")
		return
	}

	id, err := strconv.ParseInt(chi.URLParam(r, "snapshot_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	var req UpdateSnapshotRequest
	if err := decodeRequestJSON(w, r, &req, true); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if !validateRuneLength(req.Name, 255) || !validateRuneLength(req.Description, 512) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "name 或 description 超出长度限制")
		return
	}
	req.Name = normalizeRequestText(req.Name, 255)
	req.Description = normalizeRequestText(req.Description, 512)

	var item *InventoryReplenishmentSnapshotListItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		updated, err := txStore.UpdateSnapshot(ctx, id, req, identity.Operator)
		if err != nil {
			return err
		}
		if updated == nil {
			return errSnapshotNotFound
		}
		item = updated
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "inventory_replenishment_snapshot.update",
			TargetType: "inventory_replenishment_snapshot",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON: map[string]any{
				"snapshot_id": id,
				"name":        updated.Name,
				"description": updated.Description,
			},
			Result: "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		if errors.Is(err, errSnapshotNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "快照不存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteInventoryReplenishmentSnapshot(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "仅管理员可删除快照")
		return
	}

	id, err := strconv.ParseInt(chi.URLParam(r, "snapshot_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	var ok bool
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		deleted, err := txStore.DeleteSnapshot(ctx, id, identity.Operator)
		if err != nil {
			return err
		}
		if !deleted {
			return errSnapshotNotFound
		}
		ok = deleted
		targetID := fmt.Sprintf("%d", id)
		entry := audit.Entry{
			Action:     "inventory_replenishment_snapshot.delete",
			TargetType: "inventory_replenishment_snapshot",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  map[string]any{"snapshot_id": id, "deleted": true},
			Result:     "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		if errors.Is(err, errSnapshotNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "快照不存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": ok, "snapshot_id": id})
}
