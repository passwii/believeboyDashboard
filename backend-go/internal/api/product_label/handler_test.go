package product_label

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockGenerator struct {
	err error
}

func (m *mockGenerator) Generate(_ context.Context, input GenerateInput) ([]byte, string, error) {
	if m.err != nil {
		return nil, "", m.err
	}
	return []byte("%PDF-1.4 mock pdf output"), "test-labeled.pdf", nil
}

func TestProductLabelHandler(t *testing.T) {
	generator := &mockGenerator{}
	router := chi.NewRouter()
	reg := NewRegistrar(generator)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin",
		Operator: "admin_op",
		IsAdmin:  true,
	})

	// Test 1: Success
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	part, _ := w.CreateFormFile("file", "test.pdf")
	_, _ = part.Write([]byte("%PDF-1.4 test content"))
	_ = w.WriteField("text", "Sample Text")
	_ = w.WriteField("made_in_china", "true")
	_ = w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("expected application/pdf, got %s", rec.Header().Get("Content-Type"))
	}

	// Test 2: Non-pdf extension
	b.Reset()
	w = multipart.NewWriter(&b)
	part, _ = w.CreateFormFile("file", "test.txt")
	_, _ = part.Write([]byte("%PDF-1.4 test content"))
	_ = w.WriteField("text", "Sample Text")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "仅支持 PDF 格式") {
		t.Fatalf("expected 400 for non-pdf extension, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 3: Non-pdf content
	b.Reset()
	w = multipart.NewWriter(&b)
	part, _ = w.CreateFormFile("file", "test.pdf")
	_, _ = part.Write([]byte("not a real pdf content"))
	_ = w.WriteField("text", "Sample Text")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "不是有效的 PDF") {
		t.Fatalf("expected 400 for non-pdf content, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 4: Empty file
	b.Reset()
	w = multipart.NewWriter(&b)
	_, _ = w.CreateFormFile("file", "test.pdf")
	_ = w.WriteField("text", "Sample Text")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "上传的文件为空") {
		t.Fatalf("expected 400 for empty file, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 5: Missing file
	b.Reset()
	w = multipart.NewWriter(&b)
	_ = w.WriteField("text", "Sample Text")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing file, got %d", rec.Code)
	}

	// Test 6: Text > 200 chars
	b.Reset()
	w = multipart.NewWriter(&b)
	part, _ = w.CreateFormFile("file", "test.pdf")
	_, _ = part.Write([]byte("%PDF-1.4 test"))
	_ = w.WriteField("text", strings.Repeat("字", 201))
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "文案过长") {
		t.Fatalf("expected 400 for text too long, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 7: Empty text without made_in_china
	b.Reset()
	w = multipart.NewWriter(&b)
	part, _ = w.CreateFormFile("file", "test.pdf")
	_, _ = part.Write([]byte("%PDF-1.4 test"))
	_ = w.WriteField("text", "   ")
	_ = w.WriteField("made_in_china", "false")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "至少填写") {
		t.Fatalf("expected 400 for empty text without made in china, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 8: File > 10MB returns 413
	b.Reset()
	w = multipart.NewWriter(&b)
	part, _ = w.CreateFormFile("file", "test.pdf")
	_, _ = part.Write([]byte("%PDF-1.4"))
	// write 10MB + 100 bytes
	chunk := make([]byte, 1024*1024)
	for i := 0; i < 10; i++ {
		_, _ = part.Write(chunk)
	}
	_, _ = part.Write(make([]byte, 200))
	_ = w.WriteField("text", "Hello")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 Payload Too Large, got %d: %s", rec.Code, rec.Body.String())
	}

	// Test 9: Generator error returns 400
	generator.err = errors.New("仅支持单页产品标签")
	b.Reset()
	w = multipart.NewWriter(&b)
	part, _ = w.CreateFormFile("file", "test.pdf")
	_, _ = part.Write([]byte("%PDF-1.4 test"))
	_ = w.WriteField("text", "Sample Text")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/product-label/generate", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "仅支持单页产品标签") {
		t.Fatalf("expected 400 with generator error, got %d: %s", rec.Code, rec.Body.String())
	}
}
