package workflows

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const defaultAttachmentMaxBytes = 50 * 1024 * 1024

type documentOption struct {
	Filename    string
	ContentType string
}

var allowedDocuments = map[string]documentOption{
	DocumentKeyAmazonRegistrationForm: {
		Filename:    "亚马逊_注册信息收集表.xlsx",
		ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	},
	DocumentKeyWorldFirstRegistration: {
		Filename:    "万里汇海外收款注册流程.pdf",
		ContentType: "application/pdf",
	},
}

func normalizeAttachmentConfig(config AttachmentConfig) AttachmentConfig {
	if config.MaxBytes <= 0 {
		config.MaxBytes = defaultAttachmentMaxBytes
	}
	if len(config.AllowedExtensions) == 0 {
		config.AllowedExtensions = map[string]bool{
			".pdf": true, ".xlsx": true, ".xls": true, ".docx": true,
			".doc": true, ".csv": true, ".txt": true, ".zip": true,
			".png": true, ".jpg": true, ".jpeg": true, ".webp": true,
		}
	}
	if len(config.AllowedContentTypes) == 0 {
		config.AllowedContentTypes = map[string]bool{
			"text/plain": true, "text/csv": true, "application/csv": true,
			"application/vnd.ms-excel": true,
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
			"application/pdf": true, "application/octet-stream": true,
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
			"application/msword": true, "application/zip": true,
			"application/x-zip-compressed": true, "image/png": true,
			"image/jpeg": true, "image/webp": true,
		}
	}
	return config
}

func (h *Handler) UploadProjectAttachment(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	taskID, ok := positivePathID(w, r, "task_id")
	if !ok {
		return
	}
	identity, ok := h.requireProjectAccess(w, r, projectID)
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
	key := fmt.Sprintf(
		"project-launch-%d/task-%d/%s",
		projectID,
		taskID,
		objectName,
	)
	if _, err := h.blobs.Put(r.Context(), key, data, attachment.ContentType); err != nil {
		httpapiStorageUnavailable(w)
		return
	}
	attachment.R2Key = key
	attachment.Uploader = normalizeOptionalText(&identity.Operator)
	attachment.Origin = "upload"
	workflow, err := h.store.InsertProjectAttachment(
		mutationContext(r, identity),
		projectID,
		taskID,
		attachment,
	)
	if err != nil {
		_ = h.blobs.Delete(r.Context(), key)
		writeWorkflowError(w, err)
		return
	}
	if workflow == nil {
		_ = h.blobs.Delete(r.Context(), key)
		writeNotFound(w, "任务不存在")
		return
	}
	FinalizeWorkflow(workflow)
	_ = writeWorkflowJSON(w, http.StatusOK, workflow)
}

func (h *Handler) DownloadProjectAttachment(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	attachmentID, ok := positivePathID(w, r, "attachment_id")
	if !ok {
		return
	}
	if _, ok := h.requireProjectAccess(w, r, projectID); !ok {
		return
	}
	if h.blobs == nil {
		httpapiStorageUnavailable(w)
		return
	}
	attachment, err := h.store.GetAttachmentForDownload(
		r.Context(),
		projectID,
		attachmentID,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if attachment == nil {
		writeNotFound(w, "附件不存在")
		return
	}
	if !validProjectAttachmentKey(projectID, attachment.TaskID, attachment.R2Key) {
		writeNotFound(w, "附件不存在")
		return
	}
	reader, err := h.blobs.Get(r.Context(), attachment.R2Key)
	if err != nil {
		if errors.Is(err, ErrBlobNotFound) || errors.Is(err, os.ErrNotExist) {
			writeNotFound(w, "附件不存在")
			return
		}
		httpapiStorageUnavailable(w)
		return
	}
	defer reader.Close()

	w.Header().Set("Content-Type", attachment.ContentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", attachment.FileSize))
	w.Header().Set(
		"Content-Disposition",
		"attachment; filename=\"attachment\"; filename*=utf-8''"+
			url.PathEscape(attachment.Filename),
	)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

func (h *Handler) DeleteProjectAttachment(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	attachmentID, ok := positivePathID(w, r, "attachment_id")
	if !ok {
		return
	}
	identity, ok := h.requireProjectAccess(w, r, projectID)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapiStorageUnavailable(w)
		return
	}
	mutation, err := h.store.DeleteProjectAttachment(
		mutationContext(r, identity),
		projectID,
		attachmentID,
	)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if mutation.Workflow == nil {
		writeNotFound(w, "附件不存在")
		return
	}
	deleteBlobs(r, h.blobs, mutation.DeleteKeys)
	FinalizeWorkflow(mutation.Workflow)
	_ = writeWorkflowJSON(w, http.StatusOK, mutation.Workflow)
}

func (h *Handler) DownloadProjectDocument(w http.ResponseWriter, r *http.Request) {
	projectID, ok := projectPathID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireProjectAccess(w, r, projectID); !ok {
		return
	}
	key := strings.TrimSpace(chi.URLParam(r, "document_key"))
	document, found := allowedDocuments[key]
	if !found {
		writeNotFound(w, "文档不存在")
		return
	}
	if h.files == nil {
		httpapi.WriteDetail(
			w,
			http.StatusServiceUnavailable,
			"Document storage is not configured. Please contact administrator.",
		)
		return
	}
	reader, err := h.files.OpenDocument(r.Context(), key)
	if err != nil {
		if errors.Is(err, ErrDocumentNotFound) || errors.Is(err, os.ErrNotExist) {
			writeNotFound(w, "文档不存在")
			return
		}
		httpapi.WriteDetail(
			w,
			http.StatusServiceUnavailable,
			"Document storage is not configured. Please contact administrator.",
		)
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", document.ContentType)
	w.Header().Set(
		"Content-Disposition",
		"attachment; filename=\"attachment\"; filename*=utf-8''"+
			url.PathEscape(document.Filename),
	)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

func (h *Handler) readAttachmentUpload(
	w http.ResponseWriter,
	r *http.Request,
) (AttachmentUpload, []byte, bool) {
	limit := h.attachmentConfig.MaxBytes + 2*1024*1024
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseMultipartForm(h.attachmentConfig.MaxBytes); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "File too large")
			return AttachmentUpload{}, nil, false
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid multipart form")
		return AttachmentUpload{}, nil, false
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file in multipart form")
		return AttachmentUpload{}, nil, false
	}
	defer file.Close()
	if header == nil || strings.TrimSpace(header.Filename) == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing filename")
		return AttachmentUpload{}, nil, false
	}
	ext := strings.ToLower(filepath.Ext(filepath.Base(header.Filename)))
	if !h.attachmentConfig.AllowedExtensions[ext] {
		httpapi.WriteDetail(
			w,
			http.StatusBadRequest,
			"Unsupported extension: "+ext,
		)
		return AttachmentUpload{}, nil, false
	}
	contentType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if !h.attachmentConfig.AllowedContentTypes[contentType] {
		httpapi.WriteDetail(
			w,
			http.StatusBadRequest,
			"Unsupported MIME type: "+contentType,
		)
		return AttachmentUpload{}, nil, false
	}
	data, err := io.ReadAll(io.LimitReader(file, h.attachmentConfig.MaxBytes+1))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		return AttachmentUpload{}, nil, false
	}
	if int64(len(data)) > h.attachmentConfig.MaxBytes {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "File too large")
		return AttachmentUpload{}, nil, false
	}
	return AttachmentUpload{
		Filename:    truncateFilename(header.Filename, 256),
		ContentType: contentType,
		FileSize:    int64(len(data)),
	}, data, true
}

func truncateFilename(value string, limit int) string {
	base := filepath.Base(value)
	cleaned := make([]rune, 0, utf8.RuneCountInString(base))
	for _, current := range base {
		if unicode.IsControl(current) {
			continue
		}
		cleaned = append(cleaned, current)
	}
	runes := cleaned
	if limit > 0 && len(runes) > limit {
		runes = runes[:limit]
	}
	if len(runes) == 0 {
		return "file"
	}
	return string(runes)
}

func randomObjectName(filename string) (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	base := filepath.Base(filename)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	ext := strings.ToLower(filepath.Ext(base))
	return hex.EncodeToString(id[:]) + "_" + safeObjectStem(stem) + ext, nil
}

func safeObjectStem(value string) string {
	var builder strings.Builder
	lastDash := false
	for _, current := range strings.TrimSpace(value) {
		if unicode.IsLetter(current) || unicode.IsDigit(current) {
			builder.WriteRune(current)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	result := strings.Trim(builder.String(), "-")
	if result == "" {
		return "file"
	}
	return string([]rune(result)[:minInt(80, utf8.RuneCountInString(result))])
}

func validProjectAttachmentKey(projectID, taskID int64, key string) bool {
	expected := fmt.Sprintf("project-launch-%d/task-%d/", projectID, taskID)
	if !strings.HasPrefix(key, expected) {
		return false
	}
	rest := strings.TrimPrefix(key, expected)
	return rest != "" && !strings.Contains(rest, "..") &&
		!strings.ContainsAny(rest, "/\\\r\n") && !strings.HasPrefix(rest, "/")
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
