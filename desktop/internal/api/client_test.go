package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
)

func TestLoginSendsClientIDAndPersistsReturnedSession(t *testing.T) {
	var received LoginRequest
	httpClient := stubHTTPClient{fn: func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", req.Method)
		}
		if req.URL.String() != "http://gateway.test/api/v1/auth/login" {
			t.Errorf("URL = %s", req.URL)
		}
		if got := req.Header.Get("X-Client-Id"); got != "bb-macos-client-uuid" {
			t.Errorf("X-Client-Id = %q", got)
		}
		if got := req.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q", got)
		}
		if err := json.NewDecoder(req.Body).Decode(&received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		return jsonResponse(http.StatusOK, `{
			"id":"42",
			"name":"yawei",
			"email":"yawei@example.com",
			"full_name":"纪亚伟",
			"is_admin":true,
			"is_active":true,
			"role_type":"admin",
			"session_id":"session-1",
			"api_key":"secret-api-key"
		}`), nil
	}}
	sessions := newTestSessionStore()
	client := newTestClient(t, httpClient, sessions)

	response, err := client.Login(context.Background(), "yawei@example.com", "password-value")
	if err != nil {
		t.Fatal(err)
	}
	if received.Email != "yawei@example.com" || received.Password != "password-value" {
		t.Errorf("login body = %#v", received)
	}
	if response.ID != "42" || response.RoleType != RoleAdmin || response.APIKey != "secret-api-key" {
		t.Errorf("login response = %#v", response)
	}

	session, apiKey, err := sessions.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if apiKey != "secret-api-key" || session.UserID != "42" ||
		session.SessionID != "session-1" || !session.IsAdmin ||
		session.DisplayName() != "纪亚伟" {
		t.Errorf("persisted session = %#v, api key = %q", session, apiKey)
	}
}

func TestAuthenticatedRequestCarriesPlanHeaders(t *testing.T) {
	for _, isAdmin := range []bool{false, true} {
		t.Run(map[bool]string{false: "operator", true: "admin"}[isAdmin], func(t *testing.T) {
			httpClient := stubHTTPClient{fn: func(req *http.Request) (*http.Response, error) {
				assertHeader(t, req, "X-API-Key", "secret-api-key")
				assertHeader(t, req, "X-Session-Id", "session-1")
				assertHeader(t, req, "X-User-Id", "42")
				assertDecodedHeader(t, req, "X-User-Email", "yawei+test@example.com")
				assertDecodedHeader(t, req, "X-User-Name", "纪亚伟")
				assertDecodedHeader(t, req, "X-Operator", "纪亚伟")
				assertHeader(t, req, "X-Is-Admin", map[bool]string{false: "false", true: "true"}[isAdmin])
				return jsonResponse(http.StatusOK, `{"count":3}`), nil
			}}
			sessions := newTestSessionStore()
			fullName := "纪亚伟"
			if err := sessions.Save(context.Background(), auth.Session{
				UserID:    "42",
				Email:     "yawei+test@example.com",
				Name:      "yawei",
				FullName:  &fullName,
				RoleType:  "operator",
				SessionID: "session-1",
				IsAdmin:   isAdmin,
			}, "secret-api-key"); err != nil {
				t.Fatal(err)
			}

			var response UnreadCountResponse
			err := newTestClient(t, httpClient, sessions).Get(
				context.Background(),
				"/api/v1/notifications/unread-count",
				&response,
			)
			if err != nil {
				t.Fatal(err)
			}
			if response.Count != 3 {
				t.Errorf("unread count = %d, want 3", response.Count)
			}
		})
	}
}

func TestStableHTTPErrorClasses(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		target     error
		body       string
		retryAfter time.Duration
	}{
		{
			name:   "unauthorized",
			status: http.StatusUnauthorized,
			target: ErrUnauthorized,
			body:   `{"detail":"expired","code":"AUTH_EXPIRED","request_id":"req-1"}`,
		},
		{
			name:   "forbidden",
			status: http.StatusForbidden,
			target: ErrForbidden,
			body:   `{"detail":"denied"}`,
		},
		{
			name:       "rate limited",
			status:     http.StatusTooManyRequests,
			target:     ErrRateLimited,
			body:       `{"code":"LOGIN_RATE_LIMITED","message":"请稍后重试","request_id":"req-2","retry_after_seconds":17}`,
			retryAfter: 17 * time.Second,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sessions := newTestSessionStore()
			saveTestSession(t, sessions)
			client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
				return jsonResponse(test.status, test.body), nil
			}}, sessions)

			err := client.Get(context.Background(), "/api/v1/health", nil)
			if !errors.Is(err, test.target) {
				t.Fatalf("error = %v, want %v", err, test.target)
			}
			var httpErr *HTTPError
			if !errors.As(err, &httpErr) {
				t.Fatalf("error %T does not expose HTTPError", err)
			}
			if httpErr.StatusCode != test.status {
				t.Errorf("status = %d, want %d", httpErr.StatusCode, test.status)
			}
			if httpErr.RetryAfter != test.retryAfter {
				t.Errorf("retry after = %s, want %s", httpErr.RetryAfter, test.retryAfter)
			}
		})
	}
}

func TestLoginRateLimitIsTypedAndDoesNotPersistSession(t *testing.T) {
	sessions := newTestSessionStore()
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		return jsonResponse(
			http.StatusTooManyRequests,
			`{"code":"LOGIN_RATE_LIMITED","message":"请稍后重试","request_id":"req-3","retry_after_seconds":23}`,
		), nil
	}}, sessions)

	_, err := client.Login(context.Background(), "yawei@example.com", "wrong")
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("error = %v, want ErrRateLimited", err)
	}
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.RetryAfter != 23*time.Second {
		t.Errorf("HTTPError = %#v, want 23s retry-after", httpErr)
	}
	if _, _, err := sessions.Load(context.Background()); !errors.Is(err, auth.ErrNoSession) {
		t.Errorf("Load() error = %v, want no session", err)
	}
}

func TestLoginPersistFailureIsStableAndDoesNotExposeSecrets(t *testing.T) {
	cause := errors.New("keychain write failed secret-value")
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{
			"id":"42",
			"name":"yawei",
			"email":"yawei@example.com",
			"is_admin":false,
			"is_active":true,
			"role_type":"operator",
			"session_id":"session-secret-value",
			"api_key":"api-key-secret-value"
		}`), nil
	}}, failingSaveSessionStore{err: cause})

	_, err := client.Login(context.Background(), "yawei@example.com", "password")
	if !errors.Is(err, ErrSessionPersist) {
		t.Fatalf("error = %v, want ErrSessionPersist", err)
	}
	if !errors.Is(err, cause) {
		t.Errorf("error %v does not preserve the persistence cause", err)
	}
	if errors.Is(err, ErrInvalidLogin) {
		t.Errorf("persistence failure matched ErrInvalidLogin: %v", err)
	}
	for _, secret := range []string{"api-key-secret-value", "session-secret-value", "password"} {
		if strings.Contains(err.Error(), secret) {
			t.Errorf("error exposed %q: %v", secret, err)
		}
	}
}

type failingSaveSessionStore struct {
	err error
}

func (s failingSaveSessionStore) Load(context.Context) (auth.Session, string, error) {
	return auth.Session{}, "", auth.ErrNoSession
}

func (s failingSaveSessionStore) Save(context.Context, auth.Session, string) error {
	return s.err
}

func (s failingSaveSessionStore) Clear(context.Context) error {
	return nil
}

func TestNetworkErrorDoesNotOverwriteExistingSession(t *testing.T) {
	sessions := newTestSessionStore()
	saveTestSession(t, sessions)
	before, beforeKey, err := sessions.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection refused")
	}}, sessions)

	err = client.Get(context.Background(), "/api/v1/health", nil)
	if !errors.Is(err, ErrNetwork) {
		t.Fatalf("error = %v, want ErrNetwork", err)
	}

	after, afterKey, loadErr := sessions.Load(context.Background())
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if !reflect.DeepEqual(after, before) || afterKey != beforeKey {
		t.Errorf("session changed after network error: before=%#v/%q after=%#v/%q", before, beforeKey, after, afterKey)
	}
}

func TestLoginNetworkErrorDoesNotOverwriteExistingSession(t *testing.T) {
	sessions := newTestSessionStore()
	saveTestSession(t, sessions)
	before, beforeKey, err := sessions.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection reset")
	}}, sessions)

	_, err = client.Login(context.Background(), "yawei@example.com", "password")
	if !errors.Is(err, ErrNetwork) {
		t.Fatalf("error = %v, want ErrNetwork", err)
	}
	after, afterKey, loadErr := sessions.Load(context.Background())
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if !reflect.DeepEqual(after, before) || afterKey != beforeKey {
		t.Error("login network error overwrote the existing session")
	}
}

func TestNotFoundSessionAndInvalidJSONAreStable(t *testing.T) {
	t.Run("missing session", func(t *testing.T) {
		client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
			t.Fatal("HTTP request ran without a saved session")
			return nil, nil
		}}, newTestSessionStore())

		err := client.Get(context.Background(), "/api/v1/health", nil)
		if !errors.Is(err, ErrSessionUnavailable) {
			t.Errorf("error = %v, want ErrSessionUnavailable", err)
		}
	})

	t.Run("invalid response", func(t *testing.T) {
		sessions := newTestSessionStore()
		saveTestSession(t, sessions)
		client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusOK, `{`), nil
		}}, sessions)

		err := client.Get(context.Background(), "/api/v1/health", &HealthResponse{})
		if !errors.Is(err, ErrInvalidResponse) {
			t.Errorf("error = %v, want ErrInvalidResponse", err)
		}
	})
}

func TestCanceledContextSkipsHTTP(t *testing.T) {
	sessions := newTestSessionStore()
	saveTestSession(t, sessions)
	called := false
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		called = true
		return nil, nil
	}}, sessions)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := client.Get(ctx, "/api/v1/health", nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if called {
		t.Error("HTTP client was called with a canceled context")
	}
}

func TestLogoutClearsSession(t *testing.T) {
	sessions := newTestSessionStore()
	saveTestSession(t, sessions)
	client := newTestClient(t, stubHTTPClient{}, sessions)

	if err := client.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if client.clientID != "client-uuid" {
		t.Errorf("client_id changed during logout: %q", client.clientID)
	}
	if _, _, err := sessions.Load(context.Background()); !errors.Is(err, auth.ErrNoSession) {
		t.Errorf("Load() error = %v, want ErrNoSession", err)
	}
}

func TestPollRunsImmediatelyAndStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	err := Poll(ctx, time.Hour, func(context.Context) error {
		calls++
		cancel()
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Poll() error = %v, want context.Canceled", err)
	}
	if calls != 1 {
		t.Errorf("poll calls = %d, want 1", calls)
	}
}

func newTestClient(t *testing.T, httpClient HTTPClient, sessions SessionStore) *Client {
	t.Helper()
	client, err := NewClient(ClientConfig{
		BaseURL:    "http://gateway.test/",
		ClientID:   "client-uuid",
		HTTPClient: httpClient,
		Sessions:   sessions,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func newTestSessionStore() *auth.Store {
	return auth.NewStore(auth.NewKeychain(newTestSecrets()), testClock{})
}

func saveTestSession(t *testing.T, store *auth.Store) {
	t.Helper()
	fullName := "纪亚伟"
	err := store.Save(context.Background(), auth.Session{
		UserID:    "42",
		Email:     "yawei@example.com",
		Name:      "yawei",
		FullName:  &fullName,
		RoleType:  "operator",
		SessionID: "session-1",
	}, "secret-api-key")
	if err != nil {
		t.Fatal(err)
	}
}

func assertHeader(t *testing.T, req *http.Request, name, want string) {
	t.Helper()
	if got := req.Header.Get(name); got != want {
		t.Errorf("%s = %q, want %q", name, got, want)
	}
}

func assertDecodedHeader(t *testing.T, req *http.Request, name, want string) {
	t.Helper()
	got := decodeFastAPIHeaderReference(req.Header.Get(name))
	if got != want {
		t.Errorf("%s = %q, want %q", name, got, want)
	}
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

type stubHTTPClient struct {
	fn func(*http.Request) (*http.Response, error)
}

func (s stubHTTPClient) Do(req *http.Request) (*http.Response, error) {
	if s.fn == nil {
		return nil, errors.New("unexpected HTTP request")
	}
	return s.fn(req)
}

type testClock struct{}

func (testClock) Now() time.Time {
	return time.Date(2026, 10, 27, 9, 30, 0, 0, time.UTC)
}

type testSecrets struct {
	values map[string][]byte
}

func newTestSecrets() *testSecrets {
	return &testSecrets{values: make(map[string][]byte)}
}

func (s *testSecrets) Set(key string, value []byte) error {
	s.values[key] = append([]byte(nil), value...)
	return nil
}

func (s *testSecrets) Get(key string) ([]byte, error) {
	value, ok := s.values[key]
	if !ok {
		return nil, mygo.ErrSecretNotFound
	}
	return append([]byte(nil), value...), nil
}

func (s *testSecrets) Delete(key string) error {
	delete(s.values, key)
	return nil
}
