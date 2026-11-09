package agent_inspection

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
)

func (h *Handler) PlatformInspectionTemplate(w http.ResponseWriter, _ *http.Request) {
	writeSuccess(w, Template(), nil)
}

func (h *Handler) UpsertInspectionReport(w http.ResponseWriter, r *http.Request) {
	idempotencyKey, err := validateIdempotencyKey(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	body, err := readJSONObject(w, r, MaxJSONBodyBytes)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	country, err := parsePlatformCountry(body, "US")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	patch, err := parseReportPatch(body)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	periodID, ok := parsePathID(w, r, "period_id")
	if !ok {
		return
	}
	projectID, ok := parsePathID(w, r, "project_id")
	if !ok {
		return
	}

	var response *Report
	var before any
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		period, err := txStore.GetPeriod(ctx, periodID)
		if err != nil {
			return err
		}
		if period == nil {
			return ErrPeriodNotFound
		}
		project, err := txStore.GetProject(ctx, projectID)
		if err != nil {
			return err
		}
		if project == nil {
			return ErrProjectNotFound
		}
		current, err := txStore.GetReport(ctx, periodID, projectID, country)
		if err != nil {
			return err
		}
		if current != nil {
			before = reportResponse(current)
		}
		merged := mergeReportPatch(current, patch)
		response, err = txStore.UpsertReport(ctx, UpsertReportInput{
			PeriodID: periodID, ProjectID: projectID, Country: country, Patch: merged,
		})
		if err != nil {
			return err
		}
		return h.auditMutation(
			r, tx, txStore, "platform_inspection.save", "inspection_report",
			strconv.FormatInt(response.ID, 10), before, reportResponse(response),
		)
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeSuccess(w, reportResponse(response), idempotencyKey)
}

func (h *Handler) ValidateSubmitConfirmation(r *http.Request, body []byte) error {
	if _, err := validateIdempotencyKey(r); err != nil {
		return err
	}
	object, err := parseJSONObjectPayload(body)
	if err != nil {
		return err
	}
	country, err := parsePlatformCountry(object, "US")
	if err != nil {
		return err
	}
	periodID, err := parsePositiveID(chiURLParam(r, "period_id"), "period_id")
	if err != nil {
		return err
	}
	projectID, err := parsePositiveID(chiURLParam(r, "project_id"), "project_id")
	if err != nil {
		return err
	}
	_, _, report, err := h.loadInspectionTarget(r.Context(), periodID, projectID, country)
	if err != nil {
		return err
	}
	if report == nil {
		return &agentauth.APIError{
			Status: http.StatusNotFound, Code: "RESOURCE_NOT_FOUND",
			Detail: "无草稿报告，无法提交（请先通过 W1 保存草稿）",
		}
	}
	return nil
}

func (h *Handler) SubmitInspectionReport(w http.ResponseWriter, r *http.Request) {
	idempotencyKey, err := validateIdempotencyKey(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	body, err := readJSONObject(w, r, MaxJSONBodyBytes)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	country, err := parsePlatformCountry(body, "US")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	periodID, ok := parsePathID(w, r, "period_id")
	if !ok {
		return
	}
	projectID, ok := parsePathID(w, r, "project_id")
	if !ok {
		return
	}

	var submitted *Report
	var warnings []ThresholdWarning
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		_, project, report, err := h.loadInspectionTargetWithStore(
			ctx, txStore, periodID, projectID, country,
		)
		if err != nil {
			return err
		}
		if project == nil {
			return ErrProjectNotFound
		}
		if report == nil {
			return ErrReportNotFound
		}
		switch report.Status {
		case "submitted":
			submitted = report
			warnings = ThresholdWarnings(report)
			return nil
		case "draft", "overdue":
			submitted, warnings, err = txStore.SubmitReport(
				ctx, report.ID, credentialAgentID(r), h.now(),
			)
			if err != nil {
				return err
			}
			return h.auditMutation(
				r, tx, txStore, "platform_inspection.submit", "inspection_report",
				strconv.FormatInt(submitted.ID, 10),
				map[string]any{"status": report.Status},
				map[string]any{"status": submitted.Status, "warnings": warnings},
			)
		default:
			return ErrReportState
		}
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	payload := reportResponse(submitted)
	payload["warnings"] = warnings
	writeSuccess(w, payload, idempotencyKey)
}

func (h *Handler) UploadInspectionScreenshot(w http.ResponseWriter, r *http.Request) {
	if h.blobs == nil {
		writeAPIError(w, unavailable("screenshot storage is not configured"))
		return
	}
	idempotencyKey, err := validateIdempotencyKey(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	periodID, ok := parsePathID(w, r, "period_id")
	if !ok {
		return
	}
	projectID, ok := parsePathID(w, r, "project_id")
	if !ok {
		return
	}
	if idempotencyKey != nil {
		existing, err := h.store.GetScreenshotByIdempotency(
			r.Context(), credentialAgentID(r), *idempotencyKey, r.URL.Path,
		)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		if existing != nil {
			writeSuccess(w, screenshotResponse(existing), idempotencyKey)
			return
		}
	}

	header, data, contentType, err := readScreenshotMultipart(w, r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	primary, thumbnail, storedContentType, extension, err := prepareScreenshot(data, contentType)
	if err != nil {
		writeAPIError(w, err)
		return
	}

	_, project, report, err := h.loadTargetByProjectCountry(r.Context(), periodID, projectID)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if report == nil {
		notFoundError(w, "无巡检报告，无法上传截图")
		return
	}
	fileID, err := randomObjectID()
	if err != nil {
		writeAPIError(w, err)
		return
	}
	objectKey, err := blob.ObjectKey(
		"inspection-screenshots", safeProjectSegment(project.Name), fileID+extension,
	)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	var thumbnailKey *string
	if len(thumbnail) > 0 {
		thumbObjectKey, err := blob.ObjectKey(
			"inspection-screenshots", safeProjectSegment(project.Name), fileID+"_thumb.jpg",
		)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		if _, err := h.blobs.Put(r.Context(), thumbObjectKey, thumbnail, "image/jpeg"); err != nil {
			writeAPIError(w, unavailable("cloud storage upload failed"))
			return
		}
		thumbnailKey = &thumbObjectKey
	}
	if _, err := h.blobs.Put(r.Context(), objectKey, primary, storedContentType); err != nil {
		if thumbnailKey != nil {
			h.deleteBlobObjects(*thumbnailKey)
		}
		writeAPIError(w, unavailable("cloud storage upload failed"))
		return
	}

	var screenshot *Screenshot
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var insertErr error
		screenshot, insertErr = txStore.InsertScreenshot(ctx, InsertScreenshotInput{
			ReportID: report.ID, R2Key: objectKey, ThumbnailKey: thumbnailKey,
			Filename: sanitizeFilename(header.Filename), ContentType: storedContentType,
			FileSize: int64(len(primary)),
		})
		if insertErr != nil {
			return insertErr
		}
		return h.auditMutation(
			r, tx, txStore, "platform_inspection.upload_screenshot", "inspection_screenshot",
			strconv.FormatInt(screenshot.ID, 10),
			nil,
			map[string]any{
				"report_id": report.ID, "period_id": periodID, "project_id": projectID,
				"screenshot_id": screenshot.ID, "filename": screenshot.Filename,
				"file_size": screenshot.FileSize, "sort_order": screenshot.SortOrder,
			},
		)
	})
	if err != nil {
		keys := []string{objectKey}
		if thumbnailKey != nil {
			keys = append(keys, *thumbnailKey)
		}
		h.deleteBlobObjects(keys...)
		writeAPIError(w, err)
		return
	}
	writeSuccess(w, screenshotResponse(screenshot), idempotencyKey)
}

func (h *Handler) ValidateDeleteScreenshotConfirmation(r *http.Request, _ []byte) error {
	if _, err := validateIdempotencyKey(r); err != nil {
		return err
	}
	screenshotID, err := parsePositiveID(chiURLParam(r, "screenshot_id"), "screenshot_id")
	if err != nil {
		return err
	}
	screenshot, err := h.store.GetScreenshot(r.Context(), screenshotID)
	if err != nil {
		return err
	}
	if screenshot == nil {
		return &agentauth.APIError{
			Status: http.StatusNotFound, Code: "RESOURCE_NOT_FOUND", Detail: "截图不存在",
		}
	}
	allowed, err := projectInCredentialScope(r, screenshot.ProjectID)
	if err != nil {
		return err
	}
	if !allowed {
		return &agentauth.APIError{
			Status: http.StatusForbidden,
			Code:   agentauth.ErrorCodeAgentProjectOutOfScope,
			Detail: agentauth.DetailProjectNotInScope,
		}
	}
	return nil
}

func (h *Handler) DeleteInspectionScreenshot(w http.ResponseWriter, r *http.Request) {
	if h.blobs == nil {
		writeAPIError(w, unavailable("screenshot storage is not configured"))
		return
	}
	idempotencyKey, err := validateIdempotencyKey(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	screenshotID, ok := parsePathID(w, r, "screenshot_id")
	if !ok {
		return
	}
	screenshot, err := h.store.GetScreenshot(r.Context(), screenshotID)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if screenshot == nil {
		notFoundError(w, "截图不存在")
		return
	}
	if !requireProjectInCredentialScope(w, r, screenshot.ProjectID) {
		return
	}

	primaryBytes, err := readBlobBytes(r.Context(), h.blobs, screenshot.R2Key)
	if err != nil {
		writeAPIError(w, unavailable("cloud storage read failed"))
		return
	}
	var thumbnailBytes []byte
	if screenshot.ThumbnailKey != nil && strings.TrimSpace(*screenshot.ThumbnailKey) != "" {
		thumbnailBytes, err = readBlobBytes(r.Context(), h.blobs, *screenshot.ThumbnailKey)
		if err != nil {
			writeAPIError(w, unavailable("cloud storage read failed"))
			return
		}
	}

	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		locked, err := txStore.LockScreenshot(ctx, screenshotID)
		if err != nil {
			return err
		}
		if locked == nil {
			return ErrScreenshotNotFound
		}
		if err := h.blobs.Delete(ctx, locked.R2Key); err != nil {
			return ErrDependencyUnavailable
		}
		if locked.ThumbnailKey != nil && strings.TrimSpace(*locked.ThumbnailKey) != "" {
			if err := h.blobs.Delete(ctx, *locked.ThumbnailKey); err != nil {
				return ErrDependencyUnavailable
			}
		}
		deleted, err := txStore.DeleteScreenshot(ctx, screenshotID)
		if err != nil {
			return err
		}
		if !deleted {
			return ErrScreenshotNotFound
		}
		return h.auditMutation(
			r, tx, txStore, "platform_inspection.delete_screenshot", "inspection_screenshot",
			strconv.FormatInt(screenshotID, 10), nil,
			map[string]any{"deleted": true, "screenshot_id": screenshotID},
		)
	})
	if err != nil {
		h.restoreDeletedObjects(screenshot, primaryBytes, thumbnailBytes)
		writeAPIError(w, err)
		return
	}
	writeSuccess(w, map[string]any{"deleted": true, "screenshot_id": screenshotID}, idempotencyKey)
}

func (h *Handler) loadInspectionTarget(
	ctx context.Context,
	periodID int64,
	projectID int64,
	country string,
) (*Period, *Project, *Report, error) {
	return h.loadInspectionTargetWithStore(ctx, h.store, periodID, projectID, country)
}

func (h *Handler) loadInspectionTargetWithStore(
	ctx context.Context,
	store Store,
	periodID int64,
	projectID int64,
	country string,
) (*Period, *Project, *Report, error) {
	period, err := store.GetPeriod(ctx, periodID)
	if err != nil {
		return nil, nil, nil, err
	}
	if period == nil {
		return nil, nil, nil, ErrPeriodNotFound
	}
	project, err := store.GetProject(ctx, projectID)
	if err != nil {
		return nil, nil, nil, err
	}
	if project == nil {
		return nil, nil, nil, ErrProjectNotFound
	}
	report, err := store.GetReport(ctx, periodID, projectID, country)
	if err != nil {
		return nil, nil, nil, err
	}
	return period, project, report, nil
}

func (h *Handler) loadTargetByProjectCountry(
	ctx context.Context,
	periodID int64,
	projectID int64,
) (*Period, *Project, *Report, error) {
	period, err := h.store.GetPeriod(ctx, periodID)
	if err != nil {
		return nil, nil, nil, err
	}
	if period == nil {
		return nil, nil, nil, ErrPeriodNotFound
	}
	project, err := h.store.GetProject(ctx, projectID)
	if err != nil {
		return nil, nil, nil, err
	}
	if project == nil {
		return nil, nil, nil, ErrProjectNotFound
	}
	report, err := h.store.GetReport(ctx, periodID, projectID, project.Country)
	if err != nil {
		return nil, nil, nil, err
	}
	return period, project, report, nil
}

func parsePlatformCountry(body map[string]json.RawMessage, fallback string) (string, error) {
	raw, ok := body["country"]
	if !ok {
		return fallback, nil
	}
	if isJSONNull(raw) {
		return "", validationFailure("country 必须是 ISO-2 国家代码（如 US/DE/UK）")
	}
	var country string
	if err := decodeRaw(raw, &country); err != nil {
		return "", validationFailure("country 必须是 ISO-2 国家代码（如 US/DE/UK）")
	}
	return normalizeISO2Country(country)
}

func mergeReportPatch(current *Report, patch ReportPatch) ReportPatch {
	merged := patch
	if patch.HealthDataSet {
		health := cloneJSONMap(nil)
		if current != nil {
			health = cloneJSONMap(current.HealthData)
		}
		for key, value := range patch.HealthData {
			health[key] = value
		}
		merged.HealthData = health
	}
	if patch.ComplianceDataSet {
		compliance := cloneJSONMap(nil)
		if current != nil {
			compliance = cloneJSONMap(current.ComplianceData)
		}
		for key, value := range patch.ComplianceData {
			compliance[key] = value
		}
		merged.ComplianceData = compliance
	}
	return merged
}

func cloneJSONMap(source map[string]any) map[string]any {
	result := make(map[string]any, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func credentialAgentID(r *http.Request) string {
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		return ""
	}
	return credential.AgentID
}

func chiURLParam(r *http.Request, name string) string {
	return routeParam(r, name)
}

func routeParam(r *http.Request, name string) string {
	if r == nil || r.URL == nil {
		return ""
	}
	return chi.URLParam(r, name)
}

func readScreenshotMultipart(
	w http.ResponseWriter,
	r *http.Request,
) (*multipart.FileHeader, []byte, string, error) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxScreenshotBytes+2*1024*1024)
	if err := r.ParseMultipartForm(MaxScreenshotBytes); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			return nil, nil, "", &agentauth.APIError{
				Status: http.StatusRequestEntityTooLarge,
				Code:   agentauth.ErrorCodeValidationFailed, Detail: "File too large",
			}
		}
		return nil, nil, "", validationFailure("Invalid multipart form")
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, nil, "", validationFailure("缺少文件字段 file")
	}
	defer file.Close()
	if header == nil || strings.TrimSpace(header.Filename) == "" {
		return nil, nil, "", validationFailure("Missing filename")
	}
	contentType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	if semicolon := strings.Index(contentType, ";"); semicolon >= 0 {
		contentType = strings.TrimSpace(contentType[:semicolon])
	}
	if contentType == "image/jpg" {
		contentType = "image/jpeg"
	}
	payload, err := io.ReadAll(io.LimitReader(file, MaxScreenshotBytes+1))
	if err != nil {
		return nil, nil, "", validationFailure("Failed to read file")
	}
	if int64(len(payload)) > MaxScreenshotBytes {
		return nil, nil, "", &agentauth.APIError{
			Status: http.StatusRequestEntityTooLarge,
			Code:   agentauth.ErrorCodeValidationFailed, Detail: "File too large",
		}
	}
	if len(payload) == 0 {
		return nil, nil, "", validationFailure("File is empty")
	}
	return header, payload, contentType, nil
}

func prepareScreenshot(data []byte, declaredContentType string) (
	primary []byte,
	thumbnail []byte,
	storedContentType string,
	extension string,
	err error,
) {
	allowed := map[string]bool{
		"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true,
	}
	if !allowed[declaredContentType] {
		return nil, nil, "", "", validationFailure("Unsupported image type")
	}
	detected := detectImageMIME(data)
	if detected == "" {
		return nil, nil, "", "", validationFailure("文件内容不是受支持的图片")
	}
	if detected != declaredContentType {
		return nil, nil, "", "", validationFailure("声明 MIME 与文件内容不匹配")
	}
	if detected == "image/webp" {
		if len(data) < 16 || !bytes.Equal(data[:4], []byte("RIFF")) ||
			!bytes.Equal(data[8:12], []byte("WEBP")) {
			return nil, nil, "", "", validationFailure("WebP 文件头非法")
		}
		return data, nil, detected, ".webp", nil
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, nil, "", "", validationFailure("图片解码失败")
	}
	if config.Width <= 0 || config.Height <= 0 ||
		config.Width > 10000 || config.Height > 10000 ||
		int64(config.Width)*int64(config.Height) > 40_000_000 {
		return nil, nil, "", "", validationFailure("图片尺寸非法")
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, nil, "", "", validationFailure("图片解码失败")
	}
	primary, err = encodeJPEG(source, 1920, 80)
	if err != nil {
		return nil, nil, "", "", validationFailure("图片转换失败")
	}
	thumbnail, err = encodeJPEG(source, 320, 70)
	if err != nil {
		return nil, nil, "", "", validationFailure("缩略图生成失败")
	}
	return primary, thumbnail, "image/jpeg", ".jpg", nil
}

func detectImageMIME(data []byte) string {
	switch {
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg"
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}):
		return "image/png"
	case len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))):
		return "image/gif"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	default:
		return ""
	}
}

func encodeJPEG(source image.Image, maxWidth int, quality int) ([]byte, error) {
	width := source.Bounds().Dx()
	height := source.Bounds().Dy()
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("invalid image dimensions")
	}
	if width > maxWidth {
		height = int(float64(height) * float64(maxWidth) / float64(width))
		width = maxWidth
		if height < 1 {
			height = 1
		}
		source = resizeNearest(source, width, height)
	}
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, source, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func resizeNearest(source image.Image, width, height int) image.Image {
	bounds := source.Bounds()
	target := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		sourceY := bounds.Min.Y + y*bounds.Dy()/height
		for x := 0; x < width; x++ {
			sourceX := bounds.Min.X + x*bounds.Dx()/width
			target.Set(x, y, source.At(sourceX, sourceY))
		}
	}
	return target
}

func randomObjectID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return hex.EncodeToString(random), nil
}

func safeProjectSegment(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	value = strings.ReplaceAll(value, "/", "_")
	value = strings.ReplaceAll(value, "\\", "_")
	value = strings.Map(func(character rune) rune {
		if character < 0x20 || character == 0x7f {
			return '_'
		}
		return character
	}, value)
	if runes := []rune(value); len(runes) > 64 {
		value = string(runes[:64])
	}
	return value
}

func sanitizeFilename(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	value = filepath.Base(value)
	value = strings.Map(func(character rune) rune {
		if character < 0x20 || character == 0x7f {
			return -1
		}
		return character
	}, value)
	if value == "" || value == "." {
		return "screenshot"
	}
	if runes := []rune(value); len(runes) > 256 {
		value = string(runes[:256])
	}
	return value
}

func readBlobBytes(ctx context.Context, blobs BlobStore, key string) ([]byte, error) {
	reader, err := blobs.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	payload, err := io.ReadAll(io.LimitReader(reader, MaxScreenshotBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(payload)) > MaxScreenshotBytes {
		return nil, fmt.Errorf("blob exceeds screenshot limit")
	}
	return payload, nil
}

func (h *Handler) restoreDeletedObjects(
	screenshot *Screenshot,
	primary []byte,
	thumbnail []byte,
) {
	if h.blobs == nil || screenshot == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := h.blobs.Put(ctx, screenshot.R2Key, primary, screenshot.ContentType); err != nil {
		slog.Error("restore inspection screenshot after failed delete", "error", err)
	}
	if screenshot.ThumbnailKey != nil && strings.TrimSpace(*screenshot.ThumbnailKey) != "" {
		if _, err := h.blobs.Put(ctx, *screenshot.ThumbnailKey, thumbnail, "image/jpeg"); err != nil {
			slog.Error("restore inspection screenshot thumbnail after failed delete", "error", err)
		}
	}
}

func (h *Handler) deleteBlobObjects(keys ...string) {
	if h.blobs == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, key := range keys {
		if strings.TrimSpace(key) == "" {
			continue
		}
		if err := h.blobs.Delete(ctx, key); err != nil {
			slog.Error("delete inspection screenshot object after failed write", "error", err)
		}
	}
}
