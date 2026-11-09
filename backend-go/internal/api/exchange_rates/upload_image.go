package exchange_rates

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxExchangeImageBytes        = 10 << 20
	exchangeMultipartOverhead    = 2 << 20
	exchangeThumbnailSize        = 320
	maxExchangeImagePixels       = 40_000_000
	exchangeImageDeleteTimeout   = 5 * time.Second
	exchangeImageProjectSlug     = "exchange-rate-notes"
	exchangeImageImagesFolder    = "images"
	exchangeImageThumbsFolder    = "thumbs"
	uploadedAtResponseTimeLayout = time.RFC3339Nano
)

type BlobStore interface {
	Put(context.Context, string, []byte, string) (string, error)
	Delete(context.Context, string) error
}

type exchangeUploadResponse struct {
	ID           string  `json:"id"`
	URL          string  `json:"url"`
	ThumbnailURL *string `json:"thumbnail_url"`
	R2Key        string  `json:"r2_key"`
	ThumbnailKey string  `json:"thumbnail_key"`
	Filename     string  `json:"filename"`
	ContentType  string  `json:"content_type"`
	Size         int     `json:"size"`
	UploadedAt   string  `json:"uploaded_at"`
}

func (h *Handler) UploadImage(w http.ResponseWriter, r *http.Request) {
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage is not configured. Please contact administrator.")
		return
	}

	filename, declaredType, data, ok := readExchangeImage(w, r)
	if !ok {
		return
	}
	detectedType, err := validateExchangeImage(data)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	if declaredType == "" {
		declaredType = detectedType
	}
	if declaredType != detectedType {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Unsupported file type")
		return
	}

	imageID, err := randomExchangeImageID()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	mainFilename := imageID + imageExtension(detectedType)
	thumbData, thumbType := exchangeThumbnail(data, detectedType)
	thumbExtension := imageExtension(thumbType)
	mainKey, err := blob.ObjectKey(
		exchangeImageProjectSlug,
		exchangeImageImagesFolder,
		mainFilename,
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	thumbKey, err := blob.ObjectKey(
		exchangeImageProjectSlug,
		exchangeImageThumbsFolder,
		imageID+"_thumb"+thumbExtension,
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	mainURL, err := h.blobs.Put(r.Context(), mainKey, data, detectedType)
	if err != nil || strings.TrimSpace(mainURL) == "" {
		bestEffortExchangeImageDelete(r.Context(), h.blobs, mainKey)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage upload failed")
		return
	}
	thumbURL, err := h.blobs.Put(r.Context(), thumbKey, thumbData, thumbType)
	if err != nil || strings.TrimSpace(thumbURL) == "" {
		bestEffortExchangeImageDelete(r.Context(), h.blobs, mainKey)
		if err == nil {
			bestEffortExchangeImageDelete(r.Context(), h.blobs, thumbKey)
		}
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage upload failed")
		return
	}

	thumbURL = strings.TrimSpace(thumbURL)
	_ = httpapi.WriteJSON(w, http.StatusOK, exchangeUploadResponse{
		ID:           imageID,
		URL:          strings.TrimSpace(mainURL),
		ThumbnailURL: &thumbURL,
		R2Key:        mainKey,
		ThumbnailKey: thumbKey,
		Filename:     filename,
		ContentType:  detectedType,
		Size:         len(data),
		UploadedAt:   time.Now().UTC().Format(uploadedAtResponseTimeLayout),
	})
}

func readExchangeImage(
	w http.ResponseWriter,
	r *http.Request,
) (string, string, []byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxExchangeImageBytes+exchangeMultipartOverhead)
	if err := r.ParseMultipartForm(maxExchangeImageBytes); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
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
	filename, err := safeExchangeImageFilename(rawFilename)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return "", "", nil, false
	}
	if header.Size > maxExchangeImageBytes {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		return "", "", nil, false
	}
	file, err := header.Open()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		return "", "", nil, false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxExchangeImageBytes+1))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		return "", "", nil, false
	}
	if len(data) > maxExchangeImageBytes {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		return "", "", nil, false
	}
	if len(data) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File size exceeds 10MB")
		return "", "", nil, false
	}
	return filename, normalizeExchangeImageMIME(header.Header.Get("Content-Type")),
		data, true
}

func safeExchangeImageFilename(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("Missing filename")
	}
	if strings.ContainsAny(raw, `/\`) || strings.Contains(raw, "..") {
		return "", errors.New("Invalid filename")
	}
	for _, character := range raw {
		if unicode.IsControl(character) {
			return "", errors.New("Invalid filename")
		}
	}
	filename := filepath.Base(raw)
	if filename == "." || filename == ".." || len([]rune(filename)) > 255 {
		return "", errors.New("Invalid filename")
	}
	return filename, nil
}

func normalizeExchangeImageMIME(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if parsed, _, err := mime.ParseMediaType(raw); err == nil {
		return parsed
	}
	if index := strings.IndexByte(raw, ';'); index >= 0 {
		return strings.TrimSpace(raw[:index])
	}
	return raw
}

func validateExchangeImage(data []byte) (string, error) {
	detected := detectExchangeImageMIME(data)
	if detected == "" {
		return "", errors.New("Unsupported image content")
	}
	if detected == "image/webp" {
		return detected, nil
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", errors.New("Unsupported image content")
	}
	if config.Width <= 0 || config.Height <= 0 ||
		config.Width > 10000 || config.Height > 10000 ||
		int64(config.Width)*int64(config.Height) > maxExchangeImagePixels {
		return "", errors.New("Image dimensions are too large")
	}
	return detected, nil
}

func detectExchangeImageMIME(data []byte) string {
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

func exchangeThumbnail(data []byte, contentType string) ([]byte, string) {
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
	scale := float64(exchangeThumbnailSize) / float64(max(bounds.Dx(), bounds.Dy()))
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

func imageExtension(contentType string) string {
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

func randomExchangeImageID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func bestEffortExchangeImageDelete(parent context.Context, blobs BlobStore, key string) {
	if blobs == nil || key == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), exchangeImageDeleteTimeout)
	defer cancel()
	_ = blobs.Delete(ctx, key)
}
