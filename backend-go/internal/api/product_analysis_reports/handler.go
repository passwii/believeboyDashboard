package product_analysis_reports

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxCreateBodyBytes = 1 << 20

type Handler struct {
	store      Store
	auditor    audit.Service
	enqueuer   Enqueuer
	resultRoot string
	objectURLs ObjectURLBuilder
}

func NewHandler(
	store Store,
	auditor audit.Service,
	enqueuer Enqueuer,
	resultRoot string,
	objectURLs ObjectURLBuilder,
) *Handler {
	return &Handler{
		store:      store,
		auditor:    auditor,
		enqueuer:   enqueuer,
		resultRoot: strings.TrimSpace(resultRoot),
		objectURLs: objectURLs,
	}
}

func (handler *Handler) Create(w http.ResponseWriter, r *http.Request) {
	var request CreateRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxCreateBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON payload")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON payload")
		return
	}

	input, status, detail := validateCreateRequest(request)
	if status != 0 {
		httpapi.WriteDetail(w, status, detail)
		return
	}
	identity := requestIdentity(r)
	input.Operator = identity.Operator
	input.IsAdmin = identity.IsAdmin

	task, err := handler.store.CreateTask(r.Context(), input)
	if err != nil {
		handler.writeError(w, err)
		return
	}
	if task == nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Failed to create task")
		return
	}

	auditAfter := map[string]any{
		"job_id":            task.ID,
		"project_name":      input.ProjectName,
		"country":           input.Country,
		"report_start_date": input.ReportStartDate,
		"report_end_date":   input.ReportEndDate,
	}
	if handler.enqueuer == nil {
		err = errors.New("product analysis task queue is not configured")
		handler.failCreatedTask(r, task.ID, err)
		handler.audit(r, "product_analysis_reports.create", task.ID, auditAfter, err)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Task queue is not configured")
		return
	}
	if err := handler.enqueuer.EnqueueProductAnalysisReport(r.Context(), task.ID); err != nil {
		handler.failCreatedTask(r, task.ID, err)
		handler.audit(r, "product_analysis_reports.create", task.ID, auditAfter, err)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Task queue unavailable")
		return
	}
	handler.audit(r, "product_analysis_reports.create", task.ID, auditAfter, nil)

	statusEndpoint := fmt.Sprintf(
		"/api/v1/product-analysis-reports/tasks/%d",
		task.ID,
	)
	resultEndpoint := fmt.Sprintf(
		"/api/v1/product-analysis-reports/tasks/%d/result",
		task.ID,
	)
	createdAt := task.CreatedAt
	_ = httpapi.WriteJSON(w, http.StatusOK, CreateResponse{
		JobID:          task.ID,
		StatusEndpoint: &statusEndpoint,
		ResultEndpoint: &resultEndpoint,
		Status:         task.Status,
		CreatedAt:      &createdAt,
	})
}

func (handler *Handler) Status(w http.ResponseWriter, r *http.Request) {
	taskID, ok := parseTaskID(w, r)
	if !ok {
		return
	}
	identity := requestIdentity(r)
	task, err := handler.store.GetTask(
		r.Context(),
		taskID,
		identity.Operator,
		identity.IsAdmin,
	)
	if err != nil {
		handler.writeError(w, err)
		return
	}
	if task == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, TaskStatusResponse{
		TaskID:             task.ID,
		Status:             task.Status,
		Stage:              task.Stage,
		Progress:           task.Progress,
		Message:            task.Message,
		ErrorMessage:       task.ErrorMessage,
		PersistenceStatus:  task.PersistenceStatus,
		PersistenceMessage: task.PersistenceMessage,
		CreatedAt:          task.CreatedAt,
		UpdatedAt:          task.UpdatedAt,
	})
}

func (handler *Handler) Result(w http.ResponseWriter, r *http.Request) {
	taskID, ok := parseTaskID(w, r)
	if !ok {
		return
	}
	identity := requestIdentity(r)
	task, err := handler.store.GetTask(
		r.Context(),
		taskID,
		identity.Operator,
		identity.IsAdmin,
	)
	if err != nil {
		handler.writeError(w, err)
		return
	}
	if task == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
		return
	}
	if task.Status != StatusSuccess {
		httpapi.WriteDetail(w, http.StatusConflict, "Task not finished")
		return
	}
	if task.ResultPath == nil || strings.TrimSpace(*task.ResultPath) == "" {
		httpapi.WriteDetail(w, http.StatusNotFound, "Result file missing")
		return
	}

	rawResult := strings.TrimSpace(*task.ResultPath)
	if parsed, valid := safeHTTPSURL(rawResult); valid {
		handler.audit(r, "product_analysis_reports.result.export", task.ID, map[string]any{
			"job_id": task.ID,
			"source": "r2",
			"url":    parsed.String(),
		}, nil)
		http.Redirect(w, r, parsed.String(), http.StatusFound)
		return
	}
	if parsed, parseErr := url.Parse(rawResult); parseErr == nil && hasURLScheme(parsed.Scheme) {
		handler.resultNotFound(w, r, task.ID, "Result file not found")
		return
	}
	if strings.ContainsAny(rawResult, "\r\n\x00") {
		handler.resultNotFound(w, r, task.ID, "Result file not found")
		return
	}

	if isLocalAbsolutePath(rawResult) {
		if strings.TrimSpace(handler.resultRoot) == "" {
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Result storage is not configured")
			return
		}
		resolved, resolveErr := resolveLocalResultFile(handler.resultRoot, rawResult)
		if resolveErr != nil {
			handler.resultNotFound(w, r, task.ID, "Result file not found")
			return
		}
		handler.serveLocalResult(w, r, task.ID, resolved)
		return
	}

	relative, safeErr := safeStoredPath(rawResult)
	if safeErr != nil {
		handler.resultNotFound(w, r, task.ID, "Result file not found")
		return
	}
	if strings.TrimSpace(handler.resultRoot) != "" {
		resolved, resolveErr := resolveLocalResultFile(
			handler.resultRoot,
			relative,
		)
		if resolveErr == nil {
			handler.serveLocalResult(w, r, task.ID, resolved)
			return
		}
		if errors.Is(resolveErr, errResultPathUnsafe) {
			handler.resultNotFound(w, r, task.ID, "Result file not found")
			return
		}
	}

	if handler.objectURLs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Object storage is not configured")
		return
	}
	publicURL, err := handler.objectURLs.PublicURL(r.Context(), filepath.ToSlash(relative))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Object storage unavailable")
		return
	}
	parsed, valid := safeHTTPSURL(publicURL)
	if !valid {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Object storage URL is unsafe")
		return
	}
	handler.audit(r, "product_analysis_reports.result.export", task.ID, map[string]any{
		"job_id": task.ID,
		"source": "r2",
		"url":    parsed.String(),
	}, nil)
	http.Redirect(w, r, parsed.String(), http.StatusFound)
}

func (handler *Handler) serveLocalResult(
	w http.ResponseWriter,
	r *http.Request,
	taskID int64,
	resolved string,
) {
	file, err := os.Open(resolved)
	if err != nil {
		handler.resultNotFound(w, r, taskID, "Result file not found")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		handler.resultNotFound(w, r, taskID, "Result file not found")
		return
	}
	filename := filepath.Base(resolved)
	contentType := mime.TypeByExtension(filepath.Ext(resolved))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, filename))
	handler.audit(r, "product_analysis_reports.result.export", taskID, map[string]any{
		"job_id":   taskID,
		"filename": filename,
		"source":   "local",
	}, nil)
	http.ServeContent(w, r, filename, info.ModTime(), file)
}

func (handler *Handler) resultNotFound(
	w http.ResponseWriter,
	r *http.Request,
	taskID int64,
	detail string,
) {
	handler.audit(r, "product_analysis_reports.result.export", taskID, map[string]any{
		"job_id": taskID,
	}, errResultFileMissing)
	httpapi.WriteDetail(w, http.StatusNotFound, detail)
}

func (handler *Handler) failCreatedTask(r *http.Request, taskID int64, cause error) {
	message := "task enqueue failed"
	if cause != nil && strings.TrimSpace(cause.Error()) != "" {
		message = cause.Error()
	}
	_ = handler.store.MarkTaskFailed(r.Context(), taskID, message)
}

func parseTaskID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "task_id"))
	taskID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "task_id must be an integer")
		return 0, false
	}
	if taskID <= 0 {
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
		return 0, false
	}
	return taskID, true
}

func validateCreateRequest(request CreateRequest) (CreateInput, int, string) {
	input := CreateInput{
		ProjectName:           strings.TrimSpace(request.ProjectName),
		ReportStartDate:       strings.TrimSpace(request.ReportStartDate),
		ReportEndDate:         strings.TrimSpace(request.ReportEndDate),
		BusinessReportFileID:  strings.TrimSpace(request.BusinessReportFileID),
		PaymentReportFileID:   strings.TrimSpace(request.PaymentReportFileID),
		AdReportFileID:        strings.TrimSpace(request.AdReportFileID),
		InventoryReportFileID: trimOptionalString(request.InventoryReportFileID),
	}
	if input.ProjectName == "" || len([]rune(input.ProjectName)) > 128 {
		return CreateInput{}, http.StatusUnprocessableEntity, "project_name is required and must be at most 128 characters"
	}
	if len(input.ReportStartDate) != len("2006-01-02") ||
		len(input.ReportEndDate) != len("2006-01-02") {
		return CreateInput{}, http.StatusUnprocessableEntity, "report_start_date/report_end_date must be YYYY-MM-DD"
	}
	start, startErr := time.Parse("2006-01-02", input.ReportStartDate)
	end, endErr := time.Parse("2006-01-02", input.ReportEndDate)
	if startErr != nil || endErr != nil {
		return CreateInput{}, http.StatusBadRequest, "report_start_date/report_end_date must be YYYY-MM-DD"
	}
	if start.After(end) {
		return CreateInput{}, http.StatusBadRequest, "report_start_date cannot be greater than report_end_date"
	}

	country, err := normalizeCountry(request.Country)
	if err != nil {
		return CreateInput{}, http.StatusUnprocessableEntity, err.Error()
	}
	input.Country = country

	for _, file := range []struct {
		label string
		value string
	}{
		{label: "business_report_file_id", value: input.BusinessReportFileID},
		{label: "payment_report_file_id", value: input.PaymentReportFileID},
		{label: "ad_report_file_id", value: input.AdReportFileID},
	} {
		if _, err := normalizeStoredFileID(file.value); err != nil {
			return CreateInput{}, http.StatusUnprocessableEntity, file.label + " is invalid"
		}
	}
	if input.InventoryReportFileID != nil {
		if _, err := normalizeStoredFileID(*input.InventoryReportFileID); err != nil {
			return CreateInput{}, http.StatusUnprocessableEntity, "inventory_report_file_id is invalid"
		}
	}
	return input, 0, ""
}

func normalizeStoredFileID(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len([]rune(raw)) > 255 {
		return "", ErrInvalidStoredPath
	}
	for _, char := range raw {
		if unicode.IsControl(char) {
			return "", ErrInvalidStoredPath
		}
	}
	clean, err := safeStoredPath(raw)
	if err != nil {
		return "", ErrInvalidStoredPath
	}
	return filepath.ToSlash(clean), nil
}

func normalizeCountry(raw string) (string, error) {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "", "US", "USA", "美国", "美国站":
		return "US", nil
	case "DE", "GERMANY", "德国", "德国站":
		return "DE", nil
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK", nil
	default:
		return "", errors.New("country must be one of: US, DE, UK")
	}
}

func trimOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func requestIdentity(r *http.Request) auth.UserContext {
	if identity, ok := auth.UserContextFromContext(r.Context()); ok {
		return identity
	}
	return auth.UserContextFromRequest(r)
}

func (handler *Handler) writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "Project not found")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case errors.Is(err, ErrTaskNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
	case errors.Is(err, ErrInvalidStoredPath):
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, ErrStorageNotConfigured):
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Result storage is not configured")
	default:
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

func (handler *Handler) audit(
	r *http.Request,
	action string,
	targetID int64,
	after any,
	cause error,
) {
	if handler.auditor == nil {
		return
	}
	identity := requestIdentity(r)
	operator := optionalString(identity.Operator)
	target := strconv.FormatInt(targetID, 10)
	result := "success"
	var errorMessage *string
	if cause != nil {
		result = "failure"
		message := cause.Error()
		errorMessage = &message
	}
	entry := audit.Entry{
		Action:       action,
		TargetType:   "product_analysis_report_task",
		TargetID:     &target,
		Operator:     operator,
		Result:       result,
		AfterJSON:    after,
		ErrorMessage: errorMessage,
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
