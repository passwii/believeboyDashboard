package users

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Store interface {
	List(ctx context.Context, page, pageSize int) ([]User, int, error)
	GetByID(ctx context.Context, userID string) (*User, error)
	Create(ctx context.Context, input CreateInput) (*User, error)
	Update(ctx context.Context, userID string, input UpdateInput) (*User, error)
	Deactivate(ctx context.Context, userID string) (*User, error)
}

type Handler struct {
	store          Store
	auditor        audit.Service
	sessionRevoker SessionRevoker
}

type Option func(*Handler)

func WithAuditor(auditor audit.Service) Option {
	return func(handler *Handler) {
		handler.auditor = auditor
	}
}

func WithSessionRevoker(revoker SessionRevoker) Option {
	return func(handler *Handler) {
		handler.sessionRevoker = revoker
	}
}

func NewHandlerWithOptions(store Store, options ...Option) *Handler {
	handler := &Handler{store: store}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	return handler
}

func NewHandler(store Store, auditors ...audit.Service) *Handler {
	options := make([]Option, 0, len(auditors))
	if len(auditors) > 0 {
		options = append(options, WithAuditor(auditors[0]))
	}
	return NewHandlerWithOptions(store, options...)
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	pagination := httpapi.ParsePagination(r, 20, 200)
	items, _, err := h.store.List(r.Context(), pagination.Page, pagination.PageSize)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	responseItems := make([]UserItem, 0, len(items))
	for _, item := range items {
		responseItems = append(responseItems, serializeUser(item))
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ListResponse{Items: responseItems})
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body createUserRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	input, detail := validateCreate(body)
	if detail != "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, detail)
		return
	}

	created, err := h.store.Create(r.Context(), input)
	if err != nil {
		if isDuplicate(err) {
			httpapi.WriteDetail(w, http.StatusConflict, "邮箱已存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	if created == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	item := serializeUser(*created)
	if !h.logAction(r, audit.Entry{
		Action:     "users.create",
		TargetType: "user_account",
		TargetID:   stringPointer(created.ID),
		Operator:   operator,
		AfterJSON:  item,
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, ItemResponse{Item: item})
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")
	if userID == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "user_id is required")
		return
	}
	before, err := h.store.GetByID(r.Context(), userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "用户不存在")
		return
	}

	var body updateUserRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	input, detail := validateUpdate(body)
	if detail != "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, detail)
		return
	}
	if input.RoleType != nil {
		isAdmin := *input.RoleType == "admin"
		input.IsAdmin = &isAdmin
	}

	updated, err := h.store.Update(r.Context(), userID, input)
	if err != nil {
		if isDuplicate(err) {
			httpapi.WriteDetail(w, http.StatusConflict, "邮箱已存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "用户不存在")
		return
	}
	item := serializeUser(*updated)
	if !h.logAction(r, audit.Entry{
		Action:     "users.update",
		TargetType: "user_account",
		TargetID:   stringPointer(userID),
		Operator:   operator,
		BeforeJSON: serializeUser(*before),
		AfterJSON:  item,
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ItemResponse{Item: item})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")
	if userID == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "user_id is required")
		return
	}
	before, err := h.store.GetByID(r.Context(), userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "用户不存在")
		return
	}
	if strings.EqualFold(before.Name, "yawei") || strings.HasPrefix(strings.ToLower(before.Email), "yawei@") {
		httpapi.WriteDetail(w, http.StatusForbidden, "Yawei 账号不允许删除")
		return
	}

	deactivated, err := h.store.Deactivate(r.Context(), userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if deactivated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "用户不存在")
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "users.delete",
		TargetType: "user_account",
		TargetID:   stringPointer(userID),
		Operator:   operator,
		BeforeJSON: serializeUser(*before),
		AfterJSON:  serializeUser(*deactivated),
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) logAction(r *http.Request, entry audit.Entry) bool {
	if h.auditor == nil {
		return true
	}
	entry.PopulateFromRequest(r)
	return h.auditor.LogAction(r.Context(), entry) == nil
}

type createUserRequest struct {
	Name     string  `json:"name"`
	Email    string  `json:"email"`
	FullName *string `json:"full_name"`
	Password string  `json:"password"`
	IsAdmin  bool    `json:"is_admin"`
	RoleType string  `json:"role_type"`
}

type updateUserRequest struct {
	Name     *string `json:"name"`
	FullName *string `json:"full_name"`
	IsAdmin  *bool   `json:"is_admin"`
	IsActive *bool   `json:"is_active"`
	RoleType *string `json:"role_type"`
	Password *string `json:"password"`
}

func validateCreate(body createUserRequest) (CreateInput, string) {
	body.Name = strings.TrimSpace(body.Name)
	body.Email = strings.ToLower(strings.TrimSpace(body.Email))
	if !validTextLength(body.Name, 1, 255) {
		return CreateInput{}, "name must be between 1 and 255 characters"
	}
	if !validEmail(body.Email) {
		return CreateInput{}, "email must be a valid email address"
	}
	if !validTextLength(body.Password, 8, 128) {
		return CreateInput{}, "password must be between 8 and 128 characters"
	}
	fullName, detail := normalizeOptionalText(body.FullName, 255, "full_name")
	if detail != "" {
		return CreateInput{}, detail
	}
	roleType := strings.TrimSpace(body.RoleType)
	if roleType == "" {
		roleType = "operator"
	}
	if !validRole(roleType) {
		return CreateInput{}, "role_type must be admin or operator"
	}
	return CreateInput{
		Name:     body.Name,
		Email:    body.Email,
		FullName: fullName,
		Password: body.Password,
		IsAdmin:  body.IsAdmin,
		RoleType: roleType,
	}, ""
}

func validateUpdate(body updateUserRequest) (UpdateInput, string) {
	var input UpdateInput
	if body.Name != nil {
		value := strings.TrimSpace(*body.Name)
		if !validTextLength(value, 1, 255) {
			return input, "name must be between 1 and 255 characters"
		}
		input.Name = &value
	}
	if body.FullName != nil {
		value, detail := normalizeOptionalText(body.FullName, 255, "full_name")
		if detail != "" {
			return input, detail
		}
		input.FullName = value
	}
	if body.RoleType != nil {
		value := strings.TrimSpace(*body.RoleType)
		if !validRole(value) {
			return input, "role_type must be admin or operator"
		}
		input.RoleType = &value
	}
	if body.Password != nil {
		if !validTextLength(*body.Password, 8, 128) {
			return input, "password must be between 8 and 128 characters"
		}
		input.Password = body.Password
	}
	input.IsAdmin = body.IsAdmin
	input.IsActive = body.IsActive
	return input, ""
}

func normalizeOptionalText(value *string, maxLength int, field string) (*string, string) {
	if value == nil {
		return nil, ""
	}
	normalized := strings.TrimSpace(*value)
	if utf8.RuneCountInString(normalized) > maxLength {
		return nil, field + " must be at most " + strconv.Itoa(maxLength) + " characters"
	}
	return &normalized, ""
}

func validTextLength(value string, minLength, maxLength int) bool {
	length := utf8.RuneCountInString(value)
	return length >= minLength && length <= maxLength
}

func validEmail(value string) bool {
	if !validTextLength(value, 3, 255) {
		return false
	}
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && strings.Contains(value, "@")
}

func validRole(value string) bool {
	switch value {
	case "admin", "operator", "businessdev":
		return true
	default:
		return false
	}
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

func isDuplicate(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "duplicate key")
}

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	_, ok := requireAdminOperator(w, r)
	return ok
}

func requireAdminOperator(w http.ResponseWriter, r *http.Request) (*string, bool) {
	user, ok := auth.UserContextFromContext(r.Context())
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

func serializeUser(user User) UserItem {
	role := user.RoleType
	if role == "" {
		if user.IsAdmin {
			role = "admin"
		} else {
			role = "operator"
		}
	}
	return UserItem{
		ID:        user.ID,
		Name:      user.Name,
		Email:     user.Email,
		FullName:  user.FullName,
		IsAdmin:   user.IsAdmin,
		IsActive:  user.IsActive,
		RoleType:  role,
		CreatedAt: httpapi.Timestamp(user.CreatedAt),
		UpdatedAt: httpapi.Timestamp(user.UpdatedAt),
	}
}

func stringPointer(value string) *string {
	return &value
}
