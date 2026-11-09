package page_render

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestUploadPageCreatesBlobAndRow(t *testing.T) {
	store := &handlerStore{}
	blobs := &fakeBlobs{}
	auditor := audit.NewMockService()
	handler := NewHandler(store, blobs, Config{}, auditor)
	body, contentType := pageMultipart(t, "page.md", "text/markdown", []byte("# Hello"))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/page-render/upload", body)
	req.Header.Set("Content-Type", contentType)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{
		UserID: "42", Operator: "运营甲",
	}))
	rec := httptest.NewRecorder()
	handler.Upload(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if blobs.key == "" || blobs.data == nil || store.inserted.OwnerUserID != 42 ||
		store.inserted.SourceFormat != "markdown" {
		t.Fatalf("blob=%#v page=%#v", blobs, store.inserted)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "page_render.upload" {
		t.Fatalf("audit = %#v", auditor.Entries)
	}
}

func TestUploadRequiresBlobStoreAndIdentity(t *testing.T) {
	handler := NewHandler(&handlerStore{}, nil, Config{}, nil)
	body, contentType := pageMultipart(t, "page.md", "text/markdown", []byte("x"))
	req := httptest.NewRequest(http.MethodPost, "/upload", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	handler.Upload(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", rec.Code)
	}

	handler = NewHandler(&handlerStore{}, &fakeBlobs{}, Config{}, nil)
	rec = httptest.NewRecorder()
	handler.Upload(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestUploadRejectsOversizeAndMIME(t *testing.T) {
	handler := NewHandler(&handlerStore{}, &fakeBlobs{}, Config{MaxBytes: 4}, nil)
	req := pageUploadRequest(t, "page.html", "image/png", []byte("12345"))
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "42"}))
	rec := httptest.NewRecorder()
	handler.Upload(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("mime status = %d", rec.Code)
	}

	req = pageUploadRequest(t, "page.html", "text/html", []byte("12345"))
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "42"}))
	rec = httptest.NewRecorder()
	handler.Upload(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("size status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestHistoryAndDeleteAreOwnerScoped(t *testing.T) {
	store := &handlerStore{pages: []UploadedPage{{ID: "p1", Title: "Page"}}, page: &PageRecord{ID: "p1", OwnerUserID: 42}}
	handler := NewHandler(store, &fakeBlobs{}, Config{}, nil)
	req := httptest.NewRequest(http.MethodGet, "/history?limit=2&offset=0", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "42"}))
	rec := httptest.NewRecorder()
	handler.History(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"p1"`) {
		t.Fatalf("history = %d %s", rec.Code, rec.Body.String())
	}

	deleteReq := withChiParam(httptest.NewRequest(http.MethodDelete, "/page-render/p1", nil), "page_id", "p1")
	deleteReq = deleteReq.WithContext(auth.WithUserContext(deleteReq.Context(), auth.UserContext{UserID: "42"}))
	rec = httptest.NewRecorder()
	handler.Delete(rec, deleteReq)
	if rec.Code != http.StatusNoContent || !store.deleted {
		t.Fatalf("delete = %d", rec.Code)
	}

	foreign := withChiParam(httptest.NewRequest(http.MethodDelete, "/page-render/p1", nil), "page_id", "p1")
	foreign = foreign.WithContext(auth.WithUserContext(foreign.Context(), auth.UserContext{UserID: "7"}))
	rec = httptest.NewRecorder()
	handler.Delete(rec, foreign)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign delete = %d", rec.Code)
	}
}

func TestPublicMissingPage404(t *testing.T) {
	handler := NewHandler(&handlerStore{}, &fakeBlobs{}, Config{}, nil)
	req := withChiParam(httptest.NewRequest(http.MethodGet, "/public/missing", nil), "page_id", "missing")
	rec := httptest.NewRecorder()
	handler.Public(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
}

func pageMultipart(t *testing.T, filename, contentType string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(map[string][]string)
	header["Content-Disposition"] = []string{`form-data; name="file"; filename="` + filename + `"`}
	header["Content-Type"] = []string{contentType}
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	_ = writer.Close()
	return &body, writer.FormDataContentType()
}

func pageUploadRequest(t *testing.T, filename, contentType string, data []byte) *http.Request {
	body, formContentType := pageMultipart(t, filename, contentType, data)
	req := httptest.NewRequest(http.MethodPost, "/upload", body)
	req.Header.Set("Content-Type", formContentType)
	return req
}

type handlerStore struct {
	pages    []UploadedPage
	page     *PageRecord
	inserted PageRecord
	deleted  bool
}

func (s *handlerStore) InsertPage(_ context.Context, page PageRecord) (UploadedPage, error) {
	s.inserted = page
	return UploadedPage{
		ID: page.ID, Title: page.Title, SourceFormat: page.SourceFormat,
		PublicURL: page.PublicURL, OriginalFilename: page.OriginalFilename,
		FileSize: page.FileSize, CreatedAt: "2026-11-08T08:00:00Z",
	}, nil
}
func (s *handlerStore) GetPage(context.Context, string) (*PageRecord, error) { return s.page, nil }
func (s *handlerStore) ListPages(context.Context, int64, int, int) ([]UploadedPage, error) {
	return s.pages, nil
}
func (*handlerStore) CountPages(context.Context, int64) (int64, error) { return 1, nil }
func (s *handlerStore) DeletePage(context.Context, string, int64) (bool, error) {
	s.deleted = true
	return true, nil
}

type fakeBlobs struct {
	key  string
	data []byte
	err  error
}

func (blobs *fakeBlobs) Put(_ context.Context, key string, data []byte, _ string) (string, error) {
	blobs.key = key
	blobs.data = append([]byte(nil), data...)
	return "https://r2.example/" + key, blobs.err
}
func (*fakeBlobs) Delete(context.Context, string) error { return nil }

func withChiParam(request *http.Request, key, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(key, value)
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}
