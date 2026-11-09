package exchange_rates

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestUploadExchangeRateImageStoresMainAndThumbnail(t *testing.T) {
	blobs := &stage10EExchangeBlobs{}
	handler := NewHandler(&fakeStore{}, WithBlobStore(blobs))
	router := chi.NewRouter()
	handler.RegisterWriteRoutes(router, stage10EPassthrough)

	body, contentType := stage10EImageMultipart(t, "rate-note.png", "image/png", stage10EPNG(t))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates/upload-image", body)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
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
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.ID == "" || response.URL == "" || response.ThumbnailURL == nil ||
		response.R2Key == "" || response.ThumbnailKey == "" || response.Filename != "rate-note.png" {
		t.Fatalf("response = %#v", response)
	}
	if response.ContentType != "image/png" || response.Size != len(stage10EPNG(t)) ||
		response.UploadedAt == "" {
		t.Fatalf("response metadata = %#v", response)
	}
	if len(blobs.puts) != 2 {
		t.Fatalf("puts = %d, want main + thumbnail", len(blobs.puts))
	}
	if !bytes.HasPrefix(blobs.puts[0].data, []byte{0x89, 'P', 'N', 'G'}) {
		t.Fatalf("main object is not a PNG: %x", blobs.puts[0].data[:8])
	}
}

func TestUploadExchangeRateImageFailsClosedWithoutBlobStore(t *testing.T) {
	handler := NewHandler(&fakeStore{})
	body, contentType := stage10EImageMultipart(t, "rate-note.png", "image/png", stage10EPNG(t))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates/upload-image", body)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()

	handler.UploadImage(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestUploadExchangeRateImageRejectsMIMEAndMagicMismatch(t *testing.T) {
	blobs := &stage10EExchangeBlobs{}
	handler := NewHandler(&fakeStore{}, WithBlobStore(blobs))

	body, contentType := stage10EImageMultipart(t, "note.png", "image/png", []byte("not-an-image"))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates/upload-image", body)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()
	handler.UploadImage(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	body, contentType = stage10EImageMultipart(t, "../escape.png", "image/png", stage10EPNG(t))
	request = httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates/upload-image", body)
	request.Header.Set("Content-Type", contentType)
	recorder = httptest.NewRecorder()
	handler.UploadImage(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("traversal filename status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestUploadExchangeRateImageCompensatesWhenThumbnailUploadFails(t *testing.T) {
	blobs := &stage10EExchangeBlobs{failPutAt: 2}
	handler := NewHandler(&fakeStore{}, WithBlobStore(blobs))
	body, contentType := stage10EImageMultipart(t, "note.png", "image/png", stage10EPNG(t))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates/upload-image", body)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()

	handler.UploadImage(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.deletedKeys) != 1 {
		t.Fatalf("deleted keys = %#v, want main-object compensation", blobs.deletedKeys)
	}
}

type stage10EExchangeBlobs struct {
	puts        []stage10EExchangePut
	deletedKeys []string
	failPutAt   int
}

type stage10EExchangePut struct {
	key         string
	data        []byte
	contentType string
}

func (blobs *stage10EExchangeBlobs) Put(
	_ context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	blobs.puts = append(blobs.puts, stage10EExchangePut{
		key: key, data: append([]byte(nil), data...), contentType: contentType,
	})
	if len(blobs.puts) == blobs.failPutAt {
		return "", context.DeadlineExceeded
	}
	return "https://cdn.example.com/" + key, nil
}

func (blobs *stage10EExchangeBlobs) Delete(_ context.Context, key string) error {
	blobs.deletedKeys = append(blobs.deletedKeys, key)
	return nil
}

func (*stage10EExchangeBlobs) Get(context.Context, string) (io.ReadCloser, error) {
	return nil, context.DeadlineExceeded
}

func stage10EImageMultipart(
	t *testing.T,
	filename string,
	contentType string,
	content []byte,
) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="file"; filename="`+filename+`"`)
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("create multipart part: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write multipart part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &body, writer.FormDataContentType()
}

func stage10EPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	img.Set(1, 1, color.NRGBA{B: 255, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode PNG: %v", err)
	}
	return buffer.Bytes()
}

func stage10EPassthrough(next http.Handler) http.Handler {
	return next
}
