package page_render

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	defaultMaxBytes = 2 * 1024 * 1024
	defaultPageSize = 20
	maxPageSize     = 100
)

type BlobStore interface {
	Put(ctx context.Context, key string, data []byte, contentType string) (string, error)
	Delete(ctx context.Context, key string) error
}

type Store interface {
	InsertPage(context.Context, PageRecord) (UploadedPage, error)
	GetPage(context.Context, string) (*PageRecord, error)
	ListPages(context.Context, int64, int, int) ([]UploadedPage, error)
	CountPages(context.Context, int64) (int64, error)
	DeletePage(context.Context, string, int64) (bool, error)
}

type Config struct {
	MaxBytes                int64
	AllowedExtensions       map[string]bool
	AllowedContentTypes     map[string]bool
	PublicRequestsPerMinute int
}

type Handler struct {
	store   Store
	blobs   BlobStore
	config  Config
	auditor audit.Service
}

func NewHandler(store Store, blobs BlobStore, config Config, auditor audit.Service) *Handler {
	config = normalizeConfig(config)
	return &Handler{store: store, blobs: blobs, config: config, auditor: auditor}
}

func (handler *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	if handler.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	ownerID, ok := currentOwner(w, r)
	if !ok {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, handler.config.MaxBytes+2*1024*1024)
	if err := r.ParseMultipartForm(handler.config.MaxBytes); err != nil {
		if isRequestTooLarge(err) {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "文件过大")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid multipart form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "缺少文件")
		return
	}
	defer file.Close()

	ext, sourceFormat, contentType, data, err := handler.readUpload(file, header)
	if err != nil {
		writePageError(w, err)
		return
	}
	title := sanitizeTitle(r.FormValue("title"), header.Filename)
	objectID, err := randomUUID()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	pageID, err := randomUUID()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	key := fmt.Sprintf("special-pages/user_%d/%s%s", ownerID, objectID, ext)
	publicURL, err := handler.blobs.Put(r.Context(), key, data, contentType)
	if err != nil {
		handler.auditFailure(r, "page_render.upload", "", err)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储上传失败")
		return
	}

	page, err := handler.store.InsertPage(r.Context(), PageRecord{
		ID:               pageID,
		OwnerUserID:      ownerID,
		Title:            title,
		SourceFormat:     sourceFormat,
		OriginalFilename: truncateRunes(header.Filename, 255),
		ContentType:      contentType,
		FileSize:         int64(len(data)),
		R2Key:            key,
		PublicURL:        publicURL,
	})
	if err != nil {
		_ = handler.blobs.Delete(r.Context(), key)
		handler.auditFailure(r, "page_render.upload", "", err)
		writePageError(w, err)
		return
	}
	handler.auditSuccess(r, "page_render.upload", "uploaded_page", page.ID)
	_ = httpapi.WriteJSON(w, http.StatusCreated, page)
}

func (handler *Handler) History(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := currentOwner(w, r)
	if !ok {
		return
	}
	limit, offset, ok := parsePagination(w, r)
	if !ok {
		return
	}
	items, err := handler.store.ListPages(r.Context(), ownerID, limit, offset)
	if err != nil {
		writePageError(w, err)
		return
	}
	items = nonNil(items)
	total, err := handler.store.CountPages(r.Context(), ownerID)
	if err != nil {
		writePageError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, HistoryResponse{Items: items, Total: total})
}

func (handler *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	pageID := strings.TrimSpace(chi.URLParam(r, "page_id"))
	if pageID == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "page_id is required")
		return
	}
	ownerID, ok := currentOwner(w, r)
	if !ok {
		return
	}
	page, err := handler.store.GetPage(r.Context(), pageID)
	if err != nil {
		writePageError(w, err)
		return
	}
	if page == nil || page.OwnerUserID != ownerID {
		httpapi.WriteDetail(w, http.StatusNotFound, "页面不存在")
		return
	}
	deleted, err := handler.store.DeletePage(r.Context(), pageID, ownerID)
	if err != nil {
		handler.auditFailure(r, "page_render.delete", pageID, err)
		writePageError(w, err)
		return
	}
	if !deleted {
		httpapi.WriteDetail(w, http.StatusNotFound, "页面不存在")
		return
	}
	if handler.blobs != nil {
		_ = handler.blobs.Delete(r.Context(), page.R2Key)
	}
	handler.auditSuccess(r, "page_render.delete", "uploaded_page", pageID)
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) Public(w http.ResponseWriter, r *http.Request) {
	pageID := strings.TrimSpace(chi.URLParam(r, "page_id"))
	if pageID == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "page_id is required")
		return
	}
	page, err := handler.store.GetPage(r.Context(), pageID)
	if err != nil {
		writePageError(w, err)
		return
	}
	if page == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "页面不存在")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, PublicResponse{
		ID: page.ID, Title: page.Title, SourceFormat: page.SourceFormat, PublicURL: page.PublicURL,
	})
}

func (handler *Handler) readUpload(
	file multipart.File,
	header *multipart.FileHeader,
) (string, string, string, []byte, error) {
	if header == nil || header.Filename == "" {
		return "", "", "", nil, NewAPIError(http.StatusBadRequest, "缺少文件名")
	}
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !handler.config.AllowedExtensions[ext] {
		return "", "", "", nil, NewAPIError(
			http.StatusBadRequest,
			fmt.Sprintf("不支持的文件类型: %s（允许: %s）", ext, joinedKeys(handler.config.AllowedExtensions)),
		)
	}
	contentType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	if contentType != "" && !handler.config.AllowedContentTypes[contentType] {
		return "", "", "", nil, NewAPIError(
			http.StatusBadRequest,
			fmt.Sprintf("不支持的 MIME 类型: %s", contentType),
		)
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	reader := io.LimitReader(file, handler.config.MaxBytes+1)
	data, err := io.ReadAll(reader)
	if err != nil {
		return "", "", "", nil, NewAPIError(http.StatusBadRequest, "文件读取失败")
	}
	if int64(len(data)) > handler.config.MaxBytes {
		return "", "", "", nil, NewAPIError(
			http.StatusRequestEntityTooLarge,
			fmt.Sprintf("文件超过 %d 字节上限", handler.config.MaxBytes),
		)
	}
	if len(data) == 0 {
		return "", "", "", nil, NewAPIError(http.StatusBadRequest, "文件为空")
	}
	sourceFormat := "markdown"
	if ext == ".html" || ext == ".htm" {
		sourceFormat = "html"
	}
	return ext, sourceFormat, contentType, data, nil
}

func currentOwner(w http.ResponseWriter, r *http.Request) (int64, bool) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok || strings.TrimSpace(identity.UserID) == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "未登录")
		return 0, false
	}
	ownerID, err := strconv.ParseInt(strings.TrimSpace(identity.UserID), 10, 64)
	if err != nil || ownerID <= 0 {
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该页面")
		return 0, false
	}
	return ownerID, true
}

func parsePagination(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	limit := defaultPageSize
	offset := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > maxPageSize {
			httpapi.WriteDetail(w, http.StatusBadRequest, "limit must be between 1 and 100")
			return 0, 0, false
		}
		limit = value
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			httpapi.WriteDetail(w, http.StatusBadRequest, "offset must be greater than or equal to 0")
			return 0, 0, false
		}
		offset = value
	}
	return limit, offset, true
}

func normalizeConfig(config Config) Config {
	if config.MaxBytes <= 0 {
		config.MaxBytes = defaultMaxBytes
	}
	if config.PublicRequestsPerMinute <= 0 {
		config.PublicRequestsPerMinute = 30
	}
	if config.AllowedExtensions == nil {
		config.AllowedExtensions = map[string]bool{
			".md": true, ".markdown": true, ".html": true, ".htm": true,
		}
	}
	if config.AllowedContentTypes == nil {
		config.AllowedContentTypes = map[string]bool{
			"text/markdown": true, "text/x-markdown": true,
			"text/html": true, "text/plain": true,
			"application/octet-stream": true,
		}
	}
	return config
}

func sanitizeTitle(raw, fallbackFilename string) string {
	candidate := raw
	if candidate == "" {
		candidate = strings.TrimSuffix(filepath.Base(fallbackFilename), filepath.Ext(fallbackFilename))
	}
	candidate = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune("<>&", r) {
			return -1
		}
		return r
	}, candidate)
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		candidate = "未命名页面"
	}
	return truncateRunes(candidate, 200)
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

func randomUUID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", fmt.Errorf("generate uuid: %w", err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	raw := hex.EncodeToString(bytes[:])
	return raw[0:4] + "-" + raw[4:8] + "-" + raw[8:12] + "-" + raw[12:16] + "-" + raw[16:32], nil
}

type APIError struct {
	Status int
	Detail string
}

func (err *APIError) Error() string { return err.Detail }

func NewAPIError(status int, detail string) error {
	return &APIError{Status: status, Detail: detail}
}

func writePageError(w http.ResponseWriter, err error) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		httpapi.WriteDetail(w, apiErr.Status, apiErr.Detail)
		return
	}
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}

func isRequestTooLarge(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "request body too large") ||
		strings.Contains(strings.ToLower(err.Error()), "body too large")
}

func nonNil(items []UploadedPage) []UploadedPage {
	if items == nil {
		return []UploadedPage{}
	}
	return items
}

func joinedKeys(values map[string]bool) string {
	keys := make([]string, 0, len(values))
	for key, enabled := range values {
		if enabled {
			keys = append(keys, key)
		}
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return strings.Join(keys, ", ")
}

func (handler *Handler) auditSuccess(r *http.Request, action, targetType, targetID string) {
	if handler.auditor == nil {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	operator := optionalString(identity.Operator)
	entry := audit.Entry{
		Action: action, TargetType: targetType, TargetID: &targetID,
		Operator: operator, Result: "success",
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
}

func (handler *Handler) auditFailure(r *http.Request, action, targetID string, err error) {
	if handler.auditor == nil {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	operator := optionalString(identity.Operator)
	message := err.Error()
	entry := audit.Entry{
		Action: action, TargetType: "uploaded_page", Operator: operator,
		Result: "failure", ErrorMessage: &message,
	}
	if targetID != "" {
		entry.TargetID = &targetID
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
