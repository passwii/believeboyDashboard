package uploads

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestUploadSavesBlobAndAudits(t *testing.T) {
	store := &handlerStore{}
	blobs := &fakeBlobs{}
	auditor := audit.NewMockService()
	handler := NewHandler(store, blobs, Config{}, auditor)
	req := uploadRequest(t, "report.csv", "text/csv", []byte("a,b"), map[string]string{
		"project_name": "北美",
		"file_type":    "business_report",
	})
	rec := httptest.NewRecorder()
	handler.Upload(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if blobs.key == "" || len(auditor.Entries) != 1 || !strings.Contains(rec.Body.String(), `"file_id"`) {
		t.Fatalf("blob=%#v audit=%#v body=%s", blobs, auditor.Entries, rec.Body.String())
	}
}

func TestUploadFailsClosedWithoutObjectStore(t *testing.T) {
	handler := NewHandler(&handlerStore{}, nil, Config{}, nil)
	req := uploadRequest(t, "report.csv", "text/csv", []byte("a,b"), map[string]string{
		"project_name": "北美",
		"file_type":    "business_report",
	})
	rec := httptest.NewRecorder()
	handler.Upload(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestRecognizeRejectsUnsupportedExtensionAndOversize(t *testing.T) {
	handler := NewHandler(&handlerStore{}, nil, Config{MaxBytes: 4}, nil)
	req := uploadRequest(t, "report.pdf", "application/pdf", []byte("data"), nil)
	rec := httptest.NewRecorder()
	handler.Recognize(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("extension status = %d body=%s", rec.Code, rec.Body.String())
	}

	req = uploadRequest(t, "report.csv", "text/csv", []byte("12345"), nil)
	rec = httptest.NewRecorder()
	handler.Recognize(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("size status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCommitDoesNotTrustForgedAdminHeader(t *testing.T) {
	store := &handlerStore{commitResponse: CommitResponse{
		ReportType: "business_report", Status: "persisted", ProjectName: stringPtr("北美"),
		Country: "US", FileID: "file", FilePath: "/tmp/file",
	}}
	handler := NewHandler(store, nil, Config{}, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/report-upload/commit",
		strings.NewReader(`{"temp_file_id":"t","report_type":"business_report","project_name":"北美","report_date":"2026-11-08"}`))
	req.Header.Set("X-Is-Admin", "true")
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{
		UserID: "7", Operator: "设备用户", IsAdmin: false,
	}))
	rec := httptest.NewRecorder()
	handler.Commit(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastAdmin {
		t.Fatal("forged X-Is-Admin promoted a non-admin device identity")
	}
}

func TestCommitMapsForbiddenAndStatusReturnsItems(t *testing.T) {
	store := &handlerStore{commitErr: NewAPIError(http.StatusForbidden, "无权限访问该项目")}
	handler := NewHandler(store, nil, Config{}, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/report-upload/commit",
		strings.NewReader(`{"temp_file_id":"t","report_type":"business_report","project_name":"北美","report_date":"2026-11-08"}`))
	rec := httptest.NewRecorder()
	handler.Commit(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d", rec.Code)
	}

	store.commitErr = nil
	store.status = StatusResponse{Country: "US", Items: []ProjectStatusItem{{
		ProjectID: 1, ProjectName: "北美", Statuses: map[string]StatusCell{},
	}}}
	statusReq := httptest.NewRequest(http.MethodGet, "/api/v1/report-upload/status?country=US", nil)
	statusReq = statusReq.WithContext(auth.WithUserContext(statusReq.Context(), auth.UserContext{
		Operator: "运营甲", IsAdmin: true,
	}))
	statusRec := httptest.NewRecorder()
	handler.Status(statusRec, statusReq)
	if statusRec.Code != http.StatusOK || !strings.Contains(statusRec.Body.String(), `"project_name":"北美"`) {
		t.Fatalf("status endpoint = %d %s", statusRec.Code, statusRec.Body.String())
	}
}

func uploadRequest(
	t *testing.T,
	filename string,
	contentType string,
	data []byte,
	fields map[string]string,
) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	partHeader := make(map[string][]string)
	partHeader["Content-Disposition"] = []string{`form-data; name="file"; filename="` + filename + `"`}
	partHeader["Content-Type"] = []string{contentType}
	part, err := writer.CreatePart(partHeader)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	for key, value := range fields {
		_ = writer.WriteField(key, value)
	}
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

type handlerStore struct {
	commitResponse CommitResponse
	commitErr      error
	status         StatusResponse
	lastAdmin      bool
}

func (*handlerStore) PrepareGenericUpload(filename, projectName, fileType string) (PreparedUpload, error) {
	return PreparedUpload{
		ObjectKey: "project/report.csv", Filename: filename,
		LocalPath: "/tmp/report.csv", OriginalFilename: filename,
	}, nil
}
func (*handlerStore) CommitPreparedUpload(_ context.Context, prepared PreparedUpload, data []byte, url string) (UploadResponse, error) {
	return UploadResponse{
		FileID: prepared.ObjectKey, FilePath: url, Filename: prepared.Filename,
		OriginalFilename: prepared.OriginalFilename, Size: int64(len(data)),
	}, nil
}
func (*handlerStore) SaveReportTemp(filename string, data []byte) (TempFile, error) {
	return TempFile{TempFileID: "t", OriginalFilename: filename, Size: int64(len(data))}, nil
}
func (*handlerStore) RecognizeReport(context.Context, TempFile, string, string, bool) (RecognitionResponse, error) {
	return RecognitionResponse{Status: "recognized", ProjectMatch: ProjectMatchSummary{}}, nil
}
func (s *handlerStore) CommitReport(_ context.Context, payload CommitRequest, _ string, isAdmin bool) (CommitResponse, error) {
	s.lastAdmin = isAdmin
	return s.commitResponse, s.commitErr
}
func (s *handlerStore) ListReportStatus(context.Context, *string, string, string, bool) (StatusResponse, error) {
	return s.status, s.commitErr
}

type fakeBlobs struct {
	key  string
	data []byte
}

func (blobs *fakeBlobs) Put(_ context.Context, key string, data []byte, _ string) (string, error) {
	blobs.key = key
	blobs.data = append([]byte(nil), data...)
	return "https://r2.example/" + key, nil
}
func (*fakeBlobs) Delete(context.Context, string) error { return nil }

func stringPtr(value string) *string { return &value }
