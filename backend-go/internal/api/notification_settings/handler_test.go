package notification_settings

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
)

type fakeStore struct {
	project       *Project
	projectErr    error
	projectID     string
	items         []Setting
	listProjectID string
	listErr       error
	getID         int64
	getRow        *Setting
	getErr        error
	createInput   Setting
	createRow     *Setting
	createErr     error
	updateID      int64
	updateInput   Setting
	updateRow     *Setting
	updateErr     error
	deleteID      int64
	deleteOK      bool
	deleteErr     error
	attemptKey    string
	attempt       *TestEmailAttempt
	attemptErr    error
	auditEvents   []TestEmailAudit
	auditErr      error
}

func (s *fakeStore) GetProject(_ context.Context, id string) (*Project, error) {
	s.projectID = id
	return s.project, s.projectErr
}

func (s *fakeStore) ListSettings(_ context.Context, projectID string) ([]Setting, error) {
	s.listProjectID = projectID
	return s.items, s.listErr
}

func (s *fakeStore) GetSetting(_ context.Context, id int64) (*Setting, error) {
	s.getID = id
	return s.getRow, s.getErr
}

func (s *fakeStore) CreateSetting(_ context.Context, input Setting) (*Setting, error) {
	s.createInput = input
	return s.createRow, s.createErr
}

func (s *fakeStore) UpdateSetting(_ context.Context, id int64, input Setting) (*Setting, error) {
	s.updateID = id
	s.updateInput = input
	return s.updateRow, s.updateErr
}

func (s *fakeStore) DeleteSetting(_ context.Context, id int64) (bool, error) {
	s.deleteID = id
	return s.deleteOK, s.deleteErr
}

func (s *fakeStore) FindTestEmailAttempt(
	_ context.Context,
	idempotencyKey string,
) (*TestEmailAttempt, error) {
	s.attemptKey = idempotencyKey
	return s.attempt, s.attemptErr
}

func (s *fakeStore) RecordTestEmailAudit(_ context.Context, event TestEmailAudit) error {
	s.auditEvents = append(s.auditEvents, event)
	return s.auditErr
}

type fakeMailer struct {
	configured bool
	message    mailer.Message
	result     mailer.Result
	err        error
	calls      int
}

func (m *fakeMailer) Configured() bool {
	return m.configured
}

func (m *fakeMailer) Send(
	_ context.Context,
	message mailer.Message,
) (mailer.Result, error) {
	m.calls++
	m.message = message
	return m.result, m.err
}

func TestListSettingsRequiresProjectAndChecksAccess(t *testing.T) {
	store := &fakeStore{project: &Project{ProjectOperator: strptr("operator-a")}}
	req := identityRequest(http.MethodGet, "/api/v1/notification-settings?project_id=3", nil, "operator-a")
	rec := httptest.NewRecorder()
	NewHandler(store).ListSettings(rec, req)
	if rec.Code != http.StatusOK || store.listProjectID != "3" ||
		rec.Body.String() != `{"items":[],"total":0}` {
		t.Errorf("ListSettings() = %d %s project=%q", rec.Code, rec.Body.String(), store.listProjectID)
	}

	store = &fakeStore{}
	rec = httptest.NewRecorder()
	NewHandler(store).ListSettings(rec, httptest.NewRequest(http.MethodGet, "/api/v1/notification-settings", nil))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing project status = %d, want 422", rec.Code)
	}

	store = &fakeStore{project: &Project{ProjectOperator: strptr("operator-b")}}
	rec = httptest.NewRecorder()
	NewHandler(store).ListSettings(rec, identityRequest(http.MethodGet, "/api/v1/notification-settings?project_id=3", nil, "operator-a"))
	if rec.Code != http.StatusForbidden {
		t.Errorf("denied project status = %d, want 403", rec.Code)
	}
}

func TestCreateAndFullUpdateSetting(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	store := &fakeStore{
		project:   &Project{ProjectOperator: strptr("operator-a")},
		createRow: &Setting{ID: 5, ProjectID: 3, RuleName: "daily", Frequency: "daily", Enabled: true, CreatedAt: createdAt, UpdatedAt: createdAt},
		getRow:    &Setting{ID: 5, ProjectID: 3, RuleName: "old", Frequency: "weekly", Enabled: true},
		updateRow: &Setting{
			ID: 5, ProjectID: 3, RuleName: "weekly", Frequency: "weekly", Enabled: false,
			CreatedAt: createdAt, UpdatedAt: createdAt,
		},
	}
	req := identityRequest(http.MethodPost, "/api/v1/notification-settings", strings.NewReader(
		`{"project_id":3,"rule_name":"daily","frequency":"daily","report_types":["financial"],"recipients":["a@example.com"]}`,
	), "operator-a")
	rec := httptest.NewRecorder()
	NewHandler(store).CreateSetting(rec, req)
	if rec.Code != http.StatusCreated || store.createInput.ProjectID != 3 ||
		store.createInput.Enabled != true || store.createInput.CreatedBy == nil ||
		*store.createInput.CreatedBy != 9 {
		t.Errorf("CreateSetting() = %d %s input=%#v", rec.Code, rec.Body.String(), store.createInput)
	}

	req = identityRequest(http.MethodPut, "/api/v1/notification-settings", strings.NewReader(
		`{"id":5,"rule_name":"weekly","frequency":"weekly","enabled":false}`,
	), "operator-a")
	rec = httptest.NewRecorder()
	NewHandler(store).UpdateSetting(rec, req)
	if rec.Code != http.StatusOK || store.updateID != 5 ||
		store.updateInput.RuleName != "weekly" || store.updateInput.Frequency != "weekly" ||
		store.updateInput.Enabled {
		t.Errorf("UpdateSetting() = %d %s id=%d input=%#v", rec.Code, rec.Body.String(), store.updateID, store.updateInput)
	}
	if !strings.Contains(rec.Body.String(), `"created_at":"2026-11-07T01:02:03Z"`) {
		t.Errorf("body = %s, want httpapi timestamp", rec.Body.String())
	}
}

func TestDeleteSettingChecksProjectAndReturnsNotFound(t *testing.T) {
	store := &fakeStore{
		project:  &Project{ProjectOperator: strptr("operator-a")},
		getRow:   &Setting{ID: 7, ProjectID: 3},
		deleteOK: true,
	}
	req := identityRequest(http.MethodDelete, "/api/v1/notification-settings/7", nil, "operator-a")
	req = routeParam(req, "setting_id", "7")
	rec := httptest.NewRecorder()
	NewHandler(store).DeleteSetting(rec, req)
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 || store.deleteID != 7 {
		t.Errorf("DeleteSetting() = %d %s id=%d", rec.Code, rec.Body.String(), store.deleteID)
	}

	store.getRow = nil
	rec = httptest.NewRecorder()
	NewHandler(store).DeleteSetting(rec, req)
	if rec.Code != http.StatusNotFound || rec.Body.String() != `{"detail":"Subscription not found"}` {
		t.Errorf("missing delete = %d %s", rec.Code, rec.Body.String())
	}
}

func TestRegistrarMountsRootAndFastAPISubscriptionRoutesWithAuth(t *testing.T) {
	store := &fakeStore{
		project:   &Project{ProjectOperator: strptr("operator-a")},
		createRow: &Setting{ID: 1, ProjectID: 3, RuleName: "daily", Frequency: "daily", Enabled: true},
	}
	router := chi.NewRouter()
	NewRegistrar(store).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Settings-Auth", "checked")
			next.ServeHTTP(w, r)
		})
	})
	req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions", strings.NewReader(
		`{"project_id":3,"rule_name":"daily","frequency":"daily"}`,
	), "operator-a")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated || rec.Header().Get("X-Settings-Auth") != "checked" {
		t.Errorf("registrar route = %d %s auth=%q", rec.Code, rec.Body.String(), rec.Header().Get("X-Settings-Auth"))
	}
}

func TestSettingStoreErrorsReturnInternalServerError(t *testing.T) {
	store := &fakeStore{listErr: errors.New("database down")}
	req := identityRequest(http.MethodGet, "/api/v1/notification-settings?project_id=3", nil, "operator-a")
	store.project = &Project{ProjectOperator: strptr("operator-a")}
	rec := httptest.NewRecorder()
	NewHandler(store).ListSettings(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestTestSubscriptionEmailSendsAlignedMessageAndAuditsSuccess(t *testing.T) {
	store := &fakeStore{
		project: &Project{ProjectOperator: strptr("operator-a")},
		getRow: &Setting{
			ID:          7,
			ProjectID:   3,
			RuleName:    "weekly report",
			Frequency:   "weekly",
			ReportTypes: []string{"financial"},
			Recipients:  []string{"subscription@example.com"},
			Enabled:     true,
		},
	}
	sender := &fakeMailer{
		configured: true,
		result:     mailer.Result{ID: "email_123", StatusCode: http.StatusOK},
	}
	handler := NewHandler(store, WithMailer(sender))
	req := identityRequest(
		http.MethodPost,
		"/api/v1/notification-settings/subscriptions/7/test",
		strings.NewReader(`{"test_recipients":["override@example.com"]}`),
		"operator-a",
	)
	req = routeParam(req, "subscription_id", "7")
	req.Header.Set("Idempotency-Key", "notification-test-1")
	rec := httptest.NewRecorder()

	handler.TestSubscriptionEmail(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if sender.calls != 1 {
		t.Fatalf("mailer calls = %d, want 1", sender.calls)
	}
	if sender.message.To != "override@example.com" ||
		sender.message.Subject != "BelieveBoy Dashboard · 每周运营报告配置测试" ||
		!strings.Contains(sender.message.HTML, "报告频率：每周") ||
		sender.message.IdempotencyKey != "notification-test-1" {
		t.Fatalf("mail message = %#v", sender.message)
	}
	if !strings.Contains(rec.Body.String(), `"success":true`) ||
		!strings.Contains(rec.Body.String(), `"resend_id":"email_123"`) ||
		!strings.Contains(rec.Body.String(), "测试邮件已发送到 override@example.com") {
		t.Fatalf("response body = %s", rec.Body.String())
	}
	if len(store.auditEvents) != 1 {
		t.Fatalf("audit entries = %d, want 1", len(store.auditEvents))
	}
	entry := store.auditEvents[0]
	if entry.SubscriptionID != 7 ||
		entry.ProjectID != 3 ||
		entry.Result != "success" ||
		entry.ResendID == nil || *entry.ResendID != "email_123" ||
		entry.IdempotencyKey == nil || *entry.IdempotencyKey != "notification-test-1" {
		t.Fatalf("audit entry = %#v", entry)
	}
}

func TestTestSubscriptionEmailAuthorizationAndLookupSemantics(t *testing.T) {
	t.Run("missing subscription is 404", func(t *testing.T) {
		store := &fakeStore{project: &Project{ProjectOperator: strptr("operator-a")}}
		handler := NewHandler(store, WithMailer(&fakeMailer{configured: true}))
		req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`{}`), "operator-a")
		req = routeParam(req, "subscription_id", "7")
		rec := httptest.NewRecorder()
		handler.TestSubscriptionEmail(rec, req)
		if rec.Code != http.StatusNotFound || rec.Body.String() != `{"detail":"Subscription not found"}` {
			t.Fatalf("missing subscription = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("foreign project is 403", func(t *testing.T) {
		store := &fakeStore{
			project: &Project{ProjectOperator: strptr("operator-b")},
			getRow:  &Setting{ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{"ops@example.com"}},
		}
		handler := NewHandler(store, WithMailer(&fakeMailer{configured: true}))
		req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`{}`), "operator-a")
		req = routeParam(req, "subscription_id", "7")
		rec := httptest.NewRecorder()
		handler.TestSubscriptionEmail(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("foreign project status = %d, want 403: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("invalid path and key are 422", func(t *testing.T) {
		store := &fakeStore{
			project: &Project{ProjectOperator: strptr("operator-a")},
			getRow:  &Setting{ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{"ops@example.com"}},
		}
		handler := NewHandler(store, WithMailer(&fakeMailer{configured: true}))

		req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/nope/test", strings.NewReader(`{}`), "operator-a")
		req = routeParam(req, "subscription_id", "nope")
		rec := httptest.NewRecorder()
		handler.TestSubscriptionEmail(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid id status = %d, want 422", rec.Code)
		}

		req = identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`{}`), "operator-a")
		req = routeParam(req, "subscription_id", "7")
		req.Header.Set("Idempotency-Key", strings.Repeat("x", 65))
		rec = httptest.NewRecorder()
		handler.TestSubscriptionEmail(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid key status = %d, want 422", rec.Code)
		}

		req = identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`null`), "operator-a")
		req = routeParam(req, "subscription_id", "7")
		rec = httptest.NewRecorder()
		handler.TestSubscriptionEmail(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("null body status = %d, want 422", rec.Code)
		}
	})
}

func TestTestSubscriptionEmailFailsClosedWithoutMailerAndAudits(t *testing.T) {
	store := &fakeStore{
		project: &Project{ProjectOperator: strptr("operator-a")},
		getRow:  &Setting{ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{"ops@example.com"}},
	}
	handler := NewHandler(store)
	req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`{}`), "operator-a")
	req = routeParam(req, "subscription_id", "7")
	rec := httptest.NewRecorder()

	handler.TestSubscriptionEmail(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
	if len(store.auditEvents) != 1 || store.auditEvents[0].Result != "failure" ||
		store.auditEvents[0].ErrorMessage == nil ||
		!strings.Contains(*store.auditEvents[0].ErrorMessage, "not configured") {
		t.Fatalf("audit entries = %#v", store.auditEvents)
	}
}

func TestTestSubscriptionEmailSendFailureReturnsFastAPIShapeAndAudits(t *testing.T) {
	store := &fakeStore{
		project: &Project{ProjectOperator: strptr("operator-a")},
		getRow:  &Setting{ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{"ops@example.com"}},
	}
	sender := &fakeMailer{configured: true, err: errors.New("provider unavailable")}
	handler := NewHandler(store, WithMailer(sender))
	req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`{}`), "operator-a")
	req = routeParam(req, "subscription_id", "7")
	rec := httptest.NewRecorder()

	handler.TestSubscriptionEmail(rec, req)

	if rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), `"success":false`) ||
		!strings.Contains(rec.Body.String(), "发送失败: provider unavailable") {
		t.Fatalf("send failure = %d %s", rec.Code, rec.Body.String())
	}
	if len(store.auditEvents) != 1 || store.auditEvents[0].Result != "failure" ||
		store.auditEvents[0].ErrorMessage == nil ||
		*store.auditEvents[0].ErrorMessage != "provider unavailable" {
		t.Fatalf("audit entries = %#v", store.auditEvents)
	}
}

func TestTestSubscriptionEmailWithoutRecipientsReturnsFastAPIShape(t *testing.T) {
	store := &fakeStore{
		project: &Project{ProjectOperator: strptr("operator-a")},
		getRow:  &Setting{ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{}},
	}
	sender := &fakeMailer{configured: true}
	handler := NewHandler(store, WithMailer(sender))
	req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`{}`), "operator-a")
	req = routeParam(req, "subscription_id", "7")
	rec := httptest.NewRecorder()

	handler.TestSubscriptionEmail(rec, req)

	if rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), `"success":false`) ||
		!strings.Contains(rec.Body.String(), "无收件人配置") ||
		sender.calls != 0 {
		t.Fatalf("no recipients = %d %s calls=%d", rec.Code, rec.Body.String(), sender.calls)
	}
	if len(store.auditEvents) != 1 ||
		store.auditEvents[0].Result != "failure" ||
		store.auditEvents[0].ErrorMessage == nil ||
		*store.auditEvents[0].ErrorMessage != "无收件人配置" {
		t.Fatalf("audit entries = %#v", store.auditEvents)
	}
}

func TestTestSubscriptionEmailIdempotencyReplayAndConflict(t *testing.T) {
	baseStore := func(attempt *TestEmailAttempt) *fakeStore {
		return &fakeStore{
			project: &Project{ProjectOperator: strptr("operator-a")},
			getRow:  &Setting{ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{"ops@example.com"}},
			attempt: attempt,
		}
	}
	fingerprint := testEmailFingerprint(7, 3, "ops@example.com", "daily")

	t.Run("matching success replays without sending", func(t *testing.T) {
		store := baseStore(&TestEmailAttempt{
			Fingerprint: fingerprint,
			Result:      "success",
			ResendID:    strptr("email_replayed"),
		})
		sender := &fakeMailer{configured: true}
		handler := NewHandler(store, WithMailer(sender))
		req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`{}`), "operator-a")
		req = routeParam(req, "subscription_id", "7")
		req.Header.Set("Idempotency-Key", "replay-1")
		rec := httptest.NewRecorder()

		handler.TestSubscriptionEmail(rec, req)

		if rec.Code != http.StatusOK || sender.calls != 0 ||
			!strings.Contains(rec.Body.String(), `"success":true`) ||
			!strings.Contains(rec.Body.String(), `"resend_id":"email_replayed"`) {
			t.Fatalf("replay = %d %s calls=%d", rec.Code, rec.Body.String(), sender.calls)
		}
	})

	t.Run("different payload is 409", func(t *testing.T) {
		store := baseStore(&TestEmailAttempt{
			Fingerprint: "different",
			Result:      "success",
		})
		sender := &fakeMailer{configured: true}
		handler := NewHandler(store, WithMailer(sender))
		req := identityRequest(http.MethodPost, "/api/v1/notification-settings/subscriptions/7/test", strings.NewReader(`{}`), "operator-a")
		req = routeParam(req, "subscription_id", "7")
		req.Header.Set("Idempotency-Key", "conflict-1")
		rec := httptest.NewRecorder()

		handler.TestSubscriptionEmail(rec, req)

		if rec.Code != http.StatusConflict || sender.calls != 0 {
			t.Fatalf("conflict = %d %s calls=%d", rec.Code, rec.Body.String(), sender.calls)
		}
	})
}

func identityRequest(method, path string, body *strings.Reader, operator string) *http.Request {
	var reader *strings.Reader
	if body != nil {
		reader = body
	} else {
		reader = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("X-Operator", operator)
	req.Header.Set("X-User-Id", "9")
	return req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{
		UserID: "9", Operator: operator,
	}))
}

func routeParam(req *http.Request, name, value string) *http.Request {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add(name, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, ctx))
}

func strptr(value string) *string {
	return &value
}
