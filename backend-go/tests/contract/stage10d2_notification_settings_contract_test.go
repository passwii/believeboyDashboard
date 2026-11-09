package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notification_settings"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
)

const (
	stage10D2APIKey      = "stage10d2-api-key"
	stage10D2ProxySecret = "stage10d2-proxy-secret"
	stage10D2TestPath    = "/api/v1/notification-settings/subscriptions/7/test"
)

type stage10D2Store struct {
	project       *notification_settings.Project
	setting       *notification_settings.Setting
	attempt       *notification_settings.TestEmailAttempt
	projectErr    error
	getErr        error
	attemptErr    error
	requestedKey  string
	requestedPrj  string
	requestedItem int64
	auditEvents   []notification_settings.TestEmailAudit
	auditErr      error
}

func (s *stage10D2Store) GetProject(
	_ context.Context,
	projectID string,
) (*notification_settings.Project, error) {
	s.requestedPrj = projectID
	return s.project, s.projectErr
}

func (*stage10D2Store) ListSettings(
	context.Context,
	string,
) ([]notification_settings.Setting, error) {
	return []notification_settings.Setting{}, nil
}

func (s *stage10D2Store) GetSetting(
	_ context.Context,
	id int64,
) (*notification_settings.Setting, error) {
	s.requestedItem = id
	return s.setting, s.getErr
}

func (*stage10D2Store) CreateSetting(
	context.Context,
	notification_settings.Setting,
) (*notification_settings.Setting, error) {
	return nil, nil
}

func (*stage10D2Store) UpdateSetting(
	context.Context,
	int64,
	notification_settings.Setting,
) (*notification_settings.Setting, error) {
	return nil, nil
}

func (*stage10D2Store) DeleteSetting(context.Context, int64) (bool, error) {
	return false, nil
}

func (s *stage10D2Store) FindTestEmailAttempt(
	_ context.Context,
	idempotencyKey string,
) (*notification_settings.TestEmailAttempt, error) {
	s.requestedKey = idempotencyKey
	return s.attempt, s.attemptErr
}

func (s *stage10D2Store) RecordTestEmailAudit(
	_ context.Context,
	event notification_settings.TestEmailAudit,
) error {
	s.auditEvents = append(s.auditEvents, event)
	return s.auditErr
}

type stage10D2Mailer struct {
	configured bool
	calls      int
	message    mailer.Message
	result     mailer.Result
	err        error
}

func (m *stage10D2Mailer) Configured() bool {
	return m.configured
}

func (m *stage10D2Mailer) Send(
	_ context.Context,
	message mailer.Message,
) (mailer.Result, error) {
	m.calls++
	m.message = message
	return m.result, m.err
}

func stage10D2Router(
	store notification_settings.Store,
	sender notification_settings.Mailer,
) *chi.Mux {
	router := chi.NewRouter()
	options := []notification_settings.Option{notification_settings.WithMailer(sender)}
	notification_settings.NewRegistrar(store, options...).RegisterRoutes(
		router,
		auth.RequireAPIKey(stage10D2APIKey, stage10D2ProxySecret, nil),
	)
	return router
}

func stage10D2Request(
	router http.Handler,
	method string,
	path string,
	body string,
	authenticated bool,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	if authenticated {
		request.Header.Set("X-API-Key", stage10D2APIKey)
		request.Header.Set(auth.TrustedProxySecretHeader, stage10D2ProxySecret)
		request.Header.Set("X-Operator", "operator-a")
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestStage10D2NotificationSettingsRouteInventory(t *testing.T) {
	router := stage10D2Router(&stage10D2Store{}, &stage10D2Mailer{})
	routes := make(map[string]struct{})
	err := chi.Walk(router, func(
		method string,
		route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		routes[method+" "+route] = struct{}{}
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}

	for _, route := range []string{
		"GET /api/v1/notification-settings/subscriptions",
		"POST /api/v1/notification-settings/subscriptions",
		"PUT /api/v1/notification-settings/subscriptions/{subscription_id}",
		"DELETE /api/v1/notification-settings/subscriptions/{subscription_id}",
		"POST /api/v1/notification-settings/subscriptions/{subscription_id}/test",
	} {
		if _, ok := routes[route]; !ok {
			t.Errorf("missing route %s", route)
		}
	}
}

func TestStage10D2NotificationSettingsRequiresAPIKey(t *testing.T) {
	router := stage10D2Router(&stage10D2Store{}, &stage10D2Mailer{})
	response := stage10D2Request(router, http.MethodPost, stage10D2TestPath, `{}`, false)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", response.Code, response.Body.String())
	}
}

func TestStage10D2NotificationSettingsTestEmailSuccess(t *testing.T) {
	store := &stage10D2Store{
		project: &notification_settings.Project{ProjectOperator: stage10D2StringPointer("operator-a")},
		setting: &notification_settings.Setting{
			ID:          7,
			ProjectID:   3,
			RuleName:    "daily report",
			Frequency:   "daily",
			ReportTypes: []string{"daily_report"},
			Recipients:  []string{"owner@example.com"},
			Enabled:     true,
		},
	}
	sender := &stage10D2Mailer{
		configured: true,
		result:     mailer.Result{ID: "email_123", StatusCode: http.StatusOK},
	}
	router := stage10D2Router(store, sender)
	request := httptest.NewRequest(
		http.MethodPost,
		stage10D2TestPath,
		strings.NewReader(`{"test_recipients":["owner@example.com"]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-API-Key", stage10D2APIKey)
	request.Header.Set(auth.TrustedProxySecretHeader, stage10D2ProxySecret)
	request.Header.Set("X-Operator", "operator-a")
	request.Header.Set("Idempotency-Key", "stage10d2-test-1")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var body notification_settings.TestEmailResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !body.Success || body.ResendID == nil || *body.ResendID != "email_123" {
		t.Fatalf("response body = %#v", body)
	}
	if sender.calls != 1 ||
		sender.message.To != "owner@example.com" ||
		sender.message.IdempotencyKey != "stage10d2-test-1" {
		t.Fatalf("mailer calls=%d message=%#v", sender.calls, sender.message)
	}
	if len(store.auditEvents) != 1 ||
		store.auditEvents[0].Result != "success" ||
		store.auditEvents[0].IdempotencyKey == nil ||
		*store.auditEvents[0].IdempotencyKey != "stage10d2-test-1" {
		t.Fatalf("audit entries = %#v", store.auditEvents)
	}
}

func TestStage10D2NotificationSettingsTestEmailStatuses(t *testing.T) {
	tests := []struct {
		name          string
		store         *stage10D2Store
		sender        *stage10D2Mailer
		path          string
		body          string
		want          int
		wantMailCalls int
	}{
		{
			name: "404 missing subscription",
			store: &stage10D2Store{
				project: &notification_settings.Project{ProjectOperator: stage10D2StringPointer("operator-a")},
			},
			sender: &stage10D2Mailer{configured: true},
			path:   stage10D2TestPath,
			body:   `{}`,
			want:   http.StatusNotFound,
		},
		{
			name: "403 foreign project",
			store: &stage10D2Store{
				project: &notification_settings.Project{ProjectOperator: stage10D2StringPointer("operator-b")},
				setting: &notification_settings.Setting{
					ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{"owner@example.com"},
				},
			},
			sender: &stage10D2Mailer{configured: true},
			path:   stage10D2TestPath,
			body:   `{}`,
			want:   http.StatusForbidden,
		},
		{
			name: "422 invalid subscription id",
			store: &stage10D2Store{
				project: &notification_settings.Project{ProjectOperator: stage10D2StringPointer("operator-a")},
			},
			sender: &stage10D2Mailer{configured: true},
			path:   "/api/v1/notification-settings/subscriptions/nope/test",
			body:   `{}`,
			want:   http.StatusUnprocessableEntity,
		},
		{
			name: "503 mailer absent",
			store: &stage10D2Store{
				project: &notification_settings.Project{ProjectOperator: stage10D2StringPointer("operator-a")},
				setting: &notification_settings.Setting{
					ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{"owner@example.com"},
				},
			},
			sender: nil,
			path:   stage10D2TestPath,
			body:   `{}`,
			want:   http.StatusServiceUnavailable,
		},
		{
			name: "503 mailer unconfigured",
			store: &stage10D2Store{
				project: &notification_settings.Project{ProjectOperator: stage10D2StringPointer("operator-a")},
				setting: &notification_settings.Setting{
					ID: 7, ProjectID: 3, Frequency: "daily", Recipients: []string{"owner@example.com"},
				},
			},
			sender: &stage10D2Mailer{configured: false},
			path:   stage10D2TestPath,
			body:   `{}`,
			want:   http.StatusServiceUnavailable,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var sender notification_settings.Mailer
			if test.sender != nil {
				sender = test.sender
			}
			router := stage10D2Router(test.store, sender)
			response := stage10D2Request(router, http.MethodPost, test.path, test.body, true)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
			if test.sender != nil && test.sender.calls != test.wantMailCalls {
				t.Fatalf("mailer calls = %d, want %d", test.sender.calls, test.wantMailCalls)
			}
		})
	}
}

func stage10D2StringPointer(value string) *string {
	return &value
}
