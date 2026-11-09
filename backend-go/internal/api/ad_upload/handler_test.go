package ad_upload

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
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockAdUploadStore struct {
	recResp    AdUploadRecognitionResponse
	recErr     error
	commitResp AdUploadCommitResponse
	commitErr  error
	statusResp AdUploadStatusResponse
	statusErr  error
}

func (m *mockAdUploadStore) Recognize(_ context.Context, _ string, _ []byte, _, _ string, _ bool) (*AdUploadRecognitionResponse, error) {
	return &m.recResp, m.recErr
}
func (m *mockAdUploadStore) Commit(_ context.Context, _ AdUploadCommitRequest, _ string, _ bool) (*AdUploadCommitResponse, error) {
	return &m.commitResp, m.commitErr
}
func (m *mockAdUploadStore) ListStatus(_ context.Context, _ AdUploadStatusFilter) (*AdUploadStatusResponse, error) {
	return &m.statusResp, m.statusErr
}

type mockAuditor struct {
	entries []audit.Entry
}

func (a *mockAuditor) LogAction(_ context.Context, e audit.Entry) error {
	a.entries = append(a.entries, e)
	return nil
}
func (a *mockAuditor) LogActionTx(_ context.Context, _ pgx.Tx, e audit.Entry) error {
	a.entries = append(a.entries, e)
	return nil
}
func (a *mockAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func setupRouter(store Store, auditor audit.Service) chi.Router {
	r := chi.NewRouter()
	reg := NewRegistrar(store, auditor)
	reg.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestHandlerRecognize(t *testing.T) {
	store := &mockAdUploadStore{
		recResp: AdUploadRecognitionResponse{
			TempFileID:       "tmp123",
			OriginalFilename: "report.csv",
			ReportType:       "ad_campaign_report",
			Status:           "recognized",
		},
	}
	router := setupRouter(store, nil)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, _ := mw.CreateFormFile("file", "report.csv")
	_, _ = part.Write([]byte("开始日期,结束日期,广告活动名称,预算,定位类型,竞价策略\n"))
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ad-upload/recognize", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandlerRecognizeRejectsPathTraversalFilename(t *testing.T) {
	router := setupRouter(&mockAdUploadStore{}, nil)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, _ := mw.CreateFormFile("file", `..\evil.csv`)
	_, _ = part.Write([]byte("开始日期,结束日期,广告活动名称,预算,定位类型,竞价策略\n"))
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ad-upload/recognize", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandlerCommit(t *testing.T) {
	store := &mockAdUploadStore{
		commitResp: AdUploadCommitResponse{
			ID:              10,
			ReportType:      "ad_campaign_report",
			IngestionStatus: "saved",
			ProjectName:     "Test Project",
		},
	}
	auditor := &mockAuditor{}
	router := setupRouter(store, auditor)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   "admin-1",
		Operator: "admin",
		IsAdmin:  true,
	})

	body := `{"temp_file_id":"tmp123","report_type":"ad_campaign_report","project_name":"Test Project"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ad-upload/commit", strings.NewReader(body)).WithContext(adminCtx)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if len(auditor.entries) != 1 || auditor.entries[0].Action != "ad_upload.commit" {
		t.Fatalf("expected audit log for ad_upload.commit")
	}
}

func TestHandlerStatus(t *testing.T) {
	store := &mockAdUploadStore{
		statusResp: AdUploadStatusResponse{
			Country: "US",
			Items: []AdUploadStatusItem{
				{ID: 10, ProjectName: "Test Project", ReportType: "ad_campaign_report"},
			},
		},
	}
	router := setupRouter(store, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/ad-upload/status?country=US", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestHandlerCommitErrorMapping(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{name: "not found", err: ErrProjectNotFound, want: http.StatusNotFound},
		{name: "forbidden", err: ErrProjectForbidden, want: http.StatusForbidden},
		{name: "type mismatch", err: ErrTypeMismatch, want: http.StatusUnprocessableEntity},
		{name: "legacy 422 text", err: errors.New("422: invalid report date"), want: http.StatusUnprocessableEntity},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &mockAdUploadStore{commitErr: test.err}
			router := setupRouter(store, nil)
			body := `{"temp_file_id":"tmp123","report_type":"ad_campaign_report","project_name":"Test Project"}`
			req := httptest.NewRequest(http.MethodPost, "/api/v1/ad-upload/commit", strings.NewReader(body))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, test.want, rec.Body.String())
			}
		})
	}
}
