package alerts

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

type preferenceFakeStore struct {
	*fakeStore
	preference  *Preference
	getUserID   int64
	getCalls    int
	getErr      error
	updateID    int64
	update      UpdatePreferenceInput
	updated     *Preference
	updateErr   error
	updateCalls int
}

func (s *preferenceFakeStore) GetPreference(_ context.Context, userID int64) (*Preference, error) {
	s.getCalls++
	s.getUserID = userID
	return s.preference, s.getErr
}

func (s *preferenceFakeStore) UpdatePreference(
	_ context.Context,
	userID int64,
	input UpdatePreferenceInput,
) (*Preference, error) {
	s.updateCalls++
	s.updateID = userID
	s.update = input
	return s.updated, s.updateErr
}

func TestGetPreferencesRequiresOperatorAndNumericUser(t *testing.T) {
	quietStart := "22:30"
	store := &preferenceFakeStore{
		fakeStore: &fakeStore{},
		preference: &Preference{
			EmailEnabled:    true,
			InAppEnabled:    true,
			MinSeverity:     "warning",
			QuietHoursStart: &quietStart,
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/preferences", nil)
	req.Header.Set("X-User-Id", "42")
	req.Header.Set("X-Operator", "operator-a")
	req = withRequestIdentity(req)
	rec := httptest.NewRecorder()

	NewHandler(store).GetPreferences(rec, req)

	assertResponse(
		t,
		rec,
		http.StatusOK,
		`{"email_enabled":true,"in_app_enabled":true,"min_severity":"warning","quiet_hours_start":"22:30","quiet_hours_end":null}`,
	)
	if store.getCalls != 1 || store.getUserID != 42 {
		t.Fatalf("GetPreference() calls=%d user=%d, want 1/42", store.getCalls, store.getUserID)
	}
}

func TestGetPreferencesRejectsMissingOperatorOrUser(t *testing.T) {
	t.Run("missing operator", func(t *testing.T) {
		store := &preferenceFakeStore{fakeStore: &fakeStore{}}
		req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/preferences", nil)
		req.Header.Set("X-User-Id", "42")
		req = withRequestIdentity(req)
		rec := httptest.NewRecorder()

		NewHandler(store).GetPreferences(rec, req)

		assertResponse(t, rec, http.StatusUnauthorized, `{"detail":"Operator required"}`)
		if store.getCalls != 0 {
			t.Fatalf("GetPreference() calls = %d, want 0", store.getCalls)
		}
	})

	for _, rawUserID := range []string{"", "abc", "0"} {
		t.Run("invalid user "+rawUserID, func(t *testing.T) {
			store := &preferenceFakeStore{fakeStore: &fakeStore{}}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/preferences", nil)
			if rawUserID != "" {
				req.Header.Set("X-User-Id", rawUserID)
			}
			req.Header.Set("X-Operator", "operator-a")
			req = withRequestIdentity(req)
			rec := httptest.NewRecorder()

			NewHandler(store).GetPreferences(rec, req)

			assertResponse(t, rec, http.StatusNotFound, `{"detail":"User not found"}`)
			if store.getCalls != 0 {
				t.Fatalf("GetPreference() calls = %d, want 0", store.getCalls)
			}
		})
	}
}

func TestUpdatePreferencesValidatesBodyAndPassesTransactionalAuditInput(t *testing.T) {
	minSeverity := "critical"
	quietStart := "22:30"
	store := &preferenceFakeStore{
		fakeStore: &fakeStore{},
		updated: &Preference{
			EmailEnabled:    false,
			InAppEnabled:    true,
			MinSeverity:     minSeverity,
			QuietHoursStart: &quietStart,
		},
	}
	req := httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/alerts/preferences",
		strings.NewReader(
			`{"email_enabled":false,"in_app_enabled":true,"min_severity":"critical","quiet_hours_start":"22:30","quiet_hours_end":null}`,
		),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "42")
	req.Header.Set("X-Operator", "operator-a")
	req = withRequestIdentity(req)
	rec := httptest.NewRecorder()

	NewHandler(store).UpdatePreferences(rec, req)

	assertResponse(
		t,
		rec,
		http.StatusOK,
		`{"email_enabled":false,"in_app_enabled":true,"min_severity":"critical","quiet_hours_start":"22:30","quiet_hours_end":null}`,
	)
	if store.updateCalls != 1 || store.updateID != 42 {
		t.Fatalf("UpdatePreference() calls=%d user=%d, want 1/42", store.updateCalls, store.updateID)
	}
	patch := store.update.Patch
	if patch.EmailEnabled == nil || *patch.EmailEnabled ||
		patch.InAppEnabled == nil || !*patch.InAppEnabled ||
		patch.MinSeverity == nil || *patch.MinSeverity != "critical" ||
		!patch.QuietHoursStartSet || patch.QuietHoursStart == nil || *patch.QuietHoursStart != "22:30" ||
		!patch.QuietHoursEndSet || patch.QuietHoursEnd != nil {
		t.Errorf("preference patch = %#v, want explicit values and cleared quiet_hours_end", patch)
	}
	if store.update.Audit.Action != "alerts.preferences.update" ||
		store.update.Audit.TargetType != "alert_preference" ||
		store.update.Audit.TargetID == nil ||
		*store.update.Audit.TargetID != "42" ||
		store.update.Audit.Operator == nil ||
		*store.update.Audit.Operator != "operator-a" {
		t.Errorf("preference audit = %#v, want target/actor", store.update.Audit)
	}
}

func TestUpdatePreferencesRejectsUnknownFieldsAndIllegalValues(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "unknown field", body: `{"email_enabled":false,"org_id":7}`},
		{name: "invalid quiet start", body: `{"quiet_hours_start":"25:00"}`},
		{name: "invalid quiet end type", body: `{"quiet_hours_end":123}`},
		{name: "null non nullable", body: `{"email_enabled":null}`},
		{name: "severity too long", body: `{"min_severity":"critical-critical"}`},
		{name: "unknown severity", body: `{"min_severity":"notice"}`},
		{name: "multiple json values", body: `{"email_enabled":false}{"email_enabled":true}`},
		{name: "null body", body: `null`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &preferenceFakeStore{fakeStore: &fakeStore{}}
			req := httptest.NewRequest(
				http.MethodPatch,
				"/api/v1/alerts/preferences",
				strings.NewReader(tt.body),
			)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-User-Id", "42")
			req.Header.Set("X-Operator", "operator-a")
			req = withRequestIdentity(req)
			rec := httptest.NewRecorder()

			NewHandler(store).UpdatePreferences(rec, req)

			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422; body = %s", rec.Code, rec.Body.String())
			}
			if store.updateCalls != 0 {
				t.Fatalf("UpdatePreference() calls = %d, want 0", store.updateCalls)
			}
		})
	}
}

func TestPreferencesRouteRegistrationKeepsExistingRoutes(t *testing.T) {
	store := &preferenceFakeStore{fakeStore: &fakeStore{}}
	router := registerWriteTestRouter(NewHandler(store))

	for _, route := range []string{
		http.MethodGet + " /api/v1/alerts/preferences",
		http.MethodPatch + " /api/v1/alerts/preferences",
		http.MethodPost + " /api/v1/alerts/detect",
		http.MethodPost + " /api/v1/alerts/rules",
		http.MethodPatch + " /api/v1/alerts/rules/{rule_id}",
		http.MethodDelete + " /api/v1/alerts/rules/{rule_id}",
		http.MethodPost + " /api/v1/alerts/events/{event_id}/acknowledge",
		http.MethodPost + " /api/v1/alerts/events/{event_id}/resolve",
	} {
		if !routerRouteExists(router, route) {
			t.Errorf("missing route %s", route)
		}
	}
}

func registerWriteTestRouter(handler *Handler) *chi.Mux {
	router := chi.NewRouter()
	handler.RegisterWriteRoutes(router, nil)
	return router
}

func routerRouteExists(router chi.Routes, route string) bool {
	found := false
	_ = chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method+" "+path == route {
			found = true
		}
		return nil
	})
	return found
}
