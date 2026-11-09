package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ProjectReader interface {
	GetProject(context.Context, int64) (*projects.ProjectItem, error)
	ListManage(context.Context, string, bool, bool) ([]projects.ProjectItem, error)
}

type AttachmentConfig struct {
	MaxBytes            int64
	AllowedExtensions   map[string]bool
	AllowedContentTypes map[string]bool
}

type Option func(*Handler)

func WithBlobStore(blobs BlobStore) Option {
	return func(handler *Handler) {
		handler.blobs = blobs
	}
}

func WithFileStore(files FileStore) Option {
	return func(handler *Handler) {
		handler.files = files
	}
}

func WithAttachmentConfig(config AttachmentConfig) Option {
	return func(handler *Handler) {
		handler.attachmentConfig = normalizeAttachmentConfig(config)
	}
}

type Handler struct {
	store            Store
	projects         ProjectReader
	blobs            BlobStore
	files            FileStore
	attachmentConfig AttachmentConfig
}

func NewHandler(store Store, projectReader ProjectReader, options ...Option) *Handler {
	handler := &Handler{
		store:            store,
		projects:         projectReader,
		attachmentConfig: normalizeAttachmentConfig(AttachmentConfig{}),
	}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	return handler
}

func (h *Handler) ListTemplates(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireIdentity(w, r); !ok {
		return
	}
	items, err := h.store.ListWorkflowTemplates(r.Context())
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if items == nil {
		items = []TemplateOption{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, TemplatesResponse{Templates: items})
}

func (h *Handler) DashboardSummary(w http.ResponseWriter, r *http.Request) {
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	items, err := h.projects.ListManage(r.Context(), identity.Operator, identity.IsAdmin, false)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if items == nil {
		items = []projects.ProjectItem{}
	}
	projectIDs := make([]int64, 0, len(items))
	for _, item := range items {
		projectIDs = append(projectIDs, item.ID)
	}

	workflowsByProject, err := h.store.ListWorkflowSummaries(r.Context(), projectIDs)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	schedulesByProject, err := h.store.ListProjectSchedules(r.Context(), projectIDs)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	result := SummaryResponse{Projects: make([]ProjectSummary, 0, len(items))}
	for _, project := range items {
		summaryWorkflows := workflowsByProject[project.ID]
		if summaryWorkflows == nil {
			summaryWorkflows = []WorkflowSummary{}
		}
		schedule := schedulesByProject[project.ID]
		result.Projects = append(result.Projects, ProjectSummary{
			ProjectID: project.ID, Workflows: summaryWorkflows,
			ScheduleStart: schedule.ScheduleStart,
			ScheduleEnd:   schedule.ScheduleEnd,
			ScheduleDays:  schedule.ScheduleDays,
		})
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) ListProjectWorkflows(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireProjectAccess(w, r, projectID); !ok {
		return
	}
	items, err := h.store.ListProjectWorkflows(r.Context(), projectID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if items == nil {
		items = []Workflow{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, WorkflowListResponse{
		ProjectID: projectID,
		Workflows: items,
	})
}

func requireIdentity(w http.ResponseWriter, r *http.Request) (auth.UserContext, bool) {
	if identity, ok := auth.UserContextFromContext(r.Context()); ok {
		if identity.UserID != "" || identity.Operator != "" || identity.SessionID != "" ||
			identity.Email != "" || identity.IsAdmin {
			return identity, true
		}
	}
	identity := auth.UserContextFromRequest(r)
	if strings.TrimSpace(identity.UserID) == "" &&
		strings.TrimSpace(identity.Operator) == "" &&
		strings.TrimSpace(identity.SessionID) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "未登录")
		return auth.UserContext{}, false
	}
	return identity, true
}

func requireAdmin(w http.ResponseWriter, r *http.Request) (auth.UserContext, bool) {
	identity, ok := requireIdentity(w, r)
	if !ok {
		return auth.UserContext{}, false
	}
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
		return auth.UserContext{}, false
	}
	return identity, true
}

func (h *Handler) requireProjectAccess(
	w http.ResponseWriter,
	r *http.Request,
	projectID int64,
) (auth.UserContext, bool) {
	identity, ok := requireIdentity(w, r)
	if !ok {
		return auth.UserContext{}, false
	}
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a positive integer")
		return auth.UserContext{}, false
	}
	if h.projects == nil {
		httpapi.WriteInternalServerError(w)
		return auth.UserContext{}, false
	}
	project, err := h.projects.GetProject(r.Context(), projectID)
	if err != nil {
		writeWorkflowError(w, err)
		return auth.UserContext{}, false
	}
	if project == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
		return auth.UserContext{}, false
	}
	if !projects.CanAccessProject(*project, identity.Operator, identity.IsAdmin) {
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
		return auth.UserContext{}, false
	}
	return identity, true
}

func projectPathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	return positivePathID(w, r, "project_id")
}

func positivePathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := chi.URLParam(r, name)
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid "+name)
		return 0, false
	}
	return value, true
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := decoder.Decode(target); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	return true
}

func mutationContext(r *http.Request, identity auth.UserContext) context.Context {
	operator := strings.TrimSpace(identity.Operator)
	var operatorPtr *string
	if operator != "" {
		operatorPtr = &operator
	}
	method, path := r.Method, r.URL.Path
	var traceIDPtr, ipPtr, userAgentPtr *string
	if traceID := strings.TrimSpace(r.Header.Get("X-Request-ID")); traceID != "" {
		traceIDPtr = &traceID
	}
	if address := strings.TrimSpace(r.RemoteAddr); address != "" {
		ipPtr = &address
	}
	if userAgent := strings.TrimSpace(r.UserAgent()); userAgent != "" {
		userAgentPtr = &userAgent
	}
	return WithMutationMeta(r.Context(), MutationMeta{
		Operator:      operatorPtr,
		TraceID:       traceIDPtr,
		RequestMethod: &method,
		RequestPath:   &path,
		IPAddress:     ipPtr,
		UserAgent:     userAgentPtr,
	})
}

func validateKind(kind string) error {
	if !ValidKinds[strings.TrimSpace(kind)] {
		return errors.New("流程类型不合法")
	}
	return nil
}

func validateStatus(status string) error {
	if !ValidStatuses[status] {
		return errors.New("任务状态不合法")
	}
	return nil
}

func validateDuration(days *int) error {
	if days == nil {
		return nil
	}
	if *days < 0 || *days > MaxDurationDays {
		return errors.New("工期天数必须在 0..3650 之间")
	}
	return nil
}

func validateSortOrder(value *int) error {
	if value != nil && *value < 0 {
		return errors.New("sort_order must be greater than or equal to 0")
	}
	return nil
}

func validateDate(value *string) error {
	if value == nil {
		return nil
	}
	if _, err := time.Parse("2006-01-02", *value); err != nil {
		return errors.New("日期格式必须为 YYYY-MM-DD")
	}
	return nil
}

func validateDatePair(start, end *string) error {
	if start == nil || end == nil {
		return nil
	}
	startDate, startErr := time.Parse("2006-01-02", *start)
	endDate, endErr := time.Parse("2006-01-02", *end)
	if startErr != nil || endErr != nil {
		return errors.New("日期格式必须为 YYYY-MM-DD")
	}
	if endDate.Before(startDate) {
		return errors.New("结束日期不能早于开始日期")
	}
	return nil
}

func validateAttachmentKey(value *string) error {
	if err := ValidateAttachmentKey(value); err != nil {
		return err
	}
	return nil
}

func normalizeOptionalText(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func validateOrderIDs(ids []int64) error {
	if len(ids) == 0 {
		return errors.New("排序列表不能为空")
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 || seen[id] {
			return errors.New("排序列表包含非法或重复节点")
		}
		seen[id] = true
	}
	return nil
}

func writeWorkflowError(w http.ResponseWriter, err error) {
	if apiStatus, apiDetail := projects.HTTPError(err); apiStatus != http.StatusInternalServerError {
		httpapi.WriteDetail(w, apiStatus, apiDetail)
		return
	}
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}

func writeValidationError(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
}

func writeNotFound(w http.ResponseWriter, detail string) {
	httpapi.WriteDetail(w, http.StatusNotFound, detail)
}

func writeWorkflowJSON(w http.ResponseWriter, status int, value any) error {
	return httpapi.WriteJSON(w, status, value)
}

func httpapiInternalServerError(w http.ResponseWriter) {
	httpapi.WriteInternalServerError(w)
}

func httpapiForbiddenAdmin(w http.ResponseWriter) {
	httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
}

func httpapiStorageUnavailable(w http.ResponseWriter) {
	httpapi.WriteDetail(
		w,
		http.StatusServiceUnavailable,
		"Cloud storage is not configured. Please contact administrator.",
	)
}

func stringsError(value string) error {
	return errors.New(value)
}

func fmtInt64(value int64) string {
	return strconv.FormatInt(value, 10)
}

func deleteBlobs(r *http.Request, blobs BlobStore, keys []string) {
	if blobs == nil {
		return
	}
	for _, key := range keys {
		_ = blobs.Delete(r.Context(), key)
	}
}
