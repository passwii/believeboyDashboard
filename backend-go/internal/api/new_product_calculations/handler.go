package new_product_calculations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"github.com/passwii/believeboyDashboard/backend-go/internal/pricing"
)

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

type transactionRunner interface {
	RunInTx(
		ctx context.Context,
		fn func(context.Context, pgx.Tx, Store) error,
	) error
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	var projectID *int64
	if raw := query.Get("project_id"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
			return
		}
		projectID = &value
		if !h.checkProjectAccess(w, r, value) {
			return
		}
	}

	var calculationType, country *string
	if raw := query.Get("calculation_type"); raw != "" {
		calculationType = &raw
	}
	if raw := query.Get("country"); raw != "" {
		country = &raw
	}

	page, ok := newProductQueryInt(w, r, "page", 1, 1, int(^uint(0)>>1))
	if !ok {
		return
	}
	pageSize, ok := newProductQueryInt(w, r, "page_size", 200, 1, 500)
	if !ok {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	result, err := h.store.List(r.Context(), ListFilter{
		ProjectID:       projectID,
		CalculationType: calculationType,
		Country:         country,
		Page:            page,
		PageSize:        pageSize,
		Operator:        identity.Operator,
		IsAdmin:         identity.IsAdmin,
	})
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	if result.Items == nil {
		result.Items = []NewProductCalculationItem{}
	}
	result.Page = page
	result.PageSize = pageSize
	for index := range result.Items {
		if result.Items[index].Warnings == nil {
			result.Items[index].Warnings = []string{}
		}
		applyAnchor(&result.Items[index])
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	projectID, err := strconv.ParseInt(chi.URLParam(r, "project_id"), 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	if !h.checkProjectAccess(w, r, projectID) {
		return
	}
	calculationType := r.URL.Query().Get("calculation_type")
	if calculationType == "" {
		calculationType = "profit_calc"
	}
	item, err := h.store.Get(r.Context(), projectID, chi.URLParam(r, "sku"), calculationType)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "记录不存在")
		return
	}
	if item.Warnings == nil {
		item.Warnings = []string{}
	}
	applyAnchor(item)
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) Upsert(w http.ResponseWriter, r *http.Request) {
	input, err := decodeCreateRequest(r)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if input.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return
	}
	if !h.checkProjectAccess(w, r, input.ProjectID) {
		return
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	var item *NewProductCalculationItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		upserted, upsertErr := txStore.Upsert(ctx, input, identity.Operator)
		if upsertErr != nil {
			return upsertErr
		}
		if upserted == nil {
			return errors.New("new product calculation upsert returned nil")
		}
		item = upserted
		return h.logActionTx(ctx, r, tx, audit.Entry{
			Action:     "pricing_calculation.new_product_calculation.upsert",
			TargetType: "new_product_calculation",
			TargetID:   stringPointer(strconv.FormatInt(item.ID, 10)),
			AfterJSON: map[string]any{
				"id": item.ID, "project_id": item.ProjectID, "project_name": item.ProjectName,
				"sku": item.SKU, "calculation_type": item.CalculationType,
			},
		})
	})
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	if item.Warnings == nil {
		item.Warnings = []string{}
	}
	applyAnchor(item)
	_ = httpapi.WriteJSON(w, http.StatusCreated, item)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	snapshotID, err := strconv.ParseInt(chi.URLParam(r, "snapshot_id"), 10, 64)
	if err != nil || snapshotID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	projectID, err := h.store.ProjectID(r.Context(), snapshotID)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	if !h.checkProjectAccess(w, r, projectID) {
		return
	}
	var deleted bool
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var deleteErr error
		deleted, deleteErr = txStore.Delete(ctx, snapshotID)
		if deleteErr != nil {
			return deleteErr
		}
		if !deleted {
			return ErrNotFound
		}
		return h.logActionTx(ctx, r, tx, audit.Entry{
			Action:     "pricing_calculation.new_product_calculation.delete",
			TargetType: "new_product_calculation",
			TargetID:   stringPointer(strconv.FormatInt(snapshotID, 10)),
			AfterJSON:  map[string]any{"id": snapshotID, "project_id": projectID},
		})
	})
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) checkProjectAccess(w http.ResponseWriter, r *http.Request, projectID int64) bool {
	identity, _ := auth.UserContextFromContext(r.Context())
	if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeStoreError(w, err)
		return false
	}
	return true
}

func (h *Handler) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case errors.Is(err, ErrProductNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "商品不存在")
	case errors.Is(err, pricing.ErrMissingExchangeRate):
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, ErrInvalidCalculation):
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "记录不存在")
	default:
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	runner, ok := h.store.(transactionRunner)
	if !ok {
		return errors.New("new product calculation store does not support transactions")
	}
	return runner.RunInTx(ctx, fn)
}

func (h *Handler) logActionTx(
	ctx context.Context,
	r *http.Request,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	if h.auditor == nil {
		return errors.New("audit service is nil")
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	entry.Operator = stringPointer(strings.TrimSpace(identity.Operator))
	if entry.Operator != nil && *entry.Operator == "" {
		entry.Operator = nil
	}
	entry.Result = "success"
	entry.PopulateFromRequest(r)
	return h.auditor.LogActionTx(ctx, tx, entry)
}

func decodeCreateRequest(r *http.Request) (CreateRequest, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return CreateRequest{}, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return CreateRequest{}, errors.New("invalid JSON object")
	}
	for _, field := range requiredCreateFields {
		raw, ok := fields[field]
		if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return CreateRequest{}, errors.New("required field missing: " + field)
		}
	}
	for _, field := range nonNullableCreateFields {
		if raw, ok := fields[field]; ok && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return CreateRequest{}, errors.New("field cannot be null: " + field)
		}
	}

	var input CreateRequest
	if err := json.Unmarshal(body, &input); err != nil {
		return CreateRequest{}, err
	}
	if _, provided := fields["calculation_type"]; !provided {
		input.CalculationType = "profit_calc"
	}
	if !validCalculationType(input.CalculationType) {
		return CreateRequest{}, errors.New("invalid calculation_type")
	}
	if input.InboundPlacementMode != "single_destination" &&
		input.InboundPlacementMode != "amazon_optimized_split" {
		return CreateRequest{}, errors.New("invalid inbound_placement_mode")
	}
	if input.Warnings == nil {
		input.Warnings = []string{}
	}
	return input, nil
}

var requiredCreateFields = []string{
	"project_id", "project_name", "sku",
	"package_length_cm", "package_width_cm", "package_height_cm", "weight_kg",
	"fob_product_cost_rmb", "first_leg_cost_rmb", "ddp_cost_rmb", "ddp_cost_usd",
	"sale_price_usd", "advertising_rate", "return_loss_rate", "storage_months",
	"inbound_placement_mode", "usd_to_rmb_rate", "usd_to_rmb_rate_source",
	"size_tier", "size_tier_label", "price_band", "price_band_label",
	"longest_side_in", "middle_side_in", "shortest_side_in", "length_plus_girth_in",
	"volume_cubic_in", "volume_cubic_ft", "product_weight_lb", "product_weight_oz",
	"dimensional_weight_lb", "chargeable_weight_lb", "chargeable_weight_oz",
	"chargeable_weight_rule", "fulfillment_fee_rule_label", "inbound_config_fee_rule_label",
	"storage_fee_rule_label", "referral_fee_usd", "advertising_fee_usd", "return_loss_usd",
	"fba_fulfillment_fee_usd", "inbound_config_fee_usd", "storage_fee_usd", "total_fee_usd",
	"payout_usd", "profit_usd", "profit_rate",
}

var nonNullableCreateFields = []string{
	"calculation_type", "delivery_fee_usd", "inbound_config_fee_manual_usd",
	"storage_fee_manual_usd", "vat_usd", "warnings",
}

func validCalculationType(value string) bool {
	switch value {
	case "profit_calc", "profit_reverse", "cost_reverse", "fbm_calc", "eu_accounting":
		return true
	default:
		return false
	}
}

func newProductQueryInt(
	w http.ResponseWriter,
	r *http.Request,
	name string,
	fallback, minimum, maximum int,
) (int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" is out of range")
		return 0, false
	}
	return value, true
}

func applyAnchor(item *NewProductCalculationItem) {
	item.Anchor = deriveAnchor(item)
}

func floatPointer(value float64) *float64 { return &value }
func stringPointer(value string) *string  { return &value }
