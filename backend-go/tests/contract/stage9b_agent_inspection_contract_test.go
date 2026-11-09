package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_inspection"
)

const (
	stage9BToken   = "bbx-stage9b"
	stage9BAgentID = "agent-9b"
)

type stage9BCredentials struct {
	row agentauth.CredentialRow
}

func (store *stage9BCredentials) FindByHash(
	_ context.Context,
	keyHash string,
) (*agentauth.CredentialRow, error) {
	if keyHash != agentauth.HashAgentToken(stage9BToken) {
		return nil, nil
	}
	row := store.row
	return &row, nil
}

func (*stage9BCredentials) TouchLastUsed(context.Context, int64, time.Time) error {
	return nil
}

type stage9BStore struct {
	agent_inspection.Store

	periods       agent_inspection.PeriodPage
	currentPeriod *agent_inspection.Period
	period        *agent_inspection.Period
	projects      map[int64]*agent_inspection.Project
	reports       map[string]*agent_inspection.Report
	overview      *agent_inspection.OverviewResult
	history       agent_inspection.HistoryPage

	upsertInput  agent_inspection.UpsertReportInput
	upsertReport *agent_inspection.Report
	submitReport *agent_inspection.Report
	submitCalls  int

	screenshot  *agent_inspection.Screenshot
	screenshots map[int64]*agent_inspection.Screenshot
	idempotent  *agent_inspection.Screenshot
	insertCalls int
	insertErr   error
	deleteCalls int
	deleteErr   error

	validateComplaintErr error
	batchResult          agent_inspection.ComplaintBatchResult
	batchCalls           int

	auditEntries []agent_inspection.AuditEntry
	auditErr     error

	txCalls int
}

func (store *stage9BStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, agent_inspection.Store) error,
) error {
	store.txCalls++
	return fn(ctx, nil, store)
}

func (store *stage9BStore) ListPeriods(
	context.Context,
	agent_inspection.PeriodListFilter,
) (agent_inspection.PeriodPage, error) {
	return store.periods, nil
}

func (store *stage9BStore) GetCurrentPeriod(
	context.Context,
	time.Time,
) (*agent_inspection.Period, error) {
	return store.currentPeriod, nil
}

func (store *stage9BStore) GetPeriod(
	_ context.Context,
	_ int64,
) (*agent_inspection.Period, error) {
	return store.period, nil
}

func (store *stage9BStore) GetProject(
	_ context.Context,
	projectID int64,
) (*agent_inspection.Project, error) {
	return store.projects[projectID], nil
}

func (store *stage9BStore) GetReport(
	_ context.Context,
	periodID int64,
	projectID int64,
	country string,
) (*agent_inspection.Report, error) {
	return store.reports[stage9BReportKey(periodID, projectID, country)], nil
}

func (store *stage9BStore) GetOverview(
	context.Context,
	agent_inspection.OverviewFilter,
) (*agent_inspection.OverviewResult, error) {
	return store.overview, nil
}

func (store *stage9BStore) ListHistory(
	_ context.Context,
	filter agent_inspection.HistoryFilter,
) (agent_inspection.HistoryPage, error) {
	return store.history, nil
}

func (store *stage9BStore) UpsertReport(
	_ context.Context,
	input agent_inspection.UpsertReportInput,
) (*agent_inspection.Report, error) {
	store.upsertInput = input
	if store.upsertReport == nil {
		report := &agent_inspection.Report{
			ID: 41, PeriodID: input.PeriodID, ProjectID: input.ProjectID,
			Country: input.Country, Status: "draft",
			HealthData:     input.Patch.HealthData,
			ComplianceData: input.Patch.ComplianceData,
			StatusSummary:  input.Patch.StatusSummary,
			CreatedAt:      time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC),
			UpdatedAt:      time.Date(2026, 11, 8, 0, 1, 0, 0, time.UTC),
		}
		store.reports = map[string]*agent_inspection.Report{
			stage9BReportKey(input.PeriodID, input.ProjectID, input.Country): report,
		}
		store.upsertReport = report
	}
	return store.upsertReport, nil
}

func (store *stage9BStore) SubmitReport(
	_ context.Context,
	reportID int64,
	agentID string,
	now time.Time,
) (*agent_inspection.Report, []agent_inspection.ThresholdWarning, error) {
	store.submitCalls++
	if store.submitReport == nil {
		store.submitReport = &agent_inspection.Report{
			ID: reportID, PeriodID: 1, ProjectID: 1, Country: "US",
			Status: "submitted", SubmittedBy: &agentID, SubmittedAt: &now,
			CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
		}
	}
	return store.submitReport, agent_inspection.ThresholdWarnings(store.submitReport), nil
}

func (store *stage9BStore) GetScreenshot(
	_ context.Context,
	screenshotID int64,
) (*agent_inspection.Screenshot, error) {
	if store.screenshots != nil {
		return store.screenshots[screenshotID], nil
	}
	return store.screenshot, nil
}

func (store *stage9BStore) LockScreenshot(
	ctx context.Context,
	screenshotID int64,
) (*agent_inspection.Screenshot, error) {
	return store.GetScreenshot(ctx, screenshotID)
}

func (store *stage9BStore) GetScreenshotByIdempotency(
	context.Context,
	string,
	string,
	string,
) (*agent_inspection.Screenshot, error) {
	return store.idempotent, nil
}

func (store *stage9BStore) InsertScreenshot(
	_ context.Context,
	input agent_inspection.InsertScreenshotInput,
) (*agent_inspection.Screenshot, error) {
	store.insertCalls++
	if store.insertErr != nil {
		return nil, store.insertErr
	}
	now := time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC)
	screenshot := &agent_inspection.Screenshot{
		ID: 51, ReportID: input.ReportID, PeriodID: 1, ProjectID: 1,
		ProjectName: "Project A", WeekStart: "2026-11-02",
		R2Key: input.R2Key, ThumbnailKey: input.ThumbnailKey,
		Filename: input.Filename, ContentType: input.ContentType,
		FileSize: input.FileSize, Caption: input.Caption,
		SortOrder: 0, CreatedAt: now,
	}
	store.screenshot = screenshot
	store.idempotent = screenshot
	if store.screenshots == nil {
		store.screenshots = map[int64]*agent_inspection.Screenshot{}
	}
	store.screenshots[screenshot.ID] = screenshot
	return screenshot, nil
}

func (store *stage9BStore) DeleteScreenshot(
	context.Context,
	int64,
) (bool, error) {
	store.deleteCalls++
	return store.deleteErr == nil, store.deleteErr
}

func (store *stage9BStore) ValidateComplaintBatch(
	context.Context,
	agent_inspection.ComplaintBatchInput,
) error {
	return store.validateComplaintErr
}

func (store *stage9BStore) UpsertComplaintBatch(
	_ context.Context,
	_ agent_inspection.ComplaintBatchInput,
	_ string,
) (agent_inspection.ComplaintBatchResult, error) {
	store.batchCalls++
	return store.batchResult, nil
}

func (store *stage9BStore) LogAudit(
	_ context.Context,
	_ pgx.Tx,
	entry agent_inspection.AuditEntry,
) error {
	if store.auditErr != nil {
		return store.auditErr
	}
	store.auditEntries = append(store.auditEntries, entry)
	return nil
}

type stage9BBlobStore struct {
	objects      map[string][]byte
	contentTypes map[string]string
	putCalls     int
	deleteCalls  int
	failDelete   bool
	failPut      bool
}

func newStage9BBlobStore() *stage9BBlobStore {
	return &stage9BBlobStore{
		objects:      map[string][]byte{},
		contentTypes: map[string]string{},
	}
}

func (store *stage9BBlobStore) Put(
	_ context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	store.putCalls++
	if store.failPut {
		return "", errors.New("put failed")
	}
	store.objects[key] = append([]byte(nil), data...)
	store.contentTypes[key] = contentType
	return "https://cdn.example.com/" + key, nil
}

func (store *stage9BBlobStore) Get(
	_ context.Context,
	key string,
) (io.ReadCloser, error) {
	data, ok := store.objects[key]
	if !ok {
		return nil, errors.New("object not found")
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (store *stage9BBlobStore) Delete(_ context.Context, key string) error {
	store.deleteCalls++
	if store.failDelete {
		return errors.New("delete failed")
	}
	delete(store.objects, key)
	delete(store.contentTypes, key)
	return nil
}

func stage9BRouter(
	t *testing.T,
	store agent_inspection.Store,
	credentials *stage9BCredentials,
	blobs agent_inspection.BlobStore,
	_ any,
	options ...agent_inspection.Option,
) http.Handler {
	t.Helper()
	if credentials == nil {
		credentials = &stage9BCredentials{row: agentauth.CredentialRow{
			KeyID: 1, AgentID: stage9BAgentID, Label: "Stage 9B Agent",
			BusinessScope: "account_health,platform_inspection,complaint_center",
			ProjectScope:  "*",
		}}
	}
	router := chi.NewRouter()
	agent_inspection.NewRegistrar(
		store,
		credentials,
		agentauth.NewMemoryConfirmStore(),
		blobs,
		options...,
	).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func stage9BRequest(
	method string,
	target string,
	body io.Reader,
	idempotencyKey string,
) *http.Request {
	request := httptest.NewRequest(method, target, body)
	request.Header.Set("Authorization", "Bearer "+stage9BToken)
	request.Header.Set("X-Agent-Id", stage9BAgentID)
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	return request
}

func stage9BJSONRequest(
	method string,
	target string,
	body string,
	idempotencyKey string,
) *http.Request {
	request := stage9BRequest(method, target, strings.NewReader(body), idempotencyKey)
	request.Header.Set("Content-Type", "application/json")
	return request
}

func stage9BResponse(
	t *testing.T,
	router http.Handler,
	request *http.Request,
) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode response %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, payload
}

func stage9BReportKey(periodID, projectID int64, country string) string {
	return strings.Join([]string{
		jsonInt(periodID), jsonInt(projectID), strings.ToUpper(country),
	}, "|")
}

func jsonInt(value int64) string {
	return strconv.FormatInt(value, 10)
}

func stage9BNumber(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case json.Number:
		number, _ := typed.Int64()
		return number
	default:
		return 0
	}
}

func stage9BPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			img.Set(x, y, color.RGBA{R: 220, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode PNG: %v", err)
	}
	return buffer.Bytes()
}

func stage9BMultipart(
	t *testing.T,
	filename string,
	content []byte,
	contentType string,
	idempotencyKey string,
) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{}
	header.Set(
		"Content-Disposition",
		fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename),
	)
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("create multipart file: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	_ = writer.Close()
	request := stage9BRequest(
		http.MethodPost,
		"/api/v1/agent/platform-inspection/periods/1/projects/1/screenshots",
		&body,
		idempotencyKey,
	)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func TestStage9BAgentInspectionRouteInventory(t *testing.T) {
	registrar := agent_inspection.NewRegistrar(
		&stage9BStore{},
		&stage9BCredentials{},
		nil,
		nil,
	)
	if registrar.ModuleName() != "agent_inspection" {
		t.Fatalf("ModuleName() = %q, want agent_inspection", registrar.ModuleName())
	}
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)

	want := []string{
		"DELETE /api/v1/agent/platform-inspection/screenshots/{screenshot_id}",
		"GET /api/v1/agent/account-health/history",
		"GET /api/v1/agent/account-health/periods",
		"GET /api/v1/agent/account-health/periods/current",
		"GET /api/v1/agent/account-health/periods/{period_id}/overview",
		"GET /api/v1/agent/account-health/periods/{period_id}/projects/{project_id}",
		"GET /api/v1/agent/platform-inspection/template",
		"POST /api/v1/agent/complaint-center/batch",
		"POST /api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}/screenshots",
		"POST /api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}/submit",
		"PUT /api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}",
	}
	var got []string
	if err := chi.Walk(router, func(
		method string,
		route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		got = append(got, method+" "+route)
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("route count = %d, want %d\ngot:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("route[%d] = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestStage9BAccountHealthReadContract(t *testing.T) {
	submittedAt := "2026-11-08T09:00:00.000000+08:00"
	period := &agent_inspection.Period{
		ID: 1, WeekStart: "2026-11-02", WeekEnd: "2026-11-08",
		Deadline: "2026-11-09T09:00:00+08:00",
	}
	count := 1
	rating := "Good"
	compliance := 1
	store := &stage9BStore{
		periods: agent_inspection.PeriodPage{
			Items: []agent_inspection.Period{{
				ID: 1, WeekStart: period.WeekStart, WeekEnd: period.WeekEnd,
				Deadline: period.Deadline, SubmittedCount: &count,
			}},
			Total: 1,
		},
		currentPeriod: period,
		period:        period,
		projects: map[int64]*agent_inspection.Project{
			1: {ID: 1, Name: "Project A", Country: "US"},
		},
		reports: map[string]*agent_inspection.Report{
			stage9BReportKey(1, 1, "US"): {
				ID: 11, PeriodID: 1, ProjectID: 1, ProjectName: "Project A",
				ProjectCountry: "US", Country: "US", Status: "submitted",
				HealthData: map[string]any{
					"account_health_rating": "Good",
					"negative_feedback":     int64(2),
				},
				ComplianceData: map[string]any{"ip_infringement": int64(1)},
				StatusSummary:  stage9BString("本周健康"),
				SubmittedAt:    stage9BTime("2026-11-08T09:00:00+08:00"),
				CreatedAt:      time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC),
				UpdatedAt:      time.Date(2026, 11, 8, 1, 1, 0, 0, time.UTC),
			},
		},
		overview: &agent_inspection.OverviewResult{
			Period: *period,
			Items: []agent_inspection.AccountHealthRow{{
				PeriodID: 1, WeekStart: period.WeekStart, WeekEnd: period.WeekEnd,
				ProjectID: 1, ProjectName: "Project A", Country: "US",
				Status: "submitted", AccountHealthRating: &rating,
				ComplianceTotal: &compliance, SubmittedAt: &submittedAt,
				ScreenshotCount: 2,
			}},
			TotalProjects: 1, SubmittedCount: 1, OverdueCount: 0,
		},
		history: agent_inspection.HistoryPage{
			Items: []agent_inspection.HistoryItem{{
				PeriodID: 1, WeekStart: period.WeekStart, WeekEnd: period.WeekEnd,
				ProjectID: 1, ProjectName: "Project A", Country: "US",
				Status: "submitted", AccountHealthRating: &rating,
				ComplianceTotal: &compliance, SubmittedAt: &submittedAt,
				ScreenshotCount: 2,
			}},
			Total: 1,
		},
	}
	router := stage9BRouter(t, store, nil, nil, nil)

	cases := []struct {
		name   string
		target string
		check  func(map[string]any)
	}{
		{
			name: "periods", target: "/api/v1/agent/account-health/periods?limit=20",
			check: func(data map[string]any) {
				if stage9BNumber(data["total"]) != 1 {
					t.Fatalf("period total = %#v", data["total"])
				}
				items := data["items"].([]any)
				if len(items) != 1 || stage9BNumber(items[0].(map[string]any)["submitted_count"]) != 1 {
					t.Fatalf("period items = %#v", items)
				}
			},
		},
		{
			name: "current", target: "/api/v1/agent/account-health/periods/current",
			check: func(data map[string]any) {
				if stage9BNumber(data["period_id"]) != 1 {
					t.Fatalf("current period = %#v", data)
				}
				if _, exists := data["submitted_count"]; exists {
					t.Fatalf("current period leaked submitted_count: %#v", data)
				}
			},
		},
		{
			name: "overview", target: "/api/v1/agent/account-health/periods/1/overview?country=US",
			check: func(data map[string]any) {
				if stage9BNumber(data["submitted_count"]) != 1 {
					t.Fatalf("overview = %#v", data)
				}
				item := data["items"].([]any)[0].(map[string]any)
				if _, exists := item["health_data"]; exists {
					t.Fatalf("overview exposed raw health_data: %#v", item)
				}
			},
		},
		{
			name:   "project report",
			target: "/api/v1/agent/account-health/periods/1/projects/1?country=US&include_summary=true",
			check: func(data map[string]any) {
				if data["account_health_rating"] != "Good" ||
					stage9BNumber(data["compliance_total"]) != 1 ||
					data["status_summary"] != "本周健康" {
					t.Fatalf("project report = %#v", data)
				}
			},
		},
		{
			name: "history", target: "/api/v1/agent/account-health/history?order_by=compliance_total&order_dir=desc",
			check: func(data map[string]any) {
				if stage9BNumber(data["total"]) != 1 {
					t.Fatalf("history = %#v", data)
				}
				item := data["items"].([]any)[0].(map[string]any)
				if stage9BNumber(item["compliance_total"]) != 1 {
					t.Fatalf("history item = %#v", item)
				}
			},
		},
	}
	for _, testCase := range cases {
		recorder, payload := stage9BResponse(
			t, router,
			stage9BRequest(http.MethodGet, testCase.target, nil, ""),
		)
		if recorder.Code != http.StatusOK || payload["ok"] != true {
			t.Fatalf("%s status=%d body=%s", testCase.name, recorder.Code, recorder.Body.String())
		}
		data, _ := payload["data"].(map[string]any)
		testCase.check(data)
	}

	recorder, payload := stage9BResponse(
		t, router,
		stage9BRequest(
			http.MethodGet,
			"/api/v1/agent/account-health/history?order_by=evil",
			nil,
			"",
		),
	)
	if recorder.Code != http.StatusUnprocessableEntity ||
		payload["error_code"] != "VALIDATION_FAILED" {
		t.Fatalf("invalid order status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder, payload = stage9BResponse(
		t, router,
		stage9BRequest(
			http.MethodGet,
			"/api/v1/agent/account-health/periods/current?country=XX",
			nil,
			"",
		),
	)
	if recorder.Code != http.StatusUnprocessableEntity ||
		payload["error_code"] != "VALIDATION_FAILED" {
		t.Fatalf("invalid country status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	store.currentPeriod = nil
	recorder, payload = stage9BResponse(
		t, router,
		stage9BRequest(http.MethodGet, "/api/v1/agent/account-health/periods/current", nil, ""),
	)
	if recorder.Code != http.StatusNotFound || payload["error_code"] != "RESOURCE_NOT_FOUND" {
		t.Fatalf("missing current status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestStage9BAuthScopeAndRateLimit(t *testing.T) {
	store := &stage9BStore{
		period: &agent_inspection.Period{ID: 1, WeekStart: "2026-11-02"},
		projects: map[int64]*agent_inspection.Project{
			1: {ID: 1, Name: "Project A", Country: "US"},
			2: {ID: 2, Name: "Project B", Country: "DE"},
		},
	}
	credentials := &stage9BCredentials{row: agentauth.CredentialRow{
		KeyID: 1, AgentID: stage9BAgentID,
		BusinessScope: "account_health",
		ProjectScope:  "1",
	}}
	router := stage9BRouter(t, store, credentials, nil, nil)

	recorder, _ := stage9BResponse(
		t, router,
		httptest.NewRequest(http.MethodGet, "/api/v1/agent/account-health/periods", nil),
	)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder, payload := stage9BResponse(
		t, router,
		stage9BRequest(
			http.MethodGet,
			"/api/v1/agent/account-health/periods/1/projects/2",
			nil,
			"",
		),
	)
	if recorder.Code != http.StatusForbidden ||
		payload["error_code"] != "AGENT_PROJECT_OUT_OF_SCOPE" {
		t.Fatalf("project scope status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	credentials.row.BusinessScope = "shipments"
	recorder, payload = stage9BResponse(
		t, router,
		stage9BRequest(http.MethodGet, "/api/v1/agent/account-health/periods", nil, ""),
	)
	if recorder.Code != http.StatusForbidden ||
		payload["error_code"] != "AGENT_BUSINESS_OUT_OF_SCOPE" {
		t.Fatalf("business scope status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	credentials.row.BusinessScope = "account_health"
	limited := stage9BRouter(
		t,
		store,
		credentials,
		nil,
		nil,
		agent_inspection.WithReadRateLimiter(agentauth.NewMemoryRateLimiter(
			agentauth.RateLimit{Requests: 1, Window: time.Minute},
		)),
	)
	first, _ := stage9BResponse(
		t, limited,
		stage9BRequest(http.MethodGet, "/api/v1/agent/account-health/periods", nil, ""),
	)
	if first.Code != http.StatusOK {
		t.Fatalf("first limited request status=%d body=%s", first.Code, first.Body.String())
	}
	second, payload := stage9BResponse(
		t, limited,
		stage9BRequest(http.MethodGet, "/api/v1/agent/account-health/periods", nil, ""),
	)
	if second.Code != http.StatusTooManyRequests ||
		payload["error_code"] != "AGENT_RATE_LIMIT_EXCEEDED" ||
		second.Header().Get("Retry-After") == "" {
		t.Fatalf("rate limit status=%d headers=%v body=%s", second.Code, second.Header(), second.Body.String())
	}
}

func TestStage9BPlatformInspectionWriteAndConfirmContract(t *testing.T) {
	period := &agent_inspection.Period{
		ID: 1, WeekStart: "2026-11-02", WeekEnd: "2026-11-08",
		Deadline: "2026-11-09T09:00:00+08:00",
	}
	project := &agent_inspection.Project{ID: 1, Name: "Project A", Country: "US"}
	report := &agent_inspection.Report{
		ID: 21, PeriodID: 1, ProjectID: 1, Country: "US", Status: "draft",
		HealthData: map[string]any{"negative_feedback": int64(5)},
		CreatedAt:  time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC),
		UpdatedAt:  time.Date(2026, 11, 8, 0, 1, 0, 0, time.UTC),
	}
	store := &stage9BStore{
		period:   period,
		projects: map[int64]*agent_inspection.Project{1: project},
		reports: map[string]*agent_inspection.Report{
			stage9BReportKey(1, 1, "US"): report,
		},
		submitReport: &agent_inspection.Report{
			ID: 21, PeriodID: 1, ProjectID: 1, Country: "US",
			Status: "submitted", SubmittedBy: stage9BString(stage9BAgentID),
			SubmittedAt: stage9BTime("2026-11-08T09:30:00+08:00"),
			CreatedAt:   report.CreatedAt, UpdatedAt: time.Date(2026, 11, 8, 1, 30, 0, 0, time.UTC),
			HealthData: map[string]any{"negative_feedback": int64(5)},
		},
	}
	router := stage9BRouter(t, store, nil, nil, nil)

	recorder, payload := stage9BResponse(
		t, router,
		stage9BRequest(http.MethodGet, "/api/v1/agent/platform-inspection/template", nil, ""),
	)
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("template status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	template := payload["data"].(map[string]any)
	if len(template["compliance_fields"].([]any)) != 10 ||
		len(template["shipping_performance_fields"].([]any)) != 4 {
		t.Fatalf("template shape = %#v", template)
	}

	recorder, payload = stage9BResponse(
		t, router,
		stage9BJSONRequest(
			http.MethodPut,
			"/api/v1/agent/platform-inspection/periods/1/projects/1",
			`{"health_data":{"account_health_rating":"Good","negative_feedback":2},"compliance_data":{"ip_infringement":1},"status_summary":"ok"}`,
			"idem-save",
		),
	)
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("save status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	data := payload["data"].(map[string]any)
	if data["status"] != "draft" || data["health_data"].(map[string]any)["account_health_rating"] != "Good" {
		t.Fatalf("save data = %#v", data)
	}
	if store.upsertInput.Patch.StatusSummary == nil || *store.upsertInput.Patch.StatusSummary != "ok" {
		t.Fatalf("upsert patch = %#v", store.upsertInput.Patch)
	}
	entries := store.auditEntries
	if len(entries) != 1 || entries[0].Action != "platform_inspection.save" ||
		entries[0].AgentID == nil || *entries[0].AgentID != stage9BAgentID ||
		entries[0].IdempotencyKey == nil || *entries[0].IdempotencyKey != "idem-save" {
		t.Fatalf("save audit = %#v", entries)
	}

	recorder, payload = stage9BResponse(
		t, router,
		stage9BJSONRequest(
			http.MethodPut,
			"/api/v1/agent/platform-inspection/periods/1/projects/1",
			`{"health_data":{"negative_feedback":5}}`,
			"",
		),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("merge save status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if store.upsertInput.Patch.HealthData["account_health_rating"] != "Good" ||
		store.upsertInput.Patch.HealthData["negative_feedback"] != int64(5) {
		t.Fatalf("explicit merge patch = %#v", store.upsertInput.Patch.HealthData)
	}

	recorder, payload = stage9BResponse(
		t, router,
		stage9BJSONRequest(
			http.MethodPut,
			"/api/v1/agent/platform-inspection/periods/1/projects/1",
			`{"health_data":{"account_health_rating":"Superb"}}`,
			"",
		),
	)
	if recorder.Code != http.StatusUnprocessableEntity ||
		payload["error_code"] != "VALIDATION_FAILED" {
		t.Fatalf("invalid rating status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	store.period = nil
	recorder, payload = stage9BResponse(
		t, router,
		stage9BJSONRequest(
			http.MethodPut,
			"/api/v1/agent/platform-inspection/periods/1/projects/1",
			`{}`,
			"",
		),
	)
	if recorder.Code != http.StatusNotFound || payload["error_code"] != "RESOURCE_NOT_FOUND" {
		t.Fatalf("missing period status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	store.period = period

	submitURL := "/api/v1/agent/platform-inspection/periods/1/projects/1/submit"
	previewRequest := stage9BJSONRequest(http.MethodPost, submitURL, `{"country":"US"}`, "idem-submit")
	recorder, payload = stage9BResponse(t, router, previewRequest)
	if recorder.Code != http.StatusOK || payload["requires_confirmation"] != true {
		t.Fatalf("submit preview status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	token, _ := payload["confirm_token"].(string)
	if token == "" {
		t.Fatalf("missing confirm token: %#v", payload)
	}
	replayRequest := stage9BJSONRequest(http.MethodPost, submitURL, `{"country":"US"}`, "idem-submit")
	replayRequest.Header.Set(agentauth.ConfirmTokenHeader, token)
	recorder, payload = stage9BResponse(t, router, replayRequest)
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("submit replay status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	data = payload["data"].(map[string]any)
	if data["status"] != "submitted" || stage9BNumber(data["report_id"]) != 21 {
		t.Fatalf("submitted data = %#v", data)
	}
	warnings := data["warnings"].([]any)
	foundWarning := false
	for _, warning := range warnings {
		if warning.(map[string]any)["metric"] == "inspection_negative_feedback" {
			foundWarning = true
		}
	}
	if !foundWarning {
		t.Fatalf("warnings = %#v", warnings)
	}
	if store.submitCalls != 1 || store.txCalls < 4 {
		t.Fatalf("submit calls=%d tx calls=%d", store.submitCalls, store.txCalls)
	}
	foundSubmitAudit := false
	for _, entry := range store.auditEntries {
		if entry.Action == "platform_inspection.submit" &&
			entry.TargetID != nil && *entry.TargetID == "21" {
			foundSubmitAudit = true
		}
	}
	if !foundSubmitAudit {
		t.Fatalf("submit audit missing: %#v", store.auditEntries)
	}

	bodyMismatchPreview := stage9BJSONRequest(http.MethodPost, submitURL, `{}`, "idem-body")
	_, payload = stage9BResponse(t, router, bodyMismatchPreview)
	bodyToken := payload["confirm_token"].(string)
	bodyMismatchReplay := stage9BJSONRequest(http.MethodPost, submitURL, `{"country":"DE"}`, "idem-body")
	bodyMismatchReplay.Header.Set(agentauth.ConfirmTokenHeader, bodyToken)
	recorder, payload = stage9BResponse(t, router, bodyMismatchReplay)
	if recorder.Code != http.StatusBadRequest || payload["error_code"] != "CONFIRM_TOKEN_INVALID" {
		t.Fatalf("body mismatch status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	resourcePreview := stage9BJSONRequest(
		http.MethodPost,
		"/api/v1/agent/platform-inspection/periods/1/projects/1/submit",
		`{}`,
		"idem-resource",
	)
	_, payload = stage9BResponse(t, router, resourcePreview)
	resourceToken := payload["confirm_token"].(string)
	resourceReplay := stage9BJSONRequest(
		http.MethodPost,
		"/api/v1/agent/platform-inspection/periods/1/projects/2/submit",
		`{}`,
		"idem-resource",
	)
	resourceReplay.Header.Set(agentauth.ConfirmTokenHeader, resourceToken)
	recorder, payload = stage9BResponse(t, router, resourceReplay)
	if recorder.Code != http.StatusBadRequest || payload["error_code"] != "CONFIRM_TOKEN_INVALID" {
		t.Fatalf("resource mismatch status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	noConfirmCredentials := &stage9BCredentials{row: agentauth.CredentialRow{
		KeyID: 1, AgentID: stage9BAgentID,
		BusinessScope: "platform_inspection", ProjectScope: "*",
	}}
	noConfirmStore := &stage9BStore{
		period:   period,
		projects: map[int64]*agent_inspection.Project{1: project},
		reports: map[string]*agent_inspection.Report{
			stage9BReportKey(1, 1, "US"): report,
		},
	}
	noConfirmRouter := chi.NewRouter()
	agent_inspection.NewRegistrar(
		noConfirmStore,
		noConfirmCredentials,
		nil,
		nil,
	).RegisterRoutes(noConfirmRouter, nil)
	recorder, payload = stage9BResponse(
		t,
		noConfirmRouter,
		stage9BJSONRequest(http.MethodPost, submitURL, `{}`, "idem-no-confirm"),
	)
	if recorder.Code != http.StatusServiceUnavailable ||
		payload["error_code"] != "SERVICE_UNAVAILABLE" {
		t.Fatalf("missing confirm service status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestStage9BScreenshotUploadSecurityAndIdempotency(t *testing.T) {
	period := &agent_inspection.Period{ID: 1, WeekStart: "2026-11-02"}
	project := &agent_inspection.Project{ID: 1, Name: "Project A", Country: "US"}
	report := &agent_inspection.Report{
		ID: 31, PeriodID: 1, ProjectID: 1, Country: "US", Status: "draft",
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	store := &stage9BStore{
		period:   period,
		projects: map[int64]*agent_inspection.Project{1: project},
		reports: map[string]*agent_inspection.Report{
			stage9BReportKey(1, 1, "US"): report,
		},
	}
	blobs := newStage9BBlobStore()
	router := stage9BRouter(t, store, nil, blobs, nil)

	request := stage9BMultipart(t, "shot.png", stage9BPNG(t), "image/png", "idem-shot")
	recorder, payload := stage9BResponse(t, router, request)
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("upload status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	data := payload["data"].(map[string]any)
	if stage9BNumber(data["screenshot_id"]) != 51 || data["content_type"] != "image/jpeg" {
		t.Fatalf("upload data = %#v", data)
	}
	for _, forbidden := range []string{"url", "thumbnail_url", "r2_key"} {
		if _, exists := data[forbidden]; exists {
			t.Fatalf("upload leaked %s: %#v", forbidden, data)
		}
	}
	if store.insertCalls != 1 || blobs.putCalls != 2 {
		t.Fatalf("insert calls=%d blob puts=%d", store.insertCalls, blobs.putCalls)
	}
	entries := store.auditEntries
	if len(entries) != 1 || entries[0].Action != "platform_inspection.upload_screenshot" ||
		entries[0].IdempotencyKey == nil || *entries[0].IdempotencyKey != "idem-shot" {
		t.Fatalf("upload audit = %#v", entries)
	}

	replay := stage9BMultipart(t, "different.png", stage9BPNG(t), "image/png", "idem-shot")
	recorder, payload = stage9BResponse(t, router, replay)
	if recorder.Code != http.StatusOK ||
		stage9BNumber(payload["data"].(map[string]any)["screenshot_id"]) != 51 {
		t.Fatalf("upload replay status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if store.insertCalls != 1 || blobs.putCalls != 2 {
		t.Fatalf("replay duplicated upload: insert=%d puts=%d", store.insertCalls, blobs.putCalls)
	}

	recorder, payload = stage9BResponse(
		t, router,
		stage9BMultipart(t, "bad.txt", []byte("hello"), "text/plain", ""),
	)
	if recorder.Code != http.StatusUnprocessableEntity ||
		payload["error_code"] != "VALIDATION_FAILED" {
		t.Fatalf("invalid MIME status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder, payload = stage9BResponse(
		t, router,
		stage9BMultipart(t, "fake.png", []byte("not an image"), "image/png", ""),
	)
	if recorder.Code != http.StatusUnprocessableEntity ||
		payload["error_code"] != "VALIDATION_FAILED" {
		t.Fatalf("magic mismatch status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	store.reports = map[string]*agent_inspection.Report{}
	beforePuts := blobs.putCalls
	recorder, payload = stage9BResponse(
		t, router,
		stage9BMultipart(t, "shot.png", stage9BPNG(t), "image/png", ""),
	)
	if recorder.Code != http.StatusNotFound || payload["error_code"] != "RESOURCE_NOT_FOUND" {
		t.Fatalf("missing report status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if blobs.putCalls != beforePuts {
		t.Fatal("missing report uploaded an object before returning 404")
	}

	store.reports = map[string]*agent_inspection.Report{
		stage9BReportKey(1, 1, "US"): report,
	}
	withoutBlob := stage9BRouter(t, store, nil, nil, nil)
	recorder, payload = stage9BResponse(
		t, withoutBlob,
		stage9BMultipart(t, "shot.png", stage9BPNG(t), "image/png", ""),
	)
	if recorder.Code != http.StatusServiceUnavailable ||
		payload["error_code"] != "SERVICE_UNAVAILABLE" {
		t.Fatalf("missing blob store status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	compensatingStore := &stage9BStore{
		period:   period,
		projects: map[int64]*agent_inspection.Project{1: project},
		reports: map[string]*agent_inspection.Report{
			stage9BReportKey(1, 1, "US"): report,
		},
		insertErr: errors.New("database insert failed"),
	}
	compensatingBlobs := newStage9BBlobStore()
	compensatingRouter := stage9BRouter(t, compensatingStore, nil, compensatingBlobs, nil)
	recorder, _ = stage9BResponse(
		t, compensatingRouter,
		stage9BMultipart(t, "shot.png", stage9BPNG(t), "image/png", ""),
	)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("upload compensation status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if compensatingBlobs.putCalls != 2 || compensatingBlobs.deleteCalls != 2 {
		t.Fatalf("upload compensation puts=%d deletes=%d", compensatingBlobs.putCalls, compensatingBlobs.deleteCalls)
	}
}

func TestStage9BScreenshotDeleteConfirmCompensationAndFingerprint(t *testing.T) {
	thumbnailKey := "inspection-screenshots/Project_A/61_thumb.jpg"
	store := &stage9BStore{
		screenshots: map[int64]*agent_inspection.Screenshot{
			61: {
				ID: 61, ReportID: 31, PeriodID: 1, ProjectID: 1,
				ProjectName: "Project A", R2Key: "inspection-screenshots/Project_A/61.jpg",
				ThumbnailKey: &thumbnailKey, Filename: "shot.jpg", ContentType: "image/jpeg",
				CreatedAt: time.Now().UTC(),
			},
			62: {
				ID: 62, ReportID: 31, PeriodID: 1, ProjectID: 1,
				ProjectName: "Project A", R2Key: "inspection-screenshots/Project_A/62.jpg",
				Filename: "shot-2.jpg", ContentType: "image/jpeg", CreatedAt: time.Now().UTC(),
			},
		},
	}
	blobs := newStage9BBlobStore()
	blobs.objects["inspection-screenshots/Project_A/61.jpg"] = []byte{0xff, 0xd8, 0xff}
	blobs.objects[thumbnailKey] = []byte{0xff, 0xd8, 0xff}
	router := stage9BRouter(t, store, nil, blobs, nil)

	previewRequest := stage9BRequest(
		http.MethodDelete,
		"/api/v1/agent/platform-inspection/screenshots/61",
		strings.NewReader(""),
		"idem-delete",
	)
	recorder, payload := stage9BResponse(t, router, previewRequest)
	if recorder.Code != http.StatusOK || payload["requires_confirmation"] != true {
		t.Fatalf("delete preview status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	token := payload["confirm_token"].(string)
	replayRequest := stage9BRequest(
		http.MethodDelete,
		"/api/v1/agent/platform-inspection/screenshots/61",
		strings.NewReader(""),
		"idem-delete",
	)
	replayRequest.Header.Set(agentauth.ConfirmTokenHeader, token)
	recorder, payload = stage9BResponse(t, router, replayRequest)
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("delete replay status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if store.deleteCalls != 1 || blobs.deleteCalls != 2 {
		t.Fatalf("delete calls=%d blob deletes=%d", store.deleteCalls, blobs.deleteCalls)
	}
	entries := store.auditEntries
	if len(entries) != 1 || entries[0].Action != "platform_inspection.delete_screenshot" {
		t.Fatalf("delete audit = %#v", entries)
	}

	recorder, payload = stage9BResponse(
		t, router,
		stage9BRequest(
			http.MethodDelete,
			"/api/v1/agent/platform-inspection/screenshots/999",
			strings.NewReader(""),
			"",
		),
	)
	if recorder.Code != http.StatusNotFound || payload["error_code"] != "RESOURCE_NOT_FOUND" {
		t.Fatalf("delete missing status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	resourcePreview := stage9BRequest(
		http.MethodDelete,
		"/api/v1/agent/platform-inspection/screenshots/61",
		strings.NewReader(""),
		"idem-resource-delete",
	)
	_, payload = stage9BResponse(t, router, resourcePreview)
	resourceToken := payload["confirm_token"].(string)
	resourceReplay := stage9BRequest(
		http.MethodDelete,
		"/api/v1/agent/platform-inspection/screenshots/62",
		strings.NewReader(""),
		"idem-resource-delete",
	)
	resourceReplay.Header.Set(agentauth.ConfirmTokenHeader, resourceToken)
	recorder, payload = stage9BResponse(t, router, resourceReplay)
	if recorder.Code != http.StatusBadRequest || payload["error_code"] != "CONFIRM_TOKEN_INVALID" {
		t.Fatalf("delete fingerprint status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	outOfScope := &stage9BCredentials{row: agentauth.CredentialRow{
		KeyID: 1, AgentID: stage9BAgentID,
		BusinessScope: "platform_inspection", ProjectScope: "2",
	}}
	scopedRouter := stage9BRouter(t, store, outOfScope, blobs, nil)
	recorder, payload = stage9BResponse(
		t, scopedRouter,
		stage9BRequest(
			http.MethodDelete,
			"/api/v1/agent/platform-inspection/screenshots/61",
			strings.NewReader(""),
			"",
		),
	)
	if recorder.Code != http.StatusForbidden ||
		payload["error_code"] != "AGENT_PROJECT_OUT_OF_SCOPE" {
		t.Fatalf("delete scope status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	compensatingStore := &stage9BStore{
		screenshots: map[int64]*agent_inspection.Screenshot{
			63: {
				ID: 63, ReportID: 31, PeriodID: 1, ProjectID: 1,
				ProjectName: "Project A", R2Key: "inspection-screenshots/Project_A/63.jpg",
				ThumbnailKey: &thumbnailKey, Filename: "shot-3.jpg",
				ContentType: "image/jpeg", CreatedAt: time.Now().UTC(),
			},
		},
	}
	compensatingBlobs := newStage9BBlobStore()
	compensatingBlobs.failDelete = true
	compensatingBlobs.objects["inspection-screenshots/Project_A/63.jpg"] = []byte{0xff, 0xd8, 0xff}
	compensatingBlobs.objects[thumbnailKey] = []byte{0xff, 0xd8, 0xff}
	compensatingRouter := stage9BRouter(t, compensatingStore, nil, compensatingBlobs, nil)
	compensatingPreview := stage9BRequest(
		http.MethodDelete,
		"/api/v1/agent/platform-inspection/screenshots/63",
		strings.NewReader(""),
		"idem-delete-compensate",
	)
	_, payload = stage9BResponse(t, compensatingRouter, compensatingPreview)
	compensatingToken := payload["confirm_token"].(string)
	compensatingReplay := stage9BRequest(
		http.MethodDelete,
		"/api/v1/agent/platform-inspection/screenshots/63",
		strings.NewReader(""),
		"idem-delete-compensate",
	)
	compensatingReplay.Header.Set(agentauth.ConfirmTokenHeader, compensatingToken)
	recorder, _ = stage9BResponse(t, compensatingRouter, compensatingReplay)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("delete compensation status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if compensatingBlobs.putCalls != 2 || compensatingStore.deleteCalls != 0 {
		t.Fatalf(
			"delete compensation puts=%d db deletes=%d",
			compensatingBlobs.putCalls,
			compensatingStore.deleteCalls,
		)
	}
}

func TestStage9BComplaintBatchContract(t *testing.T) {
	store := &stage9BStore{
		batchResult: agent_inspection.ComplaintBatchResult{
			RunID:   71,
			RunDate: "2026-11-08",
			ShopChecks: []agent_inspection.ShopCheckResult{{
				ShopCheckID: 72, ProjectID: 1, Country: "US",
			}},
			Complaints: []agent_inspection.ComplaintResult{{
				ComplaintID: 73, ProjectID: 1, Country: "US",
				BuyerName: "Crystal", FirstMessageDate: "2026-11-07",
				MessageDate: "2026-11-07",
			}},
		},
	}
	router := stage9BRouter(t, store, nil, nil, nil)
	body := `{
		"run_date":"2026-11-08",
		"trigger":"autopilot",
		"shops_total":1,
		"shops_checked":1,
		"shops_failed":[],
		"summary":{"total_needs_reply":1,"total_reported_unresolved":0,"shops_with_pending":1},
		"shop_checks":[{
			"project_id":1,"country":"US","check_status":"ok",
			"metrics":{"needs_reply":1,"reported_unresolved":0,"resolved_total":0,"resolved_today":0}
		}],
		"complaints":[{
			"project_id":1,"country":"US","first_message_date":"2026-11-07",
			"message_date":"2026-11-07","buyer_name":"Crystal",
			"subject":"Question","message_body":"Need details",
			"triage":{"category":"no_order_info","has_order":false,"summary_zh":"咨询"}
		}]
	}`

	recorder, payload := stage9BResponse(
		t, router,
		stage9BJSONRequest(
			http.MethodPost,
			"/api/v1/agent/complaint-center/batch",
			body,
			"idem-batch",
		),
	)
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("batch status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	data := payload["data"].(map[string]any)
	if stage9BNumber(data["run_id"]) != 71 ||
		stage9BNumber(data["shop_checks"].([]any)[0].(map[string]any)["shop_check_id"]) != 72 ||
		stage9BNumber(data["complaints"].([]any)[0].(map[string]any)["complaint_id"]) != 73 {
		t.Fatalf("batch data = %#v", data)
	}
	if data["idempotency_key"] != "idem-batch" {
		t.Fatalf("batch idempotency = %#v", data)
	}
	if store.txCalls != 1 || store.batchCalls != 1 {
		t.Fatalf("tx calls=%d batch calls=%d", store.txCalls, store.batchCalls)
	}
	entries := store.auditEntries
	if len(entries) != 1 || entries[0].Action != "complaint_center.batch_write" ||
		entries[0].TargetID == nil || *entries[0].TargetID != "71" ||
		entries[0].IdempotencyKey == nil || *entries[0].IdempotencyKey != "idem-batch" {
		t.Fatalf("batch audit = %#v", entries)
	}

	recorder, payload = stage9BResponse(
		t, router,
		stage9BJSONRequest(
			http.MethodPost,
			"/api/v1/agent/complaint-center/batch",
			`{"run_date":"bad-date"}`,
			"",
		),
	)
	if recorder.Code != http.StatusUnprocessableEntity ||
		payload["error_code"] != "VALIDATION_FAILED" {
		t.Fatalf("invalid batch status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	emptyKey := stage9BJSONRequest(
		http.MethodPost,
		"/api/v1/agent/complaint-center/batch",
		body,
		"",
	)
	emptyKey.Header.Set("Idempotency-Key", "   ")
	recorder, payload = stage9BResponse(t, router, emptyKey)
	if recorder.Code != http.StatusUnprocessableEntity ||
		payload["error_code"] != "VALIDATION_FAILED" {
		t.Fatalf("empty idempotency status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	outOfScope := &stage9BCredentials{row: agentauth.CredentialRow{
		KeyID: 1, AgentID: stage9BAgentID,
		BusinessScope: "complaint_center", ProjectScope: "9",
	}}
	scopedRouter := stage9BRouter(t, store, outOfScope, nil, nil)
	recorder, payload = stage9BResponse(
		t, scopedRouter,
		stage9BJSONRequest(
			http.MethodPost,
			"/api/v1/agent/complaint-center/batch",
			body,
			"",
		),
	)
	if recorder.Code != http.StatusForbidden ||
		payload["error_code"] != "AGENT_PROJECT_OUT_OF_SCOPE" {
		t.Fatalf("batch scope status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	store.validateComplaintErr = &agent_inspection.ValidationError{
		Code: "IDENTITY_CHECK_REQUIRED", Detail: "identity verification required",
	}
	recorder, payload = stage9BResponse(
		t, router,
		stage9BJSONRequest(
			http.MethodPost,
			"/api/v1/agent/complaint-center/batch",
			body,
			"",
		),
	)
	if recorder.Code != http.StatusUnprocessableEntity ||
		payload["error_code"] != "IDENTITY_CHECK_REQUIRED" {
		t.Fatalf("identity gate status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	store.validateComplaintErr = agent_inspection.ErrProjectNotFound
	recorder, payload = stage9BResponse(
		t, router,
		stage9BJSONRequest(
			http.MethodPost,
			"/api/v1/agent/complaint-center/batch",
			body,
			"",
		),
	)
	if recorder.Code != http.StatusNotFound || payload["error_code"] != "RESOURCE_NOT_FOUND" {
		t.Fatalf("missing project status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func stage9BString(value string) *string {
	return &value
}

func stage9BTime(value string) *time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		panic(err)
	}
	return &parsed
}
