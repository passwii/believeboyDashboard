package projects

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
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Store interface {
	ListOptions(context.Context) ([]ProjectOption, error)
	ListManage(context.Context, string, bool, bool) ([]ProjectItem, error)
	ListOperatorOptions(context.Context) ([]string, error)
	GetProject(context.Context, int64) (*ProjectItem, error)
	CreateProject(context.Context, CreateProjectInput) (ProjectItem, error)
	UpdateProject(context.Context, int64, UpdateProjectInput) (ProjectItem, error)
	MoveProject(context.Context, int64, string) (ProjectItem, error)
	ListProjectShops(context.Context, int64) ([]ProjectShopItem, error)
	UpsertProjectShop(context.Context, int64, string, ShopUpsert) (*ProjectShopItem, ProjectShopItem, error)
	DeleteProjectShop(context.Context, int64, string) (bool, error)
	GetProjectContext(context.Context, int64) (ProjectContext, error)
	PatchProjectContext(context.Context, int64, map[string]any, map[string]any, string) (ProjectContext, error)
}

type Handler struct {
	store         Store
	auditor       audit.Service
	contextParser ContextParser
}

type Option func(*Handler)

func WithContextParser(parser ContextParser) Option {
	return func(handler *Handler) {
		handler.contextParser = parser
	}
}

func NewHandler(store Store, auditor audit.Service, options ...Option) *Handler {
	handler := &Handler{store: store, auditor: auditor}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	return handler
}

func (h *Handler) ListProjects(w http.ResponseWriter, r *http.Request) {
	items, err := h.store.ListOptions(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if items == nil {
		items = []ProjectOption{}
	}
	h.logView(r, "projects.options.view", "project", map[string]any{"count": len(items)})
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) ListProjectOperatorOptions(w http.ResponseWriter, r *http.Request) {
	items, err := h.store.ListOperatorOptions(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if items == nil {
		items = []string{}
	}
	h.logView(r, "projects.operator_options.view", "project_operator", map[string]any{"count": len(items)})
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) ListProjectsManage(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	showInactive, err := parseBoolQuery(r, "show_inactive")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "show_inactive must be a valid boolean")
		return
	}
	items, err := h.store.ListManage(r.Context(), identity.Operator, identity.IsAdmin, showInactive)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if items == nil {
		items = []ProjectItem{}
	}
	h.logView(r, "projects.list", "project", map[string]any{"count": len(items)})
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) CreateProject(w http.ResponseWriter, r *http.Request) {
	var input CreateProjectInput
	if err := decodeJSON(r, &input); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if err := validateProjectInput(input); err != nil {
		writeStoreError(w, err)
		return
	}
	country, err := ValidateCountry(input.Country)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	input.Country = country
	identity, _ := auth.UserContextFromContext(r.Context())
	if !identity.IsAdmin &&
		!HasOperator(input.ProjectOperator, identity.Operator) &&
		!HasOperator(input.AssistantOperator, identity.Operator) {
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限创建项目")
		return
	}

	item, err := h.store.CreateProject(r.Context(), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := h.logAction(r, "projects.create", "project", item.ID, nil, item); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) UpdateProject(w http.ResponseWriter, r *http.Request) {
	projectID, ok := h.authorizedProject(w, r)
	if !ok {
		return
	}
	var input UpdateProjectInput
	if err := decodeJSON(r, &input); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 255 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "name must contain 1 to 255 characters")
		return
	}
	if err := validateProjectFields(input.BrandName, input.StoreAddress, input.ProjectOperator,
		input.AssistantOperator, input.CommissionBasis, input.CommissionRate, input.ProjectTier); err != nil {
		writeStoreError(w, err)
		return
	}
	if input.Country != nil {
		country, err := ValidateCountry(*input.Country)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		input.Country = &country
	}
	before, err := h.store.GetProject(r.Context(), projectID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	item, err := h.store.UpdateProject(r.Context(), projectID, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := h.logAction(r, "projects.update", "project", projectID, before, item); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) MoveProjectUp(w http.ResponseWriter, r *http.Request) {
	h.moveProject(w, r, "up")
}

func (h *Handler) MoveProjectDown(w http.ResponseWriter, r *http.Request) {
	h.moveProject(w, r, "down")
}

func (h *Handler) MoveProject(w http.ResponseWriter, r *http.Request) {
	h.moveProject(w, r, chi.URLParam(r, "direction"))
}

func (h *Handler) moveProject(w http.ResponseWriter, r *http.Request, direction string) {
	if direction != "up" && direction != "down" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "direction must be 'up' or 'down'")
		return
	}
	projectID, ok := h.authorizedProject(w, r)
	if !ok {
		return
	}

	entry := audit.Entry{
		Action:     "projects.move_" + direction,
		TargetType: "project",
		TargetID:   stringPointer(strconv.FormatInt(projectID, 10)),
		Operator:   optionalNonBlank(identityForRequest(r).Operator),
		Result:     "success",
	}
	entry.PopulateFromRequest(r)

	var item ProjectItem
	var err error
	if mover, ok := h.store.(interface {
		MoveProjectAudited(context.Context, int64, string, audit.Entry) (ProjectItem, error)
	}); ok {
		item, err = mover.MoveProjectAudited(r.Context(), projectID, direction, entry)
	} else {
		item, err = h.store.MoveProject(r.Context(), projectID, direction)
		if err == nil && h.auditor != nil {
			entry.AfterJSON = item
			err = h.auditor.LogAction(r.Context(), entry)
		}
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) ParseProjectContext(w http.ResponseWriter, r *http.Request) {
	_, ok := h.authorizedProject(w, r)
	if !ok {
		return
	}
	if h.contextParser == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "AI 项目背景解析未配置")
		return
	}

	var input struct {
		Description string `json:"description"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := decodeJSON(r, &input); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	input.Description = strings.TrimSpace(input.Description)
	if input.Description == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "description must contain at least 1 character")
		return
	}

	result, err := h.contextParser.Parse(r.Context(), input.Description)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "AI 项目背景解析不可用")
		return
	}
	if result == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "AI 项目背景解析未返回有效结果")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"result": result,
	})
}

func (h *Handler) ListProjectShops(w http.ResponseWriter, r *http.Request) {
	projectID, ok := h.authorizedProject(w, r)
	if !ok {
		return
	}
	items, err := h.store.ListProjectShops(r.Context(), projectID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if items == nil {
		items = []ProjectShopItem{}
	}
	h.logView(r, "projects.shops.list", "project_shop", map[string]any{"count": len(items)})
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) UpsertProjectShop(w http.ResponseWriter, r *http.Request) {
	projectID, ok := h.authorizedProject(w, r)
	if !ok {
		return
	}
	country, err := ValidateCountry(chi.URLParam(r, "country"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var input ShopUpsert
	if err := decodeJSON(r, &input); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	input.ShopID = strings.TrimSpace(input.ShopID)
	if input.ShopID == "" || len([]rune(input.ShopID)) > 64 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "shop_id must contain 1 to 64 characters")
		return
	}
	if err := validateShopUpsert(input); err != nil {
		writeStoreError(w, err)
		return
	}
	before, item, err := h.store.UpsertProjectShop(r.Context(), projectID, country, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if before != nil && identityFieldsChanged(*before, item) {
		identityBefore := map[string]any{
			"expected_alias": before.SellerIdentityExpectedAlias,
			"aliases":        before.SellerIdentityAliases,
		}
		identityAfter := map[string]any{
			"expected_alias": item.SellerIdentityExpectedAlias,
			"aliases":        item.SellerIdentityAliases,
		}
		if err := h.logAction(r, "projects.shops.identity_change", "project_shop", item.ID, identityBefore, identityAfter); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	if err := h.logAction(r, "projects.shops.upsert", "project_shop", item.ID, before, item); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteProjectShop(w http.ResponseWriter, r *http.Request) {
	projectID, ok := h.authorizedProject(w, r)
	if !ok {
		return
	}
	country, err := ValidateCountry(chi.URLParam(r, "country"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	deleted, err := h.store.DeleteProjectShop(r.Context(), projectID, country)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := h.logAction(r, "projects.shops.delete", "project_shop", projectID, nil, map[string]any{
		"deleted": deleted, "project_id": projectID, "country": country,
	}); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ShopDeleteResponse{
		Deleted: deleted, ProjectID: projectID, Country: country,
	})
}

func (h *Handler) GetProjectContext(w http.ResponseWriter, r *http.Request) {
	projectID, ok := h.authorizedProject(w, r)
	if !ok {
		return
	}
	value, err := h.store.GetProjectContext(r.Context(), projectID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if value.ProjectContext == nil {
		value.ProjectContext = map[string]any{}
	}
	if value.SKUContext == nil {
		value.SKUContext = map[string]any{}
	}
	h.logView(r, "projects.context.view", "project_context", map[string]any{
		"has_project_context": len(value.ProjectContext) > 0,
		"has_sku_context":     len(value.SKUContext) > 0,
	})
	_ = httpapi.WriteJSON(w, http.StatusOK, value)
}

func (h *Handler) PatchProjectContext(w http.ResponseWriter, r *http.Request) {
	projectID, ok := h.authorizedProject(w, r)
	if !ok {
		return
	}
	var input ContextPatchInput
	if err := decodeJSON(r, &input); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	before, err := h.store.GetProjectContext(r.Context(), projectID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	identity := identityForRequest(r)
	value, err := h.store.PatchProjectContext(r.Context(), projectID, input.ProjectContext, input.SKUContext, identity.Operator)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := h.logAction(r, "projects.context.update", "project_context", projectID, before, value); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, value)
}

func (h *Handler) authorizedProject(w http.ResponseWriter, r *http.Request) (int64, bool) {
	projectID, err := strconv.ParseInt(chi.URLParam(r, "project_id"), 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a positive integer")
		return 0, false
	}
	item, err := h.store.GetProject(r.Context(), projectID)
	if err != nil {
		writeStoreError(w, err)
		return 0, false
	}
	if item == nil {
		writeStoreError(w, ErrNotFound)
		return 0, false
	}
	identity := identityForRequest(r)
	if !CanAccessProject(*item, identity.Operator, identity.IsAdmin) {
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
		return 0, false
	}
	return projectID, true
}

func (h *Handler) logAction(r *http.Request, action, targetType string, targetID int64, before, after any) error {
	if h.auditor == nil {
		return nil
	}
	identity := identityForRequest(r)
	entry := audit.Entry{
		Action:     action,
		TargetType: targetType,
		TargetID:   stringPointer(strconv.FormatInt(targetID, 10)),
		Operator:   optionalNonBlank(identity.Operator),
		Result:     "success",
		BeforeJSON: before,
		AfterJSON:  after,
	}
	entry.PopulateFromRequest(r)
	return h.auditor.LogAction(r.Context(), entry)
}

func (h *Handler) logView(r *http.Request, action, targetType string, after any) {
	if h.auditor == nil {
		return
	}
	identity := identityForRequest(r)
	_ = h.auditor.LogView(r.Context(), action, targetType, optionalNonBlank(identity.Operator), after, r)
}

func writeStoreError(w http.ResponseWriter, err error) {
	status, detail := HTTPError(err)
	httpapi.WriteDetail(w, status, detail)
}

func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func parseBoolQuery(r *http.Request, key string) (bool, error) {
	values, present := r.URL.Query()[key]
	if !present || len(values) == 0 || values[len(values)-1] == "" {
		return false, nil
	}
	switch strings.ToLower(strings.TrimSpace(values[len(values)-1])) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean")
	}
}

func identityForRequest(r *http.Request) auth.UserContext {
	identity, _ := auth.UserContextFromContext(r.Context())
	return identity
}

func HasOperator(value *string, operator string) bool {
	operator = strings.TrimSpace(operator)
	if value == nil || operator == "" {
		return false
	}
	for _, candidate := range strings.FieldsFunc(*value, func(r rune) bool {
		switch r {
		case '、', ',', '，', ';', '\n':
			return true
		default:
			return false
		}
	}) {
		if strings.TrimSpace(candidate) == operator {
			return true
		}
	}
	return false
}

func CanAccessProject(item ProjectItem, operator string, isAdmin bool) bool {
	return isAdmin || HasOperator(item.ProjectOperator, operator) ||
		HasOperator(item.AssistantOperator, operator)
}

func identityFieldsChanged(before, after ProjectShopItem) bool {
	if !sameOptionalString(before.SellerIdentityExpectedAlias, after.SellerIdentityExpectedAlias) {
		return true
	}
	if len(before.SellerIdentityAliases) != len(after.SellerIdentityAliases) {
		return true
	}
	for i := range before.SellerIdentityAliases {
		if before.SellerIdentityAliases[i] != after.SellerIdentityAliases[i] {
			return true
		}
	}
	return false
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func validateShopUpsert(input ShopUpsert) error {
	for name, value := range map[string]*string{
		"shop_name":                      input.ShopName.Value,
		"seller_identity_expected_alias": input.SellerIdentityExpectedAlias.Value,
		"seller_identity_source":         input.SellerIdentitySource.Value,
	} {
		if value != nil && len([]rune(*value)) > 128 {
			return NewAPIError(http.StatusUnprocessableEntity, name+" is too long")
		}
	}
	return nil
}

func optionalNonBlank(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func stringPointer(value string) *string { return &value }
func int64Pointer(value int64) *int64    { return &value }
