package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestListRequiresXUserID(t *testing.T) {
	tests := []struct {
		name   string
		header *string
	}{
		{name: "missing"},
		{name: "empty", header: stringPointer("")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
			if tt.header != nil {
				req.Header.Set("X-User-Id", *tt.header)
			}
			rec := httptest.NewRecorder()

			NewHandler(store).List(rec, req)

			assertResponse(t, rec, http.StatusUnauthorized, `{"detail":"X-User-Id required"}`)
			if store.listCalls != 0 {
				t.Errorf("List() calls = %d, want 0", store.listCalls)
			}
		})
	}
}

func TestListRejectsInvalidXUserID(t *testing.T) {
	for _, value := range []string{"abc", "1.5", "QQ==", "1__0"} {
		t.Run(value, func(t *testing.T) {
			store := &fakeStore{}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
			req.Header.Set("X-User-Id", value)
			rec := httptest.NewRecorder()

			NewHandler(store).List(rec, req)

			assertResponse(t, rec, http.StatusBadRequest, `{"detail":"Invalid X-User-Id"}`)
			if store.listCalls != 0 {
				t.Errorf("List() calls = %d, want 0", store.listCalls)
			}
		})
	}
}

func TestListUsesDefaultPaginationAndReturnsFastAPIShape(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	readAt := createdAt.Add(time.Minute)
	message := "message"
	store := &fakeStore{
		listRows: []Notification{{
			ID:        7,
			UserID:    10,
			Type:      "alert",
			Title:     "title",
			Message:   &message,
			Data:      json.RawMessage(`{"project_id":3}`),
			Read:      true,
			ReadAt:    &readAt,
			CreatedAt: createdAt,
		}},
		listTotal: 11,
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	req.Header.Set("X-User-Id", "1_0")
	rec := httptest.NewRecorder()

	NewHandler(store).List(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.listUserID != "10" || store.listParams.Page != 1 ||
		store.listParams.PageSize != 20 || store.listParams.Type != nil ||
		store.listParams.Read != nil {
		t.Errorf("List() args = user %q params %#v, want canonical user and defaults", store.listUserID, store.listParams)
	}
	want := `{"items":[{"id":7,"user_id":10,"type":"alert","title":"title","message":"message","data":{"project_id":3},"read":true,"read_at":"2026-10-01T02:04:04.123000Z","created_at":"2026-10-01T02:03:04.123000Z"}],"total":11,"page":1,"page_size":20}`
	assertResponse(t, rec, http.StatusOK, want)
}

func TestListPreservesNonUTCTimestampOffset(t *testing.T) {
	shanghai := time.FixedZone("Asia/Shanghai", 8*60*60)
	createdAt := time.Date(2026, 10, 1, 10, 3, 4, 123000000, shanghai)
	store := &fakeStore{
		listRows: []Notification{{
			ID:        7,
			UserID:    10,
			Type:      "system",
			Title:     "title",
			Read:      false,
			CreatedAt: createdAt,
		}},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	req.Header.Set("X-User-Id", "10")
	rec := httptest.NewRecorder()

	NewHandler(store).List(rec, req)

	assertResponse(
		t,
		rec,
		http.StatusOK,
		`{"items":[{"id":7,"user_id":10,"type":"system","title":"title","message":null,"data":null,"read":false,"read_at":null,"created_at":"2026-10-01T10:03:04.123000+08:00"}],"total":0,"page":1,"page_size":20}`,
	)
}

func TestListPassesFiltersAndPreservesNulls(t *testing.T) {
	store := &fakeStore{}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/notifications?type=system&read=False&page=2&page_size=5",
		nil,
	)
	req.Header.Set("X-User-Id", "42")
	rec := httptest.NewRecorder()

	NewHandler(store).List(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.listParams.Type == nil || *store.listParams.Type != "system" ||
		store.listParams.Read == nil || *store.listParams.Read ||
		store.listParams.Page != 2 || store.listParams.PageSize != 5 {
		t.Errorf("List() params = %#v, want system/false/page 2/size 5", store.listParams)
	}
	want := `{"items":[],"total":0,"page":2,"page_size":5}`
	assertResponse(t, rec, http.StatusOK, want)
}

func TestListRejectsPaginationBoundsWithFastAPIBody(t *testing.T) {
	tests := []struct {
		query string
		body  string
	}{
		{
			query: "page=0",
			body:  `{"detail":[{"type":"greater_than_equal","loc":["query","page"],"msg":"Input should be greater than or equal to 1","input":"0","ctx":{"ge":1}}]}`,
		},
		{
			query: "page=1&page_size=101",
			body:  `{"detail":[{"type":"less_than_equal","loc":["query","page_size"],"msg":"Input should be less than or equal to 100","input":"101","ctx":{"le":100}}]}`,
		},
		{
			query: "page=abc",
			body:  `{"detail":[{"type":"int_parsing","loc":["query","page"],"msg":"Input should be a valid integer, unable to parse string as an integer","input":"abc"}]}`,
		},
		{
			query: "read=maybe",
			body:  `{"detail":[{"type":"bool_parsing","loc":["query","read"],"msg":"Input should be a valid boolean, unable to interpret input","input":"maybe"}]}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			store := &fakeStore{}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications?"+tt.query, nil)
			req.Header.Set("X-User-Id", "1")
			rec := httptest.NewRecorder()

			NewHandler(store).List(rec, req)

			assertResponse(t, rec, http.StatusUnprocessableEntity, tt.body)
			if store.listCalls != 0 {
				t.Errorf("List() calls = %d, want 0", store.listCalls)
			}
		})
	}
}

func TestListAggregatesQueryValidationErrorsInPydanticOrder(t *testing.T) {
	store := &fakeStore{}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/notifications?page=0&page_size=101",
		nil,
	)
	req.Header.Set("X-Is-Admin", "invalid")
	rec := httptest.NewRecorder()

	NewHandler(store).List(rec, req)

	assertResponse(
		t,
		rec,
		http.StatusUnprocessableEntity,
		`{"detail":[{"type":"greater_than_equal","loc":["query","page"],"msg":"Input should be greater than or equal to 1","input":"0","ctx":{"ge":1}},{"type":"less_than_equal","loc":["query","page_size"],"msg":"Input should be less than or equal to 100","input":"101","ctx":{"le":100}}]}`,
	)
	if store.listCalls != 0 {
		t.Errorf("List() calls = %d, want 0", store.listCalls)
	}
}

func TestListValidatesQueryBeforeUserIDHandlerCheck(t *testing.T) {
	store := &fakeStore{}
	rec := httptest.NewRecorder()

	NewHandler(store).List(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/v1/notifications?page=0", nil),
	)

	assertResponse(
		t,
		rec,
		http.StatusUnprocessableEntity,
		`{"detail":[{"type":"greater_than_equal","loc":["query","page"],"msg":"Input should be greater than or equal to 1","input":"0","ctx":{"ge":1}}]}`,
	)
}

func TestListUsesLastRepeatedPaginationAndPreservesHugePage(t *testing.T) {
	huge := "999999999999999999999999999999999999"
	store := &fakeStore{}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/notifications?page=1&page=000"+huge+"&page_size=2&page_size=5",
		nil,
	)
	req.Header.Set("X-User-Id", "1")
	rec := httptest.NewRecorder()

	NewHandler(store).List(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if store.listParams.Page != maxIntValue || store.listParams.PageSize != 5 {
		t.Errorf("List() page/size = %d/%d, want %d/5", store.listParams.Page, store.listParams.PageSize, maxIntValue)
	}
	if got, want := rec.Body.String(), `{"items":[],"total":0,"page":`+huge+`,"page_size":5}`; got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}

func TestUnreadCountRequiresUserAndReturnsCount(t *testing.T) {
	store := &fakeStore{unreadCount: 3}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications/unread-count", nil)
	req.Header.Set("X-User-Id", "7")
	rec := httptest.NewRecorder()

	NewHandler(store).UnreadCount(rec, req)

	if store.unreadUserID != "7" {
		t.Errorf("UnreadCount() user = %q, want 7", store.unreadUserID)
	}
	assertResponse(t, rec, http.StatusOK, `{"count":3}`)
}

func TestUnreadCountRequiresUser(t *testing.T) {
	store := &fakeStore{}
	rec := httptest.NewRecorder()

	NewHandler(store).UnreadCount(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/v1/notifications/unread-count", nil),
	)

	assertResponse(t, rec, http.StatusUnauthorized, `{"detail":"X-User-Id required"}`)
	if store.unreadCalls != 0 {
		t.Errorf("UnreadCount() calls = %d, want 0", store.unreadCalls)
	}
}

func TestNotificationStoreErrorsReturn500(t *testing.T) {
	store := &fakeStore{err: errors.New("database down")}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	req.Header.Set("X-User-Id", "1")
	rec := httptest.NewRecorder()
	NewHandler(store).List(rec, req)
	assertInternalError(t, rec)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/notifications/unread-count", nil)
	req.Header.Set("X-User-Id", "1")
	rec = httptest.NewRecorder()
	NewHandler(store).UnreadCount(rec, req)
	assertInternalError(t, rec)
}

type fakeStore struct {
	listRows     []Notification
	listTotal    int
	unreadCount  int
	err          error
	listCalls    int
	unreadCalls  int
	listUserID   string
	listParams   ListParams
	unreadUserID string
}

func (s *fakeStore) List(
	_ context.Context,
	userID string,
	params ListParams,
) ([]Notification, int, error) {
	s.listCalls++
	s.listUserID = userID
	s.listParams = params
	return s.listRows, s.listTotal, s.err
}

func (s *fakeStore) UnreadCount(_ context.Context, userID string) (int, error) {
	s.unreadCalls++
	s.unreadUserID = userID
	return s.unreadCount, s.err
}

func assertResponse(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, status, rec.Body.String())
	}
	if got := rec.Body.String(); got != body {
		t.Errorf("body = %s, want %s", got, body)
	}
}

func assertInternalError(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body = %s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Header().Get("Content-Type"), "text/plain; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	if got, want := rec.Body.String(), "Internal Server Error"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func stringPointer(value string) *string {
	return &value
}

const maxIntValue = int(^uint(0) >> 1)
