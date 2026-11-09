package shop_calculation

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

func (h *Handler) writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case errors.Is(err, ErrNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "记录不存在")
	default:
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

func (h *Handler) checkProjectAccess(w http.ResponseWriter, r *http.Request, projectID int64) bool {
	identity, _ := auth.UserContextFromContext(r.Context())
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return false
	}
	if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeError(w, err)
		return false
	}
	return true
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	var projectID *int64
	if _, present := query["project_id"]; present {
		raw := query.Get("project_id")
		parsed, err := parsePositiveInt(raw)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
			return
		}
		projectID = &parsed
	}
	_, hasPage := query["page"]
	page, err := parseBoundedQueryInt(query.Get("page"), hasPage, 1, 1, 0)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "page must be greater than or equal to 1")
		return
	}
	_, hasPageSize := query["page_size"]
	pageSize, err := parseBoundedQueryInt(query.Get("page_size"), hasPageSize, 200, 1, 500)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "page_size must be between 1 and 500")
		return
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	if projectID != nil && !h.checkProjectAccess(w, r, *projectID) {
		return
	}

	filter := ShopCalculationListFilter{ProjectID: projectID, Page: page, PageSize: pageSize}
	if _, present := query["country"]; present {
		country := query.Get("country")
		filter.Country = &country
	}
	if projectID == nil && !identity.IsAdmin {
		projectIDs, err := h.store.AccessibleProjectIDs(r.Context(), identity.Operator)
		if err != nil {
			h.writeError(w, err)
			return
		}
		if len(projectIDs) == 0 {
			_ = httpapi.WriteJSON(w, http.StatusOK, ShopCalculationListResponse{
				Items: []ShopCalculationItem{}, Total: 0, Page: page, PageSize: pageSize,
			})
			return
		}
		filter.ProjectIDs = projectIDs
	}

	items, total, err := h.store.List(r.Context(), filter)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if items == nil {
		items = []ShopCalculationItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ShopCalculationListResponse{
		Items: items, Total: total, Page: page, PageSize: pageSize,
	})
}

func (h *Handler) History(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	projectID, err := parsePositiveInt(query.Get("project_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return
	}
	if !h.checkProjectAccess(w, r, projectID) {
		return
	}

	includeDeleted := false
	if _, present := query["include_deleted"]; present {
		raw := query.Get("include_deleted")
		includeDeleted, err = parseQueryBool(raw)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "include_deleted must be a valid boolean")
			return
		}
	}
	filter := ShopCalculationHistoryFilter{ProjectID: projectID, IncludeDeleted: includeDeleted}
	if _, present := query["sku"]; present {
		sku := query.Get("sku")
		filter.SKU = &sku
	}
	if _, present := query["country"]; present {
		country := query.Get("country")
		filter.Country = &country
	}
	items, err := h.store.History(r.Context(), filter)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if items == nil {
		items = []ShopCalculationItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) Aggregate(w http.ResponseWriter, r *http.Request) {
	projectID, err := parsePositiveInt(r.URL.Query().Get("project_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return
	}
	if !h.checkProjectAccess(w, r, projectID) {
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	aggregate, err := h.store.AggregateCurrent(r.Context(), projectID, country)
	if err != nil {
		h.writeError(w, err)
		return
	}
	aggregate.ProjectID = projectID
	aggregate.Country = country
	_ = httpapi.WriteJSON(w, http.StatusOK, aggregate)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	payload, err := decodeCreateRequest(r.Body)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if payload.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return
	}
	if !h.checkProjectAccess(w, r, payload.ProjectID) {
		return
	}
	if strings.TrimSpace(payload.Source) == "" {
		payload.Source = "manual"
	} else {
		payload.Source = strings.TrimSpace(payload.Source)
	}
	if payload.Warnings == nil {
		payload.Warnings = []string{}
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	var item ShopCalculationItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		appended, appendErr := txStore.Append(ctx, payload, identity.Operator)
		if appendErr != nil {
			return appendErr
		}
		item = appended
		targetID := strconv.FormatInt(item.ID, 10)
		return h.logMutationTx(ctx, r, tx, audit.Entry{
			Action:     "pricing_calculation.shop_calculation.append",
			TargetType: "shop_calculation",
			TargetID:   &targetID,
			AfterJSON: map[string]any{
				"id": item.ID, "project_id": item.ProjectID, "project_name": item.ProjectName,
				"sku": item.SKU, "country": item.Country, "accounting_type": item.AccountingType,
				"source": item.Source, "observed_at": item.ObservedAt,
			},
		})
	})
	if err != nil {
		h.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, item)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	itemID, err := parsePositiveInt(chi.URLParam(r, "item_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid item_id")
		return
	}
	projectID, err := h.store.ProjectIDForItem(r.Context(), itemID)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if !h.checkProjectAccess(w, r, projectID) {
		return
	}
	var deleted bool
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var deleteErr error
		deleted, deleteErr = txStore.DeleteGroup(ctx, itemID)
		if deleteErr != nil {
			return deleteErr
		}
		if !deleted {
			return ErrNotFound
		}
		targetID := strconv.FormatInt(itemID, 10)
		return h.logMutationTx(ctx, r, tx, audit.Entry{
			Action:     "pricing_calculation.shop_calculation.delete",
			TargetType: "shop_calculation",
			TargetID:   &targetID,
			AfterJSON:  map[string]any{"item_id": itemID, "project_id": projectID},
		})
	})
	if err != nil {
		h.writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	runner, ok := h.store.(transactionRunner)
	if !ok {
		return errors.New("shop calculation store does not support transactions")
	}
	return runner.RunInTx(ctx, fn)
}

func (h *Handler) logMutationTx(
	ctx context.Context,
	r *http.Request,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	if h.auditor == nil {
		return errors.New("audit service is nil")
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if operator := strings.TrimSpace(identity.Operator); operator != "" {
		entry.Operator = &operator
	}
	entry.Result = "success"
	entry.PopulateFromRequest(r)
	return h.auditor.LogActionTx(ctx, tx, entry)
}

func decodeCreateRequest(body io.Reader) (ShopCalculationCreateRequest, error) {
	data, err := io.ReadAll(body)
	if err != nil {
		return ShopCalculationCreateRequest{}, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return ShopCalculationCreateRequest{}, errors.New("invalid object")
	}
	for _, field := range requiredCreateFields {
		value, ok := raw[field]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return ShopCalculationCreateRequest{}, errors.New("required field missing")
		}
	}
	for _, field := range nonNullDefaultCreateFields {
		value, ok := raw[field]
		if ok && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return ShopCalculationCreateRequest{}, errors.New("defaulted field cannot be null")
		}
	}

	var request ShopCalculationCreateRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return ShopCalculationCreateRequest{}, err
	}
	if request.Country != "US" && request.Country != "DE" && request.Country != "UK" {
		return ShopCalculationCreateRequest{}, errors.New("invalid country")
	}
	if _, present := raw["accounting_type"]; present &&
		request.AccountingType != "profit_calc" && request.AccountingType != "eu_accounting" {
		return ShopCalculationCreateRequest{}, errors.New("invalid accounting_type")
	}
	if request.InboundPlacementMode != "single_destination" && request.InboundPlacementMode != "amazon_optimized_split" {
		return ShopCalculationCreateRequest{}, errors.New("invalid inbound_placement_mode")
	}
	if _, present := raw["accounting_type"]; !present {
		request.AccountingType = "profit_calc"
	}
	return request, nil
}

var nonNullDefaultCreateFields = []string{
	"accounting_type", "delivery_fee_usd", "inbound_config_fee_manual_usd",
	"storage_fee_manual_usd", "platform_fee_usd", "vat_usd", "warnings", "source",
}

var requiredCreateFields = []string{
	"project_id", "project_name", "sku", "country",
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

func parsePositiveInt(raw string) (int64, error) {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		return 0, errors.New("must be positive")
	}
	return value, nil
}

func parseBoundedQueryInt(raw string, present bool, fallback, min, max int) (int, error) {
	if !present {
		return fallback, nil
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < min || (max > 0 && value > max) {
		return 0, errors.New("out of range")
	}
	return value, nil
}

func parseQueryBool(raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "t", "1", "yes", "y", "on":
		return true, nil
	case "false", "f", "0", "no", "n", "off":
		return false, nil
	default:
		return false, errors.New("invalid boolean")
	}
}
