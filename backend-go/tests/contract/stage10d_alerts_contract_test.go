package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

const (
	stage10DAPIKey      = "stage10d-api-key"
	stage10DProxySecret = "stage10d-proxy-secret"
)

type stage10DReadOnlyStore struct{}

func (*stage10DReadOnlyStore) GetProject(_ context.Context, _ string) (*alerts.Project, error) {
	operator := "stage10d-owner"
	return &alerts.Project{ProjectOperator: &operator}, nil
}

func (*stage10DReadOnlyStore) ListRules(
	context.Context,
	alerts.RuleFilters,
) ([]alerts.Rule, error) {
	return []alerts.Rule{}, nil
}

func (*stage10DReadOnlyStore) ListEvents(
	context.Context,
	alerts.EventFilters,
) ([]alerts.Event, int, error) {
	return []alerts.Event{}, 0, nil
}

func (*stage10DReadOnlyStore) Stats(
	context.Context,
	*string,
	string,
) (alerts.Stats, error) {
	return alerts.Stats{}, nil
}

type stage10DStore struct {
	stage10DReadOnlyStore

	detectResult alerts.DetectionResult
	detectErr    error
	detectInput  alerts.DetectionInput
	detectCalls  int

	preference      *alerts.Preference
	preferenceErr   error
	updated         *alerts.Preference
	updateErr       error
	updateUserID    int64
	updateInput     alerts.UpdatePreferenceInput
	updateCalls     int
	getCalls        int
	getUserID       int64
	createRuleInput alerts.Rule
}

func (s *stage10DStore) Detect(
	_ context.Context,
	input alerts.DetectionInput,
) (alerts.DetectionResult, error) {
	s.detectCalls++
	s.detectInput = input
	return s.detectResult, s.detectErr
}

func (s *stage10DStore) GetPreference(
	_ context.Context,
	userID int64,
) (*alerts.Preference, error) {
	s.getCalls++
	s.getUserID = userID
	return s.preference, s.preferenceErr
}

func (s *stage10DStore) UpdatePreference(
	_ context.Context,
	userID int64,
	input alerts.UpdatePreferenceInput,
) (*alerts.Preference, error) {
	s.updateCalls++
	s.updateUserID = userID
	s.updateInput = input
	return s.updated, s.updateErr
}

func (s *stage10DStore) CreateRule(_ context.Context, input alerts.Rule) (*alerts.Rule, error) {
	s.createRuleInput = input
	now := time.Date(2026, 11, 8, 2, 3, 4, 0, time.UTC)
	created := input
	created.ID = 10
	created.CreatedAt = now
	created.UpdatedAt = now
	return &created, nil
}

func (*stage10DStore) GetRule(context.Context, int64) (*alerts.Rule, error) {
	return nil, nil
}

func (*stage10DStore) UpdateRule(
	context.Context,
	int64,
	alerts.RuleUpdate,
) (*alerts.Rule, error) {
	return nil, nil
}

func (*stage10DStore) DeleteRule(context.Context, int64) (bool, error) {
	return false, nil
}

func (*stage10DStore) GetEvent(context.Context, int64) (*alerts.Event, error) {
	return nil, nil
}

func (*stage10DStore) AcknowledgeEvent(
	context.Context,
	int64,
	*string,
) (*alerts.Event, error) {
	return nil, nil
}

func (*stage10DStore) ResolveEvent(context.Context, int64) (*alerts.Event, error) {
	return nil, nil
}

func stage10DRouter(store alerts.Store) *chi.Mux {
	router := chi.NewRouter()
	alerts.NewHandler(store).RegisterWriteRoutes(
		router,
		auth.RequireAPIKey(stage10DAPIKey, stage10DProxySecret, nil),
	)
	return router
}

func stage10DRequest(
	router http.Handler,
	method, path, body string,
	headers map[string]string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func stage10DAuthorizedHeaders() map[string]string {
	return map[string]string{
		"X-API-Key":                   stage10DAPIKey,
		auth.TrustedProxySecretHeader: stage10DProxySecret,
		"X-Operator":                  "运营 A",
		"X-Is-Admin":                  "true",
		"X-User-Id":                   "42",
	}
}

func TestStage10DAlertsRouteInventory(t *testing.T) {
	router := stage10DRouter(&stage10DStore{})
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

	expected := []string{
		"POST /api/v1/alerts/detect",
		"GET /api/v1/alerts/preferences",
		"PATCH /api/v1/alerts/preferences",
		"POST /api/v1/alerts/rules",
		"PATCH /api/v1/alerts/rules/{rule_id}",
		"DELETE /api/v1/alerts/rules/{rule_id}",
		"POST /api/v1/alerts/events/{event_id}/acknowledge",
		"POST /api/v1/alerts/events/{event_id}/resolve",
	}
	sort.Strings(expected)
	for _, route := range expected {
		if _, ok := routes[route]; !ok {
			t.Errorf("missing route %s", route)
		}
	}
}

func TestStage10DAlertsRequireAPIKey(t *testing.T) {
	router := stage10DRouter(&stage10DStore{})
	for _, test := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v1/alerts/detect"},
		{http.MethodGet, "/api/v1/alerts/preferences"},
		{http.MethodPatch, "/api/v1/alerts/preferences"},
	} {
		response := stage10DRequest(router, test.method, test.path, `{}`, nil)
		if response.Code != http.StatusUnauthorized {
			t.Errorf("%s %s status = %d, want 401; body=%s",
				test.method, test.path, response.Code, response.Body.String())
		}
	}
}

func TestStage10DDetectContract(t *testing.T) {
	t.Run("admin success persists detector result and audit context", func(t *testing.T) {
		store := &stage10DStore{
			detectResult: alerts.DetectionResult{
				RulesEvaluated: 2,
				EventsCreated:  1,
				MessagesSent:   1,
			},
		}
		router := stage10DRouter(store)
		response := stage10DRequest(
			router,
			http.MethodPost,
			"/api/v1/alerts/detect",
			"",
			stage10DAuthorizedHeaders(),
		)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
		}
		if response.Body.String() != `{"rules_evaluated":2,"events_created":1,"messages_sent":1}` {
			t.Fatalf("body = %s", response.Body.String())
		}
		if store.detectCalls != 1 {
			t.Fatalf("Detect() calls = %d, want 1", store.detectCalls)
		}
		if store.detectInput.Audit.Action != "alerts.detect" ||
			store.detectInput.Audit.TargetType != "alert_detection" ||
			store.detectInput.Audit.Operator == nil ||
			*store.detectInput.Audit.Operator != "运营 A" {
			t.Errorf("detect audit = %#v, want alerts.detect and operator", store.detectInput.Audit)
		}
	})

	t.Run("non admin forbidden before store", func(t *testing.T) {
		store := &stage10DStore{}
		headers := stage10DAuthorizedHeaders()
		headers["X-Is-Admin"] = "false"
		response := stage10DRequest(
			stage10DRouter(store),
			http.MethodPost,
			"/api/v1/alerts/detect",
			"",
			headers,
		)
		if response.Code != http.StatusForbidden || response.Body.String() != `{"detail":"Admin only"}` {
			t.Fatalf("response = (%d, %s), want 403 Admin only", response.Code, response.Body.String())
		}
		if store.detectCalls != 0 {
			t.Fatalf("Detect() calls = %d, want 0", store.detectCalls)
		}
	})

	t.Run("invalid admin header is 422", func(t *testing.T) {
		store := &stage10DStore{}
		headers := stage10DAuthorizedHeaders()
		headers["X-Is-Admin"] = "maybe"
		response := stage10DRequest(
			stage10DRouter(store),
			http.MethodPost,
			"/api/v1/alerts/detect",
			"",
			headers,
		)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422; body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("missing detector dependency is 503", func(t *testing.T) {
		response := stage10DRequest(
			stage10DRouter(&stage10DReadOnlyStore{}),
			http.MethodPost,
			"/api/v1/alerts/detect",
			"",
			stage10DAuthorizedHeaders(),
		)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503; body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("concurrent detector conflict is 409", func(t *testing.T) {
		store := &stage10DStore{detectErr: alerts.ErrDetectionConflict}
		response := stage10DRequest(
			stage10DRouter(store),
			http.MethodPost,
			"/api/v1/alerts/detect",
			"",
			stage10DAuthorizedHeaders(),
		)
		if response.Code != http.StatusConflict {
			t.Fatalf("status = %d, want 409; body=%s", response.Code, response.Body.String())
		}
	})
}

func TestStage10DPreferencesRoundTripAndAudit(t *testing.T) {
	quietStart := "22:30"
	store := &stage10DStore{
		preference: &alerts.Preference{
			EmailEnabled:    true,
			InAppEnabled:    true,
			MinSeverity:     "warning",
			QuietHoursStart: &quietStart,
		},
		updated: &alerts.Preference{
			EmailEnabled:    false,
			InAppEnabled:    true,
			MinSeverity:     "critical",
			QuietHoursStart: &quietStart,
		},
	}
	router := stage10DRouter(store)

	getResponse := stage10DRequest(
		router,
		http.MethodGet,
		"/api/v1/alerts/preferences",
		"",
		stage10DAuthorizedHeaders(),
	)
	if getResponse.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200; body=%s", getResponse.Code, getResponse.Body.String())
	}
	var current map[string]any
	if err := json.Unmarshal(getResponse.Body.Bytes(), &current); err != nil {
		t.Fatalf("decode GET: %v", err)
	}
	if current["min_severity"] != "warning" || current["quiet_hours_start"] != "22:30" ||
		current["quiet_hours_end"] != nil {
		t.Fatalf("GET body = %#v", current)
	}
	if store.getCalls != 1 || store.getUserID != 42 {
		t.Fatalf("GetPreference() calls=%d user=%d", store.getCalls, store.getUserID)
	}

	patchResponse := stage10DRequest(
		router,
		http.MethodPatch,
		"/api/v1/alerts/preferences",
		`{"email_enabled":false,"min_severity":"critical","quiet_hours_end":null}`,
		stage10DAuthorizedHeaders(),
	)
	if patchResponse.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want 200; body=%s", patchResponse.Code, patchResponse.Body.String())
	}
	if store.updateCalls != 1 || store.updateUserID != 42 {
		t.Fatalf("UpdatePreference() calls=%d user=%d", store.updateCalls, store.updateUserID)
	}
	if store.updateInput.Audit.Action != "alerts.preferences.update" ||
		store.updateInput.Audit.TargetType != "alert_preference" ||
		store.updateInput.Audit.TargetID == nil || *store.updateInput.Audit.TargetID != "42" ||
		store.updateInput.Audit.Operator == nil || *store.updateInput.Audit.Operator != "运营 A" {
		t.Errorf("preference audit = %#v", store.updateInput.Audit)
	}
	if store.updateInput.Patch.EmailEnabled == nil || *store.updateInput.Patch.EmailEnabled ||
		store.updateInput.Patch.MinSeverity == nil || *store.updateInput.Patch.MinSeverity != "critical" ||
		!store.updateInput.Patch.QuietHoursEndSet || store.updateInput.Patch.QuietHoursEnd != nil {
		t.Errorf("preference patch = %#v", store.updateInput.Patch)
	}
}

func TestStage10DPreferencesValidationAndDependencies(t *testing.T) {
	t.Run("invalid user id is 404", func(t *testing.T) {
		store := &stage10DStore{preference: &alerts.Preference{}}
		headers := stage10DAuthorizedHeaders()
		headers["X-User-Id"] = "not-a-user"
		response := stage10DRequest(
			stage10DRouter(store),
			http.MethodGet,
			"/api/v1/alerts/preferences",
			"",
			headers,
		)
		if response.Code != http.StatusNotFound || response.Body.String() != `{"detail":"User not found"}` {
			t.Fatalf("response = (%d, %s), want 404 User not found", response.Code, response.Body.String())
		}
		if store.getCalls != 0 {
			t.Fatalf("GetPreference() calls = %d, want 0", store.getCalls)
		}
	})

	for _, test := range []struct {
		name string
		body string
	}{
		{name: "unknown field", body: `{"org_id":7}`},
		{name: "invalid time", body: `{"quiet_hours_start":"24:10"}`},
		{name: "wrong type", body: `{"in_app_enabled":"true"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &stage10DStore{updated: &alerts.Preference{}}
			response := stage10DRequest(
				stage10DRouter(store),
				http.MethodPatch,
				"/api/v1/alerts/preferences",
				test.body,
				stage10DAuthorizedHeaders(),
			)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422; body=%s", response.Code, response.Body.String())
			}
			if store.updateCalls != 0 {
				t.Fatalf("UpdatePreference() calls = %d, want 0", store.updateCalls)
			}
		})
	}

	t.Run("missing preference dependency is 503", func(t *testing.T) {
		response := stage10DRequest(
			stage10DRouter(&stage10DReadOnlyStore{}),
			http.MethodGet,
			"/api/v1/alerts/preferences",
			"",
			stage10DAuthorizedHeaders(),
		)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503; body=%s", response.Code, response.Body.String())
		}
	})
}

func TestStage10DExistingCreateRuleStillReturns201(t *testing.T) {
	store := &stage10DStore{}
	response := stage10DRequest(
		stage10DRouter(store),
		http.MethodPost,
		"/api/v1/alerts/rules",
		`{"name":"high ACOS","project_id":9,"metric":"acos","condition":"above","threshold":25}`,
		stage10DAuthorizedHeaders(),
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", response.Code, response.Body.String())
	}
	if store.createRuleInput.ProjectID != 9 || store.createRuleInput.CreatedBy != "运营 A" {
		t.Errorf("create rule input = %#v", store.createRuleInput)
	}
}
