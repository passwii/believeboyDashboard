package internal_keys

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Store interface {
	ListAPIKeys(ctx context.Context, includeDeleted bool) ([]APIKey, error)
	CreateAPIKey(ctx context.Context, input APIKeyCreateInput, operator string) (*APIKey, string, error)
	DeleteAPIKey(ctx context.Context, id int64) (*APIKey, error)
	ListUserAPIKeys(ctx context.Context) ([]UserAPIKey, error)
	CreateUserAPIKey(ctx context.Context, userID, clientID string) (*UserAPIKey, string, error)
	DeleteUserAPIKey(ctx context.Context, id int64) (*UserAPIKey, error)
	RevokeUserAPIKeys(ctx context.Context, userID string, clientID *string) ([]UserAPIKey, error)
	RotateUserAPIKey(ctx context.Context, userID string, clientID *string) (*UserAPIKey, string, error)
}

type updateStore interface {
	UpdateAPIKey(
		ctx context.Context,
		id int64,
		input APIKeyUpdateInput,
	) (*APIKey, error)
}

type revokeStore interface {
	RevokeAPIKey(ctx context.Context, id int64) (*APIKey, error)
}

type activateStore interface {
	ActivateAPIKey(ctx context.Context, id int64) (*APIKey, error)
}

type Handler struct {
	store   Store
	auditor audit.Service
}

const provisioningSingletonConflictMessage = "管理 Key 全局单例：已存在一张有效的签发域(agent_provisioning)凭据；请先停用/删除现役管理 Key 后再签发或补授签发域"

func NewHandler(store Store, auditors ...audit.Service) *Handler {
	var auditor audit.Service
	if len(auditors) > 0 {
		auditor = auditors[0]
	}
	return &Handler{store: store, auditor: auditor}
}

func (h *Handler) ListAPIKeys(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	includeDeleted := false
	if raw := r.URL.Query().Get("include_deleted"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "include_deleted must be a boolean")
			return
		}
		includeDeleted = value
	}
	rows, err := h.store.ListAPIKeys(r.Context(), includeDeleted)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	items := make([]APIKeyItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, serializeAPIKey(row))
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) CreateAPIKey(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body APIKeyCreateRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	input, detail := validateAPIKeyCreate(body)
	if detail != "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, detail)
		return
	}
	createdBy := "admin"
	if operator != nil {
		createdBy = *operator
	}
	record, plaintext, err := h.createAPIKey(r, input, createdBy, func(record *APIKey) audit.Entry {
		entry := audit.Entry{
			Action:     "api_key.create",
			TargetType: "agent_api_key",
			TargetID:   int64Pointer(record.ID),
			Operator:   operator,
			AfterJSON:  serializeAPIKey(*record),
		}
		entry.PopulateFromRequest(r)
		return entry
	})
	if err != nil {
		if errors.Is(err, ErrAPIKeyConflict) {
			httpapi.WriteDetail(w, http.StatusConflict, provisioningSingletonConflictMessage)
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	if record == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	item := serializeAPIKey(*record)
	_ = httpapi.WriteJSON(w, http.StatusCreated, APIKeyCreateResponse{
		ID:            item.ID,
		KeyPrefix:     item.KeyPrefix,
		Label:         item.Label,
		Scope:         item.Scope,
		ProjectScope:  item.ProjectScope,
		BusinessScope: item.BusinessScope,
		AgentID:       item.AgentID,
		ItemKey:       item.ItemKey,
		ExpiresAt:     item.ExpiresAt,
		CreatedAt:     item.CreatedAt,
		PlaintextKey:  plaintext,
	})
}

// auditedKeyCreator is implemented by the transactional store. It is optional so
// non-transactional test doubles can still satisfy Store; the production store
// always implements it, which keeps the insert and its audit entry atomic.
type auditedKeyCreator interface {
	CreateAPIKeyWithAudit(
		ctx context.Context,
		input APIKeyCreateInput,
		operator string,
		auditor audit.Service,
		entryFor func(*APIKey) audit.Entry,
	) (*APIKey, string, error)
}

func (h *Handler) createAPIKey(
	r *http.Request,
	input APIKeyCreateInput,
	createdBy string,
	entryFor func(*APIKey) audit.Entry,
) (*APIKey, string, error) {
	if creator, ok := h.store.(auditedKeyCreator); ok {
		return creator.CreateAPIKeyWithAudit(r.Context(), input, createdBy, h.auditor, entryFor)
	}
	// Fallback for stores without transaction support (in-memory test doubles):
	// the audit entry is written after the insert and cannot roll it back.
	record, plaintext, err := h.store.CreateAPIKey(r.Context(), input, createdBy)
	if err != nil || record == nil || h.auditor == nil {
		return record, plaintext, err
	}
	if err := h.auditor.LogAction(r.Context(), entryFor(record)); err != nil {
		return nil, "", err
	}
	return record, plaintext, nil
}

func (h *Handler) UpdateAPIKey(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	id, ok := parseUpdateID(w, chi.URLParam(r, "key_id"))
	if !ok {
		return
	}
	var body APIKeyUpdateRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	input, detail := validateAPIKeyUpdate(body)
	if detail != "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, detail)
		return
	}
	store, ok := h.store.(updateStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	record, err := store.UpdateAPIKey(r.Context(), id, input)
	if err != nil {
		if errors.Is(err, ErrAPIKeyUpdateConflict) {
			httpapi.WriteDetail(w, http.StatusConflict, provisioningSingletonConflictMessage)
			return
		}
		if errors.Is(err, ErrAPIKeyNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "API key not found")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	if record == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "API key not found")
		return
	}
	item := serializeAPIKey(*record)
	if !h.logAction(r, audit.Entry{
		Action:     "api_key.update",
		TargetType: "agent_api_key",
		TargetID:   int64Pointer(id),
		Operator:   operator,
		AfterJSON:  item,
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteAPIKey(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	id, ok := parseID(w, chi.URLParam(r, "key_id"))
	if !ok {
		return
	}
	record, err := h.store.DeleteAPIKey(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if record == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "API key not found")
		return
	}
	item := serializeAPIKey(*record)
	if !h.logAction(r, audit.Entry{
		Action:     "api_key.delete",
		TargetType: "agent_api_key",
		TargetID:   int64Pointer(id),
		Operator:   operator,
		AfterJSON:  item,
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) RevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	h.mutateAPIKeyStatus(w, r, "api_key.revoke")
}

func (h *Handler) DeactivateAPIKey(w http.ResponseWriter, r *http.Request) {
	h.mutateAPIKeyStatus(w, r, "api_key.deactivate")
}

func (h *Handler) mutateAPIKeyStatus(w http.ResponseWriter, r *http.Request, action string) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	id, ok := parseID(w, chi.URLParam(r, "key_id"))
	if !ok {
		return
	}
	store, ok := h.store.(revokeStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	record, err := store.RevokeAPIKey(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if record == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "API key not found")
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     action,
		TargetType: "agent_api_key",
		TargetID:   int64Pointer(id),
		Operator:   operator,
		AfterJSON: map[string]any{
			"id":         record.ID,
			"is_revoked": record.IsRevoked,
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"id":         record.ID,
		"is_revoked": record.IsRevoked,
	})
}

func (h *Handler) ActivateAPIKey(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	id, ok := parseID(w, chi.URLParam(r, "key_id"))
	if !ok {
		return
	}
	store, ok := h.store.(activateStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	record, err := store.ActivateAPIKey(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if record == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "API key not found")
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "api_key.activate",
		TargetType: "agent_api_key",
		TargetID:   int64Pointer(id),
		Operator:   operator,
		AfterJSON: map[string]any{
			"id":         record.ID,
			"is_revoked": record.IsRevoked,
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"id":         record.ID,
		"is_revoked": record.IsRevoked,
	})
}

func (h *Handler) ListUserAPIKeys(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	rows, err := h.store.ListUserAPIKeys(r.Context())
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	items := make([]UserAPIKeyItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, serializeUserAPIKey(row))
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) CreateUserAPIKey(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body UserAPIKeyCreateRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	userID := strings.TrimSpace(body.UserID)
	if userID == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "user_id is required")
		return
	}
	clientID, valid := normalizeClientID(body.ClientID)
	if !valid {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid client_id")
		return
	}
	record, plaintext, err := h.store.CreateUserAPIKey(r.Context(), userID, clientID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if record == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	item := serializeUserAPIKey(*record)
	if !h.logAction(r, audit.Entry{
		Action:     "user_api_key.create",
		TargetType: "user_api_key",
		TargetID:   int64Pointer(record.ID),
		Operator:   operator,
		AfterJSON: map[string]any{
			"user_id":    record.UserID,
			"client_id":  record.ClientID,
			"key_prefix": record.KeyPrefix,
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, UserAPIKeyCreateResponse{
		UserID:       item.UserID,
		ClientID:     item.ClientID,
		KeyPrefix:    item.KeyPrefix,
		PlaintextKey: plaintext,
	})
}

func (h *Handler) DeleteUserAPIKey(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	id, ok := parseID(w, chi.URLParam(r, "key_id"))
	if !ok {
		return
	}
	record, err := h.store.DeleteUserAPIKey(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if record == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User API key not found")
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "user_api_key.revoke",
		TargetType: "user_api_key",
		TargetID:   int64Pointer(id),
		Operator:   operator,
		AfterJSON: map[string]any{
			"user_id":    record.UserID,
			"client_id":  record.ClientID,
			"key_prefix": record.KeyPrefix,
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) RevokeUserAPIKeys(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")
	if strings.TrimSpace(userID) == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "user_id is required")
		return
	}
	var clientID *string
	if values, present := r.URL.Query()["client_id"]; present && len(values) > 0 && values[len(values)-1] != "" {
		value, valid := normalizeProvidedClientID(values[len(values)-1])
		if !valid {
			httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid client_id")
			return
		}
		clientID = &value
	}
	rows, err := h.store.RevokeUserAPIKeys(r.Context(), userID, clientID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if len(rows) == 0 {
		httpapi.WriteDetail(w, http.StatusNotFound, "User API key not found")
		return
	}
	changed := 0
	for _, row := range rows {
		if row.RevokedNow {
			changed++
		}
	}
	if !h.logAction(r, audit.Entry{
		Action:     "user_api_key.revoke",
		TargetType: "user_api_key",
		Operator:   operator,
		AfterJSON: map[string]any{
			"user_id":       userID,
			"client_id":     clientID,
			"revoked_count": changed,
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"user_id":       userID,
		"revoked":       true,
		"client_id":     clientID,
		"revoked_count": changed,
	})
}

func (h *Handler) RotateUserAPIKey(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")
	if strings.TrimSpace(userID) == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "user_id is required")
		return
	}
	var clientID *string
	if values, present := r.URL.Query()["client_id"]; present && len(values) > 0 && values[len(values)-1] != "" {
		value, valid := normalizeProvidedClientID(values[len(values)-1])
		if !valid {
			httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid client_id")
			return
		}
		clientID = &value
	}
	record, plaintext, err := h.store.RotateUserAPIKey(r.Context(), userID, clientID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if record == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User API key not found")
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "user_api_key.rotate",
		TargetType: "user_api_key",
		TargetID:   int64Pointer(record.ID),
		Operator:   operator,
		AfterJSON: map[string]any{
			"user_id":    record.UserID,
			"client_id":  record.ClientID,
			"key_prefix": record.KeyPrefix,
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, UserAPIKeyCreateResponse{
		UserID:       record.UserID,
		ClientID:     record.ClientID,
		KeyPrefix:    record.KeyPrefix,
		PlaintextKey: plaintext,
	})
}

func (h *Handler) logAction(r *http.Request, entry audit.Entry) bool {
	if h.auditor == nil {
		return true
	}
	entry.PopulateFromRequest(r)
	return h.auditor.LogAction(r.Context(), entry) == nil
}

func validateAPIKeyCreate(body APIKeyCreateRequest) (APIKeyCreateInput, string) {
	body.Label = strings.TrimSpace(body.Label)
	if !validTextLength(body.Label, 1, 128) {
		return APIKeyCreateInput{}, "label must be between 1 and 128 characters"
	}
	if body.Scope == "" {
		body.Scope = "read"
	}
	if body.ProjectScope == "" {
		body.ProjectScope = "*"
	}
	if body.BusinessScope == "" {
		body.BusinessScope = "*"
	}
	if !validTextLength(body.Scope, 1, 64) {
		return APIKeyCreateInput{}, "scope must be between 1 and 64 characters"
	}
	if !validTextLength(body.ProjectScope, 1, 255) {
		return APIKeyCreateInput{}, "project_scope must be between 1 and 255 characters"
	}
	if !validTextLength(body.BusinessScope, 1, 255) {
		return APIKeyCreateInput{}, "business_scope must be between 1 and 255 characters"
	}
	if !validOptionalText(body.AgentID, 128) || !validOptionalText(body.ItemKey, 128) {
		return APIKeyCreateInput{}, "agent_id and item_key must be at most 128 characters"
	}
	return APIKeyCreateInput{
		Label:         body.Label,
		Scope:         body.Scope,
		ProjectScope:  body.ProjectScope,
		BusinessScope: body.BusinessScope,
		ExpiresAt:     body.ExpiresAt,
		AgentID:       trimOptional(body.AgentID),
		ItemKey:       trimOptional(body.ItemKey),
	}, ""
}

func validateAPIKeyUpdate(body APIKeyUpdateRequest) (APIKeyUpdateInput, string) {
	if body.Label != nil && !validTextLength(*body.Label, 1, 128) {
		return APIKeyUpdateInput{}, "label must be between 1 and 128 characters"
	}
	if body.ProjectScope != nil && !validTextLength(*body.ProjectScope, 0, 255) {
		return APIKeyUpdateInput{}, "project_scope must be at most 255 characters"
	}
	if body.BusinessScope != nil && !validTextLength(*body.BusinessScope, 0, 255) {
		return APIKeyUpdateInput{}, "business_scope must be at most 255 characters"
	}
	if body.ItemKey != nil && !validTextLength(*body.ItemKey, 0, 128) {
		return APIKeyUpdateInput{}, "item_key must be at most 128 characters"
	}
	return APIKeyUpdateInput{
		Label:         body.Label,
		ProjectScope:  body.ProjectScope,
		BusinessScope: body.BusinessScope,
		ItemKey:       body.ItemKey,
	}, ""
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := decoder.Decode(destination); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON body")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON body")
		return false
	}
	return true
}

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	_, ok := requireAdminOperator(w, r)
	return ok
}

func requireAdminOperator(w http.ResponseWriter, r *http.Request) (*string, bool) {
	user, ok := requestauth.UserContextFromContext(r.Context())
	if !ok || !user.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
		return nil, false
	}
	operator := strings.TrimSpace(user.Operator)
	if operator == "" {
		operator = strings.TrimSpace(user.Name)
	}
	if operator == "" {
		operator = strings.TrimSpace(user.Email)
	}
	if operator == "" {
		return nil, true
	}
	return &operator, true
}

func serializeAPIKey(row APIKey) APIKeyItem {
	return APIKeyItem{
		ID:            row.ID,
		KeyPrefix:     row.KeyPrefix,
		Label:         row.Label,
		Scope:         row.Scope,
		ProjectScope:  row.ProjectScope,
		BusinessScope: row.BusinessScope,
		AgentID:       row.AgentID,
		ItemKey:       row.ItemKey,
		IsRevoked:     row.IsRevoked,
		ExpiresAt:     httpapi.OptionalTimestamp(row.ExpiresAt),
		CreatedAt:     httpapi.Timestamp(row.CreatedAt),
		LastUsedAt:    httpapi.OptionalTimestamp(row.LastUsedAt),
		DeletedAt:     httpapi.OptionalTimestamp(row.DeletedAt),
	}
}

func serializeUserAPIKey(row UserAPIKey) UserAPIKeyItem {
	return UserAPIKeyItem{
		ID:        row.ID,
		UserID:    row.UserID,
		ClientID:  row.ClientID,
		KeyPrefix: row.KeyPrefix,
		RevokedAt: httpapi.OptionalTimestamp(row.RevokedAt),
		CreatedAt: httpapi.OptionalTimestamp(row.CreatedAt),
	}
}

func parseID(w http.ResponseWriter, value string) (int64, bool) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id < 1 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid key id")
		return 0, false
	}
	return id, true
}

func parseUpdateID(w http.ResponseWriter, value string) (int64, bool) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid key id")
		return 0, false
	}
	return id, true
}

func normalizeClientID(value string) (string, bool) {
	if value == "" {
		return "default", true
	}
	if !clientIDPattern.MatchString(value) {
		return "", false
	}
	return value, true
}

func normalizeProvidedClientID(value string) (string, bool) {
	if len(value) > 64 || !clientIDPattern.MatchString(value) {
		return "", false
	}
	return value, true
}

var clientIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

func validTextLength(value string, minLength, maxLength int) bool {
	length := utf8.RuneCountInString(value)
	return length >= minLength && length <= maxLength
}

func validOptionalText(value *string, maxLength int) bool {
	return value == nil || utf8.RuneCountInString(strings.TrimSpace(*value)) <= maxLength
}

func trimOptional(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func int64Pointer(value int64) *string {
	formatted := strconv.FormatInt(value, 10)
	return &formatted
}
