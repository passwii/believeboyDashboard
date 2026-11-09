package ad_analysis

import (
	"errors"
	"net/http"
	"strings"

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

func (h *Handler) parseBaseFilter(r *http.Request) (BaseFilter, bool) {
	identity, _ := auth.UserContextFromContext(r.Context())
	param, valErr := httpapi.ParseIntegerQuery(r, "project_id")
	if valErr != nil {
		return BaseFilter{}, false
	}
	if !param.Present || param.Value == nil {
		return BaseFilter{}, false
	}
	if minErr := httpapi.ValidateIntegerMinimum(param, "project_id", 1); minErr != nil {
		return BaseFilter{}, false
	}
	projectID := param.Value.Int64()

	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}

	var dateFrom *string
	if v := strings.TrimSpace(r.URL.Query().Get("date_from")); v != "" {
		dateFrom = &v
	}

	var dateTo *string
	if v := strings.TrimSpace(r.URL.Query().Get("date_to")); v != "" {
		dateTo = &v
	}

	return BaseFilter{
		ProjectID: projectID,
		Country:   country,
		DateFrom:  dateFrom,
		DateTo:    dateTo,
		Operator:  identity.Operator,
		IsAdmin:   identity.IsAdmin,
	}, true
}

func (h *Handler) checkAccess(w http.ResponseWriter, r *http.Request, projectID int64, identity auth.UserContext) bool {
	err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return false
		}
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
		return false
	}
	return true
}

func optionalQuery(r *http.Request, key string) *string {
	v := strings.TrimSpace(r.URL.Query().Get(key))
	if v == "" {
		return nil
	}
	return &v
}

func (h *Handler) GetOverview(w http.ResponseWriter, r *http.Request) {
	filter, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, filter.ProjectID, identity) {
		return
	}

	resp, err := h.store.BuildOverview(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetCampaigns(w http.ResponseWriter, r *http.Request) {
	base, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, base.ProjectID, identity) {
		return
	}

	filter := CampaignsFilter{
		BaseFilter: base,
		Campaign:   optionalQuery(r, "campaign"),
		SKU:        optionalQuery(r, "sku"),
		SearchTerm: optionalQuery(r, "search_term"),
		Placement:  optionalQuery(r, "placement"),
	}

	resp, err := h.store.BuildCampaigns(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetProducts(w http.ResponseWriter, r *http.Request) {
	base, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, base.ProjectID, identity) {
		return
	}

	filter := ProductsFilter{
		BaseFilter: base,
		Campaign:   optionalQuery(r, "campaign"),
		SKU:        optionalQuery(r, "sku"),
	}

	resp, err := h.store.BuildProducts(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetTimeTrend(w http.ResponseWriter, r *http.Request) {
	filter, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, filter.ProjectID, identity) {
		return
	}

	resp, err := h.store.BuildTimeTrend(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetPurchasedProducts(w http.ResponseWriter, r *http.Request) {
	base, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, base.ProjectID, identity) {
		return
	}

	filter := PurchasedProductsFilter{
		BaseFilter:    base,
		Campaign:      optionalQuery(r, "campaign"),
		SKU:           optionalQuery(r, "sku"),
		PurchasedASIN: optionalQuery(r, "purchased_asin"),
	}

	resp, err := h.store.BuildPurchasedProducts(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetSearchTerms(w http.ResponseWriter, r *http.Request) {
	base, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, base.ProjectID, identity) {
		return
	}

	filter := SearchTermsFilter{
		BaseFilter: base,
		Campaign:   optionalQuery(r, "campaign"),
		SearchTerm: optionalQuery(r, "search_term"),
		SKU:        optionalQuery(r, "sku"),
	}

	resp, err := h.store.BuildSearchTerms(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetTargets(w http.ResponseWriter, r *http.Request) {
	base, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, base.ProjectID, identity) {
		return
	}

	filter := TargetsFilter{
		BaseFilter: base,
		Campaign:   optionalQuery(r, "campaign"),
		TargetText: optionalQuery(r, "target_text"),
		SKU:        optionalQuery(r, "sku"),
	}

	resp, err := h.store.BuildTargets(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetBudget(w http.ResponseWriter, r *http.Request) {
	base, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, base.ProjectID, identity) {
		return
	}

	filter := BudgetFilter{
		BaseFilter: base,
		Campaign:   optionalQuery(r, "campaign"),
		SKU:        optionalQuery(r, "sku"),
	}

	resp, err := h.store.BuildBudget(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetPlacements(w http.ResponseWriter, r *http.Request) {
	base, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, base.ProjectID, identity) {
		return
	}

	filter := PlacementsFilter{
		BaseFilter: base,
		Campaign:   optionalQuery(r, "campaign"),
		SKU:        optionalQuery(r, "sku"),
		Placement:  optionalQuery(r, "placement"),
	}

	resp, err := h.store.BuildPlacements(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetTrafficQuality(w http.ResponseWriter, r *http.Request) {
	base, ok := h.parseBaseFilter(r)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, base.ProjectID, identity) {
		return
	}

	filter := TrafficQualityFilter{
		BaseFilter: base,
		Campaign:   optionalQuery(r, "campaign"),
		SKU:        optionalQuery(r, "sku"),
	}

	resp, err := h.store.BuildTrafficQuality(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}
