package workflows

import (
	"net/http"
	"strings"
	"unicode/utf8"
)

func (h *Handler) ListAdminTemplates(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	items, err := h.store.ListWorkflowTemplateRows(r.Context())
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if items == nil {
		items = []TemplateListItem{}
	}
	_ = writeWorkflowJSON(w, http.StatusOK, TemplateListResponse{Templates: items})
}

func (h *Handler) GetAdminTemplate(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	templateID, ok := positivePathID(w, r, "template_id")
	if !ok {
		return
	}
	item, err := h.store.GetWorkflowTemplate(r.Context(), templateID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "模板不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) CreateAdminTemplate(w http.ResponseWriter, r *http.Request) {
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	var request TemplateCreateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	request.Kind = strings.TrimSpace(request.Kind)
	request.Title = strings.TrimSpace(request.Title)
	if err := validateKind(request.Kind); err != nil {
		writeValidationError(w, err)
		return
	}
	if request.Title == "" || utf8.RuneCountInString(request.Title) > 160 {
		writeValidationError(w, stringsError("模板标题必须为 1..160 个字符"))
		return
	}
	if request.Key != nil {
		key := strings.TrimSpace(*request.Key)
		if utf8.RuneCountInString(key) > 80 {
			writeValidationError(w, stringsError("模板键不能超过 80 个字符"))
			return
		}
		request.Key = &key
	}
	if err := validateSortOrder(request.SortOrder); err != nil {
		writeValidationError(w, err)
		return
	}
	item, err := h.store.CreateWorkflowTemplate(
		mutationContext(r, identity),
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		httpapiInternalServerError(w)
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) UpdateAdminTemplate(w http.ResponseWriter, r *http.Request) {
	templateID, ok := positivePathID(w, r, "template_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	var request TemplateUpdateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Title != nil {
		title := strings.TrimSpace(*request.Title)
		if title == "" || utf8.RuneCountInString(title) > 160 {
			writeValidationError(w, stringsError("模板标题必须为 1..160 个字符"))
			return
		}
		request.Title = &title
	}
	if err := validateSortOrder(request.SortOrder); err != nil {
		writeValidationError(w, err)
		return
	}
	item, err := h.store.UpdateWorkflowTemplate(
		mutationContext(r, identity),
		templateID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "模板不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteAdminTemplate(w http.ResponseWriter, r *http.Request) {
	templateID, ok := positivePathID(w, r, "template_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapiStorageUnavailable(w)
		return
	}
	mutation, err := h.store.DeleteWorkflowTemplate(
		mutationContext(r, identity),
		templateID,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if mutation.Template == nil {
		writeNotFound(w, "模板不存在")
		return
	}
	deleteBlobs(r, h.blobs, mutation.DeleteKeys)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) CopyAdminTemplate(w http.ResponseWriter, r *http.Request) {
	templateID, ok := positivePathID(w, r, "template_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	var request TemplateCopyRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Title != nil && utf8.RuneCountInString(strings.TrimSpace(*request.Title)) > 160 {
		writeValidationError(w, stringsError("title must contain at most 160 characters"))
		return
	}
	if request.Key != nil {
		key := strings.TrimSpace(*request.Key)
		if utf8.RuneCountInString(key) > 80 {
			writeValidationError(w, stringsError("模板键不能超过 80 个字符"))
			return
		}
		request.Key = &key
	}
	item, err := h.store.CopyWorkflowTemplate(
		mutationContext(r, identity),
		templateID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "模板不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) CreateAdminTemplateTask(w http.ResponseWriter, r *http.Request) {
	templateID, ok := positivePathID(w, r, "template_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	var request TemplateTaskCreateRequest
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
	item, err := h.store.CreateTemplateTask(
		mutationContext(r, identity),
		templateID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "模板不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) UpdateAdminTemplateTask(w http.ResponseWriter, r *http.Request) {
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	var request TemplateTaskUpdateRequest
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
	item, err := h.store.UpdateTemplateTask(
		mutationContext(r, identity),
		taskID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "节点不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteAdminTemplateTask(w http.ResponseWriter, r *http.Request) {
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapiStorageUnavailable(w)
		return
	}
	mutation, err := h.store.DeleteTemplateTask(
		mutationContext(r, identity),
		taskID,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if mutation.Template == nil {
		writeNotFound(w, "节点不存在")
		return
	}
	deleteBlobs(r, h.blobs, mutation.DeleteKeys)
	_ = writeWorkflowJSON(w, http.StatusOK, mutation.Template)
}

func (h *Handler) ReorderAdminTemplateTasks(w http.ResponseWriter, r *http.Request) {
	templateID, ok := positivePathID(w, r, "template_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
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
	item, err := h.store.ReorderTemplateTasks(
		mutationContext(r, identity),
		templateID,
		request.TaskIDs,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "模板不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) CreateAdminTemplateContent(w http.ResponseWriter, r *http.Request) {
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	var request TemplateContentCreateRequest
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
	item, err := h.store.CreateTemplateContent(
		mutationContext(r, identity),
		taskID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "节点不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) UpdateAdminTemplateContent(w http.ResponseWriter, r *http.Request) {
	contentID, ok := positivePathID(w, r, "content_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	var request TemplateContentUpdateRequest
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
	item, err := h.store.UpdateTemplateContent(
		mutationContext(r, identity),
		contentID,
		request,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "内容不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteAdminTemplateContent(w http.ResponseWriter, r *http.Request) {
	contentID, ok := positivePathID(w, r, "content_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	item, err := h.store.DeleteTemplateContent(
		mutationContext(r, identity),
		contentID,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		writeNotFound(w, "内容不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) UploadAdminTemplateAttachment(w http.ResponseWriter, r *http.Request) {
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapiStorageUnavailable(w)
		return
	}
	attachment, data, ok := h.readAttachmentUpload(w, r)
	if !ok {
		return
	}
	objectName, err := randomObjectName(attachment.Filename)
	if err != nil {
		httpapiInternalServerError(w)
		return
	}
	key := "project-launch-templates/template-task-" +
		fmtInt64(taskID) + "/" + objectName
	if _, err := h.blobs.Put(r.Context(), key, data, attachment.ContentType); err != nil {
		httpapiStorageUnavailable(w)
		return
	}
	attachment.R2Key = key
	attachment.Uploader = normalizeOptionalText(&identity.Operator)
	attachment.Origin = "upload"
	item, err := h.store.InsertTemplateAttachment(
		mutationContext(r, identity),
		taskID,
		attachment,
	)
	if err != nil {
		_ = h.blobs.Delete(r.Context(), key)
		writeWorkflowError(w, err)
		return
	}
	if item == nil {
		_ = h.blobs.Delete(r.Context(), key)
		writeNotFound(w, "节点不存在")
		return
	}
	_ = writeWorkflowJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteAdminTemplateAttachment(w http.ResponseWriter, r *http.Request) {
	attachmentID, ok := positivePathID(w, r, "attachment_id")
	if !ok {
		return
	}
	identity, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapiStorageUnavailable(w)
		return
	}
	mutation, err := h.store.DeleteTemplateAttachment(
		mutationContext(r, identity),
		attachmentID,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if mutation.Template == nil {
		writeNotFound(w, "附件不存在")
		return
	}
	deleteBlobs(r, h.blobs, mutation.DeleteKeys)
	_ = writeWorkflowJSON(w, http.StatusOK, mutation.Template)
}
