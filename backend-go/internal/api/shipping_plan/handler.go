package shipping_plan

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
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
		return nil
	}
	if verifier, ok := h.store.(interface {
		VerifyProjectAccess(context.Context, int64, string, bool) error
	}); ok {
		return verifier.VerifyProjectAccess(ctx, projectID, identity.Operator, identity.IsAdmin)
	}
	return nil
}

func writePlanError(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	msg := err.Error()
	if errors.Is(err, ErrForbidden) || strings.Contains(msg, "403") || strings.Contains(msg, "无权限") {
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
		return
	}
	if errors.Is(err, ErrSKUNotFound) {
		httpapi.WriteDetail(w, http.StatusNotFound, ErrSKUNotFound.Error())
		return
	}
	if errors.Is(err, ErrNotFound) || strings.Contains(msg, "404") || strings.Contains(msg, "不存在") {
		httpapi.WriteDetail(w, http.StatusNotFound, msg)
		return
	}
	if errors.Is(err, ErrConflict) || strings.Contains(msg, "409") || strings.Contains(msg, "已取消") || strings.Contains(msg, "超过") || strings.Contains(msg, "已关联") || strings.Contains(msg, "仅 draft") {
		httpapi.WriteDetail(w, http.StatusConflict, msg)
		return
	}
	if errors.Is(err, ErrUnprocessable) || strings.Contains(msg, "422") || strings.Contains(msg, "不包含该 SKU") || strings.Contains(msg, "不属于项目") {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, msg)
		return
	}
	httpapi.WriteInternalServerError(w)
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

func growthFactorSKU(r *http.Request) (string, bool) {
	rest := chi.URLParam(r, "*")
	if rest == "" {
		rest = chi.URLParam(r, "sku")
		if rest != "" {
			rest += "/growth-factor"
		}
	}
	const suffix = "/growth-factor"
	if !strings.HasSuffix(rest, suffix) {
		return "", false
	}
	sku := strings.TrimSuffix(rest, suffix)
	if sku == "" {
		return "", false
	}
	return sku, true
}

func parseGrowthFactorValue(raw json.RawMessage) (float64, bool) {
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return 0, false
	}
	if strings.HasPrefix(text, `"`) {
		var quoted string
		if err := json.Unmarshal(raw, &quoted); err != nil {
			return 0, false
		}
		text = strings.TrimSpace(quoted)
	}
	if text == "" {
		return 0, false
	}
	rat, ok := new(big.Rat).SetString(text)
	if !ok || rat.Sign() < 0 {
		return 0, false
	}
	parts := strings.Split(text, ".")
	if len(parts) > 2 {
		return 0, false
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = strings.TrimRight(parts[1], "0")
		if len(fraction) > 4 {
			return 0, false
		}
	}
	integerDigits := strings.TrimLeft(strings.TrimPrefix(parts[0], "+"), "0")
	if len(integerDigits)+len(fraction) > 8 {
		return 0, false
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, false
	}
	return value, true
}

func (h *Handler) GetShippingPlanSkus(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	projectID, _ := strconv.ParseInt(r.URL.Query().Get("project_id"), 10, 64)
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Missing or invalid project_id")
		return
	}
	if err := h.checkAccess(r.Context(), projectID, identity); err != nil {
		writePlanError(w, err)
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if pageSize < 1 {
		pageSize = 50
	}
	resp, err := h.store.ListSkus(r.Context(), projectID, country, page, pageSize)
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetShippingPlanForecast(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	projectID, _ := strconv.ParseInt(r.URL.Query().Get("project_id"), 10, 64)
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Missing or invalid project_id")
		return
	}
	if err := h.checkAccess(r.Context(), projectID, identity); err != nil {
		writePlanError(w, err)
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	sku := strings.TrimSpace(r.URL.Query().Get("sku"))
	resp, err := h.store.GetForecast(r.Context(), projectID, country, sku)
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) PutShippingPlanGrowthFactor(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	sku, ok := growthFactorSKU(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	sku = strings.TrimSpace(sku)
	if sku == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "sku 不能为空")
		return
	}
	var payload struct {
		ProjectID    int64           `json:"project_id"`
		Country      string          `json:"country"`
		GrowthFactor json.RawMessage `json:"growth_factor"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := decoder.Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if payload.ProjectID <= 0 ||
		utf8.RuneCountInString(payload.Country) != 2 ||
		len(payload.GrowthFactor) == 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	country := strings.ToUpper(payload.Country)
	switch country {
	case "US", "DE", "UK":
	case "GB":
		country = "UK"
	default:
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country must be one of: US, DE, UK")
		return
	}
	growthFactor, ok := parseGrowthFactorValue(payload.GrowthFactor)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid growth_factor")
		return
	}
	req := ShippingPlanGrowthFactorUpdate{
		ProjectID:    payload.ProjectID,
		Country:      country,
		GrowthFactor: growthFactor,
	}
	if err := h.checkAccess(r.Context(), req.ProjectID, identity); err != nil {
		writePlanError(w, err)
		return
	}

	var resp ShippingPlanGrowthFactorResponse
	err := h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		updated, err := txStore.UpdateGrowthFactor(ctx, sku, req)
		if err != nil {
			return err
		}
		resp = updated
		targetID := sku
		entry := audit.Entry{
			Action:     "shipping_plan.growth_factor.update",
			TargetType: "shipping_plan_sku_setting",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON: map[string]any{
				"project_id":    resp.ProjectID,
				"country":       resp.Country,
				"sku":           resp.SKU,
				"growth_factor": resp.GrowthFactor,
			},
			Result: "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetShippingPlanShipmentHistory(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	projectID, _ := strconv.ParseInt(r.URL.Query().Get("project_id"), 10, 64)
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Missing or invalid project_id")
		return
	}
	if err := h.checkAccess(r.Context(), projectID, identity); err != nil {
		writePlanError(w, err)
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	etdFrom := r.URL.Query().Get("etd_from")
	etdTo := r.URL.Query().Get("etd_to")
	resp, err := h.store.GetShipmentHistory(r.Context(), projectID, country, etdFrom, etdTo)
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetShippingPlanBatches(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	projectID, _ := strconv.ParseInt(r.URL.Query().Get("project_id"), 10, 64)
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Missing or invalid project_id")
		return
	}
	if err := h.checkAccess(r.Context(), projectID, identity); err != nil {
		writePlanError(w, err)
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	resp, err := h.store.ListBatches(r.Context(), projectID, country)
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) PostShippingPlanBatch(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var req ShippingPlanBatchCreate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	for _, it := range req.Items {
		if it.Quantity <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "明细数量必须大于0")
			return
		}
	}
	if err := h.checkAccess(r.Context(), req.ProjectID, identity); err != nil {
		writePlanError(w, err)
		return
	}
	var resp ShippingPlanBatchResponse
	err := h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		created, err := txStore.CreateBatch(ctx, req, identity.Operator)
		if err != nil {
			return err
		}
		resp = created
		targetID := fmt.Sprintf("%d", resp.ID)
		entry := audit.Entry{
			Action:     "shipping_plan.batch.create",
			TargetType: "shipping_plan_batch",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, resp)
}

func (h *Handler) PatchShippingPlanBatch(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	batchID, err := strconv.ParseInt(chi.URLParam(r, "batch_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid batch_id")
		return
	}
	batch, err := h.store.GetBatch(r.Context(), batchID)
	if err != nil {
		writePlanError(w, err)
		return
	}
	if batch == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "计划批次不存在")
		return
	}
	if err := h.checkAccess(r.Context(), batch.ProjectID, identity); err != nil {
		writePlanError(w, err)
		return
	}

	var req ShippingPlanBatchUpdate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	for _, it := range req.Items {
		if it.Quantity <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "明细数量必须大于0")
			return
		}
	}
	var resp *ShippingPlanBatchResponse
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		updated, err := txStore.UpdateBatch(ctx, batchID, req, identity.Operator)
		if err != nil {
			return err
		}
		if updated == nil {
			return ErrNotFound
		}
		resp = updated
		targetID := fmt.Sprintf("%d", resp.ID)
		entry := audit.Entry{
			Action:     "shipping_plan.batch.update",
			TargetType: "shipping_plan_batch",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) CancelShippingPlanBatch(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	batchID, err := strconv.ParseInt(chi.URLParam(r, "batch_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid batch_id")
		return
	}
	batch, err := h.store.GetBatch(r.Context(), batchID)
	if err != nil {
		writePlanError(w, err)
		return
	}
	if batch == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "计划批次不存在")
		return
	}
	if err := h.checkAccess(r.Context(), batch.ProjectID, identity); err != nil {
		writePlanError(w, err)
		return
	}

	var resp *ShippingPlanBatchResponse
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		cancelled, err := txStore.CancelBatch(ctx, batchID, identity.Operator)
		if err != nil {
			return err
		}
		if cancelled == nil {
			return ErrNotFound
		}
		resp = cancelled
		targetID := fmt.Sprintf("%d", resp.ID)
		entry := audit.Entry{
			Action:     "shipping_plan.batch.cancel",
			TargetType: "shipping_plan_batch",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) PostShippingPlanAllocation(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	batchID, err := strconv.ParseInt(chi.URLParam(r, "batch_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid batch_id")
		return
	}
	batch, err := h.store.GetBatch(r.Context(), batchID)
	if err != nil {
		writePlanError(w, err)
		return
	}
	if batch == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "计划批次不存在")
		return
	}
	if err := h.checkAccess(r.Context(), batch.ProjectID, identity); err != nil {
		writePlanError(w, err)
		return
	}

	var req ShippingPlanAllocationCreate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if req.Quantity <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "分配数量必须为正整数")
		return
	}
	var resp ShippingPlanAllocationResult
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		created, err := txStore.CreateAllocation(ctx, batchID, req, identity.Operator)
		if err != nil {
			return err
		}
		resp = created
		targetID := fmt.Sprintf("%d", resp.Allocation.ID)
		entry := audit.Entry{
			Action:     "shipping_plan.allocation.create",
			TargetType: "shipping_plan_allocation",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON: map[string]any{
				"plan_item_id":         req.PlanItemID,
				"shipment_schedule_id": req.ShipmentScheduleID,
				"quantity":             req.Quantity,
			},
			Result: "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		writePlanError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, resp)
}

func (h *Handler) RemoveShippingPlanAllocation(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	allocID, err := strconv.ParseInt(chi.URLParam(r, "allocation_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid allocation_id")
		return
	}
	projectID, err := h.store.GetAllocationProjectID(r.Context(), allocID)
	if err != nil {
		if errors.Is(err, ErrNotFound) || strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "不存在") {
			httpapi.WriteDetail(w, http.StatusNotFound, "货件关联不存在")
			return
		}
		writePlanError(w, err)
		return
	}
	if err := h.checkAccess(r.Context(), projectID, identity); err != nil {
		writePlanError(w, err)
		return
	}
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		deleted, err := txStore.DeleteAllocation(ctx, allocID, identity.Operator)
		if err != nil {
			return err
		}
		if !deleted {
			return ErrNotFound
		}
		targetID := fmt.Sprintf("%d", allocID)
		entry := audit.Entry{
			Action:     "shipping_plan.allocation.delete",
			TargetType: "shipping_plan_allocation",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			Result:     "success",
		}
		return h.logActionTx(ctx, r, tx, entry)
	})
	if err != nil {
		writePlanError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
