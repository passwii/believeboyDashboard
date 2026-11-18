package scheduled_reports

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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
		UserAccountID:   input.UserAccountID,
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

const (
	testOperatorAccountID = "9703d9eb-c1f5-4e7c-8513-313b05c3ea75"
	testOtherAccountID    = "1f7ac8fd-12de-4e9b-8b49-096d5d03d2ff"
)

func TestScheduledReportsRoutesAndAuditedWrites(t *testing.T) {
	userID := testOperatorAccountID
	weekday := 0
	email := "owner@example.com"
	subscription := &Subscription{
		ID:              7,
		UserAccountID:   &userID,
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
			request := scheduledRequest(test.method, test.target, test.body, testOperatorAccountID, "operator-a", test.name == "resend" || test.name == "regenerate" || test.name == "trigger")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}

	if store.createInput.UserAccountID == nil || *store.createInput.UserAccountID != testOperatorAccountID {
		t.Fatalf("create user_account_id = %#v, want %s", store.createInput.UserAccountID, testOperatorAccountID)
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

// BLF-1556: the list endpoint returned [] for every admin because the store
// dropped the "admin sees all" branch and the identity header is a UUID that
// never parsed as an integer. The handler must pass the account UUID through
// and leave the store free to list everything for admins.
func TestScheduledReportsSubscriptionListScope(t *testing.T) {
	subscriptions := []Subscription{{ID: 7, ProjectIDs: "1,2", Country: "US", Frequency: FrequencyDaily, Enabled: true}}
	store := &fakeScheduledReportStore{subscriptions: subscriptions}
	router := setupScheduledReportRouter(store, &fakeEnqueuer{}, &fakeMailer{}, audit.NewMockService())

	t.Run("admin lists with account scope", func(t *testing.T) {
		request := scheduledRequest(
			http.MethodGet,
			"/api/v1/scheduled-reports/subscriptions",
			"",
			testOperatorAccountID,
			"operator-a",
			true,
		)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
		}
		var response SubscriptionListResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode list: %v", err)
		}
		if response.Total != len(subscriptions) || len(response.Items) != len(subscriptions) {
			t.Fatalf("response = %#v, want %d items", response, len(subscriptions))
		}
	})

	t.Run("admin without account header lists all", func(t *testing.T) {
		request := scheduledRequest(
			http.MethodGet,
			"/api/v1/scheduled-reports/subscriptions",
			"",
			"",
			"operator-a",
			true,
		)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("non-admin uuid header is accepted", func(t *testing.T) {
		request := scheduledRequest(
			http.MethodGet,
			"/api/v1/scheduled-reports/subscriptions",
			"",
			testOperatorAccountID,
			"operator-a",
			false,
		)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("legacy integer header is rejected for non-admin", func(t *testing.T) {
		request := scheduledRequest(
			http.MethodGet,
			"/api/v1/scheduled-reports/subscriptions",
			"",
			"10",
			"operator-a",
			false,
		)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403: %s", recorder.Code, recorder.Body.String())
		}
	})
}

func TestScheduledReportsCreateStoresUserAccountID(t *testing.T) {
	store := &fakeScheduledReportStore{}
	router := setupScheduledReportRouter(store, &fakeEnqueuer{}, &fakeMailer{}, audit.NewMockService())
	request := scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/subscriptions",
		`{"email":"owner@example.com","project_ids":"1,2","country":"US","frequency":"daily"}`,
		testOperatorAccountID,
		"operator-a",
		false,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if store.createInput.UserAccountID == nil || *store.createInput.UserAccountID != testOperatorAccountID {
		t.Fatalf("create user_account_id = %#v", store.createInput.UserAccountID)
	}
}

func TestParseOptionalUserAccountID(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    string
		wantNil bool
		wantErr bool
	}{
		{name: "empty", value: "", wantNil: true},
		{name: "blank", value: "   ", wantNil: true},
		{name: "lowercase uuid", value: testOperatorAccountID, want: testOperatorAccountID},
		{name: "uppercase uuid canonicalized", value: strings.ToUpper(testOperatorAccountID), want: testOperatorAccountID},
		{name: "braced uuid", value: "{" + testOperatorAccountID + "}", want: testOperatorAccountID},
		{name: "legacy integer", value: "10", wantErr: true},
		{name: "arbitrary text", value: "not-a-uuid", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseOptionalUserAccountID(test.value)
			if test.wantErr {
				if err == nil {
					t.Fatalf("parseOptionalUserAccountID(%q) = %#v, want error", test.value, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseOptionalUserAccountID(%q) error = %v", test.value, err)
			}
			if test.wantNil {
				if got != nil {
					t.Fatalf("parseOptionalUserAccountID(%q) = %#v, want nil", test.value, got)
				}
				return
			}
			if got == nil || *got != test.want {
				t.Fatalf("parseOptionalUserAccountID(%q) = %#v, want %q", test.value, got, test.want)
			}
		})
	}
}

func TestScheduledReportsStatusMatrix(t *testing.T) {
	userID := testOperatorAccountID
	subscription := &Subscription{ID: 7, UserAccountID: &userID, Frequency: FrequencyDaily, DispatchHour: 15}
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
		{"400 bad frequency", http.MethodPost, "/api/v1/scheduled-reports/trigger?frequency=hourly", "", testOperatorAccountID, true, http.StatusBadRequest},
		{"403 non-admin resend", http.MethodPost, "/api/v1/scheduled-reports/ledger/7:2026-11-03/resend", "", testOperatorAccountID, false, http.StatusForbidden},
		{"404 update other user", http.MethodPut, "/api/v1/scheduled-reports/subscriptions/7", `{"enabled":false}`, testOtherAccountID, false, http.StatusNotFound},
		{"409 already sent", http.MethodPost, "/api/v1/scheduled-reports/ledger/7:2026-11-03/resend", "", testOperatorAccountID, true, http.StatusConflict},
		{"422 bad path", http.MethodPut, "/api/v1/scheduled-reports/subscriptions/nope", `{"enabled":false}`, testOperatorAccountID, false, http.StatusUnprocessableEntity},
		{
			"422 bad create body",
			http.MethodPost,
			"/api/v1/scheduled-reports/subscriptions",
			`{"frequency":"weekly","dispatch_hour":15,"dispatch_weekday":0}`,
			testOperatorAccountID,
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
		testOperatorAccountID,
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
		testOperatorAccountID,
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
		testOperatorAccountID,
		"admin",
		true)
	recorder = httptest.NewRecorder()
	missingRunnerRouter.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing runner status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}
}

func TestScheduledReportsIdempotentReplayAndPayloadShape(t *testing.T) {
	userID := testOperatorAccountID
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
			ID:            7,
			UserAccountID: &userID,
			Email:         &email,
			ProjectIDs:    "1,2",
			Country:       "US",
			Frequency:     FrequencyDaily,
		}},
	}
	enqueuer := &fakeEnqueuer{}
	router := setupScheduledReportRouter(store, enqueuer, &fakeMailer{}, audit.NewMockService())

	request := scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/ledger/7:2026-11-02/resend?force=true&ai_model=model-a",
		"",
		testOperatorAccountID,
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
		"skip_email",
	} {
		if _, exists := payload[field]; !exists {
			t.Errorf("payload missing %q: %#v", field, payload)
		}
	}
	if payload["triggered_by"] != "manual" || payload["report_date"] != "2026-11-02" {
		t.Fatalf("payload = %#v", payload)
	}
	if payload["skip_email"] != true {
		t.Fatalf("resend payload skip_email = %#v, want true", payload["skip_email"])
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
		testOperatorAccountID,
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

func TestScheduledReportTriggerEnqueuesSubscriptionsWithoutEmail(t *testing.T) {
	userID := testOperatorAccountID
	ownerEmail := "owner@example.com"
	store := &fakeScheduledReportStore{
		active: []Subscription{
			{ID: 7, UserAccountID: &userID, Email: &ownerEmail, ProjectIDs: "1,2", Country: "US", Frequency: FrequencyDaily},
			{ID: 8, UserAccountID: &userID, Email: nil, ProjectIDs: "*", Country: "US", Frequency: FrequencyDaily},
		},
	}
	enqueuer := &fakeEnqueuer{}
	router := setupScheduledReportRouter(store, enqueuer, &fakeMailer{}, audit.NewMockService())

	request := scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/trigger?frequency=daily",
		"",
		testOperatorAccountID,
		"admin",
		true)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("trigger status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var response TriggerReportResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode trigger response: %v", err)
	}
	if !response.Success || response.SubscriptionsAffected != 2 || response.Skipped != 0 {
		t.Fatalf("trigger response = %#v, want 2 affected and 0 skipped", response)
	}
	if len(enqueuer.requests) != 2 {
		t.Fatalf("enqueue requests = %d, want 2 (no-email subscription must still be generated)", len(enqueuer.requests))
	}
	noEmailPayload, ok := enqueuer.requests[1].Payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T", enqueuer.requests[1].Payload)
	}
	if noEmailPayload["subscription_id"] != int64(8) {
		t.Fatalf("no-email payload subscription_id = %#v", noEmailPayload["subscription_id"])
	}
	if email, ok := noEmailPayload["email"].(*string); !ok || email != nil {
		t.Fatalf("no-email payload email = %#v, want typed nil", noEmailPayload["email"])
	}
}

func TestScheduledReportResendAlwaysEnqueuesGenerationWithoutEmail(t *testing.T) {
	userID := testOperatorAccountID
	ownerEmail := "owner@example.com"
	for _, testCase := range []struct {
		name  string
		email *string
	}{
		{name: "no email", email: nil},
		{name: "with email", email: &ownerEmail},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			store := &fakeScheduledReportStore{
				subscription: &Subscription{ID: 7, UserAccountID: &userID, Frequency: FrequencyDaily},
				resendResult: ResendResult{
					DeliveryLogID:  int64Pointer(12),
					Status:         "processing",
					Message:        "queued",
					SubscriptionID: 7,
					Frequency:      FrequencyDaily,
					Email:          testCase.email,
					ProjectIDs:     "1,2",
					Country:        "US",
					ReportDate:     "2026-11-03",
				},
			}
			enqueuer := &fakeEnqueuer{}
			router := setupScheduledReportRouter(store, enqueuer, &fakeMailer{}, audit.NewMockService())
			request := scheduledRequest(
				http.MethodPost,
				"/api/v1/scheduled-reports/ledger/7:2026-11-03/resend?force=true",
				"",
				testOperatorAccountID,
				"admin",
				true)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("resend status = %d, want 200 (generation must never require an email): %s",
					recorder.Code, recorder.Body.String())
			}
			if len(enqueuer.requests) != 1 {
				t.Fatalf("enqueue requests = %d, want 1", len(enqueuer.requests))
			}
			payload, ok := enqueuer.requests[0].Payload.(map[string]any)
			if !ok {
				t.Fatalf("payload type = %T", enqueuer.requests[0].Payload)
			}
			if payload["skip_email"] != true {
				t.Fatalf("skip_email = %#v, want true: resend must never send mail", payload["skip_email"])
			}
			if logID, ok := payload["pre_existing_log_id"].(*int64); !ok || logID == nil || *logID != 12 {
				t.Fatalf("pre_existing_log_id = %#v, want pointer to 12", payload["pre_existing_log_id"])
			}
		})
	}
}

func TestScheduledReportTestEmailValidationAndFailureMessages(t *testing.T) {
	store := &fakeScheduledReportStore{}
	mailer := &fakeMailer{}
	router := setupScheduledReportRouter(store, &fakeEnqueuer{}, mailer, audit.NewMockService())

	// A filled email must pass validation and call the mailer.
	request := scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/test-email",
		`{"email":"owner@example.com"}`,
		testOperatorAccountID,
		"operator-a",
		false)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("filled email status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if len(mailer.calls) != 1 || mailer.calls[0].Email != "owner@example.com" {
		t.Fatalf("mailer calls = %#v", mailer.calls)
	}

	// Empty email must produce an actionable Chinese message, not the raw
	// English "email is required" from the task payload validator.
	request = scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/test-email",
		`{"email":""}`,
		testOperatorAccountID,
		"operator-a",
		false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty email status = %d, want 422: %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if strings.Contains(body, "email is required") {
		t.Fatalf("empty email leaked English validator text: %s", body)
	}
	if !strings.Contains(body, "测试邮件需要填写接收邮箱") {
		t.Fatalf("empty email detail = %s, want Chinese actionable message", body)
	}

	// Mailer failures are surfaced as Chinese messages; the raw provider
	// error only goes to the server log.
	mailer.calls = nil
	mailer.err = errors.New("provider rejected: 422 invalid payload")
	request = scheduledRequest(
		http.MethodPost,
		"/api/v1/scheduled-reports/test-email",
		`{"email":"owner@example.com"}`,
		testOperatorAccountID,
		"operator-a",
		false)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("mailer failure status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var response TestEmailResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode test email response: %v", err)
	}
	if response.Success {
		t.Fatalf("mailer failure response = %#v, want success=false", response)
	}
	if strings.Contains(response.Message, "provider rejected") {
		t.Fatalf("mailer failure leaked raw error: %q", response.Message)
	}
	if !strings.Contains(response.Message, "测试邮件发送失败") {
		t.Fatalf("mailer failure message = %q, want Chinese actionable message", response.Message)
	}
}

func TestScheduledReportTriggerAndBeatShareLockKey(t *testing.T) {
	if got := TriggerLockKey(FrequencyDaily); got != "scheduled-report-trigger:daily" {
		t.Fatalf("lock key = %q", got)
	}
}

func stringPointer(value string) *string { return &value }

func int64Pointer(value int64) *int64 { return &value }
