package notifications

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
)

type writeFakeStore struct {
	*fakeStore
	markReadID   int64
	markReadUser string
	markReadRow  *Notification
	markReadErr  error
	markAllUser  string
	markAllCount int
	markAllErr   error
	deleteID     int64
	deleteUser   string
	deleteOK     bool
	deleteErr    error
}

func (s *writeFakeStore) MarkRead(_ context.Context, userID string, id int64) (*Notification, error) {
	s.markReadUser = userID
	s.markReadID = id
	return s.markReadRow, s.markReadErr
}

func (s *writeFakeStore) MarkAllRead(_ context.Context, userID string) (int, error) {
	s.markAllUser = userID
	return s.markAllCount, s.markAllErr
}

func (s *writeFakeStore) Delete(_ context.Context, userID string, id int64) (bool, error) {
	s.deleteUser = userID
	s.deleteID = id
	return s.deleteOK, s.deleteErr
}

func TestMarkReadUsesAuthenticatedOwnerAndReturnsTimestampedNotification(t *testing.T) {
	readAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	message := "notice"
	store := &writeFakeStore{
		fakeStore:   &fakeStore{},
		markReadRow: &Notification{ID: 8, UserID: 10, Type: "alert", Title: "title", Message: &message, Read: true, ReadAt: &readAt},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/notifications/8/read", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "10"}))
	req.Header.Set("X-User-Id", "99")
	req = withRouteParam(req, "notification_id", "8")
	rec := httptest.NewRecorder()

	NewHandler(store).MarkRead(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.markReadUser != "10" || store.markReadID != 8 {
		t.Errorf("MarkRead() owner/id = %q/%d, want authenticated user 10 and id 8", store.markReadUser, store.markReadID)
	}
	if want := `{"id":8,"user_id":10,"type":"alert","title":"title","message":"notice","data":null,"read":true,"read_at":"2026-11-07T01:02:03Z","created_at":"0001-01-01T00:00:00Z"}`; rec.Body.String() != want {
		t.Errorf("body = %s, want %s", rec.Body.String(), want)
	}
}

func TestMarkAllReadReturnsUpdatedCountAndRequiresUser(t *testing.T) {
	store := &writeFakeStore{fakeStore: &fakeStore{}, markAllCount: 3}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/notifications/mark-all-read", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "1_0"}))
	rec := httptest.NewRecorder()
	NewHandler(store).MarkAllRead(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"count":3}` || store.markAllUser != "10" {
		t.Errorf("response = %d %s, owner=%q; want count 3 for user 10", rec.Code, rec.Body.String(), store.markAllUser)
	}

	for _, userID := range []string{"", "not-an-int"} {
		req = httptest.NewRequest(http.MethodPost, "/api/v1/notifications/mark-all-read", nil)
		req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: userID}))
		rec = httptest.NewRecorder()
		NewHandler(store).MarkAllRead(rec, req)
		if userID == "" {
			assertResponse(t, rec, http.StatusUnauthorized, `{"detail":"X-User-Id required"}`)
		} else {
			assertResponse(t, rec, http.StatusBadRequest, `{"detail":"Invalid X-User-Id"}`)
		}
	}
}

func TestDeleteNotificationScopesToUserAndReturnsNotFound(t *testing.T) {
	store := &writeFakeStore{fakeStore: &fakeStore{}, deleteOK: true}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/notifications/9", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "5"}))
	req = withRouteParam(req, "notification_id", "9")
	rec := httptest.NewRecorder()
	NewHandler(store).Delete(rec, req)
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 ||
		store.deleteUser != "5" || store.deleteID != 9 {
		t.Errorf("Delete() = %d %q owner=%q id=%d", rec.Code, rec.Body.String(), store.deleteUser, store.deleteID)
	}

	store.deleteOK = false
	rec = httptest.NewRecorder()
	NewHandler(store).Delete(rec, req)
	assertResponse(t, rec, http.StatusNotFound, `{"detail":"Notification not found"}`)
}

func TestNotificationWriteRoutesRegisterRequestedPaths(t *testing.T) {
	store := &writeFakeStore{
		fakeStore:    &fakeStore{},
		markAllCount: 2,
	}
	router := chi.NewRouter()
	NewHandler(store).RegisterWriteRoutes(router, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Write-Auth", "yes")
			next.ServeHTTP(w, r)
		})
	})
	for _, path := range []string{
		"/api/v1/notifications/read-all",
		"/api/v1/notifications/mark-all-read",
	} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "3"}))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK || rec.Body.String() != `{"count":2}` ||
			rec.Header().Get("X-Write-Auth") != "yes" {
			t.Errorf("registered route %s = %d %s auth=%q", path, rec.Code, rec.Body.String(), rec.Header().Get("X-Write-Auth"))
		}
	}
}

func TestNotificationWriteErrorsReturnInternalServerError(t *testing.T) {
	store := &writeFakeStore{
		fakeStore:  &fakeStore{},
		markAllErr: errors.New("database down"),
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/notifications/mark-all-read", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "3"}))
	rec := httptest.NewRecorder()
	NewHandler(store).MarkAllRead(rec, req)
	assertInternalError(t, rec)
}

func TestNotificationWriteRoutesDoNotAcceptMalformedIDs(t *testing.T) {
	store := &writeFakeStore{fakeStore: &fakeStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/notifications/nope/read", nil)
	req = req.WithContext(auth.WithUserContext(req.Context(), auth.UserContext{UserID: "3"}))
	req = withRouteParam(req, "notification_id", "nope")
	rec := httptest.NewRecorder()
	NewHandler(store).MarkRead(rec, req)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"detail"`) {
		t.Errorf("response = %d %s, want 422 detail", rec.Code, rec.Body.String())
	}
}

func withRouteParam(req *http.Request, name, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(name, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}
