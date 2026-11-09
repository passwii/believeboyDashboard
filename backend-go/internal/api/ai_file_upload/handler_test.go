package ai_file_upload

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestAIFileUploadRegistersRoute(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrar().RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	registered := false
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method == http.MethodPost && route == "/api/v1/ai/upload" {
			registered = true
		}
		return nil
	}); err != nil {
		t.Fatalf("Walk() error = %v", err)
	}
	if !registered {
		t.Fatal("AI file upload route was not registered")
	}
}

func TestAIFileUploadReturnsTextContentAndSanitizedFilename(t *testing.T) {
	request := multipartRequest(t, "../passwd.txt", []byte("hello\nworld"))
	recorder := httptest.NewRecorder()
	NewHandler().Upload(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		FileName      string  `json:"file_name"`
		FileType      string  `json:"file_type"`
		Content       string  `json:"content"`
		Truncated     bool    `json:"truncated"`
		TruncatedNote *string `json:"truncated_note"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.FileName != "passwd.txt" || response.FileType != "text" {
		t.Errorf("response = %#v", response)
	}
	if !strings.Contains(response.Content, "hello\nworld") {
		t.Errorf("content = %q", response.Content)
	}
	if strings.Contains(recorder.Body.String(), "../") {
		t.Errorf("response leaked path traversal filename: %s", recorder.Body.String())
	}
}

func TestAIFileUploadRejectsUnsupportedAndInvalidFiles(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		content  []byte
		status   int
	}{
		{name: "unsupported extension", filename: "bad.exe", content: []byte("MZ"), status: http.StatusBadRequest},
		{name: "invalid png", filename: "photo.png", content: []byte("not png"), status: http.StatusUnprocessableEntity},
		{name: "empty txt", filename: "empty.txt", content: nil, status: http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			NewHandler().Upload(recorder, multipartRequest(t, tt.filename, tt.content))
			if recorder.Code != tt.status {
				t.Fatalf("status = %d, want %d; body = %s", recorder.Code, tt.status, recorder.Body.String())
			}
		})
	}
}

func TestAIFileUploadRejectsOversizedText(t *testing.T) {
	payload := bytes.Repeat([]byte("a"), 2*1024*1024+1)
	recorder := httptest.NewRecorder()
	NewHandler().Upload(recorder, multipartRequest(t, "large.txt", payload))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAIFileUploadParsesXLSXWorkbook(t *testing.T) {
	workbook := stage7XLSXBytes(t)
	recorder := httptest.NewRecorder()
	NewHandler().Upload(recorder, multipartRequest(t, "report.xlsx", workbook))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		FileType string `json:"file_type"`
		Content  string `json:"content"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.FileType != "excel" ||
		!strings.Contains(response.Content, "Sheet1") ||
		!strings.Contains(response.Content, "Product") ||
		!strings.Contains(response.Content, "apple") {
		t.Errorf("xlsx response = %#v", response)
	}
}

func TestAIFileUploadMissingFileReturns422(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/ai/upload", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	NewHandler().Upload(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func multipartRequest(t *testing.T, filename string, content []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/ai/upload", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func stage7XLSXBytes(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entries := map[string]string{
		"xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?>
			<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
			  <si><t>Product</t></si><si><t>Quantity</t></si>
			</sst>`,
		"xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
			<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
			  <sheets><sheet name="Sheet1"/></sheets>
			</workbook>`,
		"xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
			<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
			  <sheetData>
			    <row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
			    <row><c r="A2" t="inlineStr"><is><t>apple</t></is></c><c r="B2"><v>3</v></c></row>
			  </sheetData>
			</worksheet>`,
	}
	for name, content := range entries {
		part, err := writer.Create(name)
		if err != nil {
			t.Fatalf("zip Create(%q) error = %v", name, err)
		}
		if _, err := part.Write([]byte(content)); err != nil {
			t.Fatalf("zip write(%q) error = %v", name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("zip close error = %v", err)
	}
	return buffer.Bytes()
}
