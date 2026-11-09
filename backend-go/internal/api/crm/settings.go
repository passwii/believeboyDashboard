package crm

import (
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (handler *Handler) ListCategories(w http.ResponseWriter, r *http.Request) {
	items, err := handler.store.ListCategories(r.Context())
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (handler *Handler) CreateCategory(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	var input CategoryCreateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if err := validateLength(input.Name, 1, 50, "name"); err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.CreateCategory(r.Context(), input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (handler *Handler) UpdateCategory(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	categoryID, err := parsePathID(r, "category_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	var input CategoryUpdateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.Name.Set && input.Name.Value != nil {
		trimmed := strings.TrimSpace(*input.Name.Value)
		input.Name.Value = &trimmed
		if err := validateLength(trimmed, 1, 50, "name"); err != nil {
			WriteError(w, err)
			return
		}
	}
	item, err := handler.store.UpdateCategory(r.Context(), categoryID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "类目不存在")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) DeleteCategory(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	categoryID, err := parsePathID(r, "category_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.store.DeleteCategory(r.Context(), categoryID, identity.UserID); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) ListSavedViews(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	entityType := optionalString(r.URL.Query().Get("entity_type"))
	if entityType != nil && *entityType != "customer" && *entityType != "lead" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "entity_type must be customer or lead")
		return
	}
	items, err := handler.store.ListSavedViews(r.Context(), entityType, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (handler *Handler) CreateSavedView(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	var input SavedViewCreateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateLength(input.Name, 1, 100, "name"); err != nil {
		WriteError(w, err)
		return
	}
	if input.EntityType != "customer" && input.EntityType != "lead" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "entity_type must be customer or lead")
		return
	}
	if input.Scope == "" {
		input.Scope = "all"
	}
	if input.Scope != "mine" && input.Scope != "all" && input.Scope != "sea" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid scope")
		return
	}
	if input.SortBy == "" {
		input.SortBy = "updated_at"
	}
	if input.SortOrder == "" {
		input.SortOrder = "desc"
	}
	if input.SortOrder != "asc" && input.SortOrder != "desc" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "sort_order must be asc or desc")
		return
	}
	if input.IsShared && !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "Admin required to create shared views")
		return
	}
	item, err := handler.store.CreateSavedView(r.Context(), input, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (handler *Handler) UpdateSavedView(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	viewID, err := parsePathID(r, "view_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	var input SavedViewUpdateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.Name.Set && input.Name.Value != nil {
		trimmed := strings.TrimSpace(*input.Name.Value)
		input.Name.Value = &trimmed
		if err := validateLength(trimmed, 1, 100, "name"); err != nil {
			WriteError(w, err)
			return
		}
	}
	if input.Scope.Set && input.Scope.Value != nil {
		if *input.Scope.Value != "mine" && *input.Scope.Value != "all" && *input.Scope.Value != "sea" {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid scope")
			return
		}
	}
	if input.SortOrder.Set && input.SortOrder.Value != nil {
		if *input.SortOrder.Value != "asc" && *input.SortOrder.Value != "desc" {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "sort_order must be asc or desc")
			return
		}
	}
	if input.IsShared.Set && input.IsShared.Value != nil && *input.IsShared.Value && !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "Admin required to create shared views")
		return
	}
	item, err := handler.store.UpdateSavedView(r.Context(), viewID, input, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "视图不存在")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) DeleteSavedView(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	viewID, err := parsePathID(r, "view_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.store.DeleteSavedView(r.Context(), viewID, identity.UserID, identity.IsAdmin); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
