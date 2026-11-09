package uploads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const defaultUploadMaxBytes = 50 * 1024 * 1024

type BlobStore interface {
	Put(ctx context.Context, key string, data []byte, contentType string) (string, error)
	Delete(ctx context.Context, key string) error
}

type Store interface {
	PrepareGenericUpload(filename, projectName, fileType string) (PreparedUpload, error)
	CommitPreparedUpload(context.Context, PreparedUpload, []byte, string) (UploadResponse, error)
	SaveReportTemp(string, []byte) (TempFile, error)
	RecognizeReport(context.Context, TempFile, string, string, bool) (RecognitionResponse, error)
	CommitReport(context.Context, CommitRequest, string, bool) (CommitResponse, error)
	ListReportStatus(context.Context, *string, string, string, bool) (StatusResponse, error)
}

type Config struct {
	MaxBytes            int64
	AllowedExtensions   map[string]bool
	AllowedContentTypes map[string]bool
	TypeExtensions      map[string]map[string]bool
}

type Handler struct {
	store   Store
	blobs   BlobStore
	auditor audit.Service
	config  Config
}

func NewHandler(store Store, blobs BlobStore, config Config, auditor audit.Service) *Handler {
	return &Handler{store: store, blobs: blobs, auditor: auditor, config: normalizeConfig(config)}
}

func (handler *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	if handler.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage is not configured. Please contact administrator.")
		return
	}
	file, header, contentType, data, ok := handler.readMultipart(w, r, "file", false)
	if !ok {
		return
	}
	defer file.Close()

	projectName := strings.TrimSpace(r.FormValue("project_name"))
	fileType := strings.TrimSpace(r.FormValue("file_type"))
	if projectName == "" || fileType == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "project_name and file_type are required")
		return
	}
	if err := handler.validateFile(header.Filename, contentType, fileType, false); err != nil {
		writeUploadError(w, err)
		return
	}
	prepared, err := handler.store.PrepareGenericUpload(header.Filename, projectName, fileType)
	if err != nil {
		writeUploadError(w, err)
		return
	}
	publicURL, err := handler.blobs.Put(r.Context(), prepared.ObjectKey, data, contentType)
	if err != nil {
		handler.auditFailure(r, "upload.save", nil, err)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage upload failed")
		return
	}
	response, err := handler.store.CommitPreparedUpload(r.Context(), prepared, data, publicURL)
	if err != nil {
		_ = handler.blobs.Delete(r.Context(), prepared.ObjectKey)
		handler.auditFailure(r, "upload.save", nil, err)
		writeUploadError(w, err)
		return
	}
	handler.auditSuccess(r, "upload.save", "upload_file", response.FileID, response)
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) Recognize(w http.ResponseWriter, r *http.Request) {
	file, header, contentType, data, ok := handler.readMultipart(w, r, "file", true)
	if !ok {
		return
	}
	defer file.Close()
	if err := handler.validateFile(header.Filename, contentType, "report_upload_temp", true); err != nil {
		writeUploadError(w, err)
		return
	}

	country := normalizeCountry(strings.TrimSpace(r.FormValue("country")))
	if country == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "country must be one of: DE, UK, US")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	isAdmin := identity.IsAdmin
	saved, err := handler.store.SaveReportTemp(header.Filename, data)
	if err != nil {
		writeUploadError(w, err)
		return
	}
	response, err := handler.store.RecognizeReport(
		r.Context(),
		saved,
		country,
		identity.Operator,
		isAdmin,
	)
	if err != nil {
		handler.auditFailure(r, "report_upload.recognize", &saved.TempFileID, err)
		writeUploadError(w, err)
		return
	}
	handler.auditSuccess(r, "report_upload.recognize", "report_upload_temp_file", saved.TempFileID, map[string]any{
		"temp_file_id":      saved.TempFileID,
		"original_filename": saved.OriginalFilename,
		"status":            response.Status,
		"report_type":       response.ReportType,
		"country":           response.Country,
	})
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) Commit(w http.ResponseWriter, r *http.Request) {
	var payload CommitRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	payload.TempFileID = strings.TrimSpace(payload.TempFileID)
	payload.ReportType = normalizeReportType(strings.TrimSpace(payload.ReportType))
	if payload.TempFileID == "" || payload.ReportType == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "temp_file_id and report_type are required")
		return
	}
	payload.Country = normalizeCountry(strings.TrimSpace(payload.Country))
	if payload.Country == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "country must be one of: DE, UK, US")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	isAdmin := identity.IsAdmin
	response, err := handler.store.CommitReport(r.Context(), payload, identity.Operator, isAdmin)
	if err != nil {
		handler.auditFailure(r, "report_upload.commit", nil, err)
		writeUploadError(w, err)
		return
	}
	handler.auditSuccess(r, "report_upload.commit", "report_upload", response.FileID, response)
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) Status(w http.ResponseWriter, r *http.Request) {
	country := normalizeCountry(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "country must be one of: DE, UK, US")
		return
	}
	var reportDate *string
	if raw := strings.TrimSpace(r.URL.Query().Get("report_date")); raw != "" {
		if _, err := parseISODate(raw); err != nil {
			httpapi.WriteDetail(w, http.StatusBadRequest, "report_date must be YYYY-MM-DD")
			return
		}
		reportDate = &raw
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	isAdmin := identity.IsAdmin
	response, err := handler.store.ListReportStatus(
		r.Context(),
		reportDate,
		identity.Operator,
		country,
		isAdmin,
	)
	if err != nil {
		writeUploadError(w, err)
		return
	}
	if response.Items == nil {
		response.Items = []ProjectStatusItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) readMultipart(
	w http.ResponseWriter,
	r *http.Request,
	field string,
	reportTemp bool,
) (multipart.File, *multipart.FileHeader, string, []byte, bool) {
	limit := handler.config.MaxBytes + 2*1024*1024
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseMultipartForm(handler.config.MaxBytes); err != nil {
		if requestTooLarge(err) {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "File too large")
			return nil, nil, "", nil, false
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid multipart form")
		return nil, nil, "", nil, false
	}
	file, header, err := r.FormFile(field)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file in multipart form")
		return nil, nil, "", nil, false
	}
	if header == nil || strings.TrimSpace(header.Filename) == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing filename")
		_ = file.Close()
		return nil, nil, "", nil, false
	}
	contentType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	data, err := io.ReadAll(io.LimitReader(file, handler.config.MaxBytes+1))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		_ = file.Close()
		return nil, nil, "", nil, false
	}
	if int64(len(data)) > handler.config.MaxBytes {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "File too large")
		_ = file.Close()
		return nil, nil, "", nil, false
	}
	if len(data) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File is empty")
		_ = file.Close()
		return nil, nil, "", nil, false
	}
	return file, header, contentType, data, true
}

func (handler *Handler) validateFile(filename, contentType, fileType string, reportTemp bool) error {
	ext := strings.ToLower(filepath.Ext(filename))
	if ext == "" {
		return NewAPIError(http.StatusBadRequest, "Missing filename")
	}
	allowed := handler.config.AllowedExtensions
	if fileType != "" {
		normalized := normalizeReportType(fileType)
		if perType, ok := handler.config.TypeExtensions[normalized]; ok {
			allowed = perType
		}
	}
	if reportTemp {
		allowed = map[string]bool{".txt": true, ".csv": true, ".xlsx": true}
	}
	if !allowed[ext] {
		return NewAPIError(
			http.StatusBadRequest,
			fmt.Sprintf("Unsupported extension: %s (expected: %s)", ext, joinKeys(allowed)),
		)
	}
	if contentType != "" && !handler.config.AllowedContentTypes[contentType] {
		return NewAPIError(http.StatusBadRequest, fmt.Sprintf("Unsupported MIME type: %s", contentType))
	}
	return nil
}

func normalizeConfig(config Config) Config {
	if config.MaxBytes <= 0 {
		config.MaxBytes = defaultUploadMaxBytes
	}
	if config.AllowedExtensions == nil {
		config.AllowedExtensions = map[string]bool{
			".txt": true, ".csv": true, ".xlsx": true, ".pdf": true,
		}
	}
	if config.AllowedContentTypes == nil {
		config.AllowedContentTypes = map[string]bool{
			"text/plain": true, "text/csv": true, "application/csv": true,
			"application/vnd.ms-excel": true,
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
			"application/pdf": true, "application/octet-stream": true,
		}
	}
	if config.TypeExtensions == nil {
		config.TypeExtensions = map[string]map[string]bool{
			"business_report":          {".csv": true},
			"sales_report":             {".txt": true},
			"inventory_report":         {".txt": true},
			"inventory_ledger":         {".csv": true},
			"inventory_ledger_summary": {".csv": true},
			"inventory_ledger_detail":  {".csv": true},
			"ad_product_report":        {".xlsx": true},
			"ad_search_term_report":    {".xlsx": true},
			"payment_report":           {".csv": true},
			"transaction_csv":          {".csv": true},
			"monthly_summary_pdf":      {".pdf": true},
			"category_research_xlsx":   {".xlsx": true},
			"report_upload_temp":       {".txt": true, ".csv": true, ".xlsx": true},
		}
	}
	return config
}

func normalizeReportType(value string) string {
	switch strings.TrimSpace(value) {
	case "ad_report":
		return "ad_product_report"
	default:
		return strings.TrimSpace(value)
	}
}

func normalizeCountry(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "", "US", "USA", "美国", "美国站":
		return "US"
	case "DE", "GERMANY", "德国", "德国站":
		return "DE"
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK"
	default:
		return ""
	}
}

func parseISODate(value string) (string, error) {
	_, err := time.Parse("2006-01-02", value)
	return value, err
}

type APIError struct {
	Status int
	Detail string
}

func (err *APIError) Error() string { return err.Detail }

func NewAPIError(status int, detail string) error {
	return &APIError{Status: status, Detail: detail}
}

func writeUploadError(w http.ResponseWriter, err error) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		httpapi.WriteDetail(w, apiErr.Status, apiErr.Detail)
		return
	}
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}

func requestTooLarge(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "too large") || strings.Contains(message, "request body")
}

func joinKeys(values map[string]bool) string {
	keys := make([]string, 0, len(values))
	for key, enabled := range values {
		if enabled {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

func (handler *Handler) auditSuccess(
	r *http.Request,
	action string,
	targetType string,
	targetID string,
	after any,
) {
	if handler.auditor == nil {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	entry := audit.Entry{
		Action: action, TargetType: targetType, TargetID: optionalString(targetID),
		Operator: optionalString(identity.Operator), Result: "success", AfterJSON: after,
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
}

func (handler *Handler) auditFailure(
	r *http.Request,
	action string,
	targetID *string,
	err error,
) {
	if handler.auditor == nil {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	message := err.Error()
	entry := audit.Entry{
		Action: action, TargetType: "upload", TargetID: targetID,
		Operator: optionalString(identity.Operator), Result: "failure", ErrorMessage: &message,
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
