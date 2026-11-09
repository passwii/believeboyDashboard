package inspections

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestInspectionRegistrarMatchesOpenAPIRoutesAndRequiresAPIKey(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrar(&fakeInspectionStore{}, &fakeInspectionBlobs{}, audit.NewMockService()).
		RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	want := []string{
		"GET /api/v1/inspections/template",
		"GET /api/v1/inspections/periods",
		"GET /api/v1/inspections/periods/current",
		"GET /api/v1/inspections/periods/{period_id}/overview",
		"GET /api/v1/inspections/periods/{period_id}/projects/{project_id}",
		"POST /api/v1/inspections/periods/{period_id}/projects/{project_id}",
		"PATCH /api/v1/inspections/periods/{period_id}/projects/{project_id}",
		"POST /api/v1/inspections/periods/{period_id}/projects/{project_id}/submit",
		"POST /api/v1/inspections/screenshots/upload",
		"DELETE /api/v1/inspections/screenshots/{screenshot_id}",
		"GET /api/v1/inspections/history",
	}
	got := make(map[string]bool)
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("route count = %d, want %d: %#v", len(got), len(want), got)
	}
	for _, route := range want {
		if !got[route] {
			t.Errorf("missing route %s", route)
		}
	}
	if got := NewRegistrar(nil, nil, nil).ModuleName(); got != "inspections" {
		t.Fatalf("ModuleName() = %q, want inspections", got)
	}

	secured := chi.NewRouter()
	NewRegistrar(&fakeInspectionStore{}, &fakeInspectionBlobs{}, audit.NewMockService()).
		RegisterRoutes(secured, auth.RequireAPIKey("master-key", "proxy-secret", nil))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/inspections/template", nil)
	response := httptest.NewRecorder()
	secured.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing API key status = %d, want 401", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/inspections/template", nil)
	request.Header.Set("X-API-Key", "master-key")
	request.Header.Set(auth.TrustedProxySecretHeader, "proxy-secret")
	response = httptest.NewRecorder()
	secured.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("authenticated template status = %d, body=%s", response.Code, response.Body.String())
	}
}

func TestInspectionReadRoutes(t *testing.T) {
	store := &fakeInspectionStore{
		periodList: PeriodListResponse{
			Items: []Period{testPeriod()},
			Total: 1,
		},
		currentPeriod: testPeriod(),
		overview: &OverviewResponse{
			Period: testPeriod(),
			Items: []OverviewItem{
				{
					ProjectID:   7,
					ProjectName: "North",
					Status:      "submitted",
					Screenshots: []OverviewScreenshot{
						{ID: 2, R2Key: "inspection-screenshots/north/report_9/a.png", ThumbnailKey: stringTestPointer("thumb")},
					},
				},
			},
		},
		report: &Report{
			ID: 9, PeriodID: 4, ProjectID: 7, ProjectName: "North", Status: "draft",
			CreatedAt: "2026-11-08T10:00:00+08:00",
			UpdatedAt: "2026-11-08T10:00:00+08:00",
			Screenshots: []ScreenshotItem{
				{ID: 2, R2Key: "inspection-screenshots/north/report_9/a.png", URL: "javascript:alert(1)"},
			},
		},
		history: HistoryResponse{
			Items: []HistoryItem{
				{
					ID: 9, PeriodID: 4, WeekStart: "2026-11-02", WeekEnd: "2026-11-08",
					ProjectID: 7, ProjectName: "North", Status: "submitted",
					Screenshots: []HistoryScreenshot{
						{ID: 2, R2Key: "inspection-screenshots/north/report_9/a.png"},
					},
				},
			},
			Total: 1,
		},
	}
	blobs := &fakeInspectionBlobs{presignURL: "https://cdn.example.com/signed"}
	router := newInspectionTestRouter(store, blobs, audit.NewMockService())

	tests := []struct {
		name   string
		path   string
		status int
		body   string
	}{
		{name: "template", path: "/api/v1/inspections/template", status: http.StatusOK, body: "account_health_rating"},
		{name: "periods", path: "/api/v1/inspections/periods?limit=20&offset=0", status: http.StatusOK, body: `"total":1`},
		{name: "current", path: "/api/v1/inspections/periods/current", status: http.StatusOK, body: `"week_start":"2026-11-02"`},
		{name: "overview", path: "/api/v1/inspections/periods/4/overview", status: http.StatusOK, body: `"url":"https://cdn.example.com/signed"`},
		{name: "history", path: "/api/v1/inspections/history?limit=50", status: http.StatusOK, body: `"project_name":"North"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := serveInspection(
				t,
				router,
				http.MethodGet,
				test.path,
				nil,
				"",
				auth.UserContext{Operator: "alice"},
			)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d, body=%s", response.Code, test.status, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), test.body) {
				t.Fatalf("body = %s, want substring %q", response.Body.String(), test.body)
			}
		})
	}

	response := serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/periods/4/projects/7",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusOK {
		t.Fatalf("get report status = %d", response.Code)
	}
	if strings.Contains(response.Body.String(), "javascript:alert") {
		t.Fatalf("unsafe URL echoed: %s", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"screenshots":[]`) {
		t.Logf("resolver URL body: %s", response.Body.String())
	}

	store.report = nil
	response = serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/periods/4/projects/7",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != "null" {
		t.Fatalf("missing report = %d %q, want 200 null", response.Code, response.Body.String())
	}
}

func TestInspectionProjectAccessErrorsAndValidation(t *testing.T) {
	store := &fakeInspectionStore{
		accessErr: ErrProjectForbidden,
		report:    &Report{ID: 9, ProjectID: 7},
	}
	router := newInspectionTestRouter(store, &fakeInspectionBlobs{}, audit.NewMockService())
	response := serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/periods/4/projects/7",
		nil, "", auth.UserContext{Operator: "intruder"},
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden status = %d, body=%s", response.Code, response.Body.String())
	}

	store.accessErr = ErrProjectNotFound
	response = serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/periods/4/projects/7",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("project not found status = %d", response.Code)
	}

	store.accessErr = nil
	response = serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/periods/not-an-int/projects/7",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad path status = %d", response.Code)
	}

	response = serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/periods?limit=0",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad limit status = %d", response.Code)
	}

	response = serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/history?offset=-1",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad offset status = %d", response.Code)
	}

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/inspections/periods/4/overview",
		nil,
	)
	request.Header.Set("X-Is-Admin", "not-a-bool")
	request = request.WithContext(auth.WithUserContext(
		request.Context(),
		auth.UserContext{Operator: "alice"},
	))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad admin header status = %d", response.Code)
	}
}

func TestInspectionReportMutations(t *testing.T) {
	store := &fakeInspectionStore{
		period: testPeriodPointer(),
		createReport: &Report{
			ID: 9, PeriodID: 4, ProjectID: 7, Status: "draft",
			CreatedAt: "2026-11-08T10:00:00+08:00",
			UpdatedAt: "2026-11-08T10:00:00+08:00",
		},
	}
	auditor := audit.NewMockService()
	router := newInspectionTestRouter(store, &fakeInspectionBlobs{}, auditor)

	body := `{"health_data":{"account_health_rating":"Good","negative_feedback":1},"compliance_data":null,"status_summary":"ok","screenshot_ids":[]}`
	response := serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/periods/4/projects/7",
		strings.NewReader(body), "application/json",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", response.Code, response.Body.String())
	}
	if store.lastWrite.HealthData == nil || store.lastWrite.HealthData.NegativeFeedback == nil ||
		*store.lastWrite.HealthData.NegativeFeedback != 1 {
		t.Fatalf("decoded write input = %#v", store.lastWrite)
	}
	if store.lastWrite.StatusSummary == nil || *store.lastWrite.StatusSummary != "ok" {
		t.Fatalf("status summary not preserved: %#v", store.lastWrite.StatusSummary)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "inspection.save" {
		t.Fatalf("audit entries = %#v", auditor.Entries)
	}

	response = serveInspection(
		t, router, http.MethodPatch,
		"/api/v1/inspections/periods/4/projects/7",
		strings.NewReader(`{"status_summary":null,"screenshot_ids":null}`), "application/json",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body=%s", response.Code, response.Body.String())
	}
	if !store.lastWrite.StatusSummarySet || store.lastWrite.StatusSummary != nil {
		t.Fatalf("null status_summary not preserved: %#v", store.lastWrite)
	}
	if len(auditor.Entries) != 2 || auditor.Entries[1].Action != "inspection.update" {
		t.Fatalf("audit entries after patch = %#v", auditor.Entries)
	}

	store.period = nil
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/periods/4/projects/7",
		strings.NewReader(`{}`), "application/json",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing period status = %d", response.Code)
	}

	store.period = testPeriodPointer()
	store.createErr = ErrConflict
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/periods/4/projects/7",
		strings.NewReader(`{}`), "application/json",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d", response.Code)
	}

	store.createErr = nil
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/periods/4/projects/7",
		strings.NewReader(`{"health_data":{"negative_feedback":"bad"}}`), "application/json",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad body status = %d", response.Code)
	}
}

func TestInspectionSubmitAndAuditWarnings(t *testing.T) {
	store := &fakeInspectionStore{
		report: &Report{ID: 9, PeriodID: 4, ProjectID: 7, Status: "draft"},
		submittedReport: &Report{
			ID: 9, PeriodID: 4, ProjectID: 7, Status: "submitted",
			SubmittedBy: stringTestPointer("alice"),
			SubmittedAt: stringTestPointer("2026-11-08T10:00:00+08:00"),
		},
		submitWarnings: []ThresholdWarning{
			{Metric: "inspection_negative_feedback", Value: 1, Threshold: 1, Severity: "warning"},
		},
	}
	auditor := audit.NewMockService()
	router := newInspectionTestRouter(store, &fakeInspectionBlobs{}, auditor)

	response := serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/periods/4/projects/7/submit",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusOK {
		t.Fatalf("submit status = %d, body=%s", response.Code, response.Body.String())
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "inspection.submit" {
		t.Fatalf("submit audit entries = %#v", auditor.Entries)
	}
	after, ok := auditor.Entries[0].AfterJSON.(map[string]any)
	if !ok || after["warnings"] == nil {
		t.Fatalf("submit audit after = %#v", auditor.Entries[0].AfterJSON)
	}

	store.report = nil
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/periods/4/projects/7/submit",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing submit report status = %d", response.Code)
	}
}

func TestInspectionScreenshotUploadValidationAndCompensation(t *testing.T) {
	store := &fakeInspectionStore{
		reportByID: &Report{
			ID: 9, PeriodID: 4, ProjectID: 7, ProjectName: "../../North / Store",
		},
		insertedScreenshot: &ScreenshotRecord{
			ID: 12, ReportID: 9, R2Key: "key", Filename: "../../shot.png",
			ContentType: "image/png", FileSize: 8, SortOrder: 0,
			CreatedAt: "2026-11-08T10:00:00+08:00",
		},
	}
	blobs := &fakeInspectionBlobs{putURL: "https://cdn.example.com/object"}
	auditor := audit.NewMockService()
	router := newInspectionTestRouter(store, blobs, auditor)

	response := serveInspection(
		t, newInspectionTestRouter(store, nil, auditor), http.MethodPost,
		"/api/v1/inspections/screenshots/upload", nil, "",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing blob status = %d", response.Code)
	}

	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/screenshots/upload",
		multipartInspectionBody(t, nil, "", "", nil),
		"",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing file status = %d, body=%s", response.Code, response.Body.String())
	}

	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/screenshots/upload",
		multipartInspectionBody(t, []byte("not-an-image"), "shot.png", "image/png", nil),
		"",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing report_id status = %d, body=%s", response.Code, response.Body.String())
	}

	store.reportByID = nil
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/screenshots/upload",
		multipartInspectionBody(t, validPNGForTest(), "shot.png", "image/png", int64Pointer(9)),
		"",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing report status = %d", response.Code)
	}

	store.reportByID = &Report{ID: 9, ProjectID: 7, ProjectName: "North"}
	store.accessErr = ErrProjectForbidden
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/screenshots/upload",
		multipartInspectionBody(t, validPNGForTest(), "shot.png", "image/png", int64Pointer(9)),
		"",
		auth.UserContext{Operator: "intruder"},
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden upload status = %d", response.Code)
	}

	store.accessErr = nil
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/screenshots/upload",
		multipartInspectionBody(t, validPNGForTest(), "shot.png", "image/svg+xml", int64Pointer(9)),
		"",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("bad MIME status = %d, body=%s", response.Code, response.Body.String())
	}

	large := make([]byte, maxScreenshotBytes+1)
	copy(large, validPNGForTest())
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/screenshots/upload",
		multipartInspectionBody(t, large, "large.png", "image/png", int64Pointer(9)),
		"",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("large upload status = %d, body=%s", response.Code, response.Body.String())
	}

	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/screenshots/upload",
		multipartInspectionBody(t, validPNGForTest(), "../../shot.png", "image/png", int64Pointer(9)),
		"",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body=%s", response.Code, response.Body.String())
	}
	if len(blobs.putKeys) != 1 {
		t.Fatalf("blob puts = %#v", blobs.putKeys)
	}
	if strings.Contains(blobs.putKeys[0], "..") || strings.Contains(blobs.putKeys[0], "\\") {
		t.Fatalf("unsafe object key %q", blobs.putKeys[0])
	}
	if !strings.HasPrefix(blobs.putKeys[0], screenshotPrefix) {
		t.Fatalf("object key prefix = %q", blobs.putKeys[0])
	}
	if store.lastScreenshot == nil || store.lastScreenshot.Filename != "shot.png" {
		t.Fatalf("stored screenshot input = %#v", store.lastScreenshot)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "inspection.upload_screenshot" {
		t.Fatalf("audit entries = %#v", auditor.Entries)
	}

	blobs.putKeys = nil
	store.insertErr = errors.New("db down")
	response = serveInspection(
		t, router, http.MethodPost,
		"/api/v1/inspections/screenshots/upload",
		multipartInspectionBody(t, validPNGForTest(), "shot.png", "image/png", int64Pointer(9)),
		"",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("compensated upload status = %d", response.Code)
	}
	if len(blobs.deleteKeys) != 1 {
		t.Fatalf("compensation deletes = %#v, want one", blobs.deleteKeys)
	}
}

func TestInspectionDeleteScreenshot(t *testing.T) {
	store := &fakeInspectionStore{
		screenshot: &ScreenshotRecord{
			ID: 12, ReportID: 9, ProjectID: 7, R2Key: "original",
			ThumbnailKey: stringTestPointer("thumb"),
		},
	}
	blobs := &fakeInspectionBlobs{}
	auditor := audit.NewMockService()
	router := newInspectionTestRouter(store, blobs, auditor)

	response := serveInspection(
		t, newInspectionTestRouter(store, nil, auditor), http.MethodDelete,
		"/api/v1/inspections/screenshots/12", nil, "",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing blob status = %d", response.Code)
	}

	store.screenshot = nil
	response = serveInspection(
		t, router, http.MethodDelete,
		"/api/v1/inspections/screenshots/12", nil, "",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing screenshot status = %d", response.Code)
	}

	store.screenshot = &ScreenshotRecord{ID: 12, ProjectID: 7, R2Key: "original"}
	store.accessErr = ErrProjectForbidden
	response = serveInspection(
		t, router, http.MethodDelete,
		"/api/v1/inspections/screenshots/12", nil, "",
		auth.UserContext{Operator: "intruder"},
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden delete status = %d", response.Code)
	}

	store.accessErr = nil
	store.screenshot = &ScreenshotRecord{
		ID: 12, ProjectID: 7, R2Key: "original",
		ThumbnailKey: stringTestPointer("thumb"),
	}
	response = serveInspection(
		t, router, http.MethodDelete,
		"/api/v1/inspections/screenshots/12", nil, "",
		auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body=%s", response.Code, response.Body.String())
	}
	if len(blobs.deleteKeys) != 2 {
		t.Fatalf("blob deletes = %#v, want original and thumbnail", blobs.deleteKeys)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "inspection.delete_screenshot" {
		t.Fatalf("delete audit entries = %#v", auditor.Entries)
	}
}

func TestInspectionHistoryAccessAndFilters(t *testing.T) {
	store := &fakeInspectionStore{
		history: HistoryResponse{
			Items: []HistoryItem{
				{ID: 9, ProjectID: 7, ProjectName: "North", WeekStart: "2026-11-02", WeekEnd: "2026-11-08"},
			},
			Total: 1,
		},
	}
	router := newInspectionTestRouter(store, &fakeInspectionBlobs{}, audit.NewMockService())

	response := serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/history?period_id=4&project_id=7&limit=25&offset=5",
		nil, "", auth.UserContext{Operator: "alice"},
	)
	if response.Code != http.StatusOK {
		t.Fatalf("history status = %d", response.Code)
	}
	if store.lastHistory.Operator != "alice" || store.lastHistory.IsAdmin {
		t.Fatalf("history identity = %#v", store.lastHistory)
	}
	if store.lastHistory.Limit != 25 || store.lastHistory.Offset != 5 {
		t.Fatalf("history pagination = %#v", store.lastHistory)
	}
	if store.lastHistory.PeriodID == nil || *store.lastHistory.PeriodID != 4 ||
		store.lastHistory.ProjectID == nil || *store.lastHistory.ProjectID != 7 {
		t.Fatalf("history filters = %#v", store.lastHistory)
	}

	store.accessErr = ErrProjectForbidden
	response = serveInspection(
		t, router, http.MethodGet,
		"/api/v1/inspections/history?project_id=7",
		nil, "", auth.UserContext{Operator: "intruder"},
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("history forbidden status = %d", response.Code)
	}
}

func newInspectionTestRouter(
	store Store,
	blobs BlobStore,
	auditor audit.Service,
) chi.Router {
	router := chi.NewRouter()
	NewRegistrar(store, blobs, auditor).
		RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func serveInspection(
	t *testing.T,
	router http.Handler,
	method string,
	path string,
	body io.Reader,
	contentType string,
	identity auth.UserContext,
) *httptest.ResponseRecorder {
	t.Helper()
	if body == nil {
		body = strings.NewReader("")
	}
	if contentType == "" {
		if provider, ok := body.(interface{ TestContentType() string }); ok {
			contentType = provider.TestContentType()
		}
	}
	request := httptest.NewRequest(method, path, body)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request = request.WithContext(auth.WithUserContext(request.Context(), identity))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func multipartInspectionBody(
	t *testing.T,
	data []byte,
	filename string,
	contentType string,
	reportID *int64,
) inspectionMultipartBody {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if data != nil {
		partHeader := make(textproto.MIMEHeader)
		partHeader["Content-Disposition"] = []string{
			`form-data; name="file"; filename="` + filename + `"`,
		}
		partHeader["Content-Type"] = []string{contentType}
		part, err := writer.CreatePart(partHeader)
		if err != nil {
			t.Fatalf("create file part: %v", err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatalf("write file part: %v", err)
		}
	}
	if reportID != nil {
		if err := writer.WriteField("report_id", strconv.FormatInt(*reportID, 10)); err != nil {
			t.Fatalf("write report_id: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return inspectionMultipartBody{
		Reader:      strings.NewReader(body.String()),
		contentType: writer.FormDataContentType(),
	}
}

type inspectionMultipartBody struct {
	*strings.Reader
	contentType string
}

func (body inspectionMultipartBody) TestContentType() string {
	return body.contentType
}

func validPNGForTest() []byte {
	return []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x00,
	}
}

func stringTestPointer(value string) *string {
	return &value
}

func int64Pointer(value int64) *int64 {
	return &value
}

func testPeriod() Period {
	return Period{
		ID: 4, WeekStart: "2026-11-02", WeekEnd: "2026-11-08",
		Deadline:  "2026-11-09T09:00:00+08:00",
		CreatedAt: "2026-11-02T00:00:00+08:00",
	}
}

func testPeriodPointer() *Period {
	period := testPeriod()
	return &period
}

type fakeInspectionStore struct {
	periodList          PeriodListResponse
	periodListErr       error
	currentPeriod       Period
	currentPeriodErr    error
	period              *Period
	periodErr           error
	overview            *OverviewResponse
	overviewErr         error
	report              *Report
	reportErr           error
	reportByID          *Report
	reportByIDErr       error
	createReport        *Report
	createErr           error
	lastWrite           ReportWriteInput
	submittedReport     *Report
	submitWarnings      []ThresholdWarning
	submitErr           error
	screenshot          *ScreenshotRecord
	screenshotErr       error
	insertedScreenshot  *ScreenshotRecord
	insertErr           error
	lastScreenshot      *InsertScreenshotInput
	deleteErr           error
	deleteResult        bool
	history             HistoryResponse
	historyErr          error
	lastHistory         HistoryFilter
	accessErr           error
	lastAccessProjectID int64
	lastOperator        string
	lastIsAdmin         bool
}

func (s *fakeInspectionStore) VerifyProjectAccess(
	_ context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	s.lastAccessProjectID = projectID
	s.lastOperator = operator
	s.lastIsAdmin = isAdmin
	return s.accessErr
}

func (s *fakeInspectionStore) ListPeriods(context.Context, int, int) (PeriodListResponse, error) {
	return s.periodList, s.periodListErr
}

func (s *fakeInspectionStore) GetOrCreateCurrentPeriod(context.Context) (Period, error) {
	return s.currentPeriod, s.currentPeriodErr
}

func (s *fakeInspectionStore) GetPeriod(context.Context, int64) (*Period, error) {
	return s.period, s.periodErr
}

func (s *fakeInspectionStore) GetOverview(context.Context, int64, string, bool) (*OverviewResponse, error) {
	return s.overview, s.overviewErr
}

func (s *fakeInspectionStore) GetReport(context.Context, int64, int64) (*Report, error) {
	return s.report, s.reportErr
}

func (s *fakeInspectionStore) GetReportByID(context.Context, int64) (*Report, error) {
	return s.reportByID, s.reportByIDErr
}

func (s *fakeInspectionStore) CreateOrUpdateReport(
	_ context.Context,
	_ int64,
	_ int64,
	input ReportWriteInput,
) (*Report, error) {
	s.lastWrite = input
	return s.createReport, s.createErr
}

func (s *fakeInspectionStore) SubmitReport(
	context.Context,
	int64,
	*string,
) (*Report, []ThresholdWarning, error) {
	return s.submittedReport, s.submitWarnings, s.submitErr
}

func (s *fakeInspectionStore) GetScreenshot(context.Context, int64) (*ScreenshotRecord, error) {
	return s.screenshot, s.screenshotErr
}

func (s *fakeInspectionStore) InsertScreenshot(
	_ context.Context,
	input InsertScreenshotInput,
) (*ScreenshotRecord, error) {
	s.lastScreenshot = &input
	if s.insertErr != nil {
		return nil, s.insertErr
	}
	if s.insertedScreenshot == nil {
		return nil, errors.New("inserted screenshot missing")
	}
	record := *s.insertedScreenshot
	record.R2Key = input.R2Key
	record.Filename = input.Filename
	record.ContentType = input.ContentType
	record.FileSize = input.FileSize
	return &record, nil
}

func (s *fakeInspectionStore) DeleteScreenshot(context.Context, int64) (bool, error) {
	if s.deleteErr != nil {
		return false, s.deleteErr
	}
	if s.deleteResult {
		return true, nil
	}
	return true, nil
}

func (s *fakeInspectionStore) ListHistory(
	_ context.Context,
	filter HistoryFilter,
) (HistoryResponse, error) {
	s.lastHistory = filter
	return s.history, s.historyErr
}

type fakeInspectionBlobs struct {
	putURL     string
	presignURL string
	putErr     error
	deleteErr  error
	putKeys    []string
	deleteKeys []string
}

func (b *fakeInspectionBlobs) Put(
	_ context.Context,
	key string,
	_ []byte,
	_ string,
) (string, error) {
	b.putKeys = append(b.putKeys, key)
	return b.putURL, b.putErr
}

func (b *fakeInspectionBlobs) Delete(_ context.Context, key string) error {
	b.deleteKeys = append(b.deleteKeys, key)
	return b.deleteErr
}

func (b *fakeInspectionBlobs) Presign(_ context.Context, _ string) (string, error) {
	return b.presignURL, nil
}
