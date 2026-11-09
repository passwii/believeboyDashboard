package scheduled_reports

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
)

type fakeScheduledReportStore struct {
	subscriptions    []Subscription
	subscription     *Subscription
	deliveryLogs     DeliveryLogListResponse
	ledger           LedgerListResponse
	resendResult     ResendResult
	resendErr        error
	regenerateResult RegenerateResult
	regenerateErr    error
	idempotency      *IdempotencyRecord
	projectErr       error
	active           []Subscription
	createInput      SubscriptionCreateInput
	updatePatch      SubscriptionPatch
	ledgerQuery      LedgerQuery
	triggerLock      string
	runInTxCalls     int
}

func (store *fakeScheduledReportStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	store.runInTxCalls++
	return fn(ctx, nil, store)
}

func (store *fakeScheduledReportStore) VerifyProjectAccess(
	_ context.Context,
	_ int64,
	_ string,
	_ bool,
) error {
	return store.projectErr
}

func (store *fakeScheduledReportStore) ListSubscriptions(
	context.Context,
	Scope,
	*string,
) ([]Subscription, error) {
	return store.subscriptions, nil
}

func (store *fakeScheduledReportStore) GetSubscription(
	context.Context,
	int64,
) (*Subscription, error) {
	return store.subscription, nil
}

func (store *fakeScheduledReportStore) CreateSubscription(
	_ context.Context,
	input SubscriptionCreateInput,
) (*Subscription, error) {
	store.createInput = input
	created := Subscription{
		ID:              11,
		UserID:          input.UserID,
		Email:           input.Email,
		ProjectIDs:      input.ProjectIDs,
		Country:         input.Country,
		Frequency:       input.Frequency,
		DispatchHour:    input.DispatchHour,
		DispatchMinute:  input.DispatchMinute,
		DispatchWeekday: input.DispatchWeekday,
		DispatchDay:     input.DispatchDay,
		AIModel:         input.AIModel,
		Enabled:         true,
		CreatedAt:       "2026-11-08T10:00:00+08:00",
		UpdatedAt:       "2026-11-08T10:00:00+08:00",
	}
	return &created, nil
}

func (store *fakeScheduledReportStore) UpdateSubscription(
	_ context.Context,
	id int64,
	patch SubscriptionPatch,
) (*Subscription, error) {
	store.updatePatch = patch
	if store.subscription == nil || store.subscription.ID != id {
		return nil, nil
	}
	updated := *store.subscription
	if patch.Enabled.Set && patch.Enabled.Value != nil {
		updated.Enabled = *patch.Enabled.Value
	}
	return &updated, nil
}

func (store *fakeScheduledReportStore) DeleteSubscription(context.Context, int64) (bool, error) {
	return store.subscription != nil, nil
}

func (store *fakeScheduledReportStore) ListDeliveryLogs(
	context.Context,
	Scope,
	*string,
	int,
	int,
) (DeliveryLogListResponse, error) {
	return store.deliveryLogs, nil
}

func (store *fakeScheduledReportStore) RefreshLedger(
	_ context.Context,
	query LedgerQuery,
) (LedgerListResponse, error) {
	store.ledgerQuery = query
	return store.ledger, nil
}

func (store *fakeScheduledReportStore) PrepareResend(
	context.Context,
	ResendRequest,
) (ResendResult, error) {
	return store.resendResult, store.resendErr
}

func (store *fakeScheduledReportStore) PrepareAISummaryRegeneration(
	context.Context,
	RegenerateRequest,
) (RegenerateResult, error) {
	return store.regenerateResult, store.regenerateErr
}

func (store *fakeScheduledReportStore) ListActiveSubscriptions(
	context.Context,
	string,
) ([]Subscription, error) {
	return store.active, nil
}

func (store *fakeScheduledReportStore) AcquireTriggerLock(
	_ context.Context,
	frequency string,
) error {
	store.triggerLock = frequency
	return nil
}

func (store *fakeScheduledReportStore) FindIdempotencyRecord(
	context.Context,
	string,
	string,
) (*IdempotencyRecord, error) {
	return store.idempotency, nil
}

type fakeEnqueuer struct {
	requests []EnqueueRequest
	err      error
}

func (enqueuer *fakeEnqueuer) Enqueue(
	_ context.Context,
	request EnqueueRequest,
) (string, error) {
	enqueuer.requests = append(enqueuer.requests, request)
	if enqueuer.err != nil {
		return "", enqueuer.err
	}
	return "task-id", nil
}

type fakeMailer struct {
	calls    []TestEmailMessage
	resendID *string
	err      error
}

func (mailer *fakeMailer) SendTestReport(
	_ context.Context,
	message TestEmailMessage,
) (*string, error) {
	mailer.calls = append(mailer.calls, message)
	return mailer.resendID, mailer.err
}

func setupScheduledReportRouter(
	store Store,
	enqueuer Enqueuer,
	mailer Mailer,
	auditor audit.Service,
) http.Handler {
	router := chi.NewRouter()
	NewRegistrar(store, enqueuer, mailer, auditor).RegisterRoutes(
		router,
		func(next http.Handler) http.Handler { return next },
	)
	return router
}

func scheduledRequest(
	method string,
	target string,
	body string,
	userID string,
	operator string,
	isAdmin bool,
) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		UserID:   userID,
		Operator: operator,
		IsAdmin:  isAdmin,
	}))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestScheduledReportsRoutesAndAuditedWrites(t *testing.T) {
	userID := 10
	weekday := 0
	email := "owner@example.com"
	subscription := &Subscription{
		ID:              7,
		UserID:          &userID,
		Email:           &email,
		ProjectIDs:      "1,2",
		Country:         "US",
		Frequency:       FrequencyWeekly,
		DispatchHour:    16,
		DispatchMinute:  0,
		DispatchWeekday: &weekday,
		Enabled:         true,
		CreatedAt:       "2026-11-08T10:00:00+08:00",
		UpdatedAt:       "2026-11-08T10:00:00+08:00",
	}
	store := &fakeScheduledReportStore{
		subscriptions: []Subscription{*subscription},
		subscription:  subscription,
		deliveryLogs: DeliveryLogListResponse{
			Items: []DeliveryLog{{ID: 3, SubscriptionID: 7, Status: StatusSent, Stage: "done", AISummaryStatus: "done", CreatedAt: "2026-11-08T10:00:00+08:00"}},
			Total: 1,
		},
		ledger: LedgerListResponse{
			Items:   []LedgerItem{{ID: 9, LedgerKey: "7:2026-11-03", Status: StatusSent, AISummaryStatus: "done"}},
			Total:   1,
			Summary: LedgerSummary{Expected: 1, Sent: 1},
		},
		resendResult: ResendResult{
			DeliveryLogID:  int64Pointer(12),
			Status:         "processing",
			Message:        "queued",
			SubscriptionID: 7,
			Frequency:      FrequencyWeekly,
			Email:          stringPointer("owner@example.com"),
			ProjectIDs:     "1,2",
			Country:        "US",
			ReportDate:     "2026-11-03",
		},
		regenerateResult: RegenerateResult{
			DeliveryLogID: int64Pointer(12),
			Status:        "generating",
			Message:       "started",
		},
		active: []Subscription{*subscription},
	}
	enqueuer := &fakeEnqueuer{}
	mailer := &fakeMailer{resendID: stringPointer("mail-1")}
	auditor := audit.NewMockService()
	router := setupScheduledReportRouter(store, enqueuer, mailer, auditor)

	tests := []struct {
		name   string
		method string
		target string
		body   string
		status int
	}{
		{"list", http.MethodGet, "/api/v1/scheduled-reports/subscriptions", "", http.StatusOK},
		{
			"create",
			http.MethodPost,
			"/api/v1/scheduled-reports/subscriptions",
			`{"email":"owner@example.com","project_ids":"1,2","country":"US","frequency":"weekly","dispatch_hour":16,"dispatch_weekday":0}`,
			http.StatusCreated,
		},
		{
			"update",
			http.MethodPut,
			"/api/v1/scheduled-reports/subscriptions/7",
			`{"enabled":false}`,
			http.StatusOK,
		},
		{"delete", http.MethodDelete, "/api/v1/scheduled-reports/subscriptions/7", "", http.StatusNoContent},
		{"delivery logs", http.MethodGet, "/api/v1/scheduled-reports/delivery-logs?limit=50&offset=0", "", http.StatusOK},
		{
			"test email",
			http.MethodPost,
			"/api/v1/scheduled-reports/test-email",
			`{"email":"owner@example.com","frequency":"daily","project_ids":"1,2","country":"US"}`,
			http.StatusOK,
		},
		{
			"ledger",
			http.MethodGet,
			"/api/v1/scheduled-reports/ledger?start_date=2026-11-01&end_date=2026-11-08&frequency=all&status_filter=all&limit=100",
			"",
			http.StatusOK,
		},
		{
			"resend",
			http.MethodPost,
			"/api/v1/scheduled-reports/ledger/7:2026-11-03/resend?force=true",
			"",
			http.StatusOK,
		},
		{
			"regenerate",
			http.MethodPost,
			"/api/v1/scheduled-reports/ledger/7:2026-11-03/ai-summary/regenerate",
			"",
			http.StatusOK,
		},
		{
			"trigger",
			http.MethodPost,
			"/api/v1/scheduled-reports/trigger?frequency=weekly",
			"",
			http.StatusOK,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := scheduledRequest(test.method, test.target, test.body, "10", "operator-a", test.name == "resend" || test.name == "regenerate" || test.name == "trigger")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}

	if store.createInput.UserID == nil || *store.createInput.UserID != 10 {
		t.Fatalf("create user_id = %#v, want 10", store.createInput.UserID)
	}
	if len(auditor.Entries) != 6 {
		t.Fatalf("audit entries = %d, want create/update/delete/resend/regenerate/trigger writes", len(auditor.Entries))
	}
	if len(enqueuer.requests) != 3 {
		t.Fatalf("enqueue requests = %d, want resend/regenerate/trigger", len(enqueuer.requests))
	}
	wantTaskTypes := []string{
		queue.TypeDispatchOne,
		queue.TypeGenerateDeliverySummary,
		queue.TypeDispatchOne,
	}
	for index, want := range wantTaskTypes {
		if enqueuer.requests[index].TaskType != want {
			t.Errorf("task[%d] = %q, want %q", index, enqueuer.requests[index].TaskType, want)
		}
	}
	if len(mailer.calls) != 1 || mailer.calls[0].ProjectIDs != "1,2" {
		t.Fatalf("mailer calls = %#v", mailer.calls)
	}
}

func TestScheduledReportsStatusMatrix(t *testing.T) {
	userID := 10
	subscription := &Subscription{ID: 7, UserID: &userID, Frequency: FrequencyDaily, DispatchHour: 15}
	store := &fakeScheduledReportStore{
		subscription: subscription,
		resendErr:    ErrAlreadySent,
		active:       []Subscription{*subscription},
	}
	enqueuer := &fakeEnqueuer{}
	router := setupScheduledReportRouter(store, enqueuer, &fakeMailer{}, audit.NewMockService())

	cases := []struct {
		name   string
		method string
		target string
		body   string
		userID string
		admin  bool
		status int
	}{
		{"400 bad frequency", http.MethodPost, "/api/v1/scheduled-reports/trigger?frequency=hourly", "", "10", true, http.StatusBadRequest},
		{"403 non-admin resend", http.MethodPost, "/api/v1/scheduled-reports/ledger/7:2026-11-03/resend", "", "10", false, http.StatusForbidden},
		{"404 update other user", http.MethodPut, "/api/v1/scheduled-reports/subscriptions/7", `{"enabled":false}`, "99", false, http.StatusNotFound},
		{"409 already sent", http.MethodPost, "/api/v1/scheduled-reports/ledger/7:2026-11-03/resend", "", "10", true, http.StatusConflict},
		{"422 bad path", http.MethodPut, "/api/v1/scheduled-reports/subscriptions/nope", `{"enabled":false}`, "10", false, http.StatusUnprocessableEntity},
		{
			"422 bad create body",
			http.MethodPost,
			"/api/v1/scheduled-reports/subscriptions",
			`{"frequency":"weekly","dispatch_hour":15,"dispatch_weekday":0}`,
			"10",
			false,
			http.StatusUnprocessableEntity,
		},
		{
			"403 no user",
			http.MethodGet,
			"/api/v1/scheduled-reports/subscriptions",
			"",
			"",
			false,
			http.StatusForbidden,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			request := scheduledRequest(test.method, test.target, test.body, test.userID, "operator-a", test.admin)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}

	missingMailerRouter := setupScheduledReportRouter(store, enqueuer, nil, audit.NewMockService())
	request := scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/test-email",
		`{"email":"owner@example.com"}`,
		"10",
		"operator-a",
		false)
	recorder := httptest.NewRecorder()
	missingMailerRouter.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing mailer status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}

	store.resendErr = nil
	store.resendResult = ResendResult{
		DeliveryLogID:  int64Pointer(12),
		Status:         "processing",
		Message:        "queued",
		SubscriptionID: 7,
		Frequency:      FrequencyDaily,
		Email:          stringPointer("owner@example.com"),
		ProjectIDs:     "1,2",
		Country:        "US",
		ReportDate:     "2026-11-03",
	}
	enqueuer.err = errors.New("redis down")
	request = scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/ledger/7:2026-11-03/resend",
		"",
		"10",
		"admin",
		true)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("queue failure status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}

	enqueuer.err = nil
	missingRunnerRouter := chi.NewRouter()
	NewRegistrarWithRunner(
		store,
		enqueuer,
		nil,
		&fakeMailer{},
		audit.NewMockService(),
	).RegisterRoutes(missingRunnerRouter, func(next http.Handler) http.Handler { return next })
	request = scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/ledger/7:2026-11-03/resend",
		"",
		"10",
		"admin",
		true)
	recorder = httptest.NewRecorder()
	missingRunnerRouter.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing runner status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}
}

func TestScheduledReportsIdempotentReplayAndPayloadShape(t *testing.T) {
	userID := 10
	email := "owner@example.com"
	store := &fakeScheduledReportStore{
		resendResult: ResendResult{
			DeliveryLogID:  int64Pointer(12),
			Status:         "processing",
			Message:        "queued",
			SubscriptionID: 7,
			Frequency:      FrequencyMonthly,
			Email:          &email,
			ProjectIDs:     "1,2",
			Country:        "US",
			ReportDate:     "2026-11-02",
			AIModel:        stringPointer("model-a"),
		},
		active: []Subscription{{
			ID:         7,
			UserID:     &userID,
			Email:      &email,
			ProjectIDs: "1,2",
			Country:    "US",
			Frequency:  FrequencyDaily,
		}},
	}
	enqueuer := &fakeEnqueuer{}
	router := setupScheduledReportRouter(store, enqueuer, &fakeMailer{}, audit.NewMockService())

	request := scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/ledger/7:2026-11-02/resend?force=true&ai_model=model-a",
		"",
		"10",
		"admin",
		true)
	request.Header.Set("Idempotency-Key", "resend-1")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("resend status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if len(enqueuer.requests) != 1 {
		t.Fatalf("enqueue requests = %d, want 1", len(enqueuer.requests))
	}
	payload, ok := enqueuer.requests[0].Payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T", enqueuer.requests[0].Payload)
	}
	for _, field := range []string{
		"subscription_id", "email", "project_ids", "country", "frequency",
		"ai_model", "use_cache", "triggered_by", "report_date", "pre_existing_log_id",
	} {
		if _, exists := payload[field]; !exists {
			t.Errorf("payload missing %q: %#v", field, payload)
		}
	}
	if payload["triggered_by"] != "manual" || payload["report_date"] != "2026-11-02" {
		t.Fatalf("payload = %#v", payload)
	}

	var replayResponse LedgerResendResponse
	body, _ := json.Marshal(LedgerResendResponse{
		Success:       true,
		LedgerKey:     "7:2026-11-02",
		DeliveryLogID: int64Pointer(12),
		Status:        "processing",
		Message:       "queued",
	})
	store.idempotency = &IdempotencyRecord{
		Fingerprint: requestFingerprint(map[string]any{
			"ledger_key": "7:2026-11-02",
			"force":      true,
			"ai_model":   stringPointer("model-a"),
		}),
		Response: body,
	}
	enqueuer.requests = nil
	request = scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/ledger/7:2026-11-02/resend?force=true&ai_model=model-a",
		"",
		"10",
		"admin",
		true)
	request.Header.Set("Idempotency-Key", "resend-1")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("replay status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &replayResponse); err != nil {
		t.Fatalf("decode replay: %v", err)
	}
	if replayResponse.DeliveryLogID == nil || *replayResponse.DeliveryLogID != 12 {
		t.Fatalf("replay = %#v", replayResponse)
	}
	if len(enqueuer.requests) != 0 {
		t.Fatalf("idempotent replay enqueued %d tasks", len(enqueuer.requests))
	}

	store.idempotency = &IdempotencyRecord{
		Fingerprint: "different",
		Response:    body,
	}
	request.Header.Set("Idempotency-Key", "resend-1")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, want 409: %s", recorder.Code, recorder.Body.String())
	}
}

func TestScheduledReportTriggerAndBeatShareLockKey(t *testing.T) {
	if got := TriggerLockKey(FrequencyDaily); got != "scheduled-report-trigger:daily" {
		t.Fatalf("lock key = %q", got)
	}
}

func stringPointer(value string) *string { return &value }

func int64Pointer(value int64) *int64 { return &value }
