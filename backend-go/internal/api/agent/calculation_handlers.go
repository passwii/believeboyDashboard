package agent

import (
	"encoding/json"
	"errors"
	"strconv"
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shop_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/pricing"
)

var agentCalculationSources = map[string]bool{
	"agent_listing_pull":    true,
	"agent_review_scrape":   true,
	"agent_market_research": true,
	"external_api":          true,
}

func (h *Handler) ListShopCalculations(w http.ResponseWriter, r *http.Request) {
	if h.stores.ShopCalculations == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	page, pageSize := parsePage(r, 200, 500)
	country := optionalUpperQuery(r, "country")
	items, total, err := h.stores.ShopCalculations.List(
		r.Context(),
		shop_calculation.ShopCalculationListFilter{
			ProjectID: &projectID,
			Country:   country,
			Page:      page,
			PageSize:  pageSize,
		},
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, map[string]any{
		"items":     items,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	}, "")
}

func (h *Handler) GetShopCalculationSKU(w http.ResponseWriter, r *http.Request) {
	if h.stores.ShopCalculations == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	sku := strings.TrimSpace(chiURLParam(r, "sku"))
	items, _, err := h.stores.ShopCalculations.List(
		r.Context(),
		shop_calculation.ShopCalculationListFilter{
			ProjectID: &projectID,
			Country:   optionalUpperQuery(r, "country"),
			Page:      1,
			PageSize:  500,
		},
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	for _, item := range items {
		if strings.EqualFold(strings.TrimSpace(item.SKU), sku) {
			writeOK(w, item, "")
			return
		}
	}
	writeAPIError(w, ErrorWithMessage(ErrResourceNotFound, "该 SKU 在当前项目中不存在"))
}

func (h *Handler) ListShopCalculationHistory(w http.ResponseWriter, r *http.Request) {
	if h.stores.ShopCalculations == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	items, err := h.stores.ShopCalculations.History(
		r.Context(),
		shop_calculation.ShopCalculationHistoryFilter{
			ProjectID:      projectID,
			SKU:            optionalStringQuery(r, "sku"),
			Country:        optionalUpperQuery(r, "country"),
			IncludeDeleted: parseBoolQuery(r, "include_deleted"),
		},
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	page, pageSize := parsePage(r, 200, 500)
	items = paginate(items, page, pageSize)
	writeOK(w, map[string]any{
		"items":     items,
		"total":     len(items),
		"page":      page,
		"page_size": pageSize,
	}, "")
}

func (h *Handler) GetShopCalculationAudit(w http.ResponseWriter, r *http.Request) {
	if h.stores.ShopCalculations == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	sku := strings.TrimSpace(chiURLParam(r, "sku"))
	if sku == "" {
		writeValidationError(w, "sku is required", nil)
		return
	}
	history, err := h.stores.ShopCalculations.History(r.Context(), shop_calculation.ShopCalculationHistoryFilter{
		ProjectID:      projectID,
		SKU:            &sku,
		IncludeDeleted: true,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if len(history) == 0 {
		writeAPIError(w, NewAPIError(ErrResourceNotFound))
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if val, err := strconv.Atoi(raw); err == nil && val > 0 {
			limit = val
		}
	}
	if limit > 200 {
		limit = 200
	}
	targetIDs := make([]string, 0, len(history))
	for _, item := range history {
		targetIDs = append(targetIDs, strconv.FormatInt(item.ID, 10))
	}
	var items []AuditItem
	if h.stores.Audit != nil {
		items, err = h.stores.Audit.QueryAuditLogs(r.Context(), "shop_calculation", targetIDs, limit)
		if err != nil {
			writeStoreError(w, err)
			return
	}
	}
	if items == nil {
		items = []AuditItem{}
	}
	writeOK(w, map[string]any{
		"sku":   sku,
		"items": items,
	}, "")
}

func (h *Handler) AppendShopCalculation(w http.ResponseWriter, r *http.Request) {
	if h.stores.ShopCalculations == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	body, _, ok := h.gateConfirmation(w, r, "shop_calculation.append", map[string]any{
		"project_id": projectID,
	}, func(body []byte) error {
		var request shop_calculation.ShopCalculationCreateRequest
		if err := json.Unmarshal(body, &request); err != nil {
			return errors.New("请求体必须是有效的店铺测算对象")
		}
		if !validAgentCalculationSource(request.Source) {
			return errors.New("source must be one of agent_listing_pull, agent_review_scrape, agent_market_research, external_api")
		}
		return nil
	})
	if !ok {
		return
	}
	var request shop_calculation.ShopCalculationCreateRequest
	if err := json.Unmarshal(body, &request); err != nil {
		writeValidationError(w, "请求体必须是有效的店铺测算对象", nil)
		return
	}
	request.ProjectID = projectID
	if !validAgentCalculationSource(request.Source) {
		writeValidationError(w, "source must be one of agent_listing_pull, agent_review_scrape, agent_market_research, external_api", nil)
		return
	}
	credential, _ := CredentialFromContext(r.Context())
	item, err := h.stores.ShopCalculations.Append(r.Context(), request, credential.AgentID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.logAudit(r, credential, "shop_calculation.append", "shop_calculation", strconv.FormatInt(item.ID, 10), nil, item)
	writeOK(w, item, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

type shopComputeRequest struct {
	Mode                 string   `json:"mode"`
	Country              string   `json:"country"`
	ProductName          string   `json:"product_name"`
	SKU                  *string  `json:"sku"`
	PackageLengthCM      float64  `json:"package_length_cm"`
	PackageWidthCM       float64  `json:"package_width_cm"`
	PackageHeightCM      float64  `json:"package_height_cm"`
	WeightKG             float64  `json:"weight_kg"`
	FOBProductCostRMB    float64  `json:"fob_product_cost_rmb"`
	FirstLegCostRMB      float64  `json:"first_leg_cost_rmb"`
	SalePriceUSD         float64  `json:"sale_price_usd"`
	CommissionRate       float64  `json:"commission_rate"`
	AdvertisingRate      float64  `json:"advertising_rate"`
	ReturnLossRate       float64  `json:"return_loss_rate"`
	StorageMonths        float64  `json:"storage_months"`
	InboundPlacementMode string   `json:"inbound_placement_mode"`
	USDToRMBRate         *float64 `json:"usd_to_rmb_rate"`
	TargetNetMargin      *float64 `json:"target_net_margin"`
	DeliveryFeeUSD       float64  `json:"delivery_fee_usd"`
	InboundConfigFeeUSD  float64  `json:"inbound_config_fee_usd"`
	StorageFeeUSD        float64  `json:"storage_fee_usd"`
}

func (h *Handler) ComputeShopCalculation(w http.ResponseWriter, r *http.Request) {
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	var payload shopComputeRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeValidationError(w, "请求体必须是有效的试算对象", nil)
		return
	}
	applyShopComputeDefaults(&payload)
	if payload.Mode != "profit_calc" && payload.Mode != "eu_accounting" {
		writeValidationError(w, "mode must be profit_calc or eu_accounting", nil)
		return
	}
	if payload.USDToRMBRate == nil {
		writeValidationError(w, "usd_to_rmb_rate is required for agent compute", nil)
		return
	}
	quoteData := pricing.QuoteData{ExchangeRateValue: *payload.USDToRMBRate, ExchangeRateCurrency: "USD"}
	var (
		result pricing.Result
		err    error
	)
	if payload.Mode == "eu_accounting" {
		if payload.Country != "DE" && payload.Country != "UK" {
			writeValidationError(w, "eu_accounting 模式 country 必须是 DE 或 UK", nil)
			return
		}
		result, err = pricing.QuoteEU(pricing.EURequest{
			Country:             payload.Country,
			ProductName:         payload.ProductName,
			PackageLengthCM:     payload.PackageLengthCM,
			PackageWidthCM:      payload.PackageWidthCM,
			PackageHeightCM:     payload.PackageHeightCM,
			WeightKG:            payload.WeightKG,
			FOBProductCostRMB:   payload.FOBProductCostRMB,
			FirstLegCostRMB:     payload.FirstLegCostRMB,
			ProjectID:           &projectID,
			SKU:                 payload.SKU,
			SalePriceUSD:        payload.SalePriceUSD,
			DeliveryFeeUSD:      payload.DeliveryFeeUSD,
			InboundConfigFeeUSD: payload.InboundConfigFeeUSD,
			StorageFeeUSD:       payload.StorageFeeUSD,
			CommissionRate:      defaultRate(payload.CommissionRate, 0.15),
			AdvertisingRate:     defaultRate(payload.AdvertisingRate, 0.12),
			ReturnLossRate:      defaultRate(payload.ReturnLossRate, 0.04),
			USDToRMBRate:        payload.USDToRMBRate,
		}, quoteData)
	} else {
		if payload.Country != "US" {
			writeValidationError(w, "profit_calc 模式 country 必须是 US", nil)
			return
		}
		result, err = pricing.QuoteFBA(pricing.FBARequest{
			Country:              payload.Country,
			ProductName:          payload.ProductName,
			PackageLengthCM:      payload.PackageLengthCM,
			PackageWidthCM:       payload.PackageWidthCM,
			PackageHeightCM:      payload.PackageHeightCM,
			WeightKG:             payload.WeightKG,
			FOBProductCostRMB:    payload.FOBProductCostRMB,
			FirstLegCostRMB:      payload.FirstLegCostRMB,
			ProjectID:            &projectID,
			SKU:                  payload.SKU,
			SalePriceUSD:         payload.SalePriceUSD,
			CommissionRate:       defaultRate(payload.CommissionRate, 0.15),
			AdvertisingRate:      defaultRate(payload.AdvertisingRate, 0.12),
			ReturnLossRate:       defaultRate(payload.ReturnLossRate, 0.04),
			StorageMonths:        defaultStorageMonths(payload.StorageMonths),
			InboundPlacementMode: defaultPlacement(payload.InboundPlacementMode),
			USDToRMBRate:         payload.USDToRMBRate,
		}, quoteData)
	}
	if err != nil {
		writeValidationError(w, err.Error(), nil)
		return
	}
	snapshot := pricingResultSnapshot(result)
	snapshot["anchor"] = pricingAnchorSnapshot(result, payload.TargetNetMargin)
	writeOK(w, map[string]any{
		"mode":                   payload.Mode,
		"calculation":            snapshot,
		"snapshot":               snapshot,
		"usd_to_rmb_rate":        result.USDToRMBRate,
		"usd_to_rmb_rate_source": result.USDToRMBRateSource,
	}, "")
}

func (h *Handler) ListNewProductCalculations(w http.ResponseWriter, r *http.Request) {
	if h.stores.NewProducts == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	page, pageSize := parsePage(r, 200, 500)
	resp, err := h.stores.NewProducts.List(r.Context(), new_product_calculations.ListFilter{
		ProjectID:       &projectID,
		CalculationType: optionalStringQuery(r, "calculation_type"),
		Country:         optionalUpperQuery(r, "country"),
		Page:            page,
		PageSize:        pageSize,
		Operator:        "",
		IsAdmin:         true,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetNewProductCalculationSKU(w http.ResponseWriter, r *http.Request) {
	if h.stores.NewProducts == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	calculationType := strings.TrimSpace(r.URL.Query().Get("calculation_type"))
	if calculationType == "" {
		calculationType = "profit_calc"
	}
	item, err := h.stores.NewProducts.Get(
		r.Context(),
		projectID,
		chiURLParam(r, "sku"),
		calculationType,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, item, "")
}

func (h *Handler) GetNewProductCalculationAudit(w http.ResponseWriter, r *http.Request) {
	if h.stores.NewProducts == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	sku := strings.TrimSpace(chiURLParam(r, "sku"))
	if sku == "" {
		writeValidationError(w, "sku is required", nil)
		return
	}
	var targetIDs []string
	item, err := h.stores.NewProducts.Get(r.Context(), projectID, sku, "profit_calc")
	if err == nil && item != nil {
		targetIDs = append(targetIDs, strconv.FormatInt(item.ID, 10))
	}
	itemEU, errEU := h.stores.NewProducts.Get(r.Context(), projectID, sku, "eu_accounting")
	if errEU == nil && itemEU != nil {
		targetIDs = append(targetIDs, strconv.FormatInt(itemEU.ID, 10))
	}
	if len(targetIDs) == 0 {
		writeAPIError(w, NewAPIError(ErrResourceNotFound))
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if val, err := strconv.Atoi(raw); err == nil && val > 0 {
			limit = val
		}
	}
	if limit > 200 {
		limit = 200
	}
	var items []AuditItem
	if h.stores.Audit != nil {
		items, err = h.stores.Audit.QueryAuditLogs(r.Context(), "new_product_calculation", targetIDs, limit)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	if items == nil {
		items = []AuditItem{}
	}
	writeOK(w, map[string]any{
		"sku":   sku,
		"items": items,
	}, "")
}

func (h *Handler) UpsertNewProductCalculation(w http.ResponseWriter, r *http.Request) {
	if h.stores.NewProducts == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	body, _, ok := h.gateConfirmation(w, r, "new_product_calculation.upsert", map[string]any{
		"project_id": projectID,
	}, func(body []byte) error {
		var request new_product_calculations.CreateRequest
		if err := json.Unmarshal(body, &request); err != nil {
			return errors.New("请求体必须是有效的新品测算对象")
		}
		if request.Source == nil || !validAgentCalculationSource(*request.Source) {
			return errors.New("source must be one of agent_listing_pull, agent_review_scrape, agent_market_research, external_api")
		}
		return nil
	})
	if !ok {
		return
	}
	var request new_product_calculations.CreateRequest
	if err := json.Unmarshal(body, &request); err != nil {
		writeValidationError(w, "请求体必须是有效的新品测算对象", nil)
		return
	}
	request.ProjectID = projectID
	if request.Source == nil || !validAgentCalculationSource(*request.Source) {
		writeValidationError(w, "source must be one of agent_listing_pull, agent_review_scrape, agent_market_research, external_api", nil)
		return
	}
	credential, _ := CredentialFromContext(r.Context())
	item, err := h.stores.NewProducts.Upsert(r.Context(), request, credential.AgentID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.logAudit(r, credential, "new_product_calculation.upsert", "new_product_calculation", strconv.FormatInt(item.ID, 10), nil, item)
	writeOK(w, item, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

type newProductComputeRequest struct {
	Mode                  string   `json:"mode"`
	Country               string   `json:"country"`
	ProductName           string   `json:"product_name"`
	SKU                   *string  `json:"sku"`
	ASIN                  *string  `json:"asin"`
	PackageLengthCM       float64  `json:"package_length_cm"`
	PackageWidthCM        float64  `json:"package_width_cm"`
	PackageHeightCM       float64  `json:"package_height_cm"`
	WeightKG              float64  `json:"weight_kg"`
	FOBProductCostRMB     *float64 `json:"fob_product_cost_rmb"`
	FirstLegCostRMB       *float64 `json:"first_leg_cost_rmb"`
	SalePriceUSD          *float64 `json:"sale_price_usd"`
	TargetProfitRate      *float64 `json:"target_profit_rate"`
	CommissionRate        float64  `json:"commission_rate"`
	AdvertisingRate       float64  `json:"advertising_rate"`
	ReturnLossRate        float64  `json:"return_loss_rate"`
	StorageMonths         float64  `json:"storage_months"`
	InboundPlacementMode  string   `json:"inbound_placement_mode"`
	USDToRMBRate          *float64 `json:"usd_to_rmb_rate"`
	FullContainerQuantity *float64 `json:"full_container_quantity"`
	FullContainerPriceRMB *float64 `json:"full_container_price_rmb"`
	DeliveryFeeUSD        float64  `json:"delivery_fee_usd"`
}

func (h *Handler) ComputeNewProductCalculation(w http.ResponseWriter, r *http.Request) {
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	var payload newProductComputeRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeValidationError(w, "请求体必须是有效的试算对象", nil)
		return
	}
	applyNewProductComputeDefaults(&payload)
	if payload.USDToRMBRate == nil {
		writeValidationError(w, "usd_to_rmb_rate is required for agent compute", nil)
		return
	}
	quoteData := pricing.QuoteData{ExchangeRateValue: *payload.USDToRMBRate, ExchangeRateCurrency: "USD"}
	var (
		result pricing.Result
		err    error
	)
	switch payload.Mode {
	case "profit_calc", "profit_reverse", "cost_reverse":
		if payload.FOBProductCostRMB == nil {
			writeValidationError(w, "fob_product_cost_rmb is required", nil)
			return
		}
		request := pricing.FBARequest{
			Country:              payload.Country,
			ProductName:          payload.ProductName,
			PackageLengthCM:      payload.PackageLengthCM,
			PackageWidthCM:       payload.PackageWidthCM,
			PackageHeightCM:      payload.PackageHeightCM,
			WeightKG:             payload.WeightKG,
			FOBProductCostRMB:    *payload.FOBProductCostRMB,
			FirstLegCostRMB:      derefFloat(payload.FirstLegCostRMB),
			ProjectID:            &projectID,
			SKU:                  payload.SKU,
			CommissionRate:       defaultRate(payload.CommissionRate, 0.15),
			AdvertisingRate:      defaultRate(payload.AdvertisingRate, 0.12),
			ReturnLossRate:       defaultRate(payload.ReturnLossRate, 0.04),
			StorageMonths:        defaultStorageMonths(payload.StorageMonths),
			InboundPlacementMode: defaultPlacement(payload.InboundPlacementMode),
			USDToRMBRate:         payload.USDToRMBRate,
		}
		switch payload.Mode {
		case "profit_calc":
			if payload.SalePriceUSD == nil {
				writeValidationError(w, "sale_price_usd is required", nil)
				return
			}
			request.SalePriceUSD = *payload.SalePriceUSD
			result, err = pricing.QuoteFBA(request, quoteData)
		case "profit_reverse":
			if payload.TargetProfitRate == nil {
				writeValidationError(w, "target_profit_rate is required", nil)
				return
			}
			_, result, err = pricing.SolveSalePriceForProfitRate(request, quoteData, *payload.TargetProfitRate)
		case "cost_reverse":
			if payload.SalePriceUSD == nil || payload.TargetProfitRate == nil {
				writeValidationError(w, "sale_price_usd and target_profit_rate are required", nil)
				return
			}
			request.SalePriceUSD = *payload.SalePriceUSD
			_, result, err = pricing.SolveFOBForProfitRate(request, quoteData, *payload.TargetProfitRate)
		}
	case "fbm_calc":
		if payload.FOBProductCostRMB == nil || payload.SalePriceUSD == nil ||
			payload.FullContainerQuantity == nil || payload.FullContainerPriceRMB == nil {
			writeValidationError(w, "fbm_calc requires fob cost, sale price and full-container fields", nil)
			return
		}
		result, err = pricing.QuoteFBM(pricing.FBMRequest{
			Country:               payload.Country,
			ProductName:           payload.ProductName,
			PackageLengthCM:       payload.PackageLengthCM,
			PackageWidthCM:        payload.PackageWidthCM,
			PackageHeightCM:       payload.PackageHeightCM,
			WeightKG:              payload.WeightKG,
			FOBProductCostRMB:     *payload.FOBProductCostRMB,
			FirstLegCostRMB:       derefFloat(payload.FirstLegCostRMB),
			FullContainerQuantity: *payload.FullContainerQuantity,
			FullContainerPriceRMB: *payload.FullContainerPriceRMB,
			DeliveryFeeUSD:        payload.DeliveryFeeUSD,
			ProjectID:             &projectID,
			SKU:                   payload.SKU,
			SalePriceUSD:          *payload.SalePriceUSD,
			CommissionRate:        defaultRate(payload.CommissionRate, 0.15),
			AdvertisingRate:       defaultRate(payload.AdvertisingRate, 0.12),
			ReturnLossRate:        defaultRate(payload.ReturnLossRate, 0.04),
			StorageMonths:         defaultStorageMonths(payload.StorageMonths),
			InboundPlacementMode:  defaultPlacement(payload.InboundPlacementMode),
			USDToRMBRate:          payload.USDToRMBRate,
		}, quoteData)
	default:
		writeValidationError(w, "mode must be profit_calc, profit_reverse, cost_reverse or fbm_calc", nil)
		return
	}
	if err != nil {
		writeValidationError(w, err.Error(), nil)
		return
	}
	snapshot := pricingResultSnapshot(result)
	snapshot["anchor"] = pricingAnchorSnapshot(result, payload.TargetProfitRate)
	writeOK(w, map[string]any{
		"mode":                   payload.Mode,
		"calculation":            snapshot,
		"snapshot":               snapshot,
		"usd_to_rmb_rate":        result.USDToRMBRate,
		"usd_to_rmb_rate_source": result.USDToRMBRateSource,
	}, "")
}

func (h *Handler) ListPricingSnapshots(w http.ResponseWriter, r *http.Request) {
	if h.stores.PricingSnapshots == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	page, pageSize := parsePage(r, 200, 500)
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	items, err := h.stores.PricingSnapshots.List(
		r.Context(),
		projectID,
		country,
		page,
		pageSize,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, map[string]any{
		"project_id": projectID,
		"country":    country,
		"data":       items,
		"total":      len(items),
		"page":       page,
		"page_size":  pageSize,
	}, "")
}

func validAgentCalculationSource(source string) bool {
	return agentCalculationSources[strings.TrimSpace(source)]
}

func parseBoolQuery(r *http.Request, key string) bool {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func paginate[T any](items []T, page, pageSize int) []T {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	start := (page - 1) * pageSize
	if start >= len(items) {
		return []T{}
	}
	end := start + pageSize
	if end > len(items) {
		end = len(items)
	}
	return items[start:end]
}

func defaultRate(value, fallback float64) float64 {
	if value == 0 {
		return fallback
	}
	return value
}

func defaultStorageMonths(value float64) float64 {
	if value == 0 {
		return 1
	}
	return value
}

func defaultPlacement(value string) string {
	if strings.TrimSpace(value) == "" {
		return "single_destination"
	}
	return value
}

func applyShopComputeDefaults(payload *shopComputeRequest) {
	payload.Country = strings.ToUpper(strings.TrimSpace(payload.Country))
	if payload.Country == "" {
		payload.Country = "US"
	}
	payload.Mode = strings.TrimSpace(payload.Mode)
	if payload.CommissionRate == 0 {
		payload.CommissionRate = 0.15
	}
	if payload.AdvertisingRate == 0 {
		payload.AdvertisingRate = 0.12
	}
	if payload.ReturnLossRate == 0 {
		payload.ReturnLossRate = 0.04
	}
	if payload.StorageMonths == 0 {
		payload.StorageMonths = 1
	}
	payload.InboundPlacementMode = defaultPlacement(payload.InboundPlacementMode)
}

func applyNewProductComputeDefaults(payload *newProductComputeRequest) {
	payload.Country = strings.ToUpper(strings.TrimSpace(payload.Country))
	if payload.Country == "" {
		payload.Country = "US"
	}
	payload.Mode = strings.TrimSpace(payload.Mode)
	if payload.CommissionRate == 0 {
		payload.CommissionRate = 0.15
	}
	if payload.AdvertisingRate == 0 {
		payload.AdvertisingRate = 0.12
	}
	if payload.ReturnLossRate == 0 {
		payload.ReturnLossRate = 0.04
	}
	if payload.StorageMonths == 0 {
		payload.StorageMonths = 1
	}
	payload.InboundPlacementMode = defaultPlacement(payload.InboundPlacementMode)
}

func pricingResultSnapshot(result pricing.Result) map[string]any {
	return map[string]any{
		"country":                       result.Country,
		"product_name":                  result.ProductName,
		"calculation_type":              result.CalculationType,
		"project_id":                    result.ProjectID,
		"sku":                           result.SKU,
		"package_length_cm":             result.PackageLengthCM,
		"package_width_cm":              result.PackageWidthCM,
		"package_height_cm":             result.PackageHeightCM,
		"weight_kg":                     result.WeightKG,
		"fob_product_cost_rmb":          result.FOBProductCostRMB,
		"first_leg_cost_rmb":            result.FirstLegCostRMB,
		"sale_price_usd":                result.SalePriceUSD,
		"commission_rate":               result.CommissionRate,
		"advertising_rate":              result.AdvertisingRate,
		"return_loss_rate":              result.ReturnLossRate,
		"storage_months":                result.StorageMonths,
		"inbound_placement_mode":        result.InboundPlacementMode,
		"size_tier":                     result.SizeTier,
		"size_tier_label":               result.SizeTierLabel,
		"price_band":                    result.PriceBand,
		"price_band_label":              result.PriceBandLabel,
		"usd_to_rmb_rate":               result.USDToRMBRate,
		"usd_to_rmb_rate_source":        result.USDToRMBRateSource,
		"fulfillment_fee_rule_label":    result.FulfillmentFeeRuleLabel,
		"inbound_config_fee_rule_label": result.InboundConfigFeeRuleLabel,
		"storage_fee_rule_label":        result.StorageFeeRuleLabel,
		"dimensions":                    result.Dimensions,
		"weights":                       result.Weights,
		"fees":                          result.Fees,
		"profit":                        result.Profit,
		"warnings":                      result.Warnings,
	}
}

func pricingAnchorSnapshot(result pricing.Result, targetNetMargin *float64) map[string]any {
	nonAdFee := result.Fees.TotalFeeUSD -
		result.Fees.AdvertisingFeeUSD -
		result.Fees.ReturnLossUSD
	breakeven := 0.0
	if result.SalePriceUSD > 0 {
		breakeven = nonAdFee / result.SalePriceUSD
	}
	anchor := map[string]any{
		"breakeven_advertising_rate": breakeven,
		"non_ad_fee_usd":             nonAdFee,
		"max_ad_spend_per_unit_usd":  result.SalePriceUSD * breakeven,
		"basis": map[string]any{
			"usd_to_rmb_rate":        result.USDToRMBRate,
			"usd_to_rmb_rate_source": result.USDToRMBRateSource,
		},
	}
	if targetNetMargin != nil {
		anchor["target_net_margin"] = *targetNetMargin
		anchor["target_advertising_rate"] = breakeven - *targetNetMargin
	}
	return anchor
}

func derefFloat(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}
