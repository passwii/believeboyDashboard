package monthly_reports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	pathpkg "path"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store    Store
	auditor  audit.Service
	enqueuer JobEnqueuer
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return NewHandlerWithEnqueuer(store, auditor, nil)
}

func NewHandlerWithEnqueuer(
	store Store,
	auditor audit.Service,
	enqueuer JobEnqueuer,
) *Handler {
	return &Handler{store: store, auditor: auditor, enqueuer: enqueuer}
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	filter := MonthlyReportListFilter{}

	if _, present := query["project_id"]; present {
		projectID, err := parsePositiveInt64(query.Get("project_id"))
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
			return
		}
		filter.ProjectID = &projectID
	}
	if _, present := query["year"]; present {
		year, err := parseYear(query.Get("year"))
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "year must be a four-digit year")
			return
		}
		filter.Year = &year
	}
	if _, present := query["month"]; present {
		rawMonth := strings.TrimSpace(query.Get("month"))
		if rawMonth != "" {
			if len(rawMonth) == len("2006-01") {
				month, err := normalizeReportMonth(rawMonth)
				if err != nil {
					httpapi.WriteDetail(w, http.StatusBadRequest, "month must be YYYY-MM")
					return
				}
				filter.ReportMonth = &month
			} else {
				month, err := parseBoundedInt(rawMonth, 1, 12)
				if err != nil {
					httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "month must be YYYY-MM or between 1 and 12")
					return
				}
				filter.Month = &month
			}
		}
	}
	if _, present := query["status"]; present {
		status, err := normalizeStatusFilter(query.Get("status"))
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "status must be one of: pending, running, success, failed")
			return
		}
		filter.Status = &status
	}
	if _, present := query["country"]; present {
		country, err := normalizeCountry(query.Get("country"))
		if err != nil {
			httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
			return
		}
		filter.Country = &country
	}
	if _, present := query["include_history"]; present {
		includeHistory, err := strconv.ParseBool(strings.TrimSpace(query.Get("include_history")))
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "include_history must be a boolean")
			return
		}
		filter.IncludeHistory = includeHistory
	}
	if _, present := query["limit"]; present {
		limit, err := parseBoundedInt(query.Get("limit"), 1, 1000)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "limit must be between 1 and 1000")
			return
		}
		filter.Limit = &limit
	}
	if _, present := query["offset"]; present {
		offset, err := strconv.Atoi(strings.TrimSpace(query.Get("offset")))
		if err != nil || offset < 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "offset must be zero or greater")
			return
		}
		filter.Offset = offset
	}

	identity := requestIdentity(r)
	filter.Operator = identity.Operator
	filter.IsAdmin = identity.IsAdmin
	if filter.ProjectID != nil {
		if err := h.store.VerifyProjectAccess(
			r.Context(),
			*filter.ProjectID,
			identity.Operator,
			identity.IsAdmin,
		); err != nil {
			h.writeError(w, err)
			return
		}
	}

	items, err := h.store.List(r.Context(), filter)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if items == nil {
		items = []MonthlyReport{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	reportID, ok := parseReportID(w, r)
	if !ok {
		return
	}
	detail, err := h.loadAccessibleReport(w, r, reportID)
	if err != nil {
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	h.generate(w, r, true)
}

func (h *Handler) Generate(w http.ResponseWriter, r *http.Request) {
	h.generate(w, r, false)
}

func (h *Handler) generate(w http.ResponseWriter, r *http.Request, canonical bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var request generateRequest
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON payload")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON payload")
		return
	}

	projectName := strings.TrimSpace(request.ProjectName)
	if request.ProjectID != nil && *request.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return
	}
	if request.ProjectID == nil && projectName == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id or project_name is required")
		return
	}
	if canonical && projectName == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_name is required")
		return
	}
	if len([]rune(projectName)) > 128 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_name must be at most 128 characters")
		return
	}

	reportMonth := strings.TrimSpace(request.ReportMonth)
	if len(reportMonth) != len("2006-01") {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_month must be YYYY-MM")
		return
	}
	if _, err := time.Parse("2006-01", reportMonth); err != nil {
		statusCode := http.StatusUnprocessableEntity
		if canonical {
			statusCode = http.StatusBadRequest
		}
		httpapi.WriteDetail(w, statusCode, "report_month must be YYYY-MM")
		return
	}

	rawCountry := "US"
	if len(request.Country) > 0 {
		var countryValue string
		if err := json.Unmarshal(request.Country, &countryValue); err != nil {
			httpapi.WriteDetail(
				w,
				http.StatusUnprocessableEntity,
				"country must be a string",
			)
			return
		}
		rawCountry = strings.TrimSpace(countryValue)
		if len([]rune(rawCountry)) < 2 || len([]rune(rawCountry)) > 16 {
			httpapi.WriteDetail(
				w,
				http.StatusUnprocessableEntity,
				"country must be between 2 and 16 characters",
			)
			return
		}
	}
	country, err := normalizeCountry(rawCountry)
	if err != nil {
		statusCode := http.StatusUnprocessableEntity
		if canonical {
			statusCode = http.StatusBadRequest
		}
		httpapi.WriteDetail(w, statusCode, err.Error())
		return
	}
	if !canonical && trimPointer(request.TransactionFilePath) != nil {
		httpapi.WriteDetail(
			w,
			http.StatusUnprocessableEntity,
			"transaction_file_path must not be provided",
		)
		return
	}
	if !canonical && trimPointer(request.SummaryPDFFilePath) != nil {
		httpapi.WriteDetail(
			w,
			http.StatusUnprocessableEntity,
			"summary_pdf_file_path must not be provided",
		)
		return
	}
	transactionFileID := trimPointer(request.TransactionFileID)
	if transactionFileID == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "transaction_file_id is required")
		return
	}
	if request.SummaryPDFFileID != nil && strings.TrimSpace(*request.SummaryPDFFileID) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "summary_pdf_file_id must not be empty")
		return
	}
	async := true
	if !canonical {
		async, err = resolveGenerationMode(request.Async, request.Mode)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
	}

	var projectID *int64
	if request.ProjectID != nil {
		projectID = request.ProjectID
	}
	var projectNamePointer *string
	if projectName != "" {
		projectNamePointer = &projectName
	}
	identity := requestIdentity(r)
	report, err := h.store.Generate(r.Context(), MonthlyReportGenerateInput{
		ProjectID:         projectID,
		ProjectName:       projectNamePointer,
		Country:           country,
		ReportMonth:       reportMonth,
		TransactionFileID: transactionFileID,
		SummaryPDFFileID:  trimPointer(request.SummaryPDFFileID),
		Async:             async,
		Operator:          identity.Operator,
		IsAdmin:           identity.IsAdmin,
	})
	if err != nil {
		h.writeError(w, err)
		return
	}
	if report == nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Failed to create monthly report")
		return
	}
	if report.JobID <= 0 {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Failed to create monthly report job")
		return
	}
	if h.enqueuer == nil {
		if err := h.markGenerationFailed(
			r.Context(),
			report,
			"monthly report job enqueuer is not configured",
		); err != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Failed to persist monthly report failure")
			return
		}
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Failed to schedule monthly report job")
		return
	}
	if err := h.enqueuer.EnqueueRunJob(r.Context(), report.JobID); err != nil {
		if markErr := h.markGenerationFailed(
			r.Context(),
			report,
			"monthly report job enqueue failed: "+err.Error(),
		); markErr != nil {
			httpapi.WriteDetail(w, http.StatusInternalServerError, "Failed to persist monthly report failure")
			return
		}
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Failed to schedule monthly report job")
		return
	}
	if err := h.logAction(r.Context(), r, audit.Entry{
		Action:     "monthly_reports.create",
		TargetType: monthlyReportCreateTargetType(canonical),
		TargetID:   stringPointer(strconv.FormatInt(monthlyReportCreateTargetID(report, canonical), 10)),
		AfterJSON: map[string]any{
			"report_id":    report.ID,
			"job_id":       report.JobID,
			"project_id":   report.ProjectID,
			"project_name": report.ProjectName,
			"country":      report.Country,
			"report_month": report.ReportMonth,
		},
	}); err != nil {
		h.writeError(w, err)
		return
	}

	if canonical {
		statusEndpoint := fmt.Sprintf("/api/v1/monthly-reports/tasks/%d", report.JobID)
		resultEndpoint := statusEndpoint + "/result"
		var createdAt *string
		if strings.TrimSpace(report.CreatedAt) != "" {
			value := report.CreatedAt
			createdAt = &value
		}
		_ = httpapi.WriteJSON(w, http.StatusOK, MonthlyReportResponse{
			JobID:           report.JobID,
			MonthlyReportID: nil,
			StatusEndpoint:  &statusEndpoint,
			ResultEndpoint:  resultEndpoint,
			Status:          report.Status,
			CreatedAt:       createdAt,
		})
		return
	}

	statusCode := http.StatusCreated
	if !async || report.Status == MonthlyReportStatusCompleted {
		statusCode = http.StatusOK
	}
	_ = httpapi.WriteJSON(w, statusCode, GenerateMonthlyReportResponse{
		ReportID:       report.ID,
		Status:         report.Status,
		StatusEndpoint: fmt.Sprintf("/api/v1/monthly-reports/%d/status", report.ID),
		CreatedAt:      report.CreatedAt,
	})
}

func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	reportID, ok := parseReportID(w, r)
	if !ok {
		return
	}
	if _, err := h.loadAccessibleReport(w, r, reportID); err != nil {
		return
	}
	status, err := h.store.GetStatus(r.Context(), reportID)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if status == nil {
		h.writeError(w, ErrReportNotFound)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, status)
}

func (h *Handler) FinancialSeries(w http.ResponseWriter, r *http.Request) {
	filter, ok := parseFinancialSeriesFilter(w, r)
	if !ok {
		return
	}
	if !h.verifyProjectAccess(w, r, filter.ProjectID) {
		return
	}
	store, ok := h.extendedStore(w)
	if !ok {
		return
	}
	series, err := store.GetFinancialSeries(r.Context(), filter)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if series == nil {
		h.writeError(w, ErrReportNotFound)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, series)
}

func (h *Handler) RecalculateFinancialSeries(w http.ResponseWriter, r *http.Request) {
	filter, ok := parseFinancialSeriesFilter(w, r)
	if !ok {
		return
	}
	if !h.verifyProjectAccess(w, r, filter.ProjectID) {
		return
	}
	// FastAPI accepts fill_missing on recalculate but refreshes with its
	// default fill behavior.
	filter.FillMissing = true
	store, ok := h.extendedStore(w)
	if !ok {
		return
	}
	series, err := store.RecalculateFinancialSeries(r.Context(), filter)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if series == nil {
		h.writeError(w, ErrReportNotFound)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, series)
}

func (h *Handler) AccountingDetail(w http.ResponseWriter, r *http.Request) {
	filter, ok := parseAccountingFilter(w, r)
	if !ok {
		return
	}
	if !h.verifyProjectAccess(w, r, filter.ProjectID) {
		return
	}
	store, ok := h.extendedStore(w)
	if !ok {
		return
	}
	detail, err := store.GetAccountingDetail(r.Context(), filter)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if detail == nil {
		h.writeError(w, ErrReportNotFound)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (h *Handler) ExportAccountingDetail(w http.ResponseWriter, r *http.Request) {
	filter, ok := parseAccountingFilter(w, r)
	if !ok {
		return
	}
	if !h.verifyProjectAccess(w, r, filter.ProjectID) {
		return
	}
	store, ok := h.extendedStore(w)
	if !ok {
		return
	}
	file, err := store.ExportAccountingDetail(r.Context(), filter)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if file == nil {
		h.writeError(w, ErrExportNotFound)
		return
	}
	filename := strings.TrimSpace(file.Filename)
	if filename == "" {
		filename = "accounting-detail.xlsx"
	}
	contentType := strings.TrimSpace(file.ContentType)
	if contentType == "" {
		contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": filename,
	}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(file.Content)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(file.Content)
}

func (h *Handler) Task(w http.ResponseWriter, r *http.Request) {
	taskID, ok := parseTaskID(w, r)
	if !ok {
		return
	}
	store, ok := h.extendedStore(w)
	if !ok {
		return
	}
	task, err := store.GetTask(r.Context(), taskID)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if task == nil {
		h.writeError(w, ErrTaskNotFound)
		return
	}
	if !h.verifyProjectAccess(w, r, task.ProjectID) {
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, task)
}

func (h *Handler) TaskResult(w http.ResponseWriter, r *http.Request) {
	taskID, ok := parseTaskID(w, r)
	if !ok {
		return
	}
	store, ok := h.extendedStore(w)
	if !ok {
		return
	}
	file, err := store.GetTaskResult(r.Context(), taskID)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if file == nil {
		h.writeError(w, ErrExportNotFound)
		return
	}
	if !h.verifyProjectAccess(w, r, file.ProjectID) {
		return
	}
	filename := strings.TrimSpace(file.Filename)
	if filename == "" {
		filename = "monthly-report.xlsx"
	}
	if err := h.logAction(r.Context(), r, audit.Entry{
		Action:     "monthly_reports.result.export",
		TargetType: "monthly_report_task",
		TargetID:   stringPointer(strconv.FormatInt(taskID, 10)),
		AfterJSON: map[string]any{
			"job_id":   taskID,
			"filename": filename,
		},
	}); err != nil {
		h.writeError(w, err)
		return
	}
	h.serveFile(w, r, file, filename)
}

func (h *Handler) ExportReport(w http.ResponseWriter, r *http.Request) {
	reportID, ok := parseReportID(w, r)
	if !ok {
		return
	}
	if _, err := h.loadAccessibleReport(w, r, reportID); err != nil {
		return
	}
	store, ok := h.extendedStore(w)
	if !ok {
		return
	}
	file, err := store.ExportReportFile(r.Context(), reportID)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if file == nil {
		h.writeError(w, ErrExportNotFound)
		return
	}
	filename := strings.TrimSpace(file.Filename)
	if filename == "" {
		filename = "monthly-report.xlsx"
	}
	if err := h.logAction(r.Context(), r, audit.Entry{
		Action:     "monthly_reports.export",
		TargetType: "monthly_report",
		TargetID:   stringPointer(strconv.FormatInt(reportID, 10)),
		AfterJSON: map[string]any{
			"report_id": reportID,
			"filename":  filename,
		},
	}); err != nil {
		h.writeError(w, err)
		return
	}
	h.serveFile(w, r, file, filename)
}

func (h *Handler) Confirm(w http.ResponseWriter, r *http.Request) {
	reportID, ok := parseReportID(w, r)
	if !ok {
		return
	}
	detail, err := h.loadAccessibleReport(w, r, reportID)
	if err != nil {
		return
	}

	var confirmed *MonthlyReport
	err = h.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		var confirmErr error
		confirmed, confirmErr = txStore.ConfirmReport(ctx, reportID)
		if confirmErr != nil {
			return confirmErr
		}
		if confirmed == nil {
			return ErrReportNotFound
		}
		after := map[string]any{
			"report_id":  reportID,
			"project_id": detail.Report.ProjectID,
			"status":     confirmed.Status,
			"confirmed":  true,
		}
		return h.logActionTx(ctx, r, tx, audit.Entry{
			Action:     "monthly_reports.confirm",
			TargetType: "monthly_report",
			TargetID:   stringPointer(strconv.FormatInt(reportID, 10)),
			BeforeJSON: map[string]any{"status": detail.Report.Status},
			AfterJSON:  after,
		})
	})
	if err != nil {
		h.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, confirmed)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	reportID, ok := parseReportID(w, r)
	if !ok {
		return
	}
	_, err := h.loadAccessibleReport(w, r, reportID)
	if err != nil {
		return
	}

	err = h.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		deleted, deleteErr := txStore.DeleteDraft(ctx, reportID)
		if deleteErr != nil {
			return deleteErr
		}
		if deleted == nil {
			return ErrReportNotFound
		}
		return h.logActionTx(ctx, r, tx, audit.Entry{
			Action:     "monthly_reports.delete",
			TargetType: "monthly_report",
			TargetID:   stringPointer(strconv.FormatInt(reportID, 10)),
			BeforeJSON: deleted,
			AfterJSON: map[string]any{
				"report_id":  reportID,
				"project_id": deleted.ProjectID,
				"deleted":    true,
			},
		})
	})
	if err != nil {
		h.writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) ExportExcel(w http.ResponseWriter, r *http.Request) {
	h.export(w, r, MonthlyReportExportFormatExcel)
}

func (h *Handler) ExportPDF(w http.ResponseWriter, r *http.Request) {
	h.export(w, r, MonthlyReportExportFormatPDF)
}

func (h *Handler) serveFile(
	w http.ResponseWriter,
	r *http.Request,
	file *MonthlyReportExport,
	filename string,
) {
	if file.RedirectURL != nil && strings.TrimSpace(*file.RedirectURL) != "" {
		redirectURL, safe := SafeSummaryPDFRedirect(*file.RedirectURL)
		if !safe {
			h.writeError(w, ErrExportNotFound)
			return
		}
		http.Redirect(w, r, redirectURL, http.StatusFound)
		return
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": filename,
	}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	if contentType := strings.TrimSpace(file.ContentType); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	if path := strings.TrimSpace(file.Path); path != "" {
		http.ServeFile(w, r, path)
		return
	}
	if len(file.Content) > 0 {
		w.Header().Set("Content-Length", strconv.Itoa(len(file.Content)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(file.Content)
		return
	}
	h.writeError(w, ErrExportNotFound)
}

func (h *Handler) export(w http.ResponseWriter, r *http.Request, format string) {
	reportID, ok := parseReportID(w, r)
	if !ok {
		return
	}
	if _, err := h.loadAccessibleReport(w, r, reportID); err != nil {
		return
	}
	file, err := h.store.ExportReport(r.Context(), reportID, format)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if file == nil {
		h.writeError(w, ErrExportNotFound)
		return
	}

	if file.RedirectURL != nil && strings.TrimSpace(*file.RedirectURL) != "" {
		redirectURL, safe := SafeSummaryPDFRedirect(*file.RedirectURL)
		if !safe {
			h.writeError(w, ErrExportNotFound)
			return
		}
		filename := redirectExportFilename(redirectURL, format)
		if err := h.logAction(r.Context(), r, monthlyReportExportAuditEntry(
			reportID,
			format,
			filename,
		)); err != nil {
			h.writeError(w, err)
			return
		}
		http.Redirect(w, r, redirectURL, http.StatusFound)
		return
	}

	filename := strings.TrimSpace(file.Filename)
	if filename == "" {
		filename = defaultExportFilename(format)
	}
	filePath := strings.TrimSpace(file.Path)
	if filePath == "" && len(file.Content) == 0 {
		h.writeError(w, ErrExportNotFound)
		return
	}
	if err := h.logAction(r.Context(), r, monthlyReportExportAuditEntry(
		reportID,
		format,
		filename,
	)); err != nil {
		h.writeError(w, err)
		return
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": filename,
	}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	if contentType := strings.TrimSpace(file.ContentType); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}

	if filePath != "" {
		http.ServeFile(w, r, filePath)
		return
	}
	if len(file.Content) > 0 {
		w.Header().Set("Content-Length", strconv.Itoa(len(file.Content)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(file.Content)
		return
	}
	h.writeError(w, ErrExportNotFound)
}

func (h *Handler) verifyProjectAccess(
	w http.ResponseWriter,
	r *http.Request,
	projectID int64,
) bool {
	identity := requestIdentity(r)
	if err := h.store.VerifyProjectAccess(
		r.Context(),
		projectID,
		identity.Operator,
		identity.IsAdmin,
	); err != nil {
		h.writeError(w, err)
		return false
	}
	return true
}

func (h *Handler) extendedStore(w http.ResponseWriter) (ExtendedStore, bool) {
	store, ok := h.store.(ExtendedStore)
	if !ok {
		httpapi.WriteDetail(
			w,
			http.StatusServiceUnavailable,
			"monthly report store does not support this route",
		)
		return nil, false
	}
	return store, true
}

func (h *Handler) markGenerationFailed(
	ctx context.Context,
	report *MonthlyReport,
	message string,
) error {
	marker, ok := h.store.(GenerationFailureMarker)
	if !ok {
		return errors.New("monthly report store cannot mark generation failure")
	}
	return marker.MarkGenerationFailed(ctx, report.ID, report.JobID, message)
}

func monthlyReportExportAuditEntry(reportID int64, format, filename string) audit.Entry {
	return audit.Entry{
		Action:     "monthly_reports.export",
		TargetType: "monthly_report",
		TargetID:   stringPointer(strconv.FormatInt(reportID, 10)),
		AfterJSON: map[string]any{
			"format":   format,
			"filename": filename,
		},
	}
}

func defaultExportFilename(format string) string {
	if format == MonthlyReportExportFormatPDF {
		return "monthly-report.pdf"
	}
	return "monthly-report.csv"
}

func redirectExportFilename(rawURL, format string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return defaultExportFilename(format)
	}
	filename := strings.TrimSpace(pathpkg.Base(parsed.Path))
	if filename == "" || filename == "." || filename == "/" {
		return defaultExportFilename(format)
	}
	return filename
}

func (h *Handler) loadAccessibleReport(
	w http.ResponseWriter,
	r *http.Request,
	reportID int64,
) (*MonthlyReportDetail, error) {
	detail, err := h.store.GetReport(r.Context(), reportID)
	if err != nil {
		h.writeError(w, err)
		return nil, err
	}
	if detail == nil {
		h.writeError(w, ErrReportNotFound)
		return nil, ErrReportNotFound
	}
	identity := requestIdentity(r)
	if err := h.store.VerifyProjectAccess(
		r.Context(),
		detail.Report.ProjectID,
		identity.Operator,
		identity.IsAdmin,
	); err != nil {
		h.writeError(w, err)
		return nil, err
	}
	return detail, nil
}

func (h *Handler) logActionTx(
	ctx context.Context,
	r *http.Request,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	if h.auditor == nil {
		return errors.New("audit service is nil")
	}
	identity := requestIdentity(r)
	if operator := strings.TrimSpace(identity.Operator); operator != "" {
		entry.Operator = &operator
	}
	entry.Result = "success"
	entry.PopulateFromRequest(r)
	return h.auditor.LogActionTx(ctx, tx, entry)
}

func (h *Handler) logAction(ctx context.Context, r *http.Request, entry audit.Entry) error {
	if h.auditor == nil {
		return errors.New("audit service is nil")
	}
	identity := requestIdentity(r)
	if operator := strings.TrimSpace(identity.Operator); operator != "" {
		entry.Operator = &operator
	}
	entry.Result = "success"
	entry.PopulateFromRequest(r)
	return h.auditor.LogAction(ctx, entry)
}

func (h *Handler) writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound),
		errors.Is(err, ErrReportNotFound),
		errors.Is(err, ErrExportNotFound),
		errors.Is(err, ErrTaskNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, err.Error())
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case errors.Is(err, ErrReportNotReady):
		httpapi.WriteDetail(w, http.StatusConflict, "Monthly report is not finished")
	case errors.Is(err, ErrTaskNotFinished):
		httpapi.WriteDetail(w, http.StatusConflict, "Task not finished")
	case errors.Is(err, ErrReportFinalized):
		httpapi.WriteDetail(w, http.StatusConflict, "Monthly report is already confirmed")
	case errors.Is(err, ErrAlreadyConfirmed):
		httpapi.WriteDetail(w, http.StatusConflict, "Monthly report is already confirmed")
	case errors.Is(err, ErrTransactionFileRequired):
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, ErrInvalidFinancialRange):
		httpapi.WriteDetail(w, http.StatusBadRequest, "start_month cannot be greater than end_month")
	default:
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

type generateRequest struct {
	ProjectID           *int64          `json:"project_id"`
	ProjectName         string          `json:"project_name"`
	Country             json.RawMessage `json:"country"`
	ReportMonth         string          `json:"report_month"`
	TransactionFileID   *string         `json:"transaction_file_id"`
	TransactionFilePath *string         `json:"transaction_file_path"`
	SummaryPDFFileID    *string         `json:"summary_pdf_file_id"`
	SummaryPDFFilePath  *string         `json:"summary_pdf_file_path"`
	Async               *bool           `json:"async"`
	Mode                string          `json:"mode"`
}

func parseReportID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	reportID, err := parseInteger(chi.URLParam(r, "report_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_id must be an integer")
		return 0, false
	}
	return reportID, true
}

func parseTaskID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	taskID, err := parseInteger(chi.URLParam(r, "task_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "task_id must be an integer")
		return 0, false
	}
	return taskID, true
}

func parseFinancialSeriesFilter(
	w http.ResponseWriter,
	r *http.Request,
) (MonthlyFinancialSeriesFilter, bool) {
	query := r.URL.Query()
	projectID, err := parsePositiveInt64(query.Get("project_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return MonthlyFinancialSeriesFilter{}, false
	}
	country, err := normalizeCountry(query.Get("country"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return MonthlyFinancialSeriesFilter{}, false
	}
	startMonth, ok := parseOptionalReportMonth(w, query.Get("start_month"), "start_month")
	if !ok {
		return MonthlyFinancialSeriesFilter{}, false
	}
	endMonth, ok := parseOptionalReportMonth(w, query.Get("end_month"), "end_month")
	if !ok {
		return MonthlyFinancialSeriesFilter{}, false
	}
	fillMissing := true
	if raw := strings.TrimSpace(query.Get("fill_missing")); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "fill_missing must be a boolean")
			return MonthlyFinancialSeriesFilter{}, false
		}
		fillMissing = value
	}
	return MonthlyFinancialSeriesFilter{
		ProjectID:   projectID,
		Country:     country,
		StartMonth:  startMonth,
		EndMonth:    endMonth,
		FillMissing: fillMissing,
	}, true
}

func parseAccountingFilter(
	w http.ResponseWriter,
	r *http.Request,
) (MonthlyFinancialAccountingFilter, bool) {
	query := r.URL.Query()
	projectID, err := parsePositiveInt64(query.Get("project_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return MonthlyFinancialAccountingFilter{}, false
	}
	country, err := normalizeCountry(query.Get("country"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return MonthlyFinancialAccountingFilter{}, false
	}
	rawMonth := strings.TrimSpace(query.Get("report_month"))
	if len(rawMonth) != len("2006-01") {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_month must be YYYY-MM")
		return MonthlyFinancialAccountingFilter{}, false
	}
	reportMonth, err := normalizeReportMonth(rawMonth)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "report_month must be YYYY-MM")
		return MonthlyFinancialAccountingFilter{}, false
	}
	return MonthlyFinancialAccountingFilter{
		ProjectID:   projectID,
		Country:     country,
		ReportMonth: reportMonth,
		IsAdmin:     requestIdentity(r).IsAdmin,
	}, true
}

func parseOptionalReportMonth(
	w http.ResponseWriter,
	raw string,
	field string,
) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", true
	}
	month, err := normalizeReportMonth(raw)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, field+" must be YYYY-MM")
		return "", false
	}
	return month, true
}

func normalizeReportMonth(raw string) (string, error) {
	parsed, err := time.Parse("2006-01", strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	return parsed.Format("2006-01"), nil
}

func parsePositiveInt64(raw string) (int64, error) {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		return 0, errors.New("must be positive")
	}
	return value, nil
}

func parseInteger(raw string) (int64, error) {
	return strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
}

func parseBoundedInt(raw string, minValue, maxValue int) (int, error) {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < minValue || value > maxValue {
		return 0, errors.New("out of range")
	}
	return value, nil
}

func parseYear(raw string) (int, error) {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) != 4 {
		return 0, errors.New("year must contain four digits")
	}
	return parseBoundedInt(trimmed, 1900, 9999)
}

func normalizeStatusFilter(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case MonthlyReportStatusPending:
		return MonthlyReportStatusPending, nil
	case "running", "calculating":
		return MonthlyReportStatusCalculating, nil
	case "success", "completed":
		return MonthlyReportStatusCompleted, nil
	case MonthlyReportStatusFailed:
		return MonthlyReportStatusFailed, nil
	default:
		return "", errors.New("invalid status")
	}
}

func monthlyReportCreateTargetType(canonical bool) string {
	if canonical {
		return "monthly_report_task"
	}
	return "monthly_report"
}

func monthlyReportCreateTargetID(report *MonthlyReport, canonical bool) int64 {
	if canonical {
		return report.JobID
	}
	return report.ID
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

func requestIdentity(r *http.Request) auth.UserContext {
	if identity, ok := auth.UserContextFromContext(r.Context()); ok {
		return identity
	}
	return auth.UserContextFromRequest(r)
}

func trimPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func resolveGenerationMode(async *bool, mode string) (bool, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	switch mode {
	case "", "async":
		if async == nil {
			return true, nil
		}
		if mode == "async" && !*async {
			return false, errors.New("async and mode cannot contradict each other")
		}
		return *async, nil
	case "immediate", "sync", "synchronous":
		if async != nil && *async {
			return false, errors.New("async and mode cannot contradict each other")
		}
		return false, nil
	default:
		return false, errors.New("mode must be one of: async, immediate")
	}
}

func stringPointer(value string) *string {
	return &value
}
