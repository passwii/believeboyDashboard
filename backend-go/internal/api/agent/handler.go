package agent

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/complaints"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/daily_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_ad_data"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/rpa_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type Handler struct {
	stores  Stores
	options Options
}

func NewHandler(stores Stores, options Options) *Handler {
	if options.ConfirmStore == nil {
		options.ConfirmStore = NewMemoryConfirmStore(options.Now)
	}
	return &Handler{stores: stores, options: options}
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	credential, _ := CredentialFromContext(r.Context())
	writeOK(w, map[string]any{
		"agent_id":    credential.AgentID,
		"server_time": h.options.now().UTC().Format(time.RFC3339Nano),
	}, "")
}

type agentProjectShop struct {
	ShopID         string              `json:"shop_id"`
	ShopName       *string             `json:"shop_name"`
	Country        string              `json:"country"`
	Site           *string             `json:"site"`
	SellerIdentity agentSellerIdentity `json:"seller_identity"`
}

type agentSellerIdentity struct {
	ExpectedAlias *string  `json:"expected_alias"`
	Aliases       []string `json:"aliases"`
	Source        *string  `json:"source"`
	Required      bool     `json:"required"`
}

type agentProjectItem struct {
	ProjectID   int64              `json:"project_id"`
	ProjectName string             `json:"project_name"`
	Country     string             `json:"country"`
	CountryName *string            `json:"country_name"`
	IsActive    bool               `json:"is_active"`
	Shops       []agentProjectShop `json:"shops"`
}

func (h *Handler) ListProjects(w http.ResponseWriter, r *http.Request) {
	if h.stores.Projects == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	if status == "" {
		status = "active"
	}
	showInactive := status != "active"
	items, err := h.stores.Projects.ListManage(r.Context(), "", true, showInactive)
	if err != nil {
		writeAPIError(w, NewAPIError(ErrInternal))
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	credential, _ := CredentialFromContext(r.Context())
	filtered := FilterProjectsByScope(items, credential.ProjectScope)
	response := make([]agentProjectItem, 0, len(filtered))
	for _, item := range filtered {
		if status == "active" && !item.IsActive {
			continue
		}
		if status == "inactive" && item.IsActive {
			continue
		}
		if name != "" && item.Name != name {
			continue
		}
		shops, err := h.stores.Projects.ListProjectShops(r.Context(), item.ID)
		if err != nil {
			writeAPIError(w, NewAPIError(ErrInternal))
			return
		}
		shopItems := make([]agentProjectShop, 0, len(shops))
		for _, shop := range shops {
			aliases := shop.SellerIdentityAliases
			if aliases == nil {
				aliases = []string{}
			}
			countryName := projects.CountryName(shop.Country)
			shopItems = append(shopItems, agentProjectShop{
				ShopID:   shop.ShopID,
				ShopName: shop.ShopName,
				Country:  shop.Country,
				Site:     countryName,
				SellerIdentity: agentSellerIdentity{
					ExpectedAlias: shop.SellerIdentityExpectedAlias,
					Aliases:       aliases,
					Source:        shop.SellerIdentitySource,
					Required:      shop.SellerIdentityRequired,
				},
			})
		}
		response = append(response, agentProjectItem{
			ProjectID:   item.ID,
			ProjectName: item.Name,
			Country:     item.Country,
			CountryName: projects.CountryName(item.Country),
			IsActive:    item.IsActive,
			Shops:       shopItems,
		})
	}
	writeOK(w, response, "")
}

func (h *Handler) GetSalesSummary(w http.ResponseWriter, r *http.Request) {
	if h.stores.Sales == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	period, err := parseAgentPeriod(
		r.URL.Query().Get("period"),
		optionalStringQuery(r, "start_date"),
		optionalStringQuery(r, "end_date"),
		h.options.now(),
	)
	if err != nil {
		writeValidationError(w, err.Error(), nil)
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	resp, err := h.stores.Sales.GetDailyAnalysis(
		r.Context(),
		projectID,
		country,
		period.StartDate,
		period.EndDate,
		optionalStringQuery(r, "sku"),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, map[string]any{
		"project_id": projectID,
		"period":     period,
		"country":    country,
		"data":       resp.SummaryRows,
		"aggregate":  summarizeDaily(resp.SummaryRows),
		"summary": map[string]any{
			"console":   resp.Console,
			"row_count": len(resp.SummaryRows),
		},
	}, "")
}

func (h *Handler) GetInventory(w http.ResponseWriter, r *http.Request) {
	if h.stores.Inventory == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	filter := inventory_replenishment.ReplenishmentFilter{
		ProjectID: &projectID,
		Country:   &country,
		Page:      1,
		PageSize:  500,
	}
	resp, err := h.stores.Inventory.GetInventoryAnalysis(r.Context(), filter)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if sku := strings.TrimSpace(r.URL.Query().Get("sku")); sku != "" {
		resp = filterInventoryAnalysis(resp, sku)
	}
	writeOK(w, map[string]any{
		"project_id":  projectID,
		"country":     country,
		"report_date": optionalStringQuery(r, "report_date"),
		"summary":     resp.Summary,
		"items":       resp.Items,
	}, "")
}

func (h *Handler) GetAdAggregate(endpoint string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.stores.Ads == nil {
			writeAPIError(w, NewAPIError(ErrServiceUnavailable))
			return
		}
		projectID, ok := requireProjectID(w, r)
		if !ok {
			return
		}
		resp, apiErr := h.queryAdRaw(r, projectID, endpoint, 10000, 0)
		if apiErr != nil {
			writeAPIError(w, apiErr)
			return
		}
		writeOK(w, aggregateAdResponse(resp, endpoint), "")
	}
}

func (h *Handler) GetAdRaw(endpoint string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.stores.Ads == nil {
			writeAPIError(w, NewAPIError(ErrServiceUnavailable))
			return
		}
		projectID, ok := requireProjectID(w, r)
		if !ok {
			return
		}
		limit, offset := parseLimitOffset(r, 10000, 50000)
		resp, apiErr := h.queryAdRaw(r, projectID, endpoint, limit, offset)
		if apiErr != nil {
			writeAPIError(w, apiErr)
			return
		}
		writeOK(w, resp, "")
	}
}

func (h *Handler) queryAdRaw(
	r *http.Request,
	projectID int64,
	endpoint string,
	limit, offset int,
) (*internal_ad_data.RawResponse, *APIError) {
	period := strings.TrimSpace(r.URL.Query().Get("period"))
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	filter := internal_ad_data.RawQueryFilter{
		ProjectID: projectID,
		Endpoint:  endpoint,
		Period:    period,
		StartDate: optionalStringQuery(r, "start_date"),
		EndDate:   optionalStringQuery(r, "end_date"),
		Country:   country,
		Limit:     limit,
		Offset:    offset,
		OrderBy:   strings.TrimSpace(r.URL.Query().Get("order_by")),
		OrderDir:  strings.ToLower(strings.TrimSpace(r.URL.Query().Get("order_dir"))),
	}
	resp, err := h.stores.Ads.QueryRaw(r.Context(), filter)
	if err != nil {
		if errors.Is(err, internal_ad_data.ErrProjectNotFound) || strings.Contains(err.Error(), "周期") {
			apiErr := NewAPIError(ErrValidationFailed)
			apiErr.Human = errMessage(err)
			return nil, apiErr
		}
		return nil, NewAPIError(ErrInternal)
	}
	return resp, nil
}

func (h *Handler) GetReportUploadStatus(w http.ResponseWriter, r *http.Request) {
	if h.stores.ReportStatus == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	reportDate := strings.TrimSpace(r.URL.Query().Get("report_date"))
	if _, err := time.Parse("2006-01-02", reportDate); err != nil {
		writeValidationError(w, "report_date 必须是 YYYY-MM-DD", nil)
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}
	resp, err := h.stores.ReportStatus.GetReportStatusForDate(
		r.Context(),
		reportDate,
		country,
		"",
		true,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	credential, _ := CredentialFromContext(r.Context())
	items := make([]rpa_reports.ProjectReportStatus, 0, len(resp.Items))
	for _, item := range resp.Items {
		if ProjectInScope(credential.ProjectScope, item.ProjectID) {
			items = append(items, item)
		}
	}
	if rawProjectID := strings.TrimSpace(r.URL.Query().Get("project_id")); rawProjectID != "" {
		projectID, err := strconv.ParseInt(rawProjectID, 10, 64)
		if err != nil || projectID < 1 {
			writeValidationError(w, "project_id must be a positive integer", nil)
			return
		}
		if !ProjectInScope(credential.ProjectScope, projectID) {
			writeAPIError(w, ErrorWithReason(ErrAgentProjectOutOfScope, "project_not_in_scope"))
			return
		}
		filtered := items[:0]
		for _, item := range items {
			if item.ProjectID == projectID {
				filtered = append(filtered, item)
			}
		}
		items = filtered
		if len(items) == 0 {
			writeAPIError(w, ErrorWithMessage(ErrResourceNotFound,
				fmt.Sprintf("项目 %d 不存在或不在凭据可见范围内", projectID)))
			return
		}
	}
	writeOK(w, map[string]any{
		"country":       country,
		"report_date":   reportDate,
		"generated_at":  h.options.now().UTC().Format("2006-01-02T15:04:05Z"),
		"project_count": len(items),
		"items":         items,
	}, "")
}

func (h *Handler) ListComplaints(w http.ResponseWriter, r *http.Request) {
	if h.stores.Complaints == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	filter := complaintsFilterFromRequest(r)
	credential, _ := CredentialFromContext(r.Context())
	if filter.ProjectID != nil {
		if !ProjectInScope(credential.ProjectScope, *filter.ProjectID) {
			writeAPIError(w, ErrorWithReason(ErrAgentProjectOutOfScope, "project_not_in_scope"))
			return
		}
	} else if credential.ProjectScope == ScopeAll {
		filter.IsAdmin = true
	} else {
		allowedIDs := parseProjectScopeIDs(credential.ProjectScope)
		if len(allowedIDs) == 0 {
			writeOK(w, complaints.ComplaintListResponse{
				Items:     []complaints.ComplaintListItem{},
				Total:     0,
				Page:      filter.Page,
				PageSize:  filter.PageSize,
				SpamCount: 0,
			}, "")
			return
		}
		filter.ProjectIDs = allowedIDs
	}
	resp, err := h.stores.Complaints.ListComplaints(r.Context(), filter)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetComplaintOverview(w http.ResponseWriter, r *http.Request) {
	if h.stores.Complaints == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	targetDate := strings.TrimSpace(r.URL.Query().Get("date"))
	if targetDate == "" {
		targetDate = h.options.now().UTC().Format("2006-01-02")
	}
	country := optionalStringQuery(r, "country")
	credential, _ := CredentialFromContext(r.Context())
	ctx := r.Context()
	if credential.ProjectScope == ScopeAll {
		ctx = auth.WithUserContext(ctx, auth.UserContext{IsAdmin: true})
	} else {
		allowedIDs := parseProjectScopeIDs(credential.ProjectScope)
		if len(allowedIDs) == 0 {
			writeOK(w, complaints.OverviewResponse{
				Date:     targetDate,
				Metrics:  complaints.OverviewMetrics{},
				Projects: []complaints.OverviewProjectRow{},
			}, "")
			return
		}
		ctx = complaints.WithAccessibleProjectIDs(ctx, allowedIDs)
	}
	resp, err := h.stores.Complaints.GetOverview(ctx, targetDate, country)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) UpdateReplenishmentSetting(w http.ResponseWriter, r *http.Request) {
	if h.stores.Replenishment == nil {
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
	body, _, ok := h.gateConfirmation(w, r, "replenishment_analysis.settings.upsert", map[string]any{
		"project_id": projectID,
		"sku":        sku,
	}, func(body []byte) error {
		var update inventory_replenishment.InventoryReplenishmentSettingUpdate
		if err := json.Unmarshal(body, &update); err != nil {
			return errors.New("请求体必须是 JSON 对象")
		}
		return nil
	})
	if !ok {
		return
	}
	var update inventory_replenishment.InventoryReplenishmentSettingUpdate
	if err := json.Unmarshal(body, &update); err != nil {
		writeValidationError(w, "请求体必须是 JSON 对象", nil)
		return
	}
	credential, _ := CredentialFromContext(r.Context())
	item, err := h.stores.Replenishment.UpdateSetting(
		r.Context(),
		projectID,
		sku,
		update,
		credential.AgentID,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.logAudit(r, credential, "replenishment_analysis.settings.upsert", "inventory_replenishment_setting", fmt.Sprintf("%d:%s", projectID, sku), nil, item)
	writeOK(w, item, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

func (h *Handler) logAudit(
	r *http.Request,
	credential Credential,
	action string,
	targetType string,
	targetID string,
	before any,
	after any,
) {
	if h.options.Auditor == nil {
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	agentID := credential.AgentID
	var idKey *string
	if idempotencyKey != "" {
		idKey = &idempotencyKey
	}
	var target *string
	if targetID != "" {
		target = &targetID
	}
	entry := audit.Entry{
		Action:         action,
		TargetType:     targetType,
		TargetID:       target,
		Operator:       &agentID,
		AgentID:        &agentID,
		Result:         "success",
		IdempotencyKey: idKey,
		BeforeJSON:     before,
		AfterJSON:      after,
	}
	entry.PopulateFromRequest(r)
	_ = h.options.Auditor.LogAction(r.Context(), entry)
}

func requireProjectID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	projectID, err := projectIDFromRequest(r)
	if err != nil {
		writeValidationError(w, "project_id must be a positive integer", nil)
		return 0, false
	}
	return projectID, true
}

func optionalStringQuery(r *http.Request, key string) *string {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return nil
	}
	return &value
}

func parseLimitOffset(r *http.Request, defaultLimit, maxLimit int) (int, int) {
	limit := defaultLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 {
			limit = parsed
		}
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	offset := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
			offset = parsed
		}
	}
	return limit, offset
}

func writeStoreError(w http.ResponseWriter, err error) {
	if err == nil {
		writeAPIError(w, NewAPIError(ErrInternal))
		return
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "not found"), strings.Contains(message, "不存在"):
		writeAPIError(w, ErrorWithMessage(ErrResourceNotFound, err.Error()))
	case strings.Contains(message, "forbidden"), strings.Contains(message, "无权限"):
		writeAPIError(w, ErrorWithReason(ErrAgentProjectOutOfScope, "project_not_in_scope"))
	case strings.Contains(message, "invalid"), strings.Contains(message, "无效"):
		writeValidationError(w, err.Error(), nil)
	default:
		writeAPIError(w, NewAPIError(ErrInternal))
	}
}

func errMessage(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}

func chiURLParam(r *http.Request, key string) string {
	value := chi.URLParam(r, key)
	if value != "" {
		return value
	}
	if params, ok := r.Context().Value(routeParamsContextKey{}).(map[string]string); ok {
		return params[key]
	}
	return ""
}

type periodInfo struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
}

func parseAgentPeriod(period string, startDate, endDate *string, now time.Time) (periodInfo, error) {
	yesterday := now.UTC().AddDate(0, 0, -1)
	period = strings.TrimSpace(strings.ToLower(period))
	if period == "custom" || (period == "" && startDate != nil && endDate != nil) {
		if startDate == nil || endDate == nil {
			return periodInfo{}, fmt.Errorf("start_date and end_date are required when period=custom")
		}
		start, err := time.Parse("2006-01-02", *startDate)
		if err != nil {
			return periodInfo{}, fmt.Errorf("invalid start_date")
		}
		end, err := time.Parse("2006-01-02", *endDate)
		if err != nil || start.After(end) {
			return periodInfo{}, fmt.Errorf("invalid start_date or end_date")
		}
		return periodInfo{Type: "custom", Value: "custom", StartDate: *startDate, EndDate: *endDate}, nil
	}
	if period == "" {
		period = "30d"
	}
	var start time.Time
	switch period {
	case "7d":
		start = yesterday.AddDate(0, 0, -6)
	case "14d":
		start = yesterday.AddDate(0, 0, -13)
	case "28d":
		start = yesterday.AddDate(0, 0, -27)
	case "30d":
		start = yesterday.AddDate(0, 0, -29)
	case "60d":
		start = yesterday.AddDate(0, 0, -59)
	case "90d":
		start = yesterday.AddDate(0, 0, -89)
	case "this_month":
		start = time.Date(yesterday.Year(), yesterday.Month(), 1, 0, 0, 0, 0, time.UTC)
	case "last_month":
		first := time.Date(yesterday.Year(), yesterday.Month(), 1, 0, 0, 0, 0, time.UTC)
		endOfLast := first.AddDate(0, 0, -1)
		startOfLast := time.Date(endOfLast.Year(), endOfLast.Month(), 1, 0, 0, 0, 0, time.UTC)
		return periodInfo{
			Type: "relative", Value: period,
			StartDate: startOfLast.Format("2006-01-02"),
			EndDate:   endOfLast.Format("2006-01-02"),
		}, nil
	case "ytd":
		start = time.Date(yesterday.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	default:
		if parsed, err := time.Parse("2006-01", period); err == nil {
			next := parsed.AddDate(0, 1, 0).AddDate(0, 0, -1)
			return periodInfo{
				Type: "relative", Value: period,
				StartDate: parsed.Format("2006-01-02"),
				EndDate:   next.Format("2006-01-02"),
			}, nil
		}
		return periodInfo{}, fmt.Errorf("unknown period alias: %q", period)
	}
	return periodInfo{
		Type: "relative", Value: period,
		StartDate: start.Format("2006-01-02"),
		EndDate:   yesterday.Format("2006-01-02"),
	}, nil
}

func summarizeDaily(rows []daily_analysis.DailyAnalysisSummaryRow) map[string]any {
	var orderQty, pendingQty, unitsOrdered int
	var salesAmount, adSpend float64
	for _, row := range rows {
		orderQty += row.OrderQty
		pendingQty += row.PendingOrderQty
		unitsOrdered += row.UnitsOrdered
		salesAmount += row.SalesAmount
		adSpend += row.AdSpend
	}
	return map[string]any{
		"order_qty":         orderQty,
		"pending_order_qty": pendingQty,
		"units_ordered":     unitsOrdered,
		"sales_amount":      salesAmount,
		"ad_spend":          adSpend,
	}
}

func filterInventoryAnalysis(
	resp inventory_replenishment.InventoryAnalysisResponse,
	sku string,
) inventory_replenishment.InventoryAnalysisResponse {
	needle := strings.ToLower(strings.TrimSpace(sku))
	items := make([]inventory_replenishment.InventoryAnalysisItem, 0, len(resp.Items))
	summary := inventory_replenishment.InventoryAnalysisSummary{}
	for _, item := range resp.Items {
		if !strings.Contains(strings.ToLower(item.SKU), needle) {
			continue
		}
		items = append(items, item)
		summary.SKUCount++
		if item.StockStatus == "out_of_stock" {
			summary.OutOfStockCount++
		}
		if item.AgingStatus == "aging" || item.AgingStatus == "over_aged" {
			summary.AgingSKUCount++
		}
		if item.AgingStatus == "over_aged" {
			summary.OverAgedSKUCount++
		}
		summary.TotalAvailableQty += item.AvailableQty
		summary.TotalAge0To90Qty += item.Age0To90Qty
		summary.TotalAge91To180Qty += item.Age91To180Qty
		summary.TotalAge181To270Qty += item.Age181To270Qty
		summary.TotalAge271To365Qty += item.Age271To365Qty
		summary.TotalAge365PlusQty += item.Age365PlusQty
	}
	resp.Items = items
	resp.Summary = summary
	return resp
}

func complaintsFilterFromRequest(r *http.Request) complaints.ComplaintFilter {
	page := 1
	if parsed, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && parsed > 0 {
		page = parsed
	}
	pageSize := 20
	if parsed, err := strconv.Atoi(r.URL.Query().Get("page_size")); err == nil && parsed > 0 {
		pageSize = parsed
	}
	if pageSize > 200 {
		pageSize = 200
	}
	var projectID *int64
	if raw := strings.TrimSpace(r.URL.Query().Get("project_id")); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil && parsed > 0 {
			projectID = &parsed
		}
	}
	return complaints.ComplaintFilter{
		Date:      optionalStringQuery(r, "date"),
		ProjectID: projectID,
		Category:  optionalStringQuery(r, "category"),
		Status:    optionalStringQuery(r, "status"),
		Country:   optionalStringQuery(r, "country"),
		Keyword:   optionalStringQuery(r, "keyword"),
		Page:      page,
		PageSize:  pageSize,
		Operator:  "",
		IsAdmin:   true,
	}
}
