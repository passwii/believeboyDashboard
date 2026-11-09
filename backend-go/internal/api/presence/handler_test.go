package presence

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestHeartbeatUpsertsAndReadsRealPresence(t *testing.T) {
	now := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	store := &handlerStore{items: []UserItem{{
		UserID: "42", DisplayName: "运营甲", CurrentPath: "/orders",
		CurrentPageTitle: "订单", LastSeenAt: "2026-11-08T08:00:00Z",
		IsCurrentUser: true,
	}}}
	handler := NewHandler(store, func() time.Time { return now })
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/system-management/presence/heartbeat",
		strings.NewReader(`{"current_path":"/orders","current_page_title":"订单"}`),
	)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{
		UserID: "42", Name: "运营甲", Email: "a@example.com",
	}))
	rec := httptest.NewRecorder()
	handler.Heartbeat(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if store.upsert == nil || store.upsert.UserID != "42" ||
		store.upsert.DisplayName != "运营甲" || store.upsert.AvatarURL == nil {
		t.Fatalf("upsert = %#v", store.upsert)
	}
	if !strings.Contains(rec.Body.String(), `"is_current_user":true`) {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func TestHeartbeatRejectsMissingFields(t *testing.T) {
	handler := NewHandler(&handlerStore{}, time.Now)
	req := httptest.NewRequest(http.MethodPost, "/heartbeat", strings.NewReader(`{"current_path":""}`))
	rec := httptest.NewRecorder()
	handler.Heartbeat(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestPresenceIgnoresForgedIdentityHeaders(t *testing.T) {
	handler := NewHandler(&handlerStore{}, time.Now)
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/system-management/presence",
		nil,
	)
	req.Header.Set("X-User-Id", "attacker")
	req.Header.Set("X-User-Name", "attacker")
	rec := httptest.NewRecorder()
	handler.Get(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body = %s", rec.Code, rec.Body.String())
	}
}

type handlerStore struct {
	upsert *UpsertInput
	items  []UserItem
	err    error
}

func (s *handlerStore) UpsertPresence(_ context.Context, input UpsertInput, _ time.Time) error {
	s.upsert = &input
	return s.err
}

func (s *handlerStore) ListActivePresence(context.Context, string, time.Time) ([]UserItem, error) {
	return s.items, s.err
}

func (*handlerStore) ServerTime(context.Context) (time.Time, error) {
	return time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC), nil
}
