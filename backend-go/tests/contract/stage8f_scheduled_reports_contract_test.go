package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_jobs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
)

const (
	stage8FAPIKey      = "stage8f-key"
	stage8FProxySecret = "stage8f-proxy"
)

type stage8FStore struct {
	subscription     *scheduled_reports.Subscription
	resendResult     scheduled_reports.ResendResult
	resendErr        error
	regenerateResult scheduled_reports.RegenerateResult
	enqueued         []scheduled_reports.EnqueueRequest
}

func (store *stage8FStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, scheduled_reports.Store) error,
) error {
	return fn(ctx, nil, store)
}

func (store *stage8FStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}

func (store *stage8FStore) ListSubscriptions(
	context.Context,
	scheduled_reports.Scope,
	*string,
) ([]scheduled_reports.Subscription, error) {
	if store.subscription == nil {
		return []scheduled_reports.Subscription{}, nil
	}
	return []scheduled_reports.Subscription{*store.subscription}, nil
}

func (store *stage8FStore) GetSubscription(context.Context, int64) (*scheduled_reports.Subscription, error) {
	return store.subscription, nil
}

func (store *stage8FStore) CreateSubscription(
	_ context.Context,
	input scheduled_reports.SubscriptionCreateInput,
) (*scheduled_reports.Subscription, error) {
	created := scheduled_reports.Subscription{
		ID:              12,
		UserID:          input.UserID,
		Email:           input.Email,
		ProjectIDs:      input.ProjectIDs,
		Country:         input.Country,
		Frequency:       input.Frequency,
		DispatchHour:    input.DispatchHour,
		DispatchMinute:  input.DispatchMinute,
		DispatchWeekday: input.DispatchWeekday,
		DispatchDay:     input.DispatchDay,
		Enabled:         true,
		CreatedAt:       "2026-11-08T10:00:00+08:00",
		UpdatedAt:       "2026-11-08T10:00:00+08:00",
	}
	store.subscription = &created
	return &created, nil
}

func (store *stage8FStore) UpdateSubscription(
	_ context.Context,
	id int64,
	patch scheduled_reports.SubscriptionPatch,
) (*scheduled_reports.Subscription, error) {
	if store.subscription == nil || store.subscription.ID != id {
		return nil, nil
	}
	updated := *store.subscription
	if patch.Enabled.Set && patch.Enabled.Value != nil {
		updated.Enabled = *patch.Enabled.Value
	}
	return &updated, nil
}

func (store *stage8FStore) DeleteSubscription(context.Context, int64) (bool, error) {
	return store.subscription != nil, nil
}

func (store *stage8FStore) ListDeliveryLogs(
	context.Context,
	scheduled_reports.Scope,
	*string,
	int,
	int,
) (scheduled_reports.DeliveryLogListResponse, error) {
	return scheduled_reports.DeliveryLogListResponse{
		Items: []scheduled_reports.DeliveryLog{{
			ID:              3,
			SubscriptionID:  7,
			Frequency:       "weekly",
			ReportDate:      "2026-11-03",
			Status:          "sent",
			Stage:           "done",
			AISummaryStatus: "done",
			CreatedAt:       "2026-11-08T10:00:00+08:00",
		}},
		Total: 1,
	}, nil
}

func (store *stage8FStore) RefreshLedger(
	context.Context,
	scheduled_reports.LedgerQuery,
) (scheduled_reports.LedgerListResponse, error) {
	return scheduled_reports.LedgerListResponse{
		Items: []scheduled_reports.LedgerItem{{
			ID:              9,
			LedgerKey:       "7:2026-11-03",
			ExpectedDate:    "2026-11-03",
			ExpectedAt:      "2026-11-03T16:00:00+08:00",
			Frequency:       "weekly",
			SubscriptionID:  7,
			ProjectIDs:      "1,2",
			ProjectNames:    []string{"项目一", "项目二"},
			Country:         "US",
			Status:          "sent",
			CanResend:       false,
			LastCheckedAt:   "2026-11-08T10:00:00+08:00",
			AISummaryStatus: "done",
		}},
		Total: 1,
		Summary: scheduled_reports.LedgerSummary{
			Expected: 1,
			Sent:     1,
		},
	}, nil
}

func (store *stage8FStore) PrepareResend(
	context.Context,
	scheduled_reports.ResendRequest,
) (scheduled_reports.ResendResult, error) {
	if store.resendResult.DeliveryLogID == nil {
		store.resendResult = scheduled_reports.ResendResult{
			DeliveryLogID:  stage8FInt64(22),
			Status:         "processing",
			Message:        "补发任务已派发到 scheduled 队列，请在台账中查看进度",
			SubscriptionID: 7,
			Frequency:      "weekly",
			Email:          stage8FString("owner@example.com"),
			ProjectIDs:     "1,2",
			Country:        "US",
			ReportDate:     "2026-11-03",
		}
	}
	return store.resendResult, store.resendErr
}

func (store *stage8FStore) PrepareAISummaryRegeneration(
	context.Context,
	scheduled_reports.RegenerateRequest,
) (scheduled_reports.RegenerateResult, error) {
	if store.regenerateResult.DeliveryLogID == nil {
		store.regenerateResult = scheduled_reports.RegenerateResult{
			DeliveryLogID: stage8FInt64(22),
			Status:        "generating",
			Message:       "AI 摘要生成已启动",
		}
	}
	return store.regenerateResult, nil
}

func (store *stage8FStore) ListActiveSubscriptions(
	context.Context,
	string,
) ([]scheduled_reports.Subscription, error) {
	if store.subscription == nil {
		return []scheduled_reports.Subscription{}, nil
	}
	return []scheduled_reports.Subscription{*store.subscription}, nil
}

func (store *stage8FStore) AcquireTriggerLock(context.Context, string) error {
	return nil
}

func (store *stage8FStore) FindIdempotencyRecord(
	context.Context,
	string,
	string,
) (*scheduled_reports.IdempotencyRecord, error) {
	return nil, nil
}

type stage8FEnqueuer struct {
	store *stage8FStore
	err   error
}

func (enqueuer *stage8FEnqueuer) Enqueue(
	_ context.Context,
	request scheduled_reports.EnqueueRequest,
) (string, error) {
	enqueuer.store.enqueued = append(enqueuer.store.enqueued, request)
	if enqueuer.err != nil {
		return "", enqueuer.err
	}
	return "task-id", nil
}

type stage8FMailer struct {
	calls int
	err   error
}

func (mailer *stage8FMailer) SendTestReport(
	context.Context,
	scheduled_reports.TestEmailMessage,
) (*string, error) {
	mailer.calls++
	if mailer.err != nil {
		return nil, mailer.err
	}
	return stage8FString("mail-1"), nil
}

type stage8FInternalJobStore struct{}

func (*stage8FInternalJobStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, internal_jobs.Store) error,
) error {
	return fn(ctx, nil, &stage8FInternalJobStore{})
}

func (*stage8FInternalJobStore) AcquireJobLock(context.Context, string) error {
	return nil
}

func (*stage8FInternalJobStore) FindIdempotencyRecord(
	context.Context,
	string,
	string,
) (*internal_jobs.IdempotencyRecord, error) {
	return nil, nil
}

type stage8FRunner struct{}

func (*stage8FRunner) RefreshReturnAnalysis(
	context.Context,
	string,
	int,
) (internal_jobs.RefreshResult, error) {
	return internal_jobs.RefreshResult{RowsWritten: 42, Projects: 3}, nil
}

func (*stage8FRunner) RebuildReturnAnalysis(
	context.Context,
) (internal_jobs.RebuildResult, error) {
	return internal_jobs.RebuildResult{
		RangeStart:      "2026-01-01",
		RangeEnd:        "2026-11-07",
		RowsWritten:     900,
		ProjectsTouched: 12,
	}, nil
}

func TestStage8FScheduledReportsRouteInventory(t *testing.T) {
	store := stage8FDefaultStore()
	router := stage8FRouter(store, &stage8FMailer{})

	want := []string{
		"GET /api/v1/scheduled-reports/subscriptions",
		"POST /api/v1/scheduled-reports/subscriptions",
		"PUT /api/v1/scheduled-reports/subscriptions/{subscription_id}",
		"DELETE /api/v1/scheduled-reports/subscriptions/{subscription_id}",
		"GET /api/v1/scheduled-reports/delivery-logs",
		"POST /api/v1/scheduled-reports/test-email",
		"GET /api/v1/scheduled-reports/ledger",
		"POST /api/v1/scheduled-reports/ledger/{ledger_key}/resend",
		"POST /api/v1/scheduled-reports/ledger/{ledger_key}/ai-summary/regenerate",
		"POST /api/v1/scheduled-reports/trigger",
		"POST /api/v1/internal/jobs/return-analysis-refresh",
		"POST /api/v1/internal/jobs/return-analysis-rebuild",
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

func TestStage8FStatusAndWireContract(t *testing.T) {
	store := stage8FDefaultStore()
	mailer := &stage8FMailer{}
	router := stage8FRouter(store, mailer)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/scheduled-reports/subscriptions", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing API key status = %d, want 401", recorder.Code)
	}

	request = stage8FRequest(
		http.MethodGet,
		"/api/v1/scheduled-reports/subscriptions",
		"",
		"10",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list subscriptions status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var list scheduled_reports.SubscriptionListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode subscriptions: %v", err)
	}
	if len(list.Items) != 1 || list.Items[0].ProjectIDs != "1,2" {
		t.Fatalf("subscriptions = %#v", list)
	}

	request = stage8FRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/subscriptions",
		`{"email":"owner@example.com","project_ids":"1,2","country":"US","frequency":"weekly","dispatch_hour":16,"dispatch_weekday":0}`,
		"10",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create subscription status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created subscription: %v", err)
	}
	for _, field := range []string{
		"project_ids", "dispatch_hour", "dispatch_minute",
		"dispatch_weekday", "created_at", "updated_at",
	} {
		if _, ok := created[field]; !ok {
			t.Errorf("created subscription missing %q: %s", field, recorder.Body.String())
		}
	}

	request = stage8FRequest(http.MethodPut, "/api/v1/scheduled-reports/subscriptions/12", `{"enabled":false}`, "10", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("update subscription status = %d: %s", recorder.Code, recorder.Body.String())
	}

	request = stage8FRequest(http.MethodDelete, "/api/v1/scheduled-reports/subscriptions/12", "", "10", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("delete subscription status = %d: %s", recorder.Code, recorder.Body.String())
	}

	request = stage8FRequest(http.MethodGet, "/api/v1/scheduled-reports/delivery-logs?limit=50", "", "10", false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delivery logs status = %d: %s", recorder.Code, recorder.Body.String())
	}

	request = stage8FRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/test-email",
		`{"email":"owner@example.com","frequency":"daily","project_ids":"1,2","country":"US"}`,
		"10",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || mailer.calls != 1 {
		t.Fatalf("test email status = %d calls=%d: %s", recorder.Code, mailer.calls, recorder.Body.String())
	}

	request = stage8FRequest(
		http.MethodGet,
		"/api/v1/scheduled-reports/ledger?start_date=2026-11-01&end_date=2026-11-08",
		"",
		"10",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("ledger status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var ledger map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &ledger); err != nil {
		t.Fatalf("decode ledger: %v", err)
	}
	for _, field := range []string{"items", "total", "summary"} {
		if _, ok := ledger[field]; !ok {
			t.Errorf("ledger response missing %q", field)
		}
	}

	request = stage8FRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/ledger/7:2026-11-03/resend?force=true",
		"",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("resend status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var resend map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &resend); err != nil {
		t.Fatalf("decode resend: %v", err)
	}
	for _, field := range []string{"success", "ledger_key", "delivery_log_id", "status", "message"} {
		if _, ok := resend[field]; !ok {
			t.Errorf("resend response missing %q", field)
		}
	}
	if len(store.enqueued) != 1 || store.enqueued[0].TaskType != queue.TypeDispatchOne {
		t.Fatalf("resend enqueue = %#v", store.enqueued)
	}

	request = stage8FRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/ledger/7:2026-11-03/ai-summary/regenerate",
		"",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("regenerate status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var regenerate map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &regenerate); err != nil {
		t.Fatalf("decode regenerate: %v", err)
	}
	for _, field := range []string{
		"success", "ledger_key", "delivery_log_id", "status",
		"insight_run_id", "message",
	} {
		if _, ok := regenerate[field]; !ok {
			t.Errorf("regenerate response missing %q", field)
		}
	}
	if len(store.enqueued) != 2 || store.enqueued[1].TaskType != queue.TypeGenerateDeliverySummary {
		t.Fatalf("regenerate enqueue = %#v", store.enqueued)
	}

	request = stage8FRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/trigger?frequency=weekly",
		"",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("trigger status = %d: %s", recorder.Code, recorder.Body.String())
	}

	request = stage8FRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-refresh",
		`{"target_date":"2026-11-07","backfill_days":1}`,
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("return analysis refresh status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var refresh map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &refresh); err != nil {
		t.Fatalf("decode refresh: %v", err)
	}
	for _, field := range []string{"target_date", "backfill_days", "rows_written", "projects", "note"} {
		if _, ok := refresh[field]; !ok {
			t.Errorf("refresh response missing %q", field)
		}
	}

	request = stage8FRequest(
		http.MethodPost,
		"/api/v1/internal/jobs/return-analysis-rebuild",
		"",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("return analysis rebuild status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var rebuild map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &rebuild); err != nil {
		t.Fatalf("decode rebuild: %v", err)
	}
	for _, field := range []string{"range_start", "range_end", "rows_written", "projects_touched"} {
		if _, ok := rebuild[field]; !ok {
			t.Errorf("rebuild response missing %q", field)
		}
	}
}

func TestStage8FErrorStatusMatrixAndFailClosed(t *testing.T) {
	store := stage8FDefaultStore()
	mailer := &stage8FMailer{}
	router := stage8FRouter(store, mailer)

	cases := []struct {
		name   string
		method string
		target string
		body   string
		userID string
		admin  bool
		status int
	}{
		{
			"403 non-admin resend",
			http.MethodPost,
			"/api/v1/scheduled-reports/ledger/7:2026-11-03/resend",
			"",
			"10",
			false,
			http.StatusForbidden,
		},
		{
			"403 non-admin internal rebuild",
			http.MethodPost,
			"/api/v1/internal/jobs/return-analysis-rebuild",
			"",
			"10",
			false,
			http.StatusForbidden,
		},
		{
			"400 trigger frequency",
			http.MethodPost,
			"/api/v1/scheduled-reports/trigger?frequency=hourly",
			"",
			"admin",
			true,
			http.StatusBadRequest,
		},
		{
			"404 missing subscription",
			http.MethodPut,
			"/api/v1/scheduled-reports/subscriptions/99",
			`{"enabled":false}`,
			"10",
			false,
			http.StatusNotFound,
		},
		{
			"409 already sent",
			http.MethodPost,
			"/api/v1/scheduled-reports/ledger/7:2026-11-03/resend",
			"",
			"admin",
			true,
			http.StatusConflict,
		},
		{
			"422 invalid path",
			http.MethodDelete,
			"/api/v1/scheduled-reports/subscriptions/not-a-number",
			"",
			"10",
			false,
			http.StatusUnprocessableEntity,
		},
		{
			"422 invalid create",
			http.MethodPost,
			"/api/v1/scheduled-reports/subscriptions",
			`{"frequency":"weekly","dispatch_hour":15,"dispatch_weekday":0}`,
			"10",
			false,
			http.StatusUnprocessableEntity,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if test.status == http.StatusNotFound {
				store.subscription = nil
			}
			if test.status == http.StatusConflict {
				store.resendErr = scheduled_reports.ErrAlreadySent
			}
			request := stage8FRequest(test.method, test.target, test.body, test.userID, test.admin)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}

	store.subscription = stage8FDefaultStore().subscription
	store.resendErr = nil
	missingMailerRouter := stage8FRouter(store, nil)
	request := stage8FRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/test-email",
		`{"email":"owner@example.com"}`,
		"10",
		false,
	)
	recorder := httptest.NewRecorder()
	missingMailerRouter.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing mailer status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}
}

func stage8FRouter(store *stage8FStore, mailer *stage8FMailer) chi.Router {
	router := chi.NewRouter()
	requireAPIKey := auth.RequireAPIKey(stage8FAPIKey, stage8FProxySecret, nil)
	enqueuer := &stage8FEnqueuer{store: store}
	scheduled_reports.NewRegistrar(store, enqueuer, mailer, audit.NewMockService()).
		RegisterRoutes(router, requireAPIKey)
	internal_jobs.NewRegistrar(
		&stage8FInternalJobStore{},
		&stage8FRunner{},
		audit.NewMockService(),
	).RegisterRoutes(router, requireAPIKey)
	return router
}

func stage8FDefaultStore() *stage8FStore {
	userID := 10
	email := "owner@example.com"
	weekday := 0
	return &stage8FStore{
		subscription: &scheduled_reports.Subscription{
			ID:              7,
			UserID:          &userID,
			Email:           &email,
			ProjectIDs:      "1,2",
			Country:         "US",
			Frequency:       "weekly",
			DispatchHour:    16,
			DispatchMinute:  0,
			DispatchWeekday: &weekday,
			Enabled:         true,
			CreatedAt:       "2026-11-08T10:00:00+08:00",
			UpdatedAt:       "2026-11-08T10:00:00+08:00",
		},
	}
}

func stage8FRequest(
	method string,
	target string,
	body string,
	userID string,
	isAdmin bool,
) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	request.Header.Set("X-API-Key", stage8FAPIKey)
	request.Header.Set(auth.TrustedProxySecretHeader, stage8FProxySecret)
	request.Header.Set("X-User-Id", userID)
	request.Header.Set("X-Operator", "operator-a")
	if isAdmin {
		request.Header.Set("X-Is-Admin", "true")
	}
	request.Header.Set("Content-Type", "application/json")
	return request
}

func stage8FString(value string) *string { return &value }

func stage8FInt64(value int64) *int64 { return &value }
