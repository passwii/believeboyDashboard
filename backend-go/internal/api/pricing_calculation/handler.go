package pricing_calculation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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

func (h *Handler) QuoteFBA(w http.ResponseWriter, r *http.Request) {
	var payload FBAQuoteRequest
	if err := decodePricingBody(r, &payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	request, err := normalizeFBARequest(payload)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if !h.authorizeProject(w, r, request.ProjectID) {
		return
	}
	data, err := h.quoteData(
		r,
		"USD",
		request.USDToRMBRate,
		request.ProjectID,
		request.SKU,
		request.UseHistoricalShippingCost,
	)
	if err != nil {
		h.writeQuoteDataError(w, "USD", err)
		return
	}
	computed, err := pricing.QuoteFBA(request, data)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	var item RunItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		created, createErr := txStore.CreateRun(ctx, runItemFromResult(computed, identity.Operator))
		if createErr != nil {
			return createErr
		}
		item = created
		return h.logActionTx(ctx, r, tx, "pricing_calculation.run.create", item.ID, nil, item)
	})
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) QuoteReverse(w http.ResponseWriter, r *http.Request) {
	var payload ReverseQuoteRequest
	if err := decodePricingBody(r, &payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	request, targetRate, err := normalizeReverseRequest(payload)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if !h.authorizeProject(w, r, request.ProjectID) {
		return
	}
	data, err := h.quoteData(
		r,
		"USD",
		request.USDToRMBRate,
		request.ProjectID,
		request.SKU,
		request.UseHistoricalShippingCost,
	)
	if err != nil {
		h.writeQuoteDataError(w, "USD", err)
		return
	}
	_, computed, err := pricing.SolveSalePriceForProfitRate(request, data, targetRate)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	computed.CalculationType = "profit_reverse"
	h.persistCalculatedRun(w, r, computed, "pricing_calculation.run.create")
}

func (h *Handler) QuoteCostReverse(w http.ResponseWriter, r *http.Request) {
	var payload CostReverseQuoteRequest
	if err := decodePricingBody(r, &payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	request, targetRate, err := normalizeCostReverseRequest(payload)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if !h.authorizeProject(w, r, request.ProjectID) {
		return
	}
	data, err := h.quoteData(
		r,
		"USD",
		request.USDToRMBRate,
		request.ProjectID,
		request.SKU,
		request.UseHistoricalShippingCost,
	)
	if err != nil {
		h.writeQuoteDataError(w, "USD", err)
		return
	}
	_, computed, err := pricing.SolveFOBForProfitRate(request, data, targetRate)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	computed.CalculationType = "cost_reverse"
	h.persistCalculatedRun(w, r, computed, "pricing_calculation.run.create")
}

func (h *Handler) persistCalculatedRun(
	w http.ResponseWriter,
	r *http.Request,
	computed pricing.Result,
	auditAction string,
) {
	identity, _ := auth.UserContextFromContext(r.Context())
	var item RunItem
	err := h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		created, createErr := txStore.CreateRun(ctx, runItemFromResult(computed, identity.Operator))
		if createErr != nil {
			return createErr
		}
		item = created
		return h.logActionTx(ctx, r, tx, auditAction, item.ID, nil, item)
	})
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) QuoteFBM(w http.ResponseWriter, r *http.Request) {
	var payload FBMQuoteRequest
	if err := decodePricingBody(r, &payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	request, err := normalizeFBMRequest(payload)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if !h.authorizeProject(w, r, request.ProjectID) {
		return
	}
	data, err := h.quoteData(
		r,
		"USD",
		request.USDToRMBRate,
		request.ProjectID,
		request.SKU,
		request.UseHistoricalShippingCost,
	)
	if err != nil {
		h.writeQuoteDataError(w, "USD", err)
		return
	}
	computed, err := pricing.QuoteFBM(request, data)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	var item RunItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		created, createErr := txStore.CreateRun(ctx, runItemFromResult(computed, identity.Operator))
		if createErr != nil {
			return createErr
		}
		item = created
		return h.logActionTx(ctx, r, tx, "pricing_calculation.run.create", item.ID, nil, item)
	})
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) QuoteEU(w http.ResponseWriter, r *http.Request) {
	var payload EUQuoteRequest
	if err := decodePricingBody(r, &payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	request, err := normalizeEURequest(payload)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if !h.authorizeProject(w, r, request.ProjectID) {
		return
	}
	currency := "EUR"
	if request.Country == "UK" {
		currency = "GBP"
	}
	data, err := h.quoteData(r, currency, request.USDToRMBRate, request.ProjectID, request.SKU, false)
	if err != nil {
		h.writeQuoteDataError(w, currency, err)
		return
	}
	computed, err := pricing.QuoteEU(request, data)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	var item RunItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		created, createErr := txStore.CreateRun(ctx, runItemFromResult(computed, identity.Operator))
		if createErr != nil {
			return createErr
		}
		item = created
		return h.logActionTx(ctx, r, tx, "pricing_calculation.run.create_eu", item.ID, nil, item)
	})
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) ListRuns(w http.ResponseWriter, r *http.Request) {
	page, ok := parsePositiveQueryInt(w, r.URL.Query(), "page", 1, 1, int(^uint(0)>>1))
	if !ok {
		return
	}
	pageSize, ok := parsePositiveQueryInt(w, r.URL.Query(), "page_size", 12, 1, 100)
	if !ok {
		return
	}
	excludeProjectID := true
	if values, exists := r.URL.Query()["exclude_project_id"]; exists && len(values) > 0 {
		value, err := strconv.ParseBool(values[len(values)-1])
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "exclude_project_id must be a valid boolean")
			return
		}
		excludeProjectID = value
	}
	country := strings.TrimSpace(lastQueryValue(r.URL.Query(), "country"))
	keyword := strings.TrimSpace(lastQueryValue(r.URL.Query(), "keyword"))
	if len([]rune(keyword)) > 100 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "keyword must be at most 100 characters")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	filter := RunListFilter{
		Page:             page,
		PageSize:         pageSize,
		ExcludeProjectID: excludeProjectID,
		Country:          country,
		Keyword:          keyword,
		Operator:         strings.TrimSpace(identity.Operator),
		IsAdmin:          identity.IsAdmin,
	}
	items, total, err := h.store.ListRuns(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if items == nil {
		items = []RunItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, RunListResponse{
		Items: items, Total: total, Page: page, PageSize: pageSize,
	})
}

func (h *Handler) DeleteRun(w http.ResponseWriter, r *http.Request) {
	runID, ok := parseRunID(w, r)
	if !ok {
		return
	}
	item, ok := h.loadAuthorizedRun(w, r, runID)
	if !ok {
		return
	}
	var deleted bool
	err := h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var deleteErr error
		deleted, deleteErr = txStore.DeleteRun(ctx, runID)
		if deleteErr != nil {
			return deleteErr
		}
		if !deleted {
			return ErrRunNotFound
		}
		return h.logActionTx(ctx, r, tx, "pricing_calculation.run.delete", runID, item, nil)
	})
	if err != nil {
		if errors.Is(err, ErrRunNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "测算记录不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) RecalculateRun(w http.ResponseWriter, r *http.Request) {
	runID, ok := parseRunID(w, r)
	if !ok {
		return
	}
	before, ok := h.loadAuthorizedRun(w, r, runID)
	if !ok {
		return
	}
	calculated, err := recalculateRun(*before)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	updated := applyRecalculation(*before, calculated)
	var persisted *RunItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var updateErr error
		persisted, updateErr = txStore.UpdateRun(ctx, runID, updated)
		if updateErr != nil {
			return updateErr
		}
		if persisted == nil {
			return ErrRunNotFound
		}
		return h.logActionTx(ctx, r, tx, "pricing_calculation.run.recalculate", runID, before, persisted)
	})
	if err != nil {
		if errors.Is(err, ErrRunNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "测算记录不存在")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, persisted)
}

func applyRecalculation(before RunItem, calculated pricing.Result) RunItem {
	updated := before
	updated.FOBProductCostRMB = calculated.FOBProductCostRMB
	updated.FirstLegCostRMB = calculated.FirstLegCostRMB
	updated.SalePriceUSD = calculated.SalePriceUSD
	updated.CommissionRate = calculated.CommissionRate
	updated.AdvertisingRate = calculated.AdvertisingRate
	updated.ReturnLossRate = calculated.ReturnLossRate
	updated.StorageMonths = calculated.StorageMonths
	updated.InboundPlacementMode = calculated.InboundPlacementMode
	updated.USDToRMBRate = calculated.USDToRMBRate
	updated.USDToRMBRateSource = calculated.USDToRMBRateSource
	if strings.TrimSpace(before.USDToRMBRateSource) != "" {
		updated.USDToRMBRateSource = before.USDToRMBRateSource
	}
	updated.SizeTier = calculated.SizeTier
	updated.SizeTierLabel = calculated.SizeTierLabel
	updated.PriceBand = calculated.PriceBand
	updated.PriceBandLabel = calculated.PriceBandLabel
	updated.FulfillmentFeeRuleLabel = calculated.FulfillmentFeeRuleLabel
	updated.InboundConfigFeeRuleLabel = calculated.InboundConfigFeeRuleLabel
	updated.StorageFeeRuleLabel = calculated.StorageFeeRuleLabel
	updated.Dimensions = PricingCalculationDimensions{
		LongestSideIn:     calculated.Dimensions.LongestSideIn,
		MiddleSideIn:      calculated.Dimensions.MiddleSideIn,
		ShortestSideIn:    calculated.Dimensions.ShortestSideIn,
		LengthPlusGirthIn: calculated.Dimensions.LengthPlusGirthIn,
		VolumeCubicIn:     calculated.Dimensions.VolumeCubicIn,
		VolumeCubicFt:     calculated.Dimensions.VolumeCubicFt,
	}
	updated.Weights = PricingCalculationWeights{
		ProductWeightLB:      calculated.Weights.ProductWeightLB,
		ProductWeightOZ:      calculated.Weights.ProductWeightOZ,
		DimensionalWeightLB:  calculated.Weights.DimensionalWeightLB,
		ChargeableWeightLB:   calculated.Weights.ChargeableWeightLB,
		ChargeableWeightOZ:   calculated.Weights.ChargeableWeightOZ,
		ChargeableWeightRule: calculated.Weights.ChargeableWeightRule,
	}
	updated.Fees = PricingCalculationFees{
		ReferralFeeUSD:       calculated.Fees.ReferralFeeUSD,
		AdvertisingFeeUSD:    calculated.Fees.AdvertisingFeeUSD,
		ReturnLossUSD:        calculated.Fees.ReturnLossUSD,
		FBAFulfillmentFeeUSD: runFBAFeeFromResult(calculated),
		InboundConfigFeeUSD:  calculated.Fees.InboundConfigFeeUSD,
		StorageFeeUSD:        calculated.Fees.StorageFeeUSD,
		TotalFeeUSD:          calculated.Fees.TotalFeeUSD,
		PlatformFeeUSD:       calculated.Fees.PlatformFeeUSD,
	}
	updated.Profit = PricingCalculationProfit{
		DDPCostRMB:            calculated.Profit.DDPCostRMB,
		DDPCostUSD:            calculated.Profit.DDPCostUSD,
		PayoutUSD:             calculated.Profit.PayoutUSD,
		ProfitUSD:             calculated.Profit.ProfitUSD,
		ProfitRate:            calculated.Profit.ProfitRate,
		VATUSD:                calculated.Profit.VATUSD,
		ProfitAfterVATUSD:     calculated.Profit.ProfitAfterVATUSD,
		ProfitAfterVATRate:    calculated.Profit.ProfitAfterVATRate,
		DeliveryFeeUSD:        calculated.Profit.DeliveryFeeUSD,
		FullContainerQuantity: calculated.Profit.FullContainerQuantity,
		FullContainerPriceRMB: calculated.Profit.FullContainerPriceRMB,
	}
	updated.Warnings = nonNilStrings(calculated.Warnings)
	updated.DeliveryFeeUSD = calculated.DeliveryFeeUSD
	updated.FullContainerQuantity = calculated.FullContainerQuantity
	updated.FullContainerPriceRMB = calculated.FullContainerPriceRMB
	return updated
}

func recalculateRun(run RunItem) (pricing.Result, error) {
	rate := run.USDToRMBRate
	switch run.CalculationType {
	case "fbm_calc":
		return pricing.QuoteFBM(pricing.FBMRequest{
			Country:               run.Country,
			ProductName:           run.ProductName,
			PackageLengthCM:       run.PackageLengthCM,
			PackageWidthCM:        run.PackageWidthCM,
			PackageHeightCM:       run.PackageHeightCM,
			WeightKG:              run.WeightKG,
			FOBProductCostRMB:     run.FOBProductCostRMB,
			FirstLegCostRMB:       run.FirstLegCostRMB,
			FullContainerQuantity: run.FullContainerQuantity,
			FullContainerPriceRMB: run.FullContainerPriceRMB,
			DeliveryFeeUSD:        run.DeliveryFeeUSD,
			ProjectID:             run.ProjectID,
			SKU:                   run.SKU,
			SalePriceUSD:          run.SalePriceUSD,
			CommissionRate:        run.CommissionRate,
			AdvertisingRate:       run.AdvertisingRate,
			ReturnLossRate:        run.ReturnLossRate,
			StorageMonths:         run.StorageMonths,
			InboundPlacementMode:  run.InboundPlacementMode,
			USDToRMBRate:          &rate,
			CompetitorURL:         run.CompetitorURL,
		}, pricing.QuoteData{})
	case "eu_accounting":
		return pricing.QuoteEU(pricing.EURequest{
			Country:                   run.Country,
			ProductName:               run.ProductName,
			PackageLengthCM:           run.PackageLengthCM,
			PackageWidthCM:            run.PackageWidthCM,
			PackageHeightCM:           run.PackageHeightCM,
			WeightKG:                  run.WeightKG,
			FOBProductCostRMB:         run.FOBProductCostRMB,
			FirstLegCostRMB:           run.FirstLegCostRMB,
			FirstLegUnitPriceRMBPerKG: run.FirstLegUnitPriceRMBPerKG,
			ProjectID:                 run.ProjectID,
			SKU:                       run.SKU,
			SalePriceUSD:              run.SalePriceUSD,
			DeliveryFeeUSD:            run.DeliveryFeeUSD,
			InboundConfigFeeUSD:       run.Fees.InboundConfigFeeUSD,
			StorageFeeUSD:             run.Fees.StorageFeeUSD,
			CommissionRate:            run.CommissionRate,
			AdvertisingRate:           run.AdvertisingRate,
			ReturnLossRate:            run.ReturnLossRate,
			USDToRMBRate:              &rate,
			CompetitorURL:             run.CompetitorURL,
		}, pricing.QuoteData{})
	default:
		return pricing.QuoteFBA(pricing.FBARequest{
			Country:                   run.Country,
			ProductName:               run.ProductName,
			PackageLengthCM:           run.PackageLengthCM,
			PackageWidthCM:            run.PackageWidthCM,
			PackageHeightCM:           run.PackageHeightCM,
			WeightKG:                  run.WeightKG,
			FOBProductCostRMB:         run.FOBProductCostRMB,
			FirstLegCostRMB:           run.FirstLegCostRMB,
			FirstLegUnitPriceRMBPerKG: run.FirstLegUnitPriceRMBPerKG,
			ProjectID:                 run.ProjectID,
			SKU:                       run.SKU,
			SalePriceUSD:              run.SalePriceUSD,
			CommissionRate:            run.CommissionRate,
			AdvertisingRate:           run.AdvertisingRate,
			ReturnLossRate:            run.ReturnLossRate,
			StorageMonths:             run.StorageMonths,
			InboundPlacementMode:      run.InboundPlacementMode,
			USDToRMBRate:              &rate,
			CompetitorURL:             run.CompetitorURL,
		}, pricing.QuoteData{})
	}
}

func (h *Handler) quoteData(
	r *http.Request,
	currency string,
	manualRate *float64,
	projectID *int64,
	sku *string,
	useHistoricalShippingCost bool,
) (pricing.QuoteData, error) {
	data := pricing.QuoteData{ExchangeRateCurrency: currency}
	if manualRate == nil {
		rate, yearMonth, err := h.store.GetLatestExchangeRate(r.Context(), currency)
		if err != nil {
			return data, err
		}
		data.ExchangeRateValue = rate
		data.ExchangeRateYearMonth = yearMonth
	}
	if useHistoricalShippingCost && projectID != nil && sku != nil && strings.TrimSpace(*sku) != "" {
		cost, err := h.store.GetHistoricalShippingCost(r.Context(), *projectID, *sku)
		if err != nil {
			return data, err
		}
		data.HistoricalShippingCostRMB = cost
	}
	return data, nil
}

func (h *Handler) authorizeProject(w http.ResponseWriter, r *http.Request, projectID *int64) bool {
	if projectID == nil {
		return true
	}
	if *projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return false
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if err := h.store.VerifyProjectAccess(r.Context(), *projectID, identity.Operator, identity.IsAdmin); err != nil {
		switch {
		case errors.Is(err, ErrProjectNotFound):
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
		case errors.Is(err, ErrProjectForbidden):
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
		default:
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		}
		return false
	}
	return true
}

func (h *Handler) loadAuthorizedRun(w http.ResponseWriter, r *http.Request, runID int64) (*RunItem, bool) {
	item, err := h.store.GetRun(r.Context(), runID)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return nil, false
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "测算记录不存在")
		return nil, false
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !canAccessRun(*item, identity.Operator, identity.IsAdmin) {
		httpapi.WriteDetail(w, http.StatusForbidden, "无权操作该测算记录")
		return nil, false
	}
	return item, true
}

func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	runner, ok := h.store.(transactionRunner)
	if !ok {
		return errors.New("pricing calculation store does not support transactions")
	}
	return runner.RunInTx(ctx, fn)
}

func (h *Handler) logActionTx(
	ctx context.Context,
	r *http.Request,
	tx pgx.Tx,
	action string,
	runID int64,
	before any,
	after any,
) error {
	if h.auditor == nil {
		return errors.New("audit service is nil")
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	targetID := strconv.FormatInt(runID, 10)
	entry := audit.Entry{
		Action:     action,
		TargetType: "pricing_calculation_run",
		TargetID:   &targetID,
		Operator:   nonEmptyStringPointer(strings.TrimSpace(identity.Operator)),
		Result:     "success",
		BeforeJSON: before,
		AfterJSON:  after,
	}
	entry.PopulateFromRequest(r)
	return h.auditor.LogActionTx(ctx, tx, entry)
}

func (h *Handler) writeQuoteDataError(w http.ResponseWriter, currency string, err error) {
	if errors.Is(err, ErrExchangeRateNotFound) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, fmt.Sprintf(
			"缺少 %s 汇率，请先维护汇率信息或在请求中传入 usd_to_rmb_rate",
			currency,
		))
		return
	}
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}

func runItemFromResult(result pricing.Result, operator string) RunItem {
	return RunItem{
		Country:                   result.Country,
		ProductName:               result.ProductName,
		CalculationType:           result.CalculationType,
		ProjectID:                 result.ProjectID,
		SKU:                       result.SKU,
		PackageLengthCM:           result.PackageLengthCM,
		PackageWidthCM:            result.PackageWidthCM,
		PackageHeightCM:           result.PackageHeightCM,
		WeightKG:                  result.WeightKG,
		FOBProductCostRMB:         result.FOBProductCostRMB,
		FirstLegCostRMB:           result.FirstLegCostRMB,
		FirstLegUnitPriceRMBPerKG: result.FirstLegUnitPriceRMBPerKG,
		SalePriceUSD:              result.SalePriceUSD,
		CommissionRate:            result.CommissionRate,
		AdvertisingRate:           result.AdvertisingRate,
		ReturnLossRate:            result.ReturnLossRate,
		StorageMonths:             result.StorageMonths,
		InboundPlacementMode:      result.InboundPlacementMode,
		SizeTier:                  result.SizeTier,
		SizeTierLabel:             result.SizeTierLabel,
		PriceBand:                 result.PriceBand,
		PriceBandLabel:            result.PriceBandLabel,
		USDToRMBRate:              result.USDToRMBRate,
		USDToRMBRateSource:        result.USDToRMBRateSource,
		FulfillmentFeeRuleLabel:   result.FulfillmentFeeRuleLabel,
		InboundConfigFeeRuleLabel: result.InboundConfigFeeRuleLabel,
		StorageFeeRuleLabel:       result.StorageFeeRuleLabel,
		Dimensions: PricingCalculationDimensions{
			LongestSideIn:     result.Dimensions.LongestSideIn,
			MiddleSideIn:      result.Dimensions.MiddleSideIn,
			ShortestSideIn:    result.Dimensions.ShortestSideIn,
			LengthPlusGirthIn: result.Dimensions.LengthPlusGirthIn,
			VolumeCubicIn:     result.Dimensions.VolumeCubicIn,
			VolumeCubicFt:     result.Dimensions.VolumeCubicFt,
		},
		Weights: PricingCalculationWeights{
			ProductWeightLB:      result.Weights.ProductWeightLB,
			ProductWeightOZ:      result.Weights.ProductWeightOZ,
			DimensionalWeightLB:  result.Weights.DimensionalWeightLB,
			ChargeableWeightLB:   result.Weights.ChargeableWeightLB,
			ChargeableWeightOZ:   result.Weights.ChargeableWeightOZ,
			ChargeableWeightRule: result.Weights.ChargeableWeightRule,
		},
		Fees: PricingCalculationFees{
			ReferralFeeUSD:       result.Fees.ReferralFeeUSD,
			AdvertisingFeeUSD:    result.Fees.AdvertisingFeeUSD,
			ReturnLossUSD:        result.Fees.ReturnLossUSD,
			FBAFulfillmentFeeUSD: runFBAFeeFromResult(result),
			InboundConfigFeeUSD:  result.Fees.InboundConfigFeeUSD,
			StorageFeeUSD:        result.Fees.StorageFeeUSD,
			TotalFeeUSD:          result.Fees.TotalFeeUSD,
			PlatformFeeUSD:       result.Fees.PlatformFeeUSD,
		},
		Profit: PricingCalculationProfit{
			DDPCostRMB:            result.Profit.DDPCostRMB,
			DDPCostUSD:            result.Profit.DDPCostUSD,
			PayoutUSD:             result.Profit.PayoutUSD,
			ProfitUSD:             result.Profit.ProfitUSD,
			ProfitRate:            result.Profit.ProfitRate,
			VATUSD:                result.Profit.VATUSD,
			ProfitAfterVATUSD:     result.Profit.ProfitAfterVATUSD,
			ProfitAfterVATRate:    result.Profit.ProfitAfterVATRate,
			DeliveryFeeUSD:        result.Profit.DeliveryFeeUSD,
			FullContainerQuantity: result.Profit.FullContainerQuantity,
			FullContainerPriceRMB: result.Profit.FullContainerPriceRMB,
		},
		Warnings:              nonNilStrings(result.Warnings),
		CreatedBy:             nonEmptyStringPointer(strings.TrimSpace(operator)),
		DeliveryFeeUSD:        result.DeliveryFeeUSD,
		FullContainerQuantity: result.FullContainerQuantity,
		FullContainerPriceRMB: result.FullContainerPriceRMB,
		CompetitorURL:         result.CompetitorURL,
	}
}

func runFBAFeeFromResult(result pricing.Result) float64 {
	if result.CalculationType == "fbm_calc" {
		return result.Fees.DeliveryFeeUSD
	}
	return result.Fees.FBAFulfillmentFeeUSD
}

func parseRunID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	runID, err := strconv.ParseInt(strings.TrimSpace(chi.URLParam(r, "run_id")), 10, 64)
	if err != nil || runID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid run_id")
		return 0, false
	}
	return runID, true
}

func canAccessRun(item RunItem, operator string, isAdmin bool) bool {
	if isAdmin {
		return true
	}
	if item.CreatedBy == nil || strings.TrimSpace(operator) == "" {
		return false
	}
	return strings.TrimSpace(*item.CreatedBy) == strings.TrimSpace(operator)
}

func decodePricingBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func parsePositiveQueryInt(w http.ResponseWriter, query url.Values, name string, fallback, minimum, maximum int) (int, bool) {
	values, exists := query[name]
	if !exists || len(values) == 0 || values[len(values)-1] == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(values[len(values)-1])
	if err != nil || value < minimum || value > maximum {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, fmt.Sprintf("%s must be between %d and %d", name, minimum, maximum))
		return 0, false
	}
	return value, true
}

func lastQueryValue(query url.Values, key string) string {
	values := query[key]
	if len(values) == 0 {
		return ""
	}
	return values[len(values)-1]
}

func nonEmptyStringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
