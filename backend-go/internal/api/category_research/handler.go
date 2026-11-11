package category_research

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxCategoryResearchFileBytes = 50 * 1024 * 1024
	maxCategoryResearchFormBytes = maxCategoryResearchFileBytes + 1024*1024
)

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

func (h *Handler) ListDatasets(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var mpPtr, kwPtr *string
	if m := q.Get("marketplace"); m != "" {
		mpPtr = &m
	}
	if k := q.Get("category_keyword_en"); k != "" {
		kwPtr = &k
	}
	currentOnly := true
	if cStr := q.Get("current_only"); cStr == "false" || cStr == "0" {
		currentOnly = false
	}
	if incHist := q.Get("include_history"); incHist == "true" || incHist == "1" {
		currentOnly = false
	}

	filter := CategoryResearchFilter{
		Marketplace:       mpPtr,
		CategoryKeywordEn: kwPtr,
		CurrentOnly:       currentOnly,
	}

	rows, err := h.store.ListDatasets(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if rows == nil {
		rows = []CategoryResearchDatasetItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, rows)
}

func (h *Handler) ImportDataset(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxCategoryResearchFormBytes)
	if err := r.ParseMultipartForm(8 * 1024 * 1024); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "File size exceeds 50MB")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid multipart form")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file")
		return
	}
	defer file.Close()

	filename := path.Base(strings.ReplaceAll(strings.TrimSpace(header.Filename), "\\", "/"))
	extension := strings.ToLower(path.Ext(filename))
	if extension != ".xlsx" && extension != ".csv" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Unsupported file extension; only .xlsx and .csv are allowed")
		return
	}
	if header.Size <= 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Empty file")
		return
	}
	if header.Size > maxCategoryResearchFileBytes {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "File size exceeds 50MB")
		return
	}
	fileBytes, err := io.ReadAll(io.LimitReader(file, maxCategoryResearchFileBytes+1))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read uploaded file")
		return
	}
	if len(fileBytes) > maxCategoryResearchFileBytes {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "File size exceeds 50MB")
		return
	}
	if len(fileBytes) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Empty file")
		return
	}
	marketplace := r.FormValue("marketplace")
	if marketplace == "" {
		marketplace = "US"
	}
	keywordEn := strings.TrimSpace(r.FormValue("category_keyword_en"))
	nameZh := strings.TrimSpace(r.FormValue("category_name_zh"))

	if keywordEn == "" || nameZh == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "category_keyword_en and category_name_zh are required")
		return
	}

	createdBy := identity.Operator
	if createdBy == "" {
		createdBy = "system"
	}

	resp, err := h.store.ImportDataset(r.Context(), marketplace, keywordEn, nameZh, filename, fileBytes, createdBy)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetDataset(w http.ResponseWriter, r *http.Request) {
	datasetID, err := strconv.ParseInt(chi.URLParam(r, "dataset_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid dataset_id")
		return
	}

	priceBandStandard := r.URL.Query().Get("price_band_standard")
	if priceBandStandard == "" {
		priceBandStandard = "default"
	}
	priceBandBreaks := r.URL.Query().Get("price_band_breaks")

	overview, err := h.store.GetDatasetOverview(r.Context(), datasetID, priceBandStandard, priceBandBreaks)
	if err != nil {
		if errors.Is(err, ErrDatasetNotFound) || strings.Contains(err.Error(), "Dataset not found") {
			httpapi.WriteDetail(w, http.StatusNotFound, "Dataset not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, overview)
}

func (h *Handler) RecomputeDataset(w http.ResponseWriter, r *http.Request) {
	datasetID, err := strconv.ParseInt(chi.URLParam(r, "dataset_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid dataset_id")
		return
	}

	resp, err := h.store.RecomputeDataset(r.Context(), datasetID)
	if err != nil {
		if errors.Is(err, ErrDatasetNotFound) || strings.Contains(err.Error(), "Dataset not found") {
			httpapi.WriteDetail(w, http.StatusNotFound, "Dataset not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) BatchRecomputeDatasets(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var mpPtr, kwPtr *string
	if m := q.Get("marketplace"); m != "" {
		mpPtr = &m
	}
	if k := q.Get("category_keyword_en"); k != "" {
		kwPtr = &k
	}
	includeHistory := true
	if incStr := q.Get("include_history"); incStr == "false" || incStr == "0" {
		includeHistory = false
	}

	resp, err := h.store.BatchRecomputeDatasets(r.Context(), mpPtr, kwPtr, includeHistory)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ListProducts(w http.ResponseWriter, r *http.Request) {
	datasetID, err := strconv.ParseInt(chi.URLParam(r, "dataset_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid dataset_id")
		return
	}

	q := r.URL.Query()
	page := 1
	if p, err := strconv.Atoi(q.Get("page")); err == nil && p >= 1 {
		page = p
	}
	pageSize := 100
	if ps, err := strconv.Atoi(q.Get("page_size")); err == nil && ps >= 1 {
		pageSize = min(ps, 500)
	}

	var brandPtr, fmPtr, pbPtr, pbStdPtr, pbBreaksPtr *string
	if b := q.Get("brand"); b != "" {
		brandPtr = &b
	}
	if fm := q.Get("fulfillment_method"); fm != "" {
		fmPtr = &fm
	}
	if pb := q.Get("price_band"); pb != "" {
		pbPtr = &pb
	}
	std := q.Get("price_band_standard")
	if std == "" {
		std = "default"
	}
	pbStdPtr = &std
	if brk := q.Get("price_band_breaks"); brk != "" {
		pbBreaksPtr = &brk
	}

	filter := CategoryResearchProductsFilter{
		DatasetID:         datasetID,
		Page:              page,
		PageSize:          pageSize,
		Brand:             brandPtr,
		FulfillmentMethod: fmPtr,
		PriceBand:         pbPtr,
		PriceBandStandard: pbStdPtr,
		PriceBandBreaks:   pbBreaksPtr,
	}

	rows, hasNext, err := h.store.ListProducts(r.Context(), filter)
	if err != nil {
		if errors.Is(err, ErrDatasetNotFound) || strings.Contains(err.Error(), "Dataset not found") {
			httpapi.WriteDetail(w, http.StatusNotFound, "Dataset not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	if rows == nil {
		rows = []CategoryResearchProductRow{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, CategoryResearchProductsResponse{
		DatasetID: datasetID,
		Page:      page,
		PageSize:  pageSize,
		HasNext:   hasNext,
		Rows:      rows,
	})
}

func (h *Handler) UpsertManualDimensions(w http.ResponseWriter, r *http.Request) {
	datasetID, err := strconv.ParseInt(chi.URLParam(r, "dataset_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid dataset_id")
		return
	}

	var payload CategoryResearchManualDimensionUpsertRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}

	updatedCount, err := h.store.UpsertManualDimensions(r.Context(), datasetID, payload.Items)
	if err != nil {
		if errors.Is(err, ErrDatasetNotFound) || strings.Contains(err.Error(), "Dataset not found") {
			httpapi.WriteDetail(w, http.StatusNotFound, "Dataset not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, CategoryResearchManualDimensionUpsertResponse{
		DatasetID:    datasetID,
		UpdatedCount: updatedCount,
	})
}

func (h *Handler) GetTrend(w http.ResponseWriter, r *http.Request) {
	datasetID, err := strconv.ParseInt(chi.URLParam(r, "dataset_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid dataset_id")
		return
	}

	asin := strings.TrimSpace(r.URL.Query().Get("asin"))
	if asin == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "asin is required")
		return
	}

	points, err := h.store.GetTrend(r.Context(), datasetID, asin)
	if err != nil {
		if errors.Is(err, ErrDatasetNotFound) || strings.Contains(err.Error(), "Dataset not found") {
			httpapi.WriteDetail(w, http.StatusNotFound, "Dataset not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	if points == nil {
		points = []CategoryResearchTrendPoint{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, CategoryResearchTrendResponse{
		DatasetID: datasetID,
		ASIN:      strings.ToUpper(asin),
		Points:    points,
	})
}

func (h *Handler) GetMarketTrend(w http.ResponseWriter, r *http.Request) {
	datasetID, err := strconv.ParseInt(chi.URLParam(r, "dataset_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid dataset_id")
		return
	}

	months := 24
	if mStr := r.URL.Query().Get("months"); mStr != "" {
		if m, err := strconv.Atoi(mStr); err == nil && m >= 1 {
			months = min(m, 60)
		}
	}

	points, err := h.store.GetMarketTrend(r.Context(), datasetID, months)
	if err != nil {
		if errors.Is(err, ErrDatasetNotFound) || strings.Contains(err.Error(), "Dataset not found") {
			httpapi.WriteDetail(w, http.StatusNotFound, "Dataset not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	if points == nil {
		points = []CategoryResearchMarketTrendPoint{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, CategoryResearchMarketTrendResponse{
		DatasetID: datasetID,
		Months:    months,
		Points:    points,
	})
}

func (h *Handler) ListExports(w http.ResponseWriter, r *http.Request) {
	datasetID, err := strconv.ParseInt(chi.URLParam(r, "dataset_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid dataset_id")
		return
	}

	items, err := h.store.ListExports(r.Context(), datasetID)
	if err != nil {
		if errors.Is(err, ErrDatasetNotFound) || strings.Contains(err.Error(), "Dataset not found") {
			httpapi.WriteDetail(w, http.StatusNotFound, "Dataset not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	if items == nil {
		items = []CategoryResearchExportItem{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, CategoryResearchExportListResponse{
		DatasetID: datasetID,
		Items:     items,
	})
}

func (h *Handler) DownloadExport(w http.ResponseWriter, r *http.Request) {
	datasetID, err := strconv.ParseInt(chi.URLParam(r, "dataset_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid dataset_id")
		return
	}

	exportKey := chi.URLParam(r, "export_key")
	priceBandStandard := r.URL.Query().Get("price_band_standard")
	priceBandBreaks := r.URL.Query().Get("price_band_breaks")

	filename, content, err := h.store.GetExportData(r.Context(), datasetID, exportKey, priceBandStandard, priceBandBreaks)
	if err != nil {
		if errors.Is(err, ErrDatasetNotFound) || strings.Contains(err.Error(), "Dataset not found") {
			httpapi.WriteDetail(w, http.StatusNotFound, "Dataset not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	encodedFilename := url.QueryEscape(filename)
	contentType := "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	switch {
	case strings.HasSuffix(strings.ToLower(filename), ".pdf"):
		contentType = "application/pdf"
	case strings.HasSuffix(strings.ToLower(filename), ".zip"):
		contentType = "application/zip"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8'%s", filename, encodedFilename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}
