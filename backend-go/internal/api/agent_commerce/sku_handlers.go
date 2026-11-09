package agent_commerce

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxFNSKULabelBytes   = int64(20 * 1024 * 1024)
	maxFNSKURequestBytes = maxFNSKULabelBytes + 2*1024*1024
)

func (h *Handler) ListSKUInfo(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	if _, _, ok := h.verifyProject(w, r); !ok {
		return
	}
	query := r.URL.Query()
	page, ok := parseQueryInt(w, query.Get("page"), 1, 1, 1<<30, "page")
	if !ok {
		return
	}
	pageSize, ok := parseQueryInt(w, query.Get("page_size"), 200, 1, 500, "page_size")
	if !ok {
		return
	}
	isActive := true
	if raw, exists := query["is_active"]; exists {
		if len(raw) == 0 {
			writeValidationError(w, "is_active 必须是布尔值", nil)
			return
		}
		parsed, err := strconv.ParseBool(strings.TrimSpace(raw[0]))
		if err != nil {
			writeValidationError(w, "is_active 必须是布尔值", nil)
			return
		}
		isActive = parsed
	}
	includeTotal := false
	if raw, exists := query["include_total"]; exists {
		if len(raw) == 0 {
			writeValidationError(w, "include_total 必须是布尔值", nil)
			return
		}
		parsed, err := strconv.ParseBool(strings.TrimSpace(raw[0]))
		if err != nil {
			writeValidationError(w, "include_total 必须是布尔值", nil)
			return
		}
		includeTotal = parsed
	}
	filter := SKUFilter{
		IsActive:     &isActive,
		Page:         page,
		PageSize:     pageSize,
		IncludeTotal: includeTotal,
	}
	if country := strings.TrimSpace(query.Get("country")); country != "" {
		country = normalizeCountryCode(country)
		filter.Country = &country
	}
	if sku := strings.TrimSpace(query.Get("sku")); sku != "" {
		filter.SKU = &sku
	}
	if asin := strings.TrimSpace(query.Get("asin")); asin != "" {
		filter.ASIN = &asin
	}
	pageResult, err := h.store.ListSKU(r.Context(), mustProjectID(r), filter)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	if pageResult.Items == nil {
		pageResult.Items = []SKURecord{}
	}
	writeOK(w, pageResult, "", "")
}

func (h *Handler) GetSKUInfo(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	if _, _, ok := h.verifyProject(w, r); !ok {
		return
	}
	projectID := mustProjectID(r)
	recordID, ok := parsePositivePathID(w, r, "sku_record_id")
	if !ok {
		return
	}
	skuRecord, err := h.store.GetSKU(r.Context(), projectID, recordID)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	writeOK(w, skuRecord, "", "")
}

func (h *Handler) GetSKUInfoAudit(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	if _, _, ok := h.verifyProject(w, r); !ok {
		return
	}
	projectID := mustProjectID(r)
	recordID, ok := parsePositivePathID(w, r, "sku_record_id")
	if !ok {
		return
	}
	if _, err := h.store.GetSKU(r.Context(), projectID, recordID); err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	limit, ok := parseQueryInt(w, r.URL.Query().Get("limit"), 50, 1, 200, "limit")
	if !ok {
		return
	}
	items, err := h.store.ListSKUAudit(r.Context(), projectID, recordID, limit)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	if items == nil {
		items = []AuditItem{}
	}
	writeOK(w, map[string]any{"sku_record_id": recordID, "items": items}, "", "")
}

func (h *Handler) UpsertSKUInfo(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	body, ok := h.confirmJSON(
		w,
		r,
		"sku_info.upsert",
		func(body []byte) *APIError {
			if _, apiErr := parseUpsertInput(body); apiErr != nil {
				return apiErr
			}
			return h.validateProject(r)
		},
		func(body []byte) (map[string]any, *APIError) {
			input, apiErr := parseUpsertInput(body)
			if apiErr != nil {
				return nil, apiErr
			}
			return map[string]any{
				"sku":     input.SKU,
				"asin":    input.ASIN,
				"country": input.Country,
				"source":  input.Source,
				"note":    "upsert 语义：按 (项目, SKU, ASIN, 国家) 写入；成本字段会影响下游财务/补货/报表",
			}, nil
		},
	)
	if !ok {
		return
	}
	input, apiErr := parseUpsertInput(body)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	projectID := mustProjectID(r)
	item, action, err := h.store.UpsertSKU(
		r.Context(),
		projectID,
		input,
		h.auditEntry(r, "sku_info.upsert"),
	)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	writeOK(w, item, action, responseIdempotencyKey(r))
}

func (h *Handler) UpdateSKUInfo(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	projectID := mustProjectID(r)
	recordID, ok := parsePositivePathID(w, r, "sku_record_id")
	if !ok {
		return
	}
	body, ok := h.confirmJSON(
		w,
		r,
		"sku_info.update",
		func(body []byte) *APIError {
			if _, apiErr := parseUpdateInput(body); apiErr != nil {
				return apiErr
			}
			if apiErr := h.validateProject(r); apiErr != nil {
				return apiErr
			}
			_, err := h.store.GetSKU(r.Context(), projectID, recordID)
			if err != nil {
				return mapStoreError(err)
			}
			return nil
		},
		func(body []byte) (map[string]any, *APIError) {
			input, apiErr := parseUpdateInput(body)
			if apiErr != nil {
				return nil, apiErr
			}
			record, err := h.store.GetSKU(r.Context(), projectID, recordID)
			if err != nil {
				return nil, mapStoreError(err)
			}
			fields := make([]string, 0, len(input.Provided))
			for field := range input.Provided {
				if field != "source" {
					fields = append(fields, field)
				}
			}
			sortStrings(fields)
			return map[string]any{
				"sku_record_id":  recordID,
				"sku":            record.SKU,
				"changed_fields": fields,
				"source":         input.Source,
				"note":           "修改成本/规格将影响下游计算（PT4 财务汇总/货件费用核算/补货/报表），请确认",
			}, nil
		},
	)
	if !ok {
		return
	}
	input, apiErr := parseUpdateInput(body)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	before, after, err := h.store.UpdateSKU(
		r.Context(),
		projectID,
		recordID,
		input,
		h.auditEntry(r, "sku_info.update"),
	)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	_ = before
	writeOK(w, after, "", responseIdempotencyKey(r))
}

func (h *Handler) BatchUpdateListingCopy(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	projectID := mustProjectID(r)
	body, ok := h.confirmJSON(
		w,
		r,
		"sku_info.listing_copy.batch",
		func(body []byte) *APIError {
			input, apiErr := parseListingCopyBatchInput(body)
			if apiErr != nil {
				return apiErr
			}
			if apiErr := h.validateProject(r); apiErr != nil {
				return apiErr
			}
			for _, item := range input.Items {
				if _, err := h.store.GetSKU(r.Context(), projectID, item.SKURecordID); err != nil {
					return mapStoreError(err)
				}
			}
			return nil
		},
		func(body []byte) (map[string]any, *APIError) {
			input, apiErr := parseListingCopyBatchInput(body)
			if apiErr != nil {
				return nil, apiErr
			}
			items := make([]map[string]any, 0, len(input.Items))
			for _, item := range input.Items {
				record, err := h.store.GetSKU(r.Context(), projectID, item.SKURecordID)
				if err != nil {
					return nil, mapStoreError(err)
				}
				items = append(items, map[string]any{
					"sku_record_id": item.SKURecordID,
					"sku":           record.SKU,
					"fields":        sortedKeys(item.Values),
				})
			}
			return map[string]any{
				"project_id": projectID,
				"item_count": len(items),
				"items":      items,
				"source":     input.Source,
				"note":       "将批量写入上述 SKU 的产品文案（仅覆盖显式提供字段；未提供的保持原值），请确认",
			}, nil
		},
	)
	if !ok {
		return
	}
	input, apiErr := parseListingCopyBatchInput(body)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	result, err := h.store.BatchUpdateListingCopy(
		r.Context(),
		projectID,
		input,
		h.auditEntry(r, "sku_info.listing_copy.batch"),
	)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	if result.UpdatedIDs == nil {
		result.UpdatedIDs = []int64{}
	}
	if result.Items == nil {
		result.Items = []SKURecord{}
	}
	writeOK(w, result, "", responseIdempotencyKey(r))
}

func (h *Handler) UpdateSKUStatus(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	projectID := mustProjectID(r)
	recordID, ok := parsePositivePathID(w, r, "sku_record_id")
	if !ok {
		return
	}
	body, ok := h.confirmJSON(
		w,
		r,
		"sku_info.status.transition",
		func(body []byte) *APIError {
			if _, apiErr := parseStatusInput(body); apiErr != nil {
				return apiErr
			}
			if apiErr := h.validateProject(r); apiErr != nil {
				return apiErr
			}
			_, err := h.store.GetSKU(r.Context(), projectID, recordID)
			if err != nil {
				return mapStoreError(err)
			}
			return nil
		},
		func(body []byte) (map[string]any, *APIError) {
			input, apiErr := parseStatusInput(body)
			if apiErr != nil {
				return nil, apiErr
			}
			record, err := h.store.GetSKU(r.Context(), projectID, recordID)
			if err != nil {
				return nil, mapStoreError(err)
			}
			return map[string]any{
				"sku_record_id": recordID,
				"sku":           record.SKU,
				"from_active":   record.IsActive,
				"to_active":     input.IsActive,
				"source":        input.Source,
				"note":          "上下架将影响补货分析、定时报表与店铺测算默认消费；历史数据保留",
			}, nil
		},
	)
	if !ok {
		return
	}
	input, apiErr := parseStatusInput(body)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	record, _, err := h.store.TransitionSKUStatus(
		r.Context(),
		projectID,
		recordID,
		input,
		h.auditEntry(r, "sku_info.status.transition"),
	)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	writeOK(w, record, "", responseIdempotencyKey(r))
}

func (h *Handler) DeleteSKUInfo(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	projectID := mustProjectID(r)
	recordID, ok := parsePositivePathID(w, r, "sku_record_id")
	if !ok {
		return
	}
	body, ok := h.confirmJSON(
		w,
		r,
		"sku_info.delete",
		func(body []byte) *APIError {
			if _, apiErr := decodeJSONObject(body, true); apiErr != nil {
				return apiErr
			}
			if apiErr := h.validateProject(r); apiErr != nil {
				return apiErr
			}
			_, err := h.store.GetSKU(r.Context(), projectID, recordID)
			if err != nil {
				return mapStoreError(err)
			}
			return nil
		},
		func(body []byte) (map[string]any, *APIError) {
			record, err := h.store.GetSKU(r.Context(), projectID, recordID)
			if err != nil {
				return nil, mapStoreError(err)
			}
			return map[string]any{
				"sku_record_id": recordID,
				"sku":           record.SKU,
				"asin":          record.ASIN,
				"country":       record.Country,
				"is_active":     record.IsActive,
				"note":          "将永久删除该 SKU 成本记录（不可恢复），请确认",
			}, nil
		},
	)
	if !ok {
		return
	}
	_ = body
	deleted, err := h.store.DeleteSKU(
		r.Context(),
		projectID,
		recordID,
		h.auditEntry(r, "sku_info.delete"),
	)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	writeOK(w, map[string]any{"deleted": true, "sku_record_id": deleted.ID}, "", responseIdempotencyKey(r))
}

type fnskuUpload struct {
	Source   string
	Filename string
	Content  []byte
	Hash     string
}

func (h *Handler) UploadFNSKULabel(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	projectID := mustProjectID(r)
	recordID, ok := parsePositivePathID(w, r, "sku_record_id")
	if !ok {
		return
	}
	upload, apiErr := parseFNSKUUpload(w, r)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	if apiErr := h.validateProject(r); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	skuRecord, err := h.store.GetSKU(r.Context(), projectID, recordID)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	if h.options.Blobs == nil {
		writeAPIError(w, newAPIError(CodeServiceUnavailable))
		return
	}

	const action = "sku_info.upload_fnsku_label"
	token := strings.TrimSpace(r.Header.Get(agentauth.ConfirmTokenHeader))
	if token == "" {
		if _, apiErr := requestIdempotencyKey(r); apiErr != nil {
			writeAPIError(w, apiErr)
			return
		}
		confirmRecord, tokenErr := h.issueConfirmForHash(r, action, responseIdempotencyKey(r), upload.Hash)
		if tokenErr != nil {
			writeAPIError(w, newAPIError(CodeServiceUnavailable))
			return
		}
		replaceOld := skuRecord.FNSKULabelR2Key != nil &&
			strings.TrimSpace(*skuRecord.FNSKULabelR2Key) != ""
		note := "将为该 SKU 上传 FNSKU 标签 PDF"
		if replaceOld {
			note = "将替换该 SKU 现有的 FNSKU 标签（旧标签将被删除）"
		}
		_ = httpapi.WriteJSON(w, http.StatusOK, confirmationPreview{
			OK:                   false,
			RequiresConfirmation: true,
			ConfirmToken:         confirmRecord.Token,
			Preview: map[string]any{
				"action":        action,
				"sku_record_id": recordID,
				"sku":           skuRecord.SKU,
				"filename":      upload.Filename,
				"file_size":     len(upload.Content),
				"replace_old":   replaceOld,
				"source":        upload.Source,
				"note":          note,
			},
			ExpiresInSec: int(confirmTTL.Seconds()),
			HumanMessage: "该操作需要用户确认",
			AgentHint:    "向用户复述上述摘要；用户确认后用同一 Idempotency-Key + X-Confirm-Token 与相同 source/filename/文件内容重放",
		})
		return
	}
	if _, ok := h.consumeConfirm(w, r, action, upload.Hash); !ok {
		return
	}

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		writeAPIError(w, newAPIError(CodeInternalError))
		return
	}
	key := fmt.Sprintf(
		"sku-info/fnsku-labels/%d/%d/%s_%s.pdf",
		projectID,
		recordID,
		hex.EncodeToString(random),
		safeSKUFilenamePart(skuRecord.SKU),
	)
	publicURL, err := h.options.Blobs.Put(r.Context(), key, upload.Content, "application/pdf")
	if err != nil {
		writeAPIError(w, newAPIError(CodeServiceUnavailable))
		return
	}
	if strings.TrimSpace(publicURL) == "" {
		deleteBlobCompensating(h.options.Blobs, key)
		writeAPIError(w, newAPIError(CodeServiceUnavailable))
		return
	}
	previousKey, err := h.store.SetFNSKULabel(
		r.Context(),
		projectID,
		recordID,
		key,
		publicURL,
		int64(len(upload.Content)),
		h.auditEntry(r, action),
	)
	if err != nil {
		deleteBlobCompensating(h.options.Blobs, key)
		writeAPIError(w, mapStoreError(err))
		return
	}
	if previousKey != nil && strings.TrimSpace(*previousKey) != "" && *previousKey != key {
		deleteBlobCompensating(h.options.Blobs, *previousKey)
	}
	writeOK(w, map[string]any{
		"sku_record_id":      recordID,
		"fnsku_label_r2_url": publicURL,
		"file_size":          len(upload.Content),
		"filename":           filepath.Base(key),
	}, "", responseIdempotencyKey(r))
}

func deleteBlobCompensating(blobs BlobStore, key string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = blobs.Delete(ctx, key)
}

func parseFNSKUUpload(w http.ResponseWriter, r *http.Request) (fnskuUpload, *APIError) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFNSKURequestBytes)
	if err := r.ParseMultipartForm(maxFNSKULabelBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return fnskuUpload{}, validationError("文件大小不能超过 20MB")
		}
		return fnskuUpload{}, validationError("multipart 表单格式无效")
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if r.MultipartForm == nil {
		return fnskuUpload{}, validationError("multipart 表单格式无效")
	}
	source := strings.TrimSpace(r.FormValue("source"))
	if !allowedAgentSources[source] {
		apiErr := newAPIError(CodeSKUInfoInvalidSource)
		apiErr.Details = map[string]any{"allowed": allowedSources()}
		return fnskuUpload{}, apiErr
	}
	files := r.MultipartForm.File["file"]
	if len(files) != 1 {
		return fnskuUpload{}, validationError("需要且只能提供一个 file 字段")
	}
	header := files[0]
	filename := filepath.Base(strings.TrimSpace(header.Filename))
	if filename == "" || filename == "." {
		return fnskuUpload{}, validationError("文件名无效")
	}
	if !strings.EqualFold(filepath.Ext(filename), ".pdf") {
		return fnskuUpload{}, validationError("仅支持 PDF 文件")
	}
	if header.Size == 0 {
		return fnskuUpload{}, validationError("文件为空")
	}
	if header.Size > maxFNSKULabelBytes {
		return fnskuUpload{}, validationError("文件大小不能超过 20MB")
	}
	file, err := header.Open()
	if err != nil {
		return fnskuUpload{}, validationError("文件读取失败")
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxFNSKULabelBytes+1))
	if err != nil {
		return fnskuUpload{}, validationError("文件读取失败")
	}
	if len(content) == 0 {
		return fnskuUpload{}, validationError("文件为空")
	}
	if int64(len(content)) > maxFNSKULabelBytes {
		return fnskuUpload{}, validationError("文件大小不能超过 20MB")
	}
	if !bytes.HasPrefix(content, []byte("%PDF-")) {
		return fnskuUpload{}, validationError("文件不是有效的 PDF")
	}
	return fnskuUpload{
		Source:   source,
		Filename: filename,
		Content:  content,
		Hash:     multipartFingerprint(source, filename, content),
	}, nil
}

func multipartFingerprint(source, filename string, content []byte) string {
	var buffer bytes.Buffer
	buffer.WriteString(source)
	buffer.WriteByte(0)
	buffer.WriteString(filename)
	buffer.WriteByte(0)
	buffer.Write(content)
	return hashBytes(buffer.Bytes())
}

func safeSKUFilenamePart(sku string) string {
	var builder strings.Builder
	for _, character := range strings.TrimSpace(sku) {
		if character == '/' || character == '\\' || character == ' ' ||
			character == ':' || character == '*' || character == '?' ||
			character == '"' || character == '<' || character == '>' ||
			character == '|' || unicode.IsControl(character) ||
			unicode.Is(unicode.Cf, character) {
			builder.WriteByte('_')
			continue
		}
		builder.WriteRune(character)
	}
	value := strings.Trim(builder.String(), "._-")
	if value == "" {
		return "sku"
	}
	return truncateRunes(value, 80)
}

func (h *Handler) validateProject(r *http.Request) *APIError {
	project, err := h.store.VerifyProject(r.Context(), mustProjectID(r))
	if err != nil {
		return mapStoreError(err)
	}
	if project == nil {
		return APIErrorWithMessage(CodeResourceNotFound, "项目不存在")
	}
	return nil
}

func mustProjectID(r *http.Request) int64 {
	value, _ := strconv.ParseInt(strings.TrimSpace(chiURLParam(r, "project_id")), 10, 64)
	return value
}

func chiURLParam(r *http.Request, name string) string {
	if r == nil {
		return ""
	}
	return routeParam(r, name)
}

func routeParam(r *http.Request, name string) string {
	return chi.URLParam(r, name)
}

func parseQueryInt(
	w http.ResponseWriter,
	raw string,
	defaultValue, minimum, maximum int,
	name string,
) (int, bool) {
	if strings.TrimSpace(raw) == "" {
		return defaultValue, true
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < minimum || value > maximum {
		writeValidationError(w, fmt.Sprintf("%s 必须在 %d 到 %d 之间", name, minimum, maximum), nil)
		return 0, false
	}
	return value, true
}

func sortedKeys(values map[string]*string) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	for left := 0; left < len(result); left++ {
		for right := left + 1; right < len(result); right++ {
			if result[right] < result[left] {
				result[left], result[right] = result[right], result[left]
			}
		}
	}
	return result
}
