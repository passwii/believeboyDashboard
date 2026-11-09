package ad_upload

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxUploadBytes        = 50 * 1024 * 1024 // 50MB
	maxUploadRequestBytes = maxUploadBytes + 2*1024*1024
)

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

func (h *Handler) Recognize(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadRequestBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file in multipart form")
		return
	}
	defer file.Close()

	filename := header.Filename
	if filename == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing filename")
		return
	}
	if filepath.IsAbs(filename) || strings.Contains(filename, `\`) || strings.Contains(filename, "/") || strings.Contains(filename, "..") {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid filename path")
		return
	}
	ext := strings.ToLower(filepath.Ext(filename))
	if ext != ".csv" && ext != ".xlsx" {
		httpapi.WriteDetail(w, http.StatusBadRequest, fmt.Sprintf("Unsupported extension: %s (expected: .csv, .xlsx)", ext))
		return
	}

	data, err := io.ReadAll(file)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		return
	}
	if len(data) > maxUploadBytes {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "File exceeds 50MB limit")
		return
	}

	country := strings.ToUpper(strings.TrimSpace(r.FormValue("country")))
	if country == "" {
		country = "US"
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	resp, err := h.store.Recognize(r.Context(), filename, data, country, identity.Operator, identity.IsAdmin)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) Commit(w http.ResponseWriter, r *http.Request) {
	var req AdUploadCommitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if req.TempFileID == "" || req.ReportType == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "temp_file_id and report_type are required")
		return
	}
	if req.Country == "" {
		req.Country = "US"
	} else {
		req.Country = strings.ToUpper(strings.TrimSpace(req.Country))
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	resp, err := h.store.Commit(r.Context(), req, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		if errors.Is(err, ErrTypeMismatch) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_type does not match recognized report")
			return
		}
		if strings.Contains(err.Error(), "422") || strings.Contains(err.Error(), "必须与") {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	if h.auditor != nil && !req.DryRun {
		fileIdStr := fmt.Sprintf("%d", resp.ID)
		entry := audit.Entry{
			Action:     "ad_upload.commit",
			TargetType: "ad_upload",
			TargetID:   &fileIdStr,
			Operator:   &identity.Operator,
			AfterJSON:  resp,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}

	var projectName *string
	if v := strings.TrimSpace(r.URL.Query().Get("project_name")); v != "" {
		projectName = &v
	}

	var reportType *string
	if v := strings.TrimSpace(r.URL.Query().Get("report_type")); v != "" {
		reportType = &v
	}

	var reportDate *string
	if v := strings.TrimSpace(r.URL.Query().Get("report_date")); v != "" {
		reportDate = &v
	}

	limit := 50
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 200 {
			limit = n
		}
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	filter := AdUploadStatusFilter{
		Country:     country,
		ProjectName: projectName,
		ReportType:  reportType,
		ReportDate:  reportDate,
		Limit:       limit,
		Operator:    identity.Operator,
		IsAdmin:     identity.IsAdmin,
	}

	resp, err := h.store.ListStatus(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}
