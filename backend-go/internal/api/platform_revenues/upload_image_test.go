package platform_revenues

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
)

func TestUploadPaymentScreenshotStoresOriginalAndThumbnail(t *testing.T) {
	data := paymentScreenshotTestPNG(t, 640, 480)
	blobs := &fakePaymentScreenshotBlobs{}
	handler := NewHandler(&mockPlatformRevenueStore{}, &mockAuditor{}).WithBlobStore(blobs)

	body, contentType := paymentScreenshotMultipart(
		t, "../../Shop US", "receipt.PNG", "image/png", data,
	)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/platform-revenues/upload-image",
		body,
	)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()

	handler.UploadImage(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response UploadImageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if len(blobs.puts) != 2 {
		t.Fatalf("puts = %d, want original + thumbnail", len(blobs.puts))
	}
	main := blobs.puts[0]
	thumbnail := blobs.puts[1]

	if main.contentType != "image/png" {
		t.Fatalf("main content type = %q", main.contentType)
	}
	if !bytes.Equal(main.data, data) {
		t.Fatal("main object bytes differ from the uploaded original")
	}
	if strings.Contains(main.key, "..") || !strings.HasPrefix(main.key, "Shop-US/payment_screenshot/images/") {
		t.Fatalf("unsafe or unexpected main key: %q", main.key)
	}
	if !strings.HasSuffix(main.key, response.ID+".png") {
		t.Fatalf("main key %q does not match id %q", main.key, response.ID)
	}
	if thumbnail.contentType != "image/jpeg" {
		t.Fatalf("thumbnail content type = %q", thumbnail.contentType)
	}
	if !strings.HasPrefix(thumbnail.key, "Shop-US/payment_screenshot/thumbs/") ||
		!strings.HasSuffix(thumbnail.key, response.ID+"_thumb.jpg") {
		t.Fatalf("unexpected thumbnail key: %q", thumbnail.key)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(thumbnail.data))
	if err != nil {
		t.Fatalf("decode thumbnail: %v", err)
	}
	if decoded.Bounds().Dx() != 320 || decoded.Bounds().Dy() != 240 {
		t.Fatalf("thumbnail bounds = %v", decoded.Bounds())
	}

	if response.URL != "https://cdn.example.com/"+main.key {
		t.Fatalf("url = %q, want Put return value", response.URL)
	}
	if response.ThumbURL != "https://cdn.example.com/"+thumbnail.key {
		t.Fatalf("thumb_url = %q, want Put return value", response.ThumbURL)
	}
	if response.Key != main.key {
		t.Fatalf("key = %q, want %q", response.Key, main.key)
	}
	if response.Filename != "receipt.png" {
		t.Fatalf("filename = %q, want canonical extension", response.Filename)
	}
	if response.Size != int64(len(data)) {
		t.Fatalf("size = %d, want %d", response.Size, len(data))
	}
	if len(response.ID) != 32 || response.CreatedAt == "" {
		t.Fatalf("response metadata = %+v", response)
	}
}

func TestUploadPaymentScreenshotFailsClosedWithoutBlobStore(t *testing.T) {
	body, contentType := paymentScreenshotMultipart(
		t, "Shop US", "receipt.png", "image/png", paymentScreenshotTestPNG(t, 32, 32),
	)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/platform-revenues/upload-image",
		body,
	)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()

	NewHandler(&mockPlatformRevenueStore{}, &mockAuditor{}).UploadImage(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestUploadPaymentScreenshotCompensatesWhenThumbnailUploadFails(t *testing.T) {
	blobs := &fakePaymentScreenshotBlobs{failPutAt: 2}
	handler := NewHandler(&mockPlatformRevenueStore{}, &mockAuditor{}).WithBlobStore(blobs)
	body, contentType := paymentScreenshotMultipart(
		t, "Shop US", "receipt.png", "image/png", paymentScreenshotTestPNG(t, 64, 64),
	)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/platform-revenues/upload-image",
		body,
	)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()

	handler.UploadImage(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.deletedKeys) != 2 ||
		blobs.deletedKeys[0] != blobs.puts[0].key ||
		blobs.deletedKeys[1] != blobs.puts[1].key {
		t.Fatalf("deleted keys = %#v, want original and thumbnail cleanup", blobs.deletedKeys)
	}
}

func TestUploadPaymentScreenshotCleansUpAfterOriginalUploadFailure(t *testing.T) {
	blobs := &fakePaymentScreenshotBlobs{failPutAt: 1}
	handler := NewHandler(&mockPlatformRevenueStore{}, &mockAuditor{}).WithBlobStore(blobs)
	body, contentType := paymentScreenshotMultipart(
		t, "Shop US", "receipt.png", "image/png", paymentScreenshotTestPNG(t, 64, 64),
	)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/platform-revenues/upload-image",
		body,
	)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()

	handler.UploadImage(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.deletedKeys) != 1 || blobs.deletedKeys[0] != blobs.puts[0].key {
		t.Fatalf("deleted keys = %#v, want best-effort cleanup", blobs.deletedKeys)
	}
}

func TestUploadPaymentScreenshotRejectsMismatchedContentType(t *testing.T) {
	blobs := &fakePaymentScreenshotBlobs{}
	handler := NewHandler(&mockPlatformRevenueStore{}, &mockAuditor{}).WithBlobStore(blobs)
	body, contentType := paymentScreenshotMultipart(
		t, "Shop US", "receipt.jpg", "image/jpeg", paymentScreenshotTestPNG(t, 64, 64),
	)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/platform-revenues/upload-image",
		body,
	)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()

	handler.UploadImage(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.puts) != 0 {
		t.Fatalf("puts = %d, want none", len(blobs.puts))
	}
}

type fakePaymentScreenshotPut struct {
	key         string
	data        []byte
	contentType string
}

type fakePaymentScreenshotBlobs struct {
	puts        []fakePaymentScreenshotPut
	deletedKeys []string
	failPutAt   int
}

func (blobs *fakePaymentScreenshotBlobs) Put(
	_ context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	blobs.puts = append(blobs.puts, fakePaymentScreenshotPut{
		key: key, data: append([]byte(nil), data...), contentType: contentType,
	})
	if len(blobs.puts) == blobs.failPutAt {
		return "", errors.New("put failed")
	}
	return "https://cdn.example.com/" + key, nil
}

func (blobs *fakePaymentScreenshotBlobs) Delete(_ context.Context, key string) error {
	blobs.deletedKeys = append(blobs.deletedKeys, key)
	return nil
}

func paymentScreenshotTestPNG(t *testing.T, width int, height int) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 120, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buffer.Bytes()
}

func paymentScreenshotMultipart(
	t *testing.T,
	projectName string,
	filename string,
	contentType string,
	content []byte,
) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("project_name", projectName); err != nil {
		t.Fatalf("write project_name: %v", err)
	}
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
