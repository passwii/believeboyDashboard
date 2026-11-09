package workflows

import (
	"net/http"
	"strings"
	"unicode/utf8"
)

func (h *Handler) CreateWorkflow(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	identity, ok := h.requireProjectAccess(w, r, projectID)
	if !ok {
		return
	}
	var request WorkflowCreateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	request.Kind = strings.TrimSpace(request.Kind)
	request.TemplateKey = strings.TrimSpace(request.TemplateKey)
	if err := validateKind(request.Kind); err != nil {
		writeValidationError(w, err)
		return
	}
	if request.TemplateKey == "" || utf8.RuneCountInString(request.TemplateKey) > 80 {
		writeValidationError(w, stringsError("template_key must contain 1 to 80 characters"))
		return
	}
	if request.Title != nil {
		title := strings.TrimSpace(*request.Title)
		if utf8.RuneCountInString(title) > 160 {
			writeValidationError(w, stringsError("title must contain at most 160 characters"))
			return
		}
		request.Title = &title
	}
	if err := validateDate(request.StartDate); err != nil {
		writeValidationError(w, err)
		return
	}
	workflow, err := h.store.CreateWorkflow(
		mutationContext(r, identity),
		projectID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if workflow == nil {
		httpapiInternalServerError(w)
		return
	}
	FinalizeWorkflow(workflow)
	_ = writeWorkflowJSON(w, http.StatusOK, workflow)
}

func (h *Handler) UpdateWorkflowDefinition(w http.ResponseWriter, r *http.Request) {
	workflowID, ok := positivePathID(w, r, "workflow_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	if !identity.IsAdmin {
		httpapiForbiddenAdmin(w)
		return
	}
	current, err := h.store.GetWorkflow(r.Context(), workflowID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if current == nil {
		writeNotFound(w, "流程不存在")
		return
	}
	if _, ok := h.requireProjectAccess(w, r, current.ProjectID); !ok {
		return
	}
	var request WorkflowDefinitionUpdateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Title != nil {
		title := strings.TrimSpace(*request.Title)
		if title == "" {
			writeValidationError(w, stringsError("流程标题不能为空"))
			return
		}
		if utf8.RuneCountInString(title) > 160 {
			writeValidationError(w, stringsError("title must contain at most 160 characters"))
			return
		}
		request.Title = &title
	}
	if request.StartDate.Present {
		if err := validateDate(request.StartDate.Value); err != nil {
			writeValidationError(w, err)
			return
		}
	}
	updated, err := h.store.UpdateWorkflowDefinition(
		mutationContext(r, identity),
		workflowID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if updated == nil {
		writeNotFound(w, "流程不存在")
		return
	}
	FinalizeWorkflow(updated)
	_ = writeWorkflowJSON(w, http.StatusOK, updated)
}

func (h *Handler) UpdateTaskStatus(w http.ResponseWriter, r *http.Request) {
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	projectID, err := h.store.GetTaskProject(r.Context(), taskID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if projectID == 0 {
		writeNotFound(w, "任务不存在")
		return
	}
	if _, ok := h.requireProjectAccess(w, r, projectID); !ok {
		return
	}
	var request TaskStatusUpdateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	request.Status = strings.TrimSpace(request.Status)
	if err := validateStatus(request.Status); err != nil {
		writeValidationError(w, err)
		return
	}
	updated, err := h.store.UpdateTaskStatus(
		mutationContext(r, identity),
		taskID,
		request.Status,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if updated == nil {
		writeNotFound(w, "任务不存在")
		return
	}
	FinalizeWorkflow(updated)
	_ = writeWorkflowJSON(w, http.StatusOK, updated)
}

func (h *Handler) CreateProjectTask(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	workflowID, ok := positivePathID(w, r, "workflow_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	if !identity.IsAdmin {
		httpapiForbiddenAdmin(w)
		return
	}
	identity, ok = h.requireProjectAccess(w, r, projectID)
	if !ok {
		return
	}
	var request TaskCreateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	request.Title = strings.TrimSpace(request.Title)
	if request.Title == "" || utf8.RuneCountInString(request.Title) > 160 {
		writeValidationError(w, stringsError("节点标题必须为 1..160 个字符"))
		return
	}
	if err := validateAttachmentKey(request.AttachmentKey); err != nil {
		writeValidationError(w, err)
		return
	}
	request.AttachmentKey = normalizeOptionalText(request.AttachmentKey)
	if err := validateDuration(request.DurationDays); err != nil {
		writeValidationError(w, err)
		return
	}
	if err := validateSortOrder(request.SortOrder); err != nil {
		writeValidationError(w, err)
		return
	}
	updated, err := h.store.CreateProjectTask(
		mutationContext(r, identity),
		projectID,
		workflowID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if updated == nil {
		writeNotFound(w, "流程不存在")
		return
	}
	FinalizeWorkflow(updated)
	_ = writeWorkflowJSON(w, http.StatusOK, updated)
}

func (h *Handler) UpdateProjectTaskDefinition(w http.ResponseWriter, r *http.Request) {
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	if !identity.IsAdmin {
		httpapiForbiddenAdmin(w)
		return
	}
	projectID, err := h.store.GetTaskProject(r.Context(), taskID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if projectID == 0 {
		writeNotFound(w, "任务不存在")
		return
	}
	if _, ok := h.requireProjectAccess(w, r, projectID); !ok {
		return
	}
	var request TaskDefinitionUpdateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Title != nil {
		title := strings.TrimSpace(*request.Title)
		if title == "" || utf8.RuneCountInString(title) > 160 {
			writeValidationError(w, stringsError("节点标题必须为 1..160 个字符"))
			return
		}
		request.Title = &title
	}
	if request.AttachmentKey.Present {
		if err := validateAttachmentKey(request.AttachmentKey.Value); err != nil {
			writeValidationError(w, err)
			return
		}
		request.AttachmentKey.Value = normalizeOptionalText(request.AttachmentKey.Value)
	}
	if request.DurationDays.Present {
		if err := validateDuration(request.DurationDays.Value); err != nil {
			writeValidationError(w, err)
			return
		}
	}
	if request.StartDate.Present {
		if err := validateDate(request.StartDate.Value); err != nil {
			writeValidationError(w, err)
			return
		}
	}
	if request.EndDate.Present {
		if err := validateDate(request.EndDate.Value); err != nil {
			writeValidationError(w, err)
			return
		}
	}
	if request.StartDate.Present && request.EndDate.Present {
		if err := validateDatePair(request.StartDate.Value, request.EndDate.Value); err != nil {
			writeValidationError(w, err)
			return
		}
	}
	updated, err := h.store.UpdateProjectTaskDefinition(
		mutationContext(r, identity),
		taskID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if updated == nil {
		writeNotFound(w, "任务不存在")
		return
	}
	FinalizeWorkflow(updated)
	_ = writeWorkflowJSON(w, http.StatusOK, updated)
}

func (h *Handler) DeleteProjectTask(w http.ResponseWriter, r *http.Request) {
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	if !identity.IsAdmin {
		httpapiForbiddenAdmin(w)
		return
	}
	if h.blobs == nil {
		httpapiStorageUnavailable(w)
		return
	}
	projectID, err := h.store.GetTaskProject(r.Context(), taskID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if projectID == 0 {
		writeNotFound(w, "任务不存在")
		return
	}
	if _, ok := h.requireProjectAccess(w, r, projectID); !ok {
		return
	}
	mutation, err := h.store.DeleteProjectTask(mutationContext(r, identity), taskID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if mutation.Workflow == nil {
		writeNotFound(w, "任务不存在")
		return
	}
	deleteBlobs(r, h.blobs, mutation.DeleteKeys)
	FinalizeWorkflow(mutation.Workflow)
	_ = writeWorkflowJSON(w, http.StatusOK, mutation.Workflow)
}

func (h *Handler) ReorderProjectTasks(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	workflowID, ok := positivePathID(w, r, "workflow_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	if !identity.IsAdmin {
		httpapiForbiddenAdmin(w)
		return
	}
	identity, ok = h.requireProjectAccess(w, r, projectID)
	if !ok {
		return
	}
	var request TaskOrderRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if err := validateOrderIDs(request.TaskIDs); err != nil {
		writeValidationError(w, err)
		return
	}
	updated, err := h.store.ReorderProjectTasks(
		mutationContext(r, identity),
		projectID,
		workflowID,
		request.TaskIDs,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if updated == nil {
		writeNotFound(w, "流程不存在")
		return
	}
	FinalizeWorkflow(updated)
	_ = writeWorkflowJSON(w, http.StatusOK, updated)
}

func (h *Handler) CreateProjectContent(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	if !identity.IsAdmin {
		httpapiForbiddenAdmin(w)
		return
	}
	identity, ok = h.requireProjectAccess(w, r, projectID)
	if !ok {
		return
	}
	var request ContentCreateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if strings.TrimSpace(request.Body) == "" {
		writeValidationError(w, stringsError("内容正文不能为空"))
		return
	}
	if request.Title != nil && utf8.RuneCountInString(strings.TrimSpace(*request.Title)) > 160 {
		writeValidationError(w, stringsError("title must contain at most 160 characters"))
		return
	}
	request.Title = normalizeOptionalText(request.Title)
	if err := validateSortOrder(request.SortOrder); err != nil {
		writeValidationError(w, err)
		return
	}
	updated, err := h.store.CreateProjectContent(
		mutationContext(r, identity),
		projectID,
		taskID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if updated == nil {
		writeNotFound(w, "任务不存在")
		return
	}
	FinalizeWorkflow(updated)
	_ = writeWorkflowJSON(w, http.StatusOK, updated)
}

func (h *Handler) UpdateProjectContent(w http.ResponseWriter, r *http.Request) {
	contentID, ok := positivePathID(w, r, "content_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	if !identity.IsAdmin {
		httpapiForbiddenAdmin(w)
		return
	}
	projectID, err := h.store.GetContentProject(r.Context(), contentID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if projectID == 0 {
		writeNotFound(w, "内容不存在")
		return
	}
	if _, ok := h.requireProjectAccess(w, r, projectID); !ok {
		return
	}
	var request ContentUpdateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Body != nil && strings.TrimSpace(*request.Body) == "" {
		writeValidationError(w, stringsError("内容正文不能为空"))
		return
	}
	if request.Title.Present && request.Title.Value != nil &&
		utf8.RuneCountInString(strings.TrimSpace(*request.Title.Value)) > 160 {
		writeValidationError(w, stringsError("title must contain at most 160 characters"))
		return
	}
	if request.Title.Present {
		request.Title.Value = normalizeOptionalText(request.Title.Value)
	}
	updated, err := h.store.UpdateProjectContent(
		mutationContext(r, identity),
		contentID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if updated == nil {
		writeNotFound(w, "内容不存在")
		return
	}
	FinalizeWorkflow(updated)
	_ = writeWorkflowJSON(w, http.StatusOK, updated)
}

func (h *Handler) DeleteProjectContent(w http.ResponseWriter, r *http.Request) {
	contentID, ok := positivePathID(w, r, "content_id")
	if !ok {
		return
	}
	identity, ok := requireIdentity(w, r)
	if !ok {
		return
	}
	if !identity.IsAdmin {
		httpapiForbiddenAdmin(w)
		return
	}
	projectID, err := h.store.GetContentProject(r.Context(), contentID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if projectID == 0 {
		writeNotFound(w, "内容不存在")
		return
	}
	if _, ok := h.requireProjectAccess(w, r, projectID); !ok {
		return
	}
	updated, err := h.store.DeleteProjectContent(
		mutationContext(r, identity),
		contentID,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if updated == nil {
		writeNotFound(w, "内容不存在")
		return
	}
	FinalizeWorkflow(updated)
	_ = writeWorkflowJSON(w, http.StatusOK, updated)
}
