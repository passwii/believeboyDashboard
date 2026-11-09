package alerts

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type writeFakeStore struct {
	*fakeStore
	createInput Rule
	createRow   *Rule
	createErr   error
	getRuleID   int64
	getRuleRow  *Rule
	getRuleErr  error
	updateID    int64
	updateInput RuleUpdate
	updateRow   *Rule
	updateErr   error
	deleteID    int64
	deleteOK    bool
	deleteErr   error
	getEventID  int64
	getEventRow *Event
	getEventErr error
	ackID       int64
	ackBy       *string
	ackRow      *Event
	ackErr      error
	resolveID   int64
	resolveRow  *Event
	resolveErr  error
}

func (s *writeFakeStore) CreateRule(_ context.Context, input Rule) (*Rule, error) {
	s.createInput = input
	return s.createRow, s.createErr
}

func (s *writeFakeStore) GetRule(_ context.Context, id int64) (*Rule, error) {
	s.getRuleID = id
	return s.getRuleRow, s.getRuleErr
}

func (s *writeFakeStore) UpdateRule(_ context.Context, id int64, input RuleUpdate) (*Rule, error) {
	s.updateID = id
	s.updateInput = input
	return s.updateRow, s.updateErr
}

func (s *writeFakeStore) DeleteRule(_ context.Context, id int64) (bool, error) {
	s.deleteID = id
	return s.deleteOK, s.deleteErr
}

func (s *writeFakeStore) GetEvent(_ context.Context, id int64) (*Event, error) {
	s.getEventID = id
	return s.getEventRow, s.getEventErr
}

func (s *writeFakeStore) AcknowledgeEvent(_ context.Context, id int64, operator *string) (*Event, error) {
	s.ackID = id
	s.ackBy = operator
	return s.ackRow, s.ackErr
}

func (s *writeFakeStore) ResolveEvent(_ context.Context, id int64) (*Event, error) {
	s.resolveID = id
	return s.resolveRow, s.resolveErr
}

func TestCreateRuleChecksProjectAccessAppliesDefaultsAndReturnsCreated(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	store := &writeFakeStore{
		fakeStore: &fakeStore{project: &Project{ProjectOperator: stringPointer("operator-a")}},
		createRow: &Rule{
			ID: 8, Name: "high ACOS", ProjectID: 3, Country: "US", Metric: "acos",
			TriggerType: "threshold", Condition: "above", Threshold: 0.25,
			WindowDays: 7, Severity: "warning", NotificationChannels: "in_app",
			IsActive: true, CreatedBy: "operator-a", CreatedAt: createdAt, UpdatedAt: createdAt,
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/rules", strings.NewReader(
		`{"name":"high ACOS","project_id":3,"metric":"acos","condition":"above","threshold":0.25}`,
	))
	req.Header.Set("X-Operator", "operator-a")
	req = withRequestIdentity(req)
	rec := httptest.NewRecorder()

	NewHandler(store).CreateRule(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	if store.createInput.ProjectID != 3 || store.createInput.Country != "US" ||
		store.createInput.TriggerType != "threshold" || store.createInput.WindowDays != 7 ||
		store.createInput.Severity != "warning" || store.createInput.NotificationChannels != "in_app" ||
		store.createInput.CreatedBy != "operator-a" {
		t.Errorf("CreateRule input = %#v, want FastAPI defaults and operator", store.createInput)
	}
	if got := rec.Body.String(); !strings.Contains(got, `"created_at":"2026-11-07T01:02:03Z"`) {
		t.Errorf("body = %s, want httpapi timestamp", got)
	}
}

func TestCreateRuleDeniesProjectAndRejectsInvalidBody(t *testing.T) {
	store := &writeFakeStore{fakeStore: &fakeStore{
		project: &Project{ProjectOperator: stringPointer("operator-b")},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/rules", strings.NewReader(
		`{"name":"rule","project_id":3,"metric":"acos","condition":"above","threshold":1}`,
	))
	req.Header.Set("X-Operator", "operator-a")
	rec := httptest.NewRecorder()
	NewHandler(store).CreateRule(rec, withRequestIdentity(req))
	assertResponse(t, rec, http.StatusForbidden, `{"detail":"无权限访问该项目"}`)
	if store.createInput.Name != "" {
		t.Errorf("CreateRule called despite denied project: %#v", store.createInput)
	}

	rec = httptest.NewRecorder()
	NewHandler(&writeFakeStore{fakeStore: &fakeStore{}}).CreateRule(
		rec,
		httptest.NewRequest(http.MethodPost, "/api/v1/alerts/rules", strings.NewReader(`{"name":"missing"}`)),
	)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("invalid body status = %d, want 422", rec.Code)
	}
}

func TestUpdateAndDeleteRuleCheckExistingRuleProjectAccess(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	existing := &Rule{ID: 9, ProjectID: 4, Name: "before"}
	store := &writeFakeStore{
		fakeStore:  &fakeStore{project: &Project{AssistantOperator: stringPointer("operator-a")}},
		getRuleRow: existing,
		updateRow: &Rule{
			ID: 9, ProjectID: 4, Name: "after", CreatedAt: createdAt, UpdatedAt: createdAt,
		},
		deleteOK: true,
	}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/alerts/rules/9", strings.NewReader(`{"name":"after","is_active":false}`))
	req.Header.Set("X-Operator", "operator-a")
	req = withRouteParam(req, "rule_id", "9")
	req = withRequestIdentity(req)
	rec := httptest.NewRecorder()
	NewHandler(store).UpdateRule(rec, req)
	if rec.Code != http.StatusOK || store.updateID != 9 ||
		store.updateInput.Name == nil || *store.updateInput.Name != "after" ||
		store.updateInput.IsActive == nil || *store.updateInput.IsActive {
		t.Errorf("UpdateRule = %d %s, id=%d patch=%#v", rec.Code, rec.Body.String(), store.updateID, store.updateInput)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/alerts/rules/9", nil)
	req.Header.Set("X-Operator", "operator-a")
	req = withRouteParam(req, "rule_id", "9")
	req = withRequestIdentity(req)
	rec = httptest.NewRecorder()
	NewHandler(store).DeleteRule(rec, req)
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 || store.deleteID != 9 {
		t.Errorf("DeleteRule = %d %s id=%d", rec.Code, rec.Body.String(), store.deleteID)
	}
}

func TestAcknowledgeAndResolveEventsCheckProjectAccessAndOperator(t *testing.T) {
	event := &Event{ID: 11, ProjectID: 4, Status: "active"}
	store := &writeFakeStore{
		fakeStore:   &fakeStore{project: &Project{ProjectOperator: stringPointer("operator-a")}},
		getEventRow: event,
		ackRow:      &Event{ID: 11, ProjectID: 4, Status: "acknowledged"},
		resolveRow:  &Event{ID: 11, ProjectID: 4, Status: "resolved"},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/events/11/acknowledge", nil)
	req.Header.Set("X-Operator", "operator-a")
	req = withRouteParam(req, "event_id", "11")
	req = withRequestIdentity(req)
	rec := httptest.NewRecorder()
	NewHandler(store).AcknowledgeEvent(rec, req)
	if rec.Code != http.StatusOK || store.ackID != 11 || store.ackBy == nil || *store.ackBy != "operator-a" {
		t.Errorf("AcknowledgeEvent = %d %s id=%d by=%v", rec.Code, rec.Body.String(), store.ackID, store.ackBy)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/alerts/events/11/resolve", nil)
	req.Header.Set("X-Operator", "operator-a")
	req = withRouteParam(req, "event_id", "11")
	req = withRequestIdentity(req)
	rec = httptest.NewRecorder()
	NewHandler(store).ResolveEvent(rec, req)
	if rec.Code != http.StatusOK || store.resolveID != 11 {
		t.Errorf("ResolveEvent = %d %s id=%d", rec.Code, rec.Body.String(), store.resolveID)
	}
}

func TestAlertWriteRoutesRegisterAndPropagateErrors(t *testing.T) {
	store := &writeFakeStore{
		fakeStore: &fakeStore{project: &Project{ProjectOperator: stringPointer("operator-a")}},
		createRow: &Rule{ID: 1, ProjectID: 2, CreatedAt: time.Now(), UpdatedAt: time.Now()},
	}
	router := chi.NewRouter()
	NewHandler(store).RegisterWriteRoutes(router, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Write-Auth", "yes")
			next.ServeHTTP(w, r)
		})
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/rules", strings.NewReader(
		`{"name":"rule","project_id":2,"metric":"acos","condition":"above","threshold":1}`,
	))
	req.Header.Set("X-Operator", "operator-a")
	req = withRequestIdentity(req)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated || rec.Header().Get("X-Write-Auth") != "yes" {
		t.Errorf("registered route = %d %s auth=%q", rec.Code, rec.Body.String(), rec.Header().Get("X-Write-Auth"))
	}

	store.createErr = errors.New("database down")
	req = httptest.NewRequest(http.MethodPost, "/api/v1/alerts/rules", strings.NewReader(
		`{"name":"rule","project_id":2,"metric":"acos","condition":"above","threshold":1}`,
	))
	req.Header.Set("X-Operator", "operator-a")
	req = withRequestIdentity(req)
	rec = httptest.NewRecorder()
	NewHandler(store).CreateRule(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("store error status = %d, want 500", rec.Code)
	}
}

func withRouteParam(req *http.Request, name, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(name, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}
