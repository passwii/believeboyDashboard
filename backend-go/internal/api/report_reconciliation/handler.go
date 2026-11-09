package report_reconciliation

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxReconciliationUploadBytes = 32 * 1024 * 1024

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

func (h *Handler) ListAvailableReports(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var projectID *int64
	if pidStr := q.Get("project_id"); pidStr != "" {
		pid, err := strconv.ParseInt(pidStr, 10, 64)
		if err != nil || pid <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
			return
		}
		projectID = &pid
	}
	var countryPtr, monthPtr *string
	if c := q.Get("country"); c != "" {
		countryPtr = &c
	}
	if m := q.Get("month"); m != "" {
		monthPtr = &m
	}

	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	filter := AvailableReportsFilter{
		ProjectID: projectID,
		Country:   countryPtr,
		Month:     monthPtr,
		Operator:  identity.Operator,
		IsAdmin:   identity.IsAdmin,
	}

	reports, err := h.store.GetAvailableReports(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if reports == nil {
		reports = []AvailableReportItem{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, AvailableReportsResponse{
		Reports: reports,
		Total:   len(reports),
	})
}

func (h *Handler) AutoReconcile(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	var req AutoReconcileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}
	if req.ReportID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_id must be greater than 0")
		return
	}
	if req.Tolerance <= 0 {
		req.Tolerance = 0.01
	}

	operator := identity.Operator
	if operator == "" {
		operator = "system"
	}

	resp, err := h.store.AutoReconcile(r.Context(), req, operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrReportNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("Report %d not found", req.ReportID))
			return
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetReconciliationHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var projectID *int64
	if pidStr := q.Get("project_id"); pidStr != "" {
		pid, err := strconv.ParseInt(pidStr, 10, 64)
		if err != nil || pid <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
			return
		}
		projectID = &pid
	}
	var monthPtr *string
	if m := q.Get("month"); m != "" {
		monthPtr = &m
	}
	limit := 50
	if lStr := q.Get("limit"); lStr != "" {
		l, err := strconv.Atoi(lStr)
		if err != nil || l < 1 || l > 200 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "limit must be between 1 and 200")
			return
		}
		limit = l
	}

	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	filter := HistoryFilter{
		ProjectID: projectID,
		Month:     monthPtr,
		Limit:     limit,
		Operator:  identity.Operator,
		IsAdmin:   identity.IsAdmin,
	}

	records, err := h.store.GetReconciliationHistory(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if records == nil {
		records = []ReconciliationRecordResponse{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, ReconciliationHistoryResponse{
		Records: records,
		Total:   len(records),
	})
}

func (h *Handler) ReconcileReports(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxReconciliationUploadBytes)
	if err := r.ParseMultipartForm(maxReconciliationUploadBytes); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid multipart form")
		return
	}

	excelFile, excelHeader, err := r.FormFile("excel_file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing excel_file")
		return
	}
	defer excelFile.Close()
	if strings.ToLower(filepath.Ext(excelHeader.Filename)) != ".xlsx" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Only XLSX files are allowed for excel_file")
		return
	}
	excelBytes, err := io.ReadAll(excelFile)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read excel_file")
		return
	}

	pdfFile, pdfHeader, err := r.FormFile("pdf_file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing pdf_file")
		return
	}
	defer pdfFile.Close()
	if strings.ToLower(filepath.Ext(pdfHeader.Filename)) != ".pdf" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Only PDF files are allowed for pdf_file")
		return
	}
	pdfBytes, err := io.ReadAll(pdfFile)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read pdf_file")
		return
	}

	tolerance := 0.01
	if tolStr := r.FormValue("tolerance"); tolStr != "" {
		if t, err := strconv.ParseFloat(tolStr, 64); err == nil && t >= 0 {
			tolerance = t
		}
	}

	var reportID *int64
	if repStr := r.URL.Query().Get("report_id"); repStr != "" {
		rep, err := strconv.ParseInt(repStr, 10, 64)
		if err != nil || rep < 1 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid report_id")
			return
		}
		reportID = &rep
	}

	operator := identity.Operator
	if operator == "" {
		operator = "manual"
	}

	result, err := h.store.ManualReconcile(r.Context(), reportID, excelBytes, pdfBytes, tolerance, operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrReportNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Report not found")
			return
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) UploadSummaryPdf(w http.ResponseWriter, r *http.Request) {
	reportID, err := strconv.ParseInt(chi.URLParam(r, "report_id"), 10, 64)
	if err != nil || reportID < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid report_id")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxReconciliationUploadBytes)
	if err := r.ParseMultipartForm(maxReconciliationUploadBytes); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid form")
		return
	}

	file, header, err := r.FormFile("pdf_file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing pdf_file")
		return
	}
	defer file.Close()

	if strings.ToLower(filepath.Ext(header.Filename)) != ".pdf" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Only PDF files are allowed")
		return
	}

	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	pdfBytes, err := io.ReadAll(file)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read PDF")
		return
	}
	resp, err := h.store.UploadSummaryPdf(r.Context(), reportID, header.Filename, pdfBytes, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrReportNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("Report %d not found", reportID))
			return
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) UploadTransactionCsv(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	reportID, err := strconv.ParseInt(chi.URLParam(r, "report_id"), 10, 64)
	if err != nil || reportID < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid report_id")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxReconciliationUploadBytes)
	if err := r.ParseMultipartForm(maxReconciliationUploadBytes); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid form")
		return
	}

	file, header, err := r.FormFile("csv_file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing csv_file")
		return
	}
	defer file.Close()

	if strings.ToLower(filepath.Ext(header.Filename)) != ".csv" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Only CSV files are allowed")
		return
	}

	csvBytes, err := io.ReadAll(file)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read CSV")
		return
	}
	resp, err := h.store.UploadTransactionCsv(r.Context(), reportID, header.Filename, csvBytes, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrReportNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("Report %d not found", reportID))
			return
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ExportPt3Data(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	reportID, err := strconv.ParseInt(chi.URLParam(r, "report_id"), 10, 64)
	if err != nil || reportID < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid report_id")
		return
	}

	filename, content, err := h.store.ExportPt3Data(r.Context(), reportID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if errors.Is(err, ErrReportNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("Report %d not found", reportID))
			return
		}
		if errors.Is(err, ErrPt3NotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "PT3 calculation not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	encodedFilename := url.QueryEscape(filename)
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8'%s", "pt3-data.xlsx", encodedFilename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func (h *Handler) DownloadPdf(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	reportID, err := strconv.ParseInt(chi.URLParam(r, "report_id"), 10, 64)
	if err != nil || reportID < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid report_id")
		return
	}

	filename, content, err := h.store.DownloadPdf(r.Context(), reportID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if errors.Is(err, ErrReportNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Report not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusNotFound, err.Error())
		return
	}

	encodedFilename := url.QueryEscape(filename)
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8'%s", "summary.pdf", encodedFilename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func (h *Handler) DownloadCsv(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	reportID, err := strconv.ParseInt(chi.URLParam(r, "report_id"), 10, 64)
	if err != nil || reportID < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid report_id")
		return
	}

	filename, content, err := h.store.DownloadCsv(r.Context(), reportID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrReportNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Report not found")
			return
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		httpapi.WriteDetail(w, http.StatusNotFound, err.Error())
		return
	}

	encodedFilename := url.QueryEscape(filename)
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8'%s", "tx.csv", encodedFilename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}
