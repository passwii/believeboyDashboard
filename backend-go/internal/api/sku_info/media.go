package sku_info

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/ledongthuc/pdf"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxFNSKULabelPDFBytes      = 20 << 20
	maxProductImageBytes       = 10 << 20
	maxBatchFNSKULabelBytes    = 20 << 20
	maxBatchFNSKUArchiveBytes  = 100 << 20
	maxBatchFNSKULabelCount    = 500
	maxSKUMediaRequestOverhead = 2 << 20
	maxSKUMediaJSONBody        = 1 << 20
	skuMediaDeleteTimeout      = 5 * time.Second
	skuProductThumbnailSize    = 320
	maxSKUImagePixels          = 40_000_000
)

var (
	fnskuExplicitPattern  = regexp.MustCompile(`FNSKU[:\s]*([0-9A-Z]{10,14})`)
	fnskuCandidatePattern = regexp.MustCompile(`\b(X[0-9A-Z]{9,12})\b`)
)

type BlobStore interface {
	Put(context.Context, string, []byte, string) (string, error)
	Get(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
}

// FileStore is the optional SKU persistence surface for media and batch
// download routes. Keeping it separate preserves the base Store contract for
// domains that do not own file handling.
type FileStore interface {
	SetFnskuLabel(
		context.Context,
		int64,
		string,
		string,
		audit.Entry,
	) (*SkuRecordItem, *string, error)
	SetProductImage(
		context.Context,
		int64,
		string,
		string,
		string,
		string,
		time.Time,
		string,
		audit.Entry,
	) (*SkuRecordItem, []string, error)
	ClearProductImage(context.Context, int64, audit.Entry) (*SkuRecordItem, []string, error)
	GetSkuRecordsByIDs(context.Context, []int64) ([]SkuRecordItem, error)
}

func (h *Handler) UploadFnskuLabel(w http.ResponseWriter, r *http.Request) {
	recordID, ok := mediaRecordID(w, r)
	if !ok {
		return
	}
	record, ok := h.authorizedMediaRecord(w, r, recordID)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储未配置")
		return
	}
	fileStore, ok := h.store.(FileStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "SKU file store is unavailable")
		return
	}

	filename, contentType, data, ok := readSKUMediaFile(
		w, r, maxFNSKULabelPDFBytes, false,
	)
	if !ok {
		return
	}
	if !strings.EqualFold(filepath.Ext(filename), ".pdf") {
		httpapi.WriteDetail(w, http.StatusBadRequest, "仅支持 PDF 文件")
		return
	}
	if contentType != "" && contentType != "application/pdf" &&
		contentType != "application/octet-stream" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "仅支持 PDF 文件")
		return
	}
	if !bytes.HasPrefix(bytes.TrimSpace(data), []byte("%PDF-")) {
		httpapi.WriteDetail(w, http.StatusBadRequest, "文件不是有效的 PDF")
		return
	}

	randomID, err := randomSKUMediaID()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	key, err := blob.ObjectKey(
		"sku-info",
		"fnsku-labels",
		strconv.FormatInt(record.ProjectID, 10),
		strconv.FormatInt(record.ID, 10),
		randomID+".pdf",
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	publicURL, err := h.blobs.Put(r.Context(), key, data, "application/pdf")
	if err != nil || strings.TrimSpace(publicURL) == "" {
		bestEffortSKUMediaDelete(r.Context(), h.blobs, key)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储上传失败")
		return
	}
	publicURL = strings.TrimSpace(publicURL)

	verification := verifyFNSKULabel(extractFNSKUText(data), record.FNSKU)
	identity, _ := auth.UserContextFromContext(r.Context())
	entry := mediaAuditEntry(
		r,
		identity,
		"sku_info.upload_fnsku_label",
		record.ID,
		map[string]any{
			"sku":                record.SKU,
			"fnsku_label_r2_key": key,
			"file_size":          len(data),
			"fnsku_verified":     verification.Verified,
			"fnsku_found_in_pdf": verification.Found,
		},
	)
	_, previousKey, err := fileStore.SetFnskuLabel(
		r.Context(), record.ID, key, publicURL, entry,
	)
	if err != nil {
		bestEffortSKUMediaDelete(r.Context(), h.blobs, key)
		writeSKUMediaStoreError(w, err)
		return
	}
	if previousKey != nil && strings.TrimSpace(*previousKey) != "" &&
		*previousKey != key {
		bestEffortSKUMediaDelete(r.Context(), h.blobs, *previousKey)
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, FnskuLabelUploadResponse{
		SkuRecordID:              record.ID,
		FnskuLabelR2Key:          key,
		FnskuLabelR2URL:          publicURL,
		FnskuVerified:            verification.Verified,
		FnskuFoundInPDF:          verification.Found,
		FnskuVerificationMessage: verification.Message,
	})
}

func (h *Handler) DownloadFnskuLabel(w http.ResponseWriter, r *http.Request) {
	recordID, ok := mediaRecordID(w, r)
	if !ok {
		return
	}
	record, ok := h.authorizedMediaRecord(w, r, recordID)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储未配置")
		return
	}
	if record.FnskuLabelR2Key == nil || strings.TrimSpace(*record.FnskuLabelR2Key) == "" {
		httpapi.WriteDetail(w, http.StatusNotFound, "该 SKU 暂无 FNSKU 标签")
		return
	}

	reader, err := h.blobs.Get(r.Context(), *record.FnskuLabelR2Key)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储读取失败")
		return
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, maxFNSKULabelPDFBytes+1))
	if err != nil || len(data) > maxFNSKULabelPDFBytes ||
		!bytes.HasPrefix(bytes.TrimSpace(data), []byte("%PDF-")) {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "FNSKU 标签文件不可用")
		return
	}

	filename := safeSKUDownloadName(record.SKU) + "-fnsku-label.pdf"
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", contentDisposition(filename))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (h *Handler) BatchDownloadFnskuLabels(w http.ResponseWriter, r *http.Request) {
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储未配置")
		return
	}
	var request BatchFnskuLabelDownloadRequest
	if err := decodeSKUMediaJSON(w, r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	ids, err := validateBatchFnskuIDs(request.SkuRecordIDs)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	fileStore, ok := h.store.(FileStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "SKU file store is unavailable")
		return
	}

	records, err := fileStore.GetSkuRecordsByIDs(r.Context(), ids)
	if err != nil {
		writeSKUMediaStoreError(w, err)
		return
	}
	byID := make(map[int64]SkuRecordItem, len(records))
	for _, record := range records {
		byID[record.ID] = record
	}
	if len(records) == 0 {
		httpapi.WriteDetail(w, http.StatusNotFound, "未找到匹配的 SKU 记录")
		return
	}
	for _, id := range ids {
		if _, exists := byID[id]; !exists {
			httpapi.WriteDetail(w, http.StatusNotFound, "部分 SKU 记录不存在")
			return
		}
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	checkedProjects := make(map[int64]bool)
	labeled := make([]SkuRecordItem, 0, len(ids))
	for _, id := range ids {
		record := byID[id]
		if record.ProjectID > 0 && !checkedProjects[record.ProjectID] {
			if err := h.checkProjectAccess(
				r.Context(), record.ProjectID, record.ProjectName, identity,
			); err != nil {
				writeSKUMediaAccessError(w, err)
				return
			}
			checkedProjects[record.ProjectID] = true
		}
		if record.FnskuLabelR2Key != nil && strings.TrimSpace(*record.FnskuLabelR2Key) != "" {
			labeled = append(labeled, record)
		}
	}
	if len(labeled) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "所选 SKU 均无 FNSKU 标签")
		return
	}

	var archiveBuffer bytes.Buffer
	archiveWriter := zip.NewWriter(&archiveBuffer)
	seenNames := make(map[string]int)
	downloaded := 0
	skipped := 0
	var totalBytes int64
	for _, record := range labeled {
		reader, err := h.blobs.Get(r.Context(), *record.FnskuLabelR2Key)
		if err != nil {
			skipped++
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, maxBatchFNSKULabelBytes+1))
		_ = reader.Close()
		if readErr != nil || len(data) > maxBatchFNSKULabelBytes ||
			!bytes.HasPrefix(bytes.TrimSpace(data), []byte("%PDF-")) {
			skipped++
			continue
		}
		totalBytes += int64(len(data))
		if totalBytes > maxBatchFNSKUArchiveBytes {
			_ = archiveWriter.Close()
			httpapi.WriteDetail(w, http.StatusBadRequest, "批量标签总大小不能超过 100MB")
			return
		}
		entryName := uniqueSKUArchiveName(record, seenNames)
		header := &zip.FileHeader{Name: entryName, Method: zip.Deflate}
		writer, err := archiveWriter.CreateHeader(header)
		if err != nil {
			skipped++
			continue
		}
		if _, err := writer.Write(data); err != nil {
			skipped++
			continue
		}
		downloaded++
	}
	if err := archiveWriter.Close(); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if downloaded == 0 {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "FNSKU 标签存储不可用")
		return
	}
	skipped += len(ids) - len(labeled)

	if h.auditor == nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	entry := mediaAuditEntry(
		r,
		identity,
		"sku_info.batch_download_fnsku_labels",
		0,
		map[string]any{
			"requested":  len(ids),
			"downloaded": downloaded,
			"skipped":    skipped,
		},
	)
	entry.TargetID = nil
	if err := h.auditor.LogAction(r.Context(), entry); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="fnsku-labels.zip"`)
	w.Header().Set("X-Downloaded-Count", strconv.Itoa(downloaded))
	w.Header().Set("X-Skipped-Count", strconv.Itoa(skipped))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(archiveBuffer.Bytes())
}

func (h *Handler) UploadProductImage(w http.ResponseWriter, r *http.Request) {
	recordID, ok := mediaRecordID(w, r)
	if !ok {
		return
	}
	record, ok := h.authorizedMediaRecord(w, r, recordID)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储未配置")
		return
	}
	fileStore, ok := h.store.(FileStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "SKU file store is unavailable")
		return
	}

	_, declaredType, data, ok := readSKUMediaFile(
		w, r, maxProductImageBytes, true,
	)
	if !ok {
		return
	}
	detectedType, err := validateSKUProductImage(data)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	if declaredType != "" && declaredType != detectedType {
		httpapi.WriteDetail(w, http.StatusBadRequest, "仅支持 JPG / PNG / WebP / GIF 图片")
		return
	}
	if declaredType == "" {
		declaredType = detectedType
	}

	randomID, err := randomSKUMediaID()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	mainKey, err := blob.ObjectKey(
		"sku-info",
		"product-images",
		strconv.FormatInt(record.ProjectID, 10),
		strconv.FormatInt(record.ID, 10),
		randomID+skuImageExtension(detectedType),
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	thumbData, thumbType := skuProductThumbnail(data, declaredType)
	thumbKey, err := blob.ObjectKey(
		"sku-info",
		"product-thumbs",
		strconv.FormatInt(record.ProjectID, 10),
		strconv.FormatInt(record.ID, 10),
		randomID+"_thumb"+skuImageExtension(thumbType),
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	mainURL, err := h.blobs.Put(r.Context(), mainKey, data, detectedType)
	if err != nil || strings.TrimSpace(mainURL) == "" {
		bestEffortSKUMediaDelete(r.Context(), h.blobs, mainKey)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储上传失败")
		return
	}
	mainURL = strings.TrimSpace(mainURL)
	thumbURL, err := h.blobs.Put(r.Context(), thumbKey, thumbData, thumbType)
	if err != nil || strings.TrimSpace(thumbURL) == "" {
		bestEffortSKUMediaDelete(r.Context(), h.blobs, mainKey)
		if err == nil {
			bestEffortSKUMediaDelete(r.Context(), h.blobs, thumbKey)
		}
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储上传失败")
		return
	}
	thumbURL = strings.TrimSpace(thumbURL)

	uploadedAt := time.Now().UTC()
	identity, _ := auth.UserContextFromContext(r.Context())
	entry := mediaAuditEntry(
		r,
		identity,
		"sku_info.upload_product_image",
		record.ID,
		map[string]any{
			"sku":                            record.SKU,
			"product_image_r2_key":           mainKey,
			"product_image_thumbnail_r2_key": thumbKey,
			"file_size":                      len(data),
		},
	)
	_, previousKeys, err := fileStore.SetProductImage(
		r.Context(),
		record.ID,
		mainKey,
		mainURL,
		thumbKey,
		thumbURL,
		uploadedAt,
		identity.Operator,
		entry,
	)
	if err != nil {
		bestEffortSKUMediaDelete(r.Context(), h.blobs, mainKey)
		bestEffortSKUMediaDelete(r.Context(), h.blobs, thumbKey)
		writeSKUMediaStoreError(w, err)
		return
	}
	for _, key := range previousKeys {
		if strings.TrimSpace(key) != "" && key != mainKey && key != thumbKey {
			bestEffortSKUMediaDelete(r.Context(), h.blobs, key)
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, SkuProductImageUploadResponse{
		SkuRecordID:                record.ID,
		ProductImageR2Key:          mainKey,
		ProductImageR2URL:          mainURL,
		ProductImageThumbnailR2Key: thumbKey,
		ProductImageThumbnailR2URL: thumbURL,
		UploadedAt:                 uploadedAt.Format(time.RFC3339Nano),
	})
}

func (h *Handler) DeleteProductImage(w http.ResponseWriter, r *http.Request) {
	recordID, ok := mediaRecordID(w, r)
	if !ok {
		return
	}
	_, ok = h.authorizedMediaRecord(w, r, recordID)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "R2 存储未配置")
		return
	}
	fileStore, ok := h.store.(FileStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "SKU file store is unavailable")
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	entry := mediaAuditEntry(
		r,
		identity,
		"sku_info.delete_product_image",
		recordID,
		map[string]any{"sku_record_id": recordID},
	)
	_, previousKeys, err := fileStore.ClearProductImage(r.Context(), recordID, entry)
	if err != nil {
		writeSKUMediaStoreError(w, err)
		return
	}
	for _, key := range previousKeys {
		bestEffortSKUMediaDelete(r.Context(), h.blobs, key)
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, SkuProductImageDeleteResponse{
		SkuRecordID: recordID,
		Deleted:     true,
	})
}

func (h *Handler) authorizedMediaRecord(
	w http.ResponseWriter,
	r *http.Request,
	recordID int64,
) (*SkuRecordItem, bool) {
	record, err := h.store.GetSkuRecord(r.Context(), recordID)
	if err != nil {
		writeSKUMediaStoreError(w, err)
		return nil, false
	}
	if record == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "SKU 记录不存在")
		return nil, false
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if err := h.checkProjectAccess(
		r.Context(), record.ProjectID, record.ProjectName, identity,
	); err != nil {
		writeSKUMediaAccessError(w, err)
		return nil, false
	}
	return record, true
}

func mediaRecordID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "sku_record_id"))
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid sku_record_id")
		return 0, false
	}
	return id, true
}

func readSKUMediaFile(
	w http.ResponseWriter,
	r *http.Request,
	maxBytes int64,
	image bool,
) (string, string, []byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+maxSKUMediaRequestOverhead)
	if err := r.ParseMultipartForm(maxBytes); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			httpapi.WriteDetail(w, http.StatusBadRequest, mediaSizeMessage(maxBytes))
		} else {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid multipart form")
		}
		return "", "", nil, false
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if r.MultipartForm == nil || len(r.MultipartForm.File["file"]) != 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Field required: file")
		return "", "", nil, false
	}
	header := r.MultipartForm.File["file"][0]
	rawFilename := header.Filename
	if disposition := header.Header.Get("Content-Disposition"); disposition != "" {
		if _, parameters, err := mime.ParseMediaType(disposition); err == nil {
			if value := strings.TrimSpace(parameters["filename"]); value != "" {
				rawFilename = value
			}
		}
	}
	filename, err := safeSKUMediaFilename(rawFilename)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return "", "", nil, false
	}
	if header.Size > maxBytes {
		httpapi.WriteDetail(w, http.StatusBadRequest, mediaSizeMessage(maxBytes))
		return "", "", nil, false
	}
	file, err := header.Open()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "文件读取失败")
		return "", "", nil, false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "文件读取失败")
		return "", "", nil, false
	}
	if int64(len(data)) > maxBytes {
		httpapi.WriteDetail(w, http.StatusBadRequest, mediaSizeMessage(maxBytes))
		return "", "", nil, false
	}
	if len(data) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "文件为空")
		return "", "", nil, false
	}
	contentType := normalizeSKUMediaMIME(header.Header.Get("Content-Type"))
	if image && contentType != "" && !allowedSKUImageMIME(contentType) {
		httpapi.WriteDetail(w, http.StatusBadRequest, "仅支持 JPG / PNG / WebP / GIF 图片")
		return "", "", nil, false
	}
	return filename, contentType, data, true
}

func safeSKUMediaFilename(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("Missing filename")
	}
	if strings.ContainsAny(raw, `/\`) || strings.Contains(raw, "..") {
		return "", errors.New("Invalid filename")
	}
	for _, character := range raw {
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) {
			return "", errors.New("Invalid filename")
		}
	}
	filename := filepath.Base(raw)
	if filename == "." || filename == ".." || len([]rune(filename)) > 255 {
		return "", errors.New("Invalid filename")
	}
	return filename, nil
}

func mediaSizeMessage(maxBytes int64) string {
	if maxBytes >= 20<<20 {
		return "文件大小不能超过 20MB"
	}
	return "文件大小不能超过 10MB"
}

func normalizeSKUMediaMIME(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if parsed, _, err := mime.ParseMediaType(raw); err == nil {
		return parsed
	}
	if index := strings.IndexByte(raw, ';'); index >= 0 {
		return strings.TrimSpace(raw[:index])
	}
	return raw
}

func allowedSKUImageMIME(contentType string) bool {
	switch contentType {
	case "image/jpeg", "image/png", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

func validateSKUProductImage(data []byte) (string, error) {
	contentType := detectSKUImageMIME(data)
	if contentType == "" {
		return "", errors.New("图片内容无法识别")
	}
	if contentType == "image/webp" {
		return contentType, nil
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", errors.New("图片内容无法识别")
	}
	if config.Width <= 0 || config.Height <= 0 ||
		config.Width > 10000 || config.Height > 10000 ||
		int64(config.Width)*int64(config.Height) > maxSKUImagePixels {
		return "", errors.New("图片尺寸过大")
	}
	return contentType, nil
}

func detectSKUImageMIME(data []byte) string {
	switch {
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg"
	case len(data) >= 8 &&
		data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' &&
		data[4] == 0x0d && data[5] == 0x0a && data[6] == 0x1a && data[7] == 0x0a:
		return "image/png"
	case len(data) >= 6 &&
		data[0] == 'G' && data[1] == 'I' && data[2] == 'F' &&
		data[3] == '8' && (data[4] == '7' || data[4] == '9') && data[5] == 'a':
		return "image/gif"
	case len(data) >= 12 &&
		bytes.Equal(data[0:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	default:
		return ""
	}
}

func skuProductThumbnail(data []byte, contentType string) ([]byte, string) {
	if contentType == "image/webp" {
		return append([]byte(nil), data...), contentType
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return append([]byte(nil), data...), contentType
	}
	bounds := source.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return append([]byte(nil), data...), contentType
	}
	scale := float64(skuProductThumbnailSize) / float64(max(bounds.Dx(), bounds.Dy()))
	width := max(int(float64(bounds.Dx())*scale), 1)
	height := max(int(float64(bounds.Dy())*scale), 1)
	thumbnail := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		sourceY := bounds.Min.Y + y*bounds.Dy()/height
		for x := 0; x < width; x++ {
			sourceX := bounds.Min.X + x*bounds.Dx()/width
			thumbnail.Set(x, y, source.At(sourceX, sourceY))
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, thumbnail); err != nil {
		return append([]byte(nil), data...), contentType
	}
	return buffer.Bytes(), "image/png"
}

func skuImageExtension(contentType string) string {
	switch contentType {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	default:
		return ".bin"
	}
}

func randomSKUMediaID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func bestEffortSKUMediaDelete(parent context.Context, blobs BlobStore, key string) {
	if blobs == nil || strings.TrimSpace(key) == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), skuMediaDeleteTimeout)
	defer cancel()
	_ = blobs.Delete(ctx, key)
}

func mediaAuditEntry(
	r *http.Request,
	identity auth.UserContext,
	action string,
	recordID int64,
	after map[string]any,
) audit.Entry {
	var targetID *string
	if recordID > 0 {
		value := strconv.FormatInt(recordID, 10)
		targetID = &value
	}
	var operator *string
	if value := strings.TrimSpace(identity.Operator); value != "" {
		operator = &value
	}
	entry := audit.Entry{
		Action:     action,
		TargetType: "sku_info",
		TargetID:   targetID,
		Operator:   operator,
		Result:     "success",
		AfterJSON:  after,
	}
	entry.PopulateFromRequest(r)
	return entry
}

func writeSKUMediaStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrSkuNotFound), errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "SKU 记录不存在")
	default:
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

func writeSKUMediaAccessError(w http.ResponseWriter, err error) {
	switch {
	case strings.Contains(err.Error(), "403"):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case strings.Contains(err.Error(), "404"):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	default:
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

func decodeSKUMediaJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxSKUMediaJSONBody)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validateBatchFnskuIDs(raw []int64) ([]int64, error) {
	if len(raw) == 0 {
		return nil, errors.New("sku_record_ids must contain 1 to 500 items")
	}
	if len(raw) > maxBatchFNSKULabelCount {
		return nil, errors.New("sku_record_ids must contain 1 to 500 items")
	}
	seen := make(map[int64]bool, len(raw))
	result := make([]int64, 0, len(raw))
	for _, id := range raw {
		if id <= 0 {
			return nil, errors.New("sku_record_ids must contain positive integers")
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, id)
	}
	return result, nil
}

func uniqueSKUArchiveName(record SkuRecordItem, seen map[string]int) string {
	baseSKU := safeSKUDownloadName(record.SKU)
	if baseSKU == "" {
		baseSKU = "sku"
	}
	base := baseSKU + "-fnsku-label.pdf"
	if seen[base] == 0 {
		seen[base] = 1
		return base
	}
	project := safeSKUDownloadName(record.ProjectName)
	if project == "" {
		project = "project"
	}
	prefixed := project + "_" + base
	count := seen[prefixed] + 1
	seen[prefixed] = count
	if count == 1 {
		return prefixed
	}
	stem := strings.TrimSuffix(prefixed, ".pdf")
	return fmt.Sprintf("%s_%d.pdf", stem, count)
}

func safeSKUDownloadName(value string) string {
	value = strings.TrimSpace(value)
	replacer := strings.NewReplacer("/", "_", `\`, "_", " ", "_")
	value = replacer.Replace(value)
	var builder strings.Builder
	for _, character := range value {
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) {
			continue
		}
		builder.WriteRune(character)
	}
	value = strings.Trim(builder.String(), "._")
	runes := []rune(value)
	if len(runes) > 120 {
		value = string(runes[:120])
	}
	if value == "" {
		return "sku"
	}
	return value
}

func contentDisposition(filename string) string {
	fallback := strings.Map(func(character rune) rune {
		switch {
		case character >= 0x20 && character <= 0x7e && character != '"' && character != '\\':
			return character
		default:
			return '_'
		}
	}, filename)
	encoded := strings.ReplaceAll(url.QueryEscape(filename), "+", "%20")
	return `attachment; filename="` + fallback + `"; filename*=UTF-8''` + encoded
}

type fnskuVerification struct {
	Verified bool
	Found    *string
	Message  string
}

func verifyFNSKULabel(text string, expected *string) fnskuVerification {
	text = strings.TrimSpace(text)
	if text == "" {
		return fnskuVerification{
			Verified: false,
			Message:  "PDF 中未识别到 FNSKU 信息，标签已上传但未验证",
		}
	}
	text = strings.ToUpper(text)
	var found []string
	for _, match := range fnskuExplicitPattern.FindAllStringSubmatch(text, -1) {
		value := strings.TrimSpace(match[1])
		if value != "" && !containsString(found, value) {
			found = append(found, value)
		}
	}
	if len(found) == 0 {
		for _, match := range fnskuCandidatePattern.FindAllStringSubmatch(text, -1) {
			value := strings.TrimSpace(match[1])
			if value != "" && !containsString(found, value) {
				found = append(found, value)
			}
		}
	}
	if len(found) == 0 {
		return fnskuVerification{
			Verified: false,
			Message:  "PDF 中未识别到 FNSKU 信息，标签已上传但未验证",
		}
	}
	first := found[0]
	if expected == nil || strings.TrimSpace(*expected) == "" {
		message := fmt.Sprintf(
			"SKU 记录中无 FNSKU 字段，无法校验。PDF 中识别到: %s",
			strings.Join(found, ", "),
		)
		return fnskuVerification{Verified: false, Found: &first, Message: message}
	}
	expectedValue := strings.ToUpper(strings.TrimSpace(*expected))
	if containsString(found, expectedValue) {
		return fnskuVerification{
			Verified: true,
			Found:    &expectedValue,
			Message:  "FNSKU 验证通过: " + expectedValue,
		}
	}
	message := fmt.Sprintf(
		"FNSKU 不匹配！SKU 记录期望: %s，PDF 中识别到: %s",
		expectedValue,
		strings.Join(found, ", "),
	)
	return fnskuVerification{Verified: false, Found: &first, Message: message}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func extractFNSKUText(data []byte) (result string) {
	defer func() {
		if recover() != nil {
			result = ""
		}
	}()
	reader, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	plain, err := reader.GetPlainText()
	if err != nil {
		return ""
	}
	var buffer bytes.Buffer
	if _, err := buffer.ReadFrom(plain); err != nil {
		return ""
	}
	return buffer.String()
}
