package inspections

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxScreenshotBytes = int64(10 * 1024 * 1024)
	maxJSONBodyBytes   = int64(1 * 1024 * 1024)
	screenshotPrefix   = "inspection-screenshots/"
)

var allowedScreenshotExtensions = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".gif":  "image/gif",
}

var allowedScreenshotContentTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/webp": true,
	"image/gif":  true,
}

type Handler struct {
	store   Store
	blobs   BlobStore
	auditor audit.Service
}

func NewHandler(store Store, blobs BlobStore, auditor audit.Service) *Handler {
	return &Handler{store: store, blobs: blobs, auditor: auditor}
}

func (h *Handler) GetTemplate(w http.ResponseWriter, _ *http.Request) {
	_ = httpapi.WriteJSON(w, http.StatusOK, Template())
}

func (h *Handler) ListPeriods(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := parseInspectionPagination(w, r, 20, 100)
	if !ok {
		return
	}
	response, err := h.store.ListPeriods(r.Context(), limit, offset)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if response.Items == nil {
		response.Items = []Period{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (h *Handler) GetCurrentPeriod(w http.ResponseWriter, r *http.Request) {
	period, err := h.store.GetOrCreateCurrentPeriod(r.Context())
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, period)
}

func (h *Handler) GetPeriodOverview(w http.ResponseWriter, r *http.Request) {
	if !validateInspectionAdminHeader(w, r) {
		return
	}
	periodID, ok := parseInspectionPathID(w, r, "period_id")
	if !ok {
		return
	}
	identity := requestIdentity(r)
	response, err := h.store.GetOverview(
		r.Context(),
		periodID,
		identity.Operator,
		identity.IsAdmin,
	)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if response == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Period not found")
		return
	}
	h.decorateOverview(r.Context(), response)
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (h *Handler) GetReport(w http.ResponseWriter, r *http.Request) {
	if !validateInspectionAdminHeader(w, r) {
		return
	}
	periodID, projectID, ok := parseInspectionPeriodProject(w, r)
	if !ok {
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}
	report, err := h.store.GetReport(r.Context(), periodID, projectID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if report == nil {
		_ = httpapi.WriteJSON(w, http.StatusOK, nil)
		return
	}
	h.decorateReport(r.Context(), report)
	_ = httpapi.WriteJSON(w, http.StatusOK, report)
}

func (h *Handler) CreateOrUpdateReport(w http.ResponseWriter, r *http.Request) {
	if !validateInspectionAdminHeader(w, r) {
		return
	}
	periodID, projectID, ok := parseInspectionPeriodProject(w, r)
	if !ok {
		return
	}
	input, ok := decodeInspectionReportInput(w, r, false)
	if !ok {
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}
	period, err := h.store.GetPeriod(r.Context(), periodID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if period == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Period not found")
		return
	}

	var report *Report
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var writeErr error
		report, writeErr = txStore.CreateOrUpdateReport(ctx, periodID, projectID, input)
		if writeErr != nil {
			return writeErr
		}
		targetID := strconv.FormatInt(report.ID, 10)
		return h.auditTx(ctx, r, tx, audit.Entry{
			Action:     "inspection.save",
			TargetType: "inspection_report",
			TargetID:   &targetID,
			AfterJSON:  input.AuditPayload(),
		})
	})
	if err != nil {
		h.writeMutationError(w, err)
		return
	}
	h.decorateReport(r.Context(), report)
	_ = httpapi.WriteJSON(w, http.StatusCreated, report)
}

func (h *Handler) UpdateReport(w http.ResponseWriter, r *http.Request) {
	if !validateInspectionAdminHeader(w, r) {
		return
	}
	periodID, projectID, ok := parseInspectionPeriodProject(w, r)
	if !ok {
		return
	}
	input, ok := decodeInspectionReportInput(w, r, true)
	if !ok {
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}
	period, err := h.store.GetPeriod(r.Context(), periodID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if period == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Period not found")
		return
	}

	var report *Report
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var writeErr error
		report, writeErr = txStore.CreateOrUpdateReport(ctx, periodID, projectID, input)
		if writeErr != nil {
			return writeErr
		}
		targetID := strconv.FormatInt(report.ID, 10)
		return h.auditTx(ctx, r, tx, audit.Entry{
			Action:     "inspection.update",
			TargetType: "inspection_report",
			TargetID:   &targetID,
			AfterJSON:  input.AuditPayload(),
		})
	})
	if err != nil {
		h.writeMutationError(w, err)
		return
	}
	h.decorateReport(r.Context(), report)
	_ = httpapi.WriteJSON(w, http.StatusOK, report)
}

func (h *Handler) SubmitReport(w http.ResponseWriter, r *http.Request) {
	if !validateInspectionAdminHeader(w, r) {
		return
	}
	periodID, projectID, ok := parseInspectionPeriodProject(w, r)
	if !ok {
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}
	report, err := h.store.GetReport(r.Context(), periodID, projectID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if report == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Report not found. Create a draft first.")
		return
	}

	identity := requestIdentity(r)
	var operator *string
	if strings.TrimSpace(identity.Operator) != "" {
		operator = &identity.Operator
	}

	var submitted *Report
	var warnings []ThresholdWarning
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var submitErr error
		submitted, warnings, submitErr = txStore.SubmitReport(ctx, report.ID, operator)
		if submitErr != nil {
			return submitErr
		}
		targetID := strconv.FormatInt(submitted.ID, 10)
		var after map[string]any
		if len(warnings) > 0 {
			after = map[string]any{"warnings": warnings}
		}
		return h.auditTx(ctx, r, tx, audit.Entry{
			Action:     "inspection.submit",
			TargetType: "inspection_report",
			TargetID:   &targetID,
			AfterJSON:  after,
		})
	})
	if err != nil {
		h.writeMutationError(w, err)
		return
	}
	h.decorateReport(r.Context(), submitted)
	_ = httpapi.WriteJSON(w, http.StatusOK, submitted)
}

func (h *Handler) UploadScreenshot(w http.ResponseWriter, r *http.Request) {
	if !validateInspectionAdminHeader(w, r) {
		return
	}
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage is not configured. Please contact administrator.")
		return
	}

	reportIDFromQuery, ok := parseInspectionOptionalReportID(w, r)
	if !ok {
		return
	}
	file, header, reportIDFromForm, ok := readScreenshotMultipart(w, r)
	if !ok {
		return
	}
	defer file.Close()
	defer cleanupInspectionMultipart(r)

	reportID := reportIDFromForm
	if reportIDFromQuery != nil {
		reportID = reportIDFromQuery
	}
	if reportID == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_id is required")
		return
	}

	report, err := h.store.GetReportByID(r.Context(), *reportID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if report == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Report not found")
		return
	}
	if !h.requireProjectAccess(w, r, report.ProjectID) {
		return
	}

	filename, contentType, extension, data, err := readAndValidateScreenshot(header, file)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	projectName := strings.TrimSpace(report.ProjectName)
	if projectName == "" {
		projectName = "unknown"
	}
	objectKey, err := inspectionScreenshotObjectKey(projectName, report.ID, extension)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	publicURL, err := h.blobs.Put(r.Context(), objectKey, data, contentType)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage upload failed")
		return
	}

	var screenshot *ScreenshotRecord
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var insertErr error
		screenshot, insertErr = txStore.InsertScreenshot(ctx, InsertScreenshotInput{
			ReportID:    report.ID,
			R2Key:       objectKey,
			Filename:    filename,
			ContentType: contentType,
			FileSize:    int64(len(data)),
		})
		if insertErr != nil {
			return insertErr
		}
		targetID := strconv.FormatInt(screenshot.ID, 10)
		return h.auditTx(ctx, r, tx, audit.Entry{
			Action:     "inspection.upload_screenshot",
			TargetType: "inspection_screenshot",
			TargetID:   &targetID,
			AfterJSON: map[string]any{
				"report_id": report.ID,
				"r2_key":    objectKey,
				"filename":  filename,
				"file_size": len(data),
			},
		})
	})
	if err != nil {
		_ = h.blobs.Delete(r.Context(), objectKey)
		h.writeMutationError(w, err)
		return
	}

	item := screenshotItemFromRecord(*screenshot, safeBlobURL(publicURL))
	_ = httpapi.WriteJSON(w, http.StatusCreated, item)
}

func (h *Handler) DeleteScreenshot(w http.ResponseWriter, r *http.Request) {
	if !validateInspectionAdminHeader(w, r) {
		return
	}
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage is not configured. Please contact administrator.")
		return
	}
	screenshotID, ok := parseInspectionPathID(w, r, "screenshot_id")
	if !ok {
		return
	}
	screenshot, err := h.store.GetScreenshot(r.Context(), screenshotID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if screenshot == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Screenshot not found")
		return
	}
	if !h.requireProjectAccess(w, r, screenshot.ProjectID) {
		return
	}

	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		deleted, deleteErr := txStore.DeleteScreenshot(ctx, screenshotID)
		if deleteErr != nil {
			return deleteErr
		}
		if !deleted {
			return ErrScreenshotNotFound
		}
		targetID := strconv.FormatInt(screenshotID, 10)
		return h.auditTx(ctx, r, tx, audit.Entry{
			Action:     "inspection.delete_screenshot",
			TargetType: "inspection_screenshot",
			TargetID:   &targetID,
		})
	})
	if err != nil {
		h.writeMutationError(w, err)
		return
	}

	// The durable row is removed first. Blob cleanup is best-effort so a transient
	// storage failure cannot leave a live database row pointing at a deleted object.
	_ = h.blobs.Delete(r.Context(), screenshot.R2Key)
	if screenshot.ThumbnailKey != nil && strings.TrimSpace(*screenshot.ThumbnailKey) != "" {
		_ = h.blobs.Delete(r.Context(), *screenshot.ThumbnailKey)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) GetHistory(w http.ResponseWriter, r *http.Request) {
	if !validateInspectionAdminHeader(w, r) {
		return
	}
	limit, offset, ok := parseInspectionPagination(w, r, 50, 200)
	if !ok {
		return
	}
	periodID, ok := parseInspectionOptionalQueryID(w, r, "period_id")
	if !ok {
		return
	}
	if periodID != nil && *periodID == 0 {
		periodID = nil
	}
	projectID, ok := parseInspectionOptionalQueryID(w, r, "project_id")
	if !ok {
		return
	}
	if projectID != nil && *projectID == 0 {
		projectID = nil
	}
	if projectID != nil && *projectID != 0 {
		if !h.requireProjectAccess(w, r, *projectID) {
			return
		}
	}

	identity := requestIdentity(r)
	response, err := h.store.ListHistory(r.Context(), HistoryFilter{
		PeriodID:  periodID,
		ProjectID: projectID,
		Limit:     limit,
		Offset:    offset,
		Operator:  identity.Operator,
		IsAdmin:   identity.IsAdmin,
	})
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if response.Items == nil {
		response.Items = []HistoryItem{}
	}
	h.decorateHistory(r.Context(), &response)
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (h *Handler) requireProjectAccess(w http.ResponseWriter, r *http.Request, projectID int64) bool {
	identity := requestIdentity(r)
	err := h.store.VerifyProjectAccess(
		r.Context(),
		projectID,
		identity.Operator,
		identity.IsAdmin,
	)
	if err == nil {
		return true
	}
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	default:
		httpapi.WriteInternalServerError(w)
	}
	return false
}

func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	runner, ok := h.store.(TransactionRunner)
	if !ok {
		return fn(ctx, nil, h.store)
	}
	return runner.RunInTx(ctx, fn)
}

func (h *Handler) auditTx(
	ctx context.Context,
	r *http.Request,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	if h.auditor == nil {
		return ErrAuditUnavailable
	}
	identity := requestIdentity(r)
	if operator := strings.TrimSpace(identity.Operator); operator != "" {
		entry.Operator = &operator
	}
	entry.Result = "success"
	entry.PopulateFromRequest(r)
	if tx != nil {
		return h.auditor.LogActionTx(ctx, tx, entry)
	}
	return h.auditor.LogAction(ctx, entry)
}

func (h *Handler) writeMutationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case errors.Is(err, ErrPeriodNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "Period not found")
	case errors.Is(err, ErrReportNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "Report not found. Create a draft first.")
	case errors.Is(err, ErrScreenshotNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "Screenshot not found")
	case errors.Is(err, ErrConflict):
		httpapi.WriteDetail(w, http.StatusConflict, "Inspection report conflict")
	default:
		httpapi.WriteInternalServerError(w)
	}
}

func requestIdentity(r *http.Request) auth.UserContext {
	identity, _ := auth.UserContextFromContext(r.Context())
	return identity
}

func validateInspectionAdminHeader(w http.ResponseWriter, r *http.Request) bool {
	_, validationErr := httpapi.ParseOptionalBoolHeader(r, "X-Is-Admin")
	if validationErr == nil {
		return true
	}
	httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validationErr})
	return false
}

func parseInspectionPeriodProject(w http.ResponseWriter, r *http.Request) (int64, int64, bool) {
	periodID, ok := parseInspectionPathID(w, r, "period_id")
	if !ok {
		return 0, 0, false
	}
	projectID, ok := parseInspectionPathID(w, r, "project_id")
	if !ok {
		return 0, 0, false
	}
	return periodID, projectID, true
}

func parseInspectionPathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	value, err := strconv.ParseInt(strings.TrimSpace(chi.URLParam(r, name)), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid "+name)
		return 0, false
	}
	return value, true
}

func parseInspectionPagination(
	w http.ResponseWriter,
	r *http.Request,
	defaultLimit int,
	maxLimit int,
) (int, int, bool) {
	limit := defaultLimit
	limitParam, validationErr := httpapi.ParseIntegerQuery(r, "limit")
	if validationErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validationErr})
		return 0, 0, false
	}
	if minimumErr := httpapi.ValidateIntegerMinimum(limitParam, "limit", 1); minimumErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*minimumErr})
		return 0, 0, false
	}
	if maximumErr := httpapi.ValidateIntegerMaximum(limitParam, "limit", maxLimit); maximumErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*maximumErr})
		return 0, 0, false
	}
	if limitParam.Present {
		limit = limitParam.IntSaturated()
	}

	offsetParam, validationErr := httpapi.ParseIntegerQuery(r, "offset")
	if validationErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validationErr})
		return 0, 0, false
	}
	if minimumErr := httpapi.ValidateIntegerMinimum(offsetParam, "offset", 0); minimumErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*minimumErr})
		return 0, 0, false
	}
	offset := 0
	if offsetParam.Present {
		offset = offsetParam.IntSaturated()
	}
	return limit, offset, true
}

func parseInspectionOptionalQueryID(
	w http.ResponseWriter,
	r *http.Request,
	name string,
) (*int64, bool) {
	param, validationErr := httpapi.ParseIntegerQuery(r, name)
	if validationErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validationErr})
		return nil, false
	}
	if !param.Present {
		return nil, true
	}
	if !param.Value.IsInt64() {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" is out of range")
		return nil, false
	}
	value := param.Value.Int64()
	return &value, true
}

func parseInspectionOptionalReportID(
	w http.ResponseWriter,
	r *http.Request,
) (*int64, bool) {
	param, validationErr := httpapi.ParseIntegerQuery(r, "report_id")
	if validationErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validationErr})
		return nil, false
	}
	if !param.Present {
		return nil, true
	}
	if !param.Value.IsInt64() {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_id is out of range")
		return nil, false
	}
	value := param.Value.Int64()
	return &value, true
}

func decodeInspectionReportInput(
	w http.ResponseWriter,
	r *http.Request,
	update bool,
) (ReportWriteInput, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()

	var raw map[string]json.RawMessage
	if err := decoder.Decode(&raw); err != nil || raw == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return ReportWriteInput{}, false
	}
	if err := ensureInspectionJSONEOF(decoder); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return ReportWriteInput{}, false
	}

	input := ReportWriteInput{}
	if value, present := raw["health_data"]; present {
		var healthData *HealthData
		if err := json.Unmarshal(value, &healthData); err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid health_data")
			return ReportWriteInput{}, false
		}
		input.HealthDataSet = true
		input.HealthData = healthData
	}
	if value, present := raw["compliance_data"]; present {
		var complianceData *ComplianceData
		if err := json.Unmarshal(value, &complianceData); err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid compliance_data")
			return ReportWriteInput{}, false
		}
		input.ComplianceDataSet = true
		input.ComplianceData = complianceData
	}
	if value, present := raw["status_summary"]; present {
		var statusSummary *string
		if err := json.Unmarshal(value, &statusSummary); err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid status_summary")
			return ReportWriteInput{}, false
		}
		input.StatusSummarySet = true
		input.StatusSummary = statusSummary
	}
	if value, present := raw["screenshot_ids"]; present {
		input.ScreenshotIDsSet = true
		if string(value) == "null" {
			if !update {
				httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid screenshot_ids")
				return ReportWriteInput{}, false
			}
		} else if err := json.Unmarshal(value, &input.ScreenshotIDs); err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid screenshot_ids")
			return ReportWriteInput{}, false
		}
	}
	return input, true
}

func ensureInspectionJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func readScreenshotMultipart(
	w http.ResponseWriter,
	r *http.Request,
) (multipart.File, *multipart.FileHeader, *int64, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxScreenshotBytes+2*1024*1024)
	if err := r.ParseMultipartForm(maxScreenshotBytes); err != nil {
		if inspectionMultipartTooLarge(err) {
			httpapi.WriteDetail(w, http.StatusBadRequest, "File too large")
		} else {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid multipart form")
		}
		return nil, nil, nil, false
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		cleanupInspectionMultipart(r)
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "file is required")
		return nil, nil, nil, false
	}
	if header == nil || strings.TrimSpace(header.Filename) == "" {
		_ = file.Close()
		cleanupInspectionMultipart(r)
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "file is required")
		return nil, nil, nil, false
	}

	var reportID *int64
	if raw := strings.TrimSpace(r.FormValue("report_id")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			_ = file.Close()
			cleanupInspectionMultipart(r)
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid report_id")
			return nil, nil, nil, false
		}
		reportID = &value
	}
	return file, header, reportID, true
}

func cleanupInspectionMultipart(r *http.Request) {
	if r.MultipartForm != nil {
		_ = r.MultipartForm.RemoveAll()
	}
}

func inspectionMultipartTooLarge(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "request body too large") ||
		strings.Contains(message, "max bytes")
}

func readAndValidateScreenshot(
	header *multipart.FileHeader,
	file multipart.File,
) (string, string, string, []byte, error) {
	if header.Size > maxScreenshotBytes {
		return "", "", "", nil, fmt.Errorf(
			"File too large: %d bytes (max %d)",
			header.Size,
			maxScreenshotBytes,
		)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxScreenshotBytes+1))
	if err != nil {
		return "", "", "", nil, errors.New("Failed to read file")
	}
	if int64(len(data)) > maxScreenshotBytes {
		return "", "", "", nil, fmt.Errorf(
			"File too large: %d bytes (max %d)",
			len(data),
			maxScreenshotBytes,
		)
	}
	if len(data) == 0 {
		return "", "", "", nil, errors.New("File is empty")
	}

	filename := sanitizeInspectionFilename(header.Filename)
	if filename == "" {
		return "", "", "", nil, errors.New("Missing filename")
	}
	extension := strings.ToLower(path.Ext(filename))
	expectedContentType, allowed := allowedScreenshotExtensions[extension]
	if !allowed {
		return "", "", "", nil, fmt.Errorf("Unsupported image extension: %s", extension)
	}

	declaredContentType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	if parsed, _, err := mime.ParseMediaType(declaredContentType); err == nil {
		declaredContentType = strings.ToLower(parsed)
	}
	if declaredContentType == "" {
		return "", "", "", nil, errors.New("Missing image content type")
	}
	if !allowedScreenshotContentTypes[declaredContentType] {
		return "", "", "", nil, fmt.Errorf("Unsupported image type: %s", declaredContentType)
	}
	if declaredContentType != expectedContentType {
		return "", "", "", nil, fmt.Errorf(
			"Image extension %s does not match content type %s",
			extension,
			declaredContentType,
		)
	}
	if detected := detectInspectionImageMIME(data); detected != declaredContentType {
		return "", "", "", nil, fmt.Errorf(
			"Image content does not match content type %s",
			declaredContentType,
		)
	}
	return filename, declaredContentType, extension, data, nil
}

func detectInspectionImageMIME(data []byte) string {
	switch {
	case len(data) >= 3 &&
		data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg"
	case len(data) >= 8 &&
		data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4e && data[3] == 0x47 &&
		data[4] == 0x0d && data[5] == 0x0a && data[6] == 0x1a && data[7] == 0x0a:
		return "image/png"
	case len(data) >= 6 &&
		(data[0] == 'G' && data[1] == 'I' && data[2] == 'F' &&
			data[3] == '8' && (data[4] == '7' || data[4] == '9') && data[5] == 'a'):
		return "image/gif"
	case len(data) >= 12 &&
		string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp"
	default:
		return http.DetectContentType(data)
	}
}

func sanitizeInspectionFilename(raw string) string {
	raw = strings.ReplaceAll(raw, "\\", "/")
	base := path.Base(raw)
	if base == "." || base == "/" {
		return ""
	}
	var builder strings.Builder
	for _, char := range base {
		switch {
		case char == '\r' || char == '\n' || char == '\t':
			builder.WriteRune('_')
		case unicode.IsControl(char):
			continue
		default:
			builder.WriteRune(char)
		}
	}
	filename := strings.TrimSpace(builder.String())
	runes := []rune(filename)
	if len(runes) > 256 {
		filename = string(runes[:256])
	}
	return filename
}

func inspectionScreenshotObjectKey(projectName string, reportID int64, extension string) (string, error) {
	if reportID <= 0 {
		return "", errors.New("invalid report id")
	}
	extension = strings.ToLower(path.Ext(extension))
	if _, allowed := allowedScreenshotExtensions[extension]; !allowed {
		return "", errors.New("invalid image extension")
	}

	projectSegment := sanitizeInspectionPathSegment(projectName)
	objectID, err := inspectionRandomID()
	if err != nil {
		return "", err
	}
	key := screenshotPrefix + projectSegment + "/report_" +
		strconv.FormatInt(reportID, 10) + "/" + objectID + extension
	if !inspectionSafeObjectKey(key) {
		return "", errors.New("unsafe screenshot object key")
	}
	return key, nil
}

func sanitizeInspectionPathSegment(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	var builder strings.Builder
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z',
			char >= 'A' && char <= 'Z',
			char >= '0' && char <= '9',
			char >= 0x80 && unicode.IsLetter(char),
			char == '-' || char == '_':
			builder.WriteRune(char)
		default:
			builder.WriteRune('_')
		}
	}
	segment := strings.Trim(builder.String(), "_")
	if segment == "" || segment == "." || segment == ".." {
		return "unknown"
	}
	runes := []rune(segment)
	if len(runes) > 80 {
		segment = string(runes[:80])
	}
	return segment
}

func inspectionSafeObjectKey(key string) bool {
	if key == "" || strings.Contains(key, "\\") {
		return false
	}
	if strings.HasPrefix(key, "/") || path.IsAbs(key) {
		return false
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	cleaned := path.Clean(key)
	return cleaned == key && strings.HasPrefix(cleaned, strings.TrimSuffix(screenshotPrefix, "/")+"/")
}

func inspectionRandomID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%s-%s-%s-%s-%s",
		hex.EncodeToString(raw[0:4]),
		hex.EncodeToString(raw[4:6]),
		hex.EncodeToString(raw[6:8]),
		hex.EncodeToString(raw[8:10]),
		hex.EncodeToString(raw[10:16]),
	), nil
}

func safeBlobURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, "\r\n") {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return ""
	}
	return parsed.String()
}

func (h *Handler) screenshotURL(ctx context.Context, key, existingURL string) string {
	if safe := safeBlobURL(existingURL); safe != "" {
		return safe
	}
	resolver, ok := h.blobs.(BlobURLResolver)
	if !ok || strings.TrimSpace(key) == "" {
		return ""
	}
	resolved, err := resolver.Presign(ctx, key)
	if err != nil {
		return ""
	}
	return safeBlobURL(resolved)
}

func (h *Handler) decorateReport(ctx context.Context, report *Report) {
	if report == nil {
		return
	}
	if report.Screenshots == nil {
		report.Screenshots = []ScreenshotItem{}
	}
	for index := range report.Screenshots {
		shot := &report.Screenshots[index]
		shot.URL = h.screenshotURL(ctx, shot.R2Key, shot.URL)
		if shot.ThumbnailKey != nil {
			shot.ThumbnailURL = inspectionURLPointer(
				h.screenshotURL(ctx, *shot.ThumbnailKey, ""),
			)
		}
	}
}

func (h *Handler) decorateOverview(ctx context.Context, response *OverviewResponse) {
	if response.Items == nil {
		response.Items = []OverviewItem{}
	}
	for itemIndex := range response.Items {
		item := &response.Items[itemIndex]
		if item.Screenshots == nil {
			item.Screenshots = []OverviewScreenshot{}
		}
		for shotIndex := range item.Screenshots {
			shot := &item.Screenshots[shotIndex]
			shot.URL = h.screenshotURL(ctx, shot.R2Key, shot.URL)
			if shot.ThumbnailKey != nil {
				shot.ThumbnailURL = inspectionURLPointer(
					h.screenshotURL(ctx, *shot.ThumbnailKey, ""),
				)
			}
		}
	}
	response.TotalProjects = len(response.Items)
	response.SubmittedCount = 0
	response.OverdueCount = 0
	for _, item := range response.Items {
		switch item.Status {
		case "submitted":
			response.SubmittedCount++
		case "overdue":
			response.OverdueCount++
		}
	}
}

func (h *Handler) decorateHistory(ctx context.Context, response *HistoryResponse) {
	if response.Items == nil {
		response.Items = []HistoryItem{}
	}
	for itemIndex := range response.Items {
		item := &response.Items[itemIndex]
		if item.Screenshots == nil {
			item.Screenshots = []HistoryScreenshot{}
		}
		for shotIndex := range item.Screenshots {
			shot := &item.Screenshots[shotIndex]
			shot.URL = h.screenshotURL(ctx, shot.R2Key, shot.URL)
			if shot.ThumbnailKey != nil {
				shot.ThumbnailURL = inspectionURLPointer(
					h.screenshotURL(ctx, *shot.ThumbnailKey, ""),
				)
			}
		}
	}
}

func inspectionURLPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func screenshotItemFromRecord(record ScreenshotRecord, publicURL string) ScreenshotItem {
	item := ScreenshotItem{
		ID:           record.ID,
		R2Key:        record.R2Key,
		ThumbnailKey: record.ThumbnailKey,
		Filename:     record.Filename,
		ContentType:  record.ContentType,
		FileSize:     record.FileSize,
		Caption:      record.Caption,
		SortOrder:    record.SortOrder,
		URL:          safeBlobURL(publicURL),
		CreatedAt:    record.CreatedAt,
	}
	return item
}
