package contract

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notification_settings"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notifications"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestStage1CWriteRoutesExposeFastAPIContracts(t *testing.T) {
	timestamp := time.Date(2026, 11, 7, 1, 2, 3, 123000000, time.UTC)
	exchangeStore := &stage1CExchangeStore{
		current: &exchange_rates.ExchangeRate{
			ID: 12, Currency: "USD", YearMonth: "2026-09", Rate: 7,
			NoteImages: []map[string]any{}, CreatedAt: timestamp, UpdatedAt: timestamp,
		},
	}
	notificationStore := &stage1CNotificationStore{
		item: &notifications.Notification{
			ID: 6, UserID: 17, Type: "alert", Title: "threshold reached",
			Data: json.RawMessage(`{"project_id":3}`), Read: true,
			ReadAt: &timestamp, CreatedAt: timestamp,
		},
	}
	alertStore := &stage1CAlertStore{
		project: &alerts.Project{ProjectOperator: stage1CString("operator-a")},
		rule: alerts.Rule{
			ID: 8, Name: "high ACOS", ProjectID: 3, Country: "US", Metric: "acos",
			TriggerType: "threshold", Condition: "above", Threshold: 0.25,
			WindowDays: 7, Severity: "warning", NotificationChannels: "in_app",
			IsActive: true, CreatedBy: "operator-a", CreatedAt: timestamp, UpdatedAt: timestamp,
		},
		event: alerts.Event{
			ID: 9, RuleID: 8, ProjectID: 3, Metric: "acos", CurrentValue: 0.3,
			BaselineValue: 0.2, DeviationPct: 50, Severity: "warning",
			Message: "threshold reached", Status: "active", TriggeredAt: timestamp,
		},
	}
	settingsStore := &stage1CSettingsStore{
		project: &notification_settings.Project{ProjectOperator: stage1CString("operator-a")},
		setting: notification_settings.Setting{
			ID: 4, ProjectID: 3, RuleName: "daily", Frequency: "daily",
			ReportTypes: []string{"financial"}, Recipients: []string{"ops@example.com"},
			Enabled: true, CreatedBy: stage1CInt64(17), CreatedAt: timestamp, UpdatedAt: timestamp,
		},
	}

	router := chi.NewRouter()
	exchange_rates.NewHandler(exchangeStore).RegisterWriteRoutes(router, stage1CPassthrough)
	notifications.NewHandler(notificationStore).RegisterWriteRoutes(router, stage1CPassthrough)
	alerts.NewHandler(alertStore).RegisterWriteRoutes(router, stage1CPassthrough)
	notification_settings.NewRegistrar(settingsStore).RegisterRoutes(router, stage1CPassthrough)

	tests := []struct {
		name     string
		method   string
		path     string
		body     string
		operator string
		userID   string
		status   int
		keys     []string
		noBody   bool
	}{
		{
			name: "exchange rate create", method: http.MethodPost, path: "/api/v1/exchange-rates",
			body:   `{"currency":"EUR","year_month":"2026-10","rate":1.1,"description":"October","note_images":[]}`,
			status: http.StatusCreated,
			keys:   []string{"id", "currency", "year_month", "rate", "description", "note_images", "created_at", "updated_at"},
		},
		{
			name: "exchange rate update", method: http.MethodPut, path: "/api/v1/exchange-rates/12",
			body: `{"rate":7.2}`, status: http.StatusOK,
			keys: []string{"id", "currency", "year_month", "rate", "created_at", "updated_at"},
		},
		{
			name: "exchange rate delete", method: http.MethodDelete, path: "/api/v1/exchange-rates/12",
			status: http.StatusNoContent, noBody: true,
		},
		{
			name: "notification mark read", method: http.MethodPost, path: "/api/v1/notifications/6/read",
			userID: "17", status: http.StatusOK,
			keys: []string{"id", "user_id", "type", "title", "data", "read", "read_at", "created_at"},
		},
		{
			name: "notification mark all read", method: http.MethodPost, path: "/api/v1/notifications/mark-all-read",
			userID: "17", status: http.StatusOK, keys: []string{"count"},
		},
		{
			name: "notification delete", method: http.MethodDelete, path: "/api/v1/notifications/6",
			userID: "17", status: http.StatusNoContent, noBody: true,
		},
		{
			name: "alert rule create", method: http.MethodPost, path: "/api/v1/alerts/rules",
			operator: "operator-a",
			body:     `{"name":"high ACOS","project_id":3,"metric":"acos","condition":"above","threshold":0.25}`,
			status:   http.StatusCreated,
			keys:     []string{"id", "name", "project_id", "country", "metric", "trigger_type", "condition", "threshold", "created_at", "updated_at"},
		},
		{
			name: "alert rule update", method: http.MethodPatch, path: "/api/v1/alerts/rules/8",
			operator: "operator-a", body: `{"is_active":false}`, status: http.StatusOK,
			keys: []string{"id", "name", "project_id", "is_active", "created_at", "updated_at"},
		},
		{
			name: "alert rule delete", method: http.MethodDelete, path: "/api/v1/alerts/rules/8",
			operator: "operator-a", status: http.StatusNoContent, noBody: true,
		},
		{
			name: "alert acknowledge", method: http.MethodPost, path: "/api/v1/alerts/events/9/acknowledge",
			operator: "operator-a", status: http.StatusOK,
			keys: []string{"id", "rule_id", "project_id", "status", "triggered_at", "acknowledged_at", "acknowledged_by"},
		},
		{
			name: "alert resolve", method: http.MethodPost, path: "/api/v1/alerts/events/9/resolve",
			operator: "operator-a", status: http.StatusOK,
			keys: []string{"id", "rule_id", "project_id", "status", "triggered_at"},
		},
		{
			name: "notification setting list", method: http.MethodGet,
			path: "/api/v1/notification-settings?project_id=3", operator: "operator-a",
			status: http.StatusOK, keys: []string{"items", "total"},
		},
		{
			name: "notification setting create", method: http.MethodPost,
			path:     "/api/v1/notification-settings",
			operator: "operator-a",
			body:     `{"project_id":3,"rule_name":"daily","frequency":"daily"}`,
			status:   http.StatusCreated,
			keys:     []string{"id", "project_id", "rule_name", "frequency", "report_types", "recipients", "enabled", "created_by", "created_at", "updated_at"},
		},
		{
			name: "notification setting update", method: http.MethodPut,
			path:     "/api/v1/notification-settings",
			operator: "operator-a", body: `{"id":4,"enabled":false}`,
			status: http.StatusOK,
			keys:   []string{"id", "project_id", "rule_name", "frequency", "enabled", "created_at", "updated_at"},
		},
		{
			name: "notification setting delete", method: http.MethodDelete,
			path: "/api/v1/notification-settings/4", operator: "operator-a",
			status: http.StatusNoContent, noBody: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
			request.Header.Set("X-Operator", test.operator)
			request.Header.Set("X-User-Id", test.userID)
			request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
				UserID: test.userID, Operator: test.operator,
			}))
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)

			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d; body = %s", recorder.Code, test.status, recorder.Body.String())
			}
			if test.noBody {
				if recorder.Body.Len() != 0 {
					t.Errorf("body = %s, want empty", recorder.Body.String())
				}
				return
			}
			assertStage1CKeys(t, recorder, test.keys)
		})
	}
}

func assertStage1CKeys(t *testing.T, recorder *httptest.ResponseRecorder, keys []string) {
	t.Helper()
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response JSON: %v; body = %s", err, recorder.Body.String())
	}
	for _, key := range keys {
		if _, ok := response[key]; !ok {
			t.Errorf("response missing snake_case key %q: %s", key, recorder.Body.String())
		}
	}
}

func stage1CPassthrough(next http.Handler) http.Handler { return next }

func stage1CString(value string) *string { return &value }
func stage1CInt64(value int64) *int64    { return &value }

type stage1CExchangeStore struct {
	exchange_rates.Store
	current *exchange_rates.ExchangeRate
}

func (s *stage1CExchangeStore) Resolve(context.Context, string, string) (*exchange_rates.ExchangeRate, error) {
	return nil, nil
}
func (s *stage1CExchangeStore) Get(context.Context, int64) (*exchange_rates.ExchangeRate, error) {
	return s.current, nil
}
func (s *stage1CExchangeStore) Insert(_ context.Context, value exchange_rates.ExchangeRate) (*exchange_rates.ExchangeRate, error) {
	value.ID = 13
	value.CreatedAt = time.Date(2026, 11, 7, 1, 2, 3, 123000000, time.UTC)
	value.UpdatedAt = value.CreatedAt
	return &value, nil
}
func (s *stage1CExchangeStore) Update(_ context.Context, id int64, value exchange_rates.ExchangeRate) (*exchange_rates.ExchangeRate, error) {
	value.ID = id
	value.CreatedAt = time.Date(2026, 11, 7, 1, 2, 3, 123000000, time.UTC)
	value.UpdatedAt = value.CreatedAt
	return &value, nil
}
func (s *stage1CExchangeStore) Delete(context.Context, int64) (bool, error) {
	return true, nil
}

type stage1CNotificationStore struct {
	notifications.Store
	item *notifications.Notification
}

func (s *stage1CNotificationStore) MarkRead(context.Context, string, int64) (*notifications.Notification, error) {
	return s.item, nil
}
func (s *stage1CNotificationStore) MarkAllRead(context.Context, string) (int, error) {
	return 2, nil
}
func (s *stage1CNotificationStore) Delete(context.Context, string, int64) (bool, error) {
	return true, nil
}

type stage1CAlertStore struct {
	alerts.Store
	project *alerts.Project
	rule    alerts.Rule
	event   alerts.Event
}

func (s *stage1CAlertStore) GetProject(context.Context, string) (*alerts.Project, error) {
	return s.project, nil
}
func (s *stage1CAlertStore) GetRule(context.Context, int64) (*alerts.Rule, error) {
	return &s.rule, nil
}
func (s *stage1CAlertStore) CreateRule(_ context.Context, value alerts.Rule) (*alerts.Rule, error) {
	value.ID = s.rule.ID
	value.CreatedAt = s.rule.CreatedAt
	value.UpdatedAt = s.rule.UpdatedAt
	return &value, nil
}
func (s *stage1CAlertStore) UpdateRule(_ context.Context, id int64, update alerts.RuleUpdate) (*alerts.Rule, error) {
	value := s.rule
	value.ID = id
	if update.IsActive != nil {
		value.IsActive = *update.IsActive
	}
	if update.Name != nil {
		value.Name = *update.Name
	}
	return &value, nil
}
func (s *stage1CAlertStore) DeleteRule(context.Context, int64) (bool, error) {
	return true, nil
}
func (s *stage1CAlertStore) GetEvent(context.Context, int64) (*alerts.Event, error) {
	return &s.event, nil
}
func (s *stage1CAlertStore) AcknowledgeEvent(_ context.Context, _ int64, operator *string) (*alerts.Event, error) {
	value := s.event
	value.Status = "acknowledged"
	value.AcknowledgedAt = &s.event.TriggeredAt
	value.AcknowledgedBy = operator
	return &value, nil
}
func (s *stage1CAlertStore) ResolveEvent(context.Context, int64) (*alerts.Event, error) {
	value := s.event
	value.Status = "resolved"
	return &value, nil
}

type stage1CSettingsStore struct {
	project *notification_settings.Project
	setting notification_settings.Setting
}

func (s *stage1CSettingsStore) GetProject(context.Context, string) (*notification_settings.Project, error) {
	return s.project, nil
}
func (s *stage1CSettingsStore) ListSettings(context.Context, string) ([]notification_settings.Setting, error) {
	return []notification_settings.Setting{s.setting}, nil
}
func (s *stage1CSettingsStore) GetSetting(context.Context, int64) (*notification_settings.Setting, error) {
	return &s.setting, nil
}
func (s *stage1CSettingsStore) CreateSetting(_ context.Context, value notification_settings.Setting) (*notification_settings.Setting, error) {
	value.ID = s.setting.ID
	value.CreatedAt = s.setting.CreatedAt
	value.UpdatedAt = s.setting.UpdatedAt
	return &value, nil
}
func (s *stage1CSettingsStore) UpdateSetting(_ context.Context, id int64, value notification_settings.Setting) (*notification_settings.Setting, error) {
	value.ID = id
	value.CreatedAt = s.setting.CreatedAt
	value.UpdatedAt = s.setting.UpdatedAt
	return &value, nil
}
func (s *stage1CSettingsStore) DeleteSetting(context.Context, int64) (bool, error) {
	return true, nil
}
