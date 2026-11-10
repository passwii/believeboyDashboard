package digital_office

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestDigitalOfficeCacheMissFallsBackToStore(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 11, 12, 123456000, time.UTC)
	store := &fakeDigitalOfficeStore{
		employees: []EmployeeSnapshot{{
			EmployeeID:    3,
			Name:          "报表快递员",
			Persona:       PersonaFor("auto_report_upload"),
			DisplayStatus: "WORKING",
			BusyLevel:     "NORMAL",
			QueuedCount:   0,
			Pace:          1,
			StepLabel:     "正在处理 payment…",
			TodayDone:     2,
			SuccessRate:   1,
		}},
		chatter: []ChatterEvent{{
			EmployeeID: 3,
			Name:       "报表快递员",
			Emoji:      "📤",
			EventType:  "task_completed",
			Text:       "✅ 完成了 payment",
			Timestamp:  PythonISO(now),
		}},
	}
	cache := &fakeOfficeCache{getErr: errors.New("redis down")}
	handler := NewHandler(
		store,
		WithCache(cache),
		WithNow(func() time.Time { return now }),
	)
	snapshot, chatter, err := handler.buildTick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !store.called {
		t.Fatal("store fallback was not called")
	}
	if !strings.Contains(snapshot, `"server_time":"2026-11-08T10:11:12.123456+00:00"`) ||
		!strings.Contains(snapshot, `"employee_id":3`) {
		t.Errorf("snapshot = %s", snapshot)
	}
	if len(chatter) != 1 || !strings.Contains(chatter[0], `"event_type":"task_completed"`) {
		t.Errorf("chatter = %#v", chatter)
	}
	if cache.getKey != "bb:office:wall_snapshot" {
		t.Errorf("cache key = %q", cache.getKey)
	}
}

func TestDigitalOfficeCacheHitSkipsDatabase(t *testing.T) {
	store := &fakeDigitalOfficeStore{err: errors.New("store must not be called")}
	cache := &fakeOfficeCache{
		snapshot: `{"server_time":"cached","employees":[]}`,
		chatter:  []string{`{"event_type":"cached_chatter"}`},
	}
	handler := NewHandler(store, WithCache(cache), WithRedisPrefix("custom"))
	snapshot, chatter, err := handler.buildTick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.called {
		t.Fatal("database fallback should be skipped on a cache hit")
	}
	if snapshot != cache.snapshot || len(chatter) != 1 {
		t.Fatalf("cache result = (%q, %#v)", snapshot, chatter)
	}
	if cache.chatterKey != "custom:office:chatter_events" {
		t.Errorf("chatter key = %q", cache.chatterKey)
	}
}

func TestDigitalOfficeStreamEmitsFirstFrameAndStopsOnCancel(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 11, 12, 0, time.UTC)
	store := &fakeDigitalOfficeStore{
		employees: []EmployeeSnapshot{{
			EmployeeID:    1,
			Name:          "数据库守护者",
			Persona:       PersonaFor("database"),
			DisplayStatus: "IDLE",
			BusyLevel:     "IDLE",
			StepLabel:     "🍵 静候下一批任务…",
			SuccessRate:   1,
		}},
		chatter: []ChatterEvent{{
			EmployeeID: 1,
			Name:       "数据库守护者",
			Emoji:      "🗄️",
			EventType:  "task_started",
			Text:       "📋 开始处理 payment",
			Timestamp:  PythonISO(now),
		}},
	}
	handler := NewHandler(
		store,
		WithNow(func() time.Time { return now }),
		WithTickInterval(time.Hour),
	)
	requestContext, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/digital-employees/office/stream",
		nil,
	).WithContext(requestContext)
	response := newStreamRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.OfficeStream(response, request)
	}()

	// The tick writes snapshot, chatter and keep-alive as separate writes.
	// Waiting for the snapshot alone lets the later assertions race with the
	// remaining writes (observed as a -race CI flake on 2026-11-10); waiting
	// for the last frame keeps the original assertions deterministic.
	body := waitForStreamText(t, response, ": keep-alive\n\n", 2*time.Second)
	if !strings.HasPrefix(body, "event: snapshot\n") {
		t.Errorf("first frame = %q", body)
	}
	if !strings.Contains(body, "event: chatter\n") {
		t.Errorf("missing chatter frame: %q", body)
	}
	if !strings.Contains(body, ": keep-alive\n\n") {
		t.Errorf("missing keep-alive frame: %q", body)
	}
	if got := response.Header().Get("Content-Type"); got != "text/event-stream; charset=utf-8" {
		t.Errorf("content type = %q", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-cache, no-transform" {
		t.Errorf("cache control = %q", got)
	}
	if got := response.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("x-accel-buffering = %q", got)
	}
	if got := response.Header().Get("Connection"); got != "keep-alive" {
		t.Errorf("connection = %q", got)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream handler did not stop after client cancellation")
	}
}

func TestDigitalOfficeRegistrarRequiresAPIKey(t *testing.T) {
	store := &fakeDigitalOfficeStore{}
	router := chi.NewRouter()
	registrar := NewRegistrar(store)
	if got := registrar.ModuleName(); got != "digital_office" {
		t.Fatalf("module name = %q", got)
	}
	registrar.RegisterRoutes(
		router,
		auth.RequireAPIKey("master-key", "proxy-secret", nil),
	)

	for name, headers := range map[string]map[string]string{
		"missing": nil,
		"invalid": {"X-API-Key": "bad-key"},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodGet,
				"/api/v1/digital-employees/office/stream",
				nil,
			)
			for key, value := range headers {
				request.Header.Set(key, value)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			want := http.StatusUnauthorized
			if name == "invalid" {
				want = http.StatusForbidden
			}
			if response.Code != want {
				t.Fatalf("status = %d, want %d; body = %s", response.Code, want, response.Body.String())
			}
		})
	}
}

type fakeDigitalOfficeStore struct {
	employees []EmployeeSnapshot
	chatter   []ChatterEvent
	err       error
	called    bool
}

func (s *fakeDigitalOfficeStore) BuildWallSnapshot(
	context.Context,
	time.Time,
) ([]EmployeeSnapshot, []ChatterEvent, error) {
	s.called = true
	return s.employees, s.chatter, s.err
}

type fakeOfficeCache struct {
	snapshot   string
	chatter    []string
	getErr     error
	lrangeErr  error
	getKey     string
	chatterKey string
}

func (c *fakeOfficeCache) Get(_ context.Context, key string) (string, error) {
	c.getKey = key
	return c.snapshot, c.getErr
}

func (c *fakeOfficeCache) LRange(
	_ context.Context,
	key string,
	_, _ int64,
) ([]string, error) {
	c.chatterKey = key
	return c.chatter, c.lrangeErr
}

type streamRecorder struct {
	header  http.Header
	mu      sync.Mutex
	body    bytes.Buffer
	status  int
	flushed chan struct{}
}

func newStreamRecorder() *streamRecorder {
	return &streamRecorder{
		header:  make(http.Header),
		status:  http.StatusOK,
		flushed: make(chan struct{}, 16),
	}
}

func (r *streamRecorder) Header() http.Header {
	return r.header
}

func (r *streamRecorder) WriteHeader(status int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status = status
}

func (r *streamRecorder) Write(payload []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.Write(payload)
}

func (r *streamRecorder) Flush() {
	select {
	case r.flushed <- struct{}{}:
	default:
	}
}

func (r *streamRecorder) text() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}

func waitForStreamText(
	t *testing.T,
	response *streamRecorder,
	contains string,
	timeout time.Duration,
) string {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		if body := response.text(); strings.Contains(body, contains) {
			return body
		}
		select {
		case <-response.flushed:
		case <-deadline.C:
			t.Fatalf("stream did not contain %q; body = %q", contains, response.text())
		}
	}
}
