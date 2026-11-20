package platform_revenues

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	_ "golang.org/x/image/webp"
)

const (
	maxImageBytes                  = 10 * 1024 * 1024
	maxImageMultipartOverhead      = 2 * 1024 * 1024
	paymentScreenshotThumbWidth    = 320
	paymentScreenshotThumbQuality  = 70
	maxPaymentScreenshotPixels     = 40_000_000
	paymentScreenshotDeleteTimeout = 5 * time.Second
)

var allowedImageTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/webp": true,
	"image/gif":  true,
}

type BlobStore interface {
	Put(context.Context, string, []byte, string) (string, error)
	Delete(context.Context, string) error
}

func (h *Handler) UploadImage(w http.ResponseWriter, r *http.Request) {
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage is not configured. Please contact administrator.")
		return
	}

	identity, authenticated := auth.UserContextFromContext(r.Context())
	projectName, filename, declaredType, data, ok := readPaymentScreenshotUpload(w, r)
	if !ok {
		return
	}

	// Production routes are wrapped by RequireAPIKey, which always installs a
	// user context. Keep direct handler calls without that middleware working
	// for existing unit-level callers; authenticated requests must fail closed.
	if authenticated {
		if strings.TrimSpace(identity.UserID) == "" {
			httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
			return
		}
		if h.projectReader == nil {
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Project authorization is not configured")
			return
		}
		project, err := h.projectReader.GetProjectByName(r.Context(), projectName)
		if err != nil {
			httpapi.WriteInternalServerError(w)
			return
		}
		if project == nil {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		if err := h.store.VerifyProjectAccess(r.Context(), project.ID, identity.Operator, identity.IsAdmin); err != nil {
			if errors.Is(err, ErrProjectNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
				return
			}
			if errors.Is(err, ErrProjectForbidden) {
				httpapi.WriteDetail(w, http.StatusForbidden, "无权限在该项目下上传图片")
				return
			}
			httpapi.WriteInternalServerError(w)
			return
		}
		projectName = project.Name
	}

	primary, primaryType, extension, thumbnail, err := preparePaymentScreenshot(data, declaredType)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	imageID, err := newPaymentScreenshotID()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Failed to generate image id")
		return
	}

	projectSegment := safePaymentProjectSegment(projectName)
	key, err := blob.ObjectKey(
		projectSegment,
		"payment_screenshot",
		"images",
		imageID+extension,
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Failed to build storage key")
		return
	}
	thumbKey, err := blob.ObjectKey(
		projectSegment,
		"payment_screenshot",
		"thumbs",
		imageID+"_thumb.jpg",
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Failed to build storage key")
		return
	}

	mainURL, err := h.blobs.Put(r.Context(), key, primary, primaryType)
	if err != nil || strings.TrimSpace(mainURL) == "" {
		bestEffortPaymentScreenshotDelete(r.Context(), h.blobs, key)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage upload failed")
		return
	}

	thumbURL, err := h.blobs.Put(r.Context(), thumbKey, thumbnail, "image/jpeg")
	if err != nil || strings.TrimSpace(thumbURL) == "" {
		bestEffortPaymentScreenshotDelete(r.Context(), h.blobs, key)
		bestEffortPaymentScreenshotDelete(r.Context(), h.blobs, thumbKey)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage upload failed")
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, UploadImageResponse{
		ID:        imageID,
		URL:       strings.TrimSpace(mainURL),
		ThumbURL:  strings.TrimSpace(thumbURL),
		Key:       key,
		Filename:  safePaymentScreenshotFilename(filename, extension),
		Size:      int64(len(primary)),
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func readPaymentScreenshotUpload(
	w http.ResponseWriter,
	r *http.Request,
) (projectName string, filename string, contentType string, data []byte, ok bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImageBytes+maxImageMultipartOverhead)
	if err := r.ParseMultipartForm(maxImageBytes); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		} else {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid multipart form")
		}
		return "", "", "", nil, false
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	projectName = strings.TrimSpace(r.FormValue("project_name"))
	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file in form")
		return "", "", "", nil, false
	}
	defer file.Close()

	contentType = normalizePaymentScreenshotMIME(header.Header.Get("Content-Type"))
	if contentType != "" && !allowedImageTypes[contentType] {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Unsupported file type")
		return "", "", "", nil, false
	}
	if header.Size > maxImageBytes {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		return "", "", "", nil, false
	}

	data, err = io.ReadAll(io.LimitReader(file, maxImageBytes+1))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		return "", "", "", nil, false
	}
	if len(data) == 0 || len(data) > maxImageBytes {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		return "", "", "", nil, false
	}
	return projectName, header.Filename, contentType, data, true
}

func normalizePaymentScreenshotMIME(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if parsed, _, err := mime.ParseMediaType(raw); err == nil {
		return parsed
	}
	if index := strings.IndexByte(raw, ';'); index >= 0 {
		return strings.TrimSpace(raw[:index])
	}
	return raw
}

func preparePaymentScreenshot(data []byte, declaredType string) (
	primary []byte,
	storedType string,
	extension string,
	thumbnail []byte,
	err error,
) {
	detected := detectImageMIME(data)
	if detected == "" {
		return nil, "", "", nil, errors.New("Unsupported image content")
	}
	if declaredType != "" && declaredType != detected {
		return nil, "", "", nil, errors.New("Unsupported file type")
	}

	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, "", "", nil, errors.New("Image decode failed")
	}
	if config.Width <= 0 || config.Height <= 0 ||
		config.Width > 10000 || config.Height > 10000 ||
		int64(config.Width)*int64(config.Height) > maxPaymentScreenshotPixels {
		return nil, "", "", nil, errors.New("Image dimensions are invalid")
	}

	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", "", nil, errors.New("Image decode failed")
	}
	thumbnail, err = encodeJPEG(
		source,
		paymentScreenshotThumbWidth,
		paymentScreenshotThumbQuality,
	)
	if err != nil {
		return nil, "", "", nil, errors.New("Thumbnail generation failed")
	}
	return data, detected, paymentScreenshotExtension(detected), thumbnail, nil
}

func detectImageMIME(data []byte) string {
	switch {
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg"
	case len(data) >= 8 &&
		bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}):
		return "image/png"
	case len(data) >= 6 &&
		(bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))):
		return "image/gif"
	case len(data) >= 12 &&
		bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	default:
		return ""
	}
}

func paymentScreenshotExtension(contentType string) string {
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

func encodeJPEG(source image.Image, maxWidth int, quality int) ([]byte, error) {
	width := source.Bounds().Dx()
	height := source.Bounds().Dy()
	if width <= 0 || height <= 0 {
		return nil, errors.New("invalid image dimensions")
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

func resizeNearest(source image.Image, width int, height int) image.Image {
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

func newPaymentScreenshotID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func safePaymentScreenshotFilename(raw string, extension string) string {
	name := safePaymentFilenameBase(raw)
	if name == "" {
		return "payment-screenshot" + extension
	}
	currentExtension := filepath.Ext(name)
	if currentExtension != extension {
		name = strings.TrimSuffix(name, currentExtension) + extension
	}
	return name
}

func safePaymentFilenameBase(raw string) string {
	name := strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	name = filepath.Base(name)
	name = strings.Map(func(character rune) rune {
		if character == 0 || character == '/' || character == '\\' ||
			unicode.IsControl(character) {
			return '-'
		}
		switch character {
		case ':', '*', '?', '"', '<', '>', '|':
			return '-'
		default:
			return character
		}
	}, name)
	name = strings.TrimSpace(strings.Trim(name, ". -"))
	if name == "" || name == "." || name == ".." {
		return ""
	}
	runes := []rune(name)
	if len(runes) > 255 {
		extension := []rune(filepath.Ext(name))
		stemLimit := 255 - len(extension)
		if stemLimit < 1 {
			return ""
		}
		name = string(runes[:stemLimit]) + string(extension)
	}
	return name
}

func safePaymentProjectSegment(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "project"
	}
	var builder strings.Builder
	lastWasDash := false
	for _, character := range value {
		switch {
		case unicode.IsLetter(character) || unicode.IsDigit(character) ||
			character == '.' || character == '_' || character == '-':
			builder.WriteRune(character)
			lastWasDash = false
		case unicode.IsSpace(character):
			if !lastWasDash && builder.Len() > 0 {
				builder.WriteByte('-')
				lastWasDash = true
			}
		default:
			if builder.Len() > 0 && !lastWasDash {
				builder.WriteByte('-')
				lastWasDash = true
			}
		}
	}
	out := strings.Trim(strings.TrimSpace(builder.String()), " .-_")
	if out == "" || out == "." || out == ".." {
		return "project"
	}
	if len(out) > 80 {
		runes := []rune(out)
		if len(runes) > 80 {
			out = string(runes[:80])
		}
		out = strings.Trim(out, " .-_")
		if out == "" {
			return "project"
		}
	}
	return out
}

func bestEffortPaymentScreenshotDelete(
	parent context.Context,
	blobs BlobStore,
	key string,
) {
	if blobs == nil || key == "" {
		return
	}
	ctx, cancel := context.WithTimeout(
		context.WithoutCancel(parent),
		paymentScreenshotDeleteTimeout,
	)
	defer cancel()
	_ = blobs.Delete(ctx, key)
}
