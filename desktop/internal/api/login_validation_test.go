package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
)

func TestLoginRejectsInvalidSuccessResponses(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{name: "204", status: http.StatusNoContent},
		{name: "empty body", status: http.StatusOK, body: ""},
		{name: "whitespace body", status: http.StatusOK, body: " \n\t"},
		{name: "partial body", status: http.StatusOK, body: `{"id":"42","email":"yawei@example.com"}`},
		{name: "empty api key", status: http.StatusOK, body: loginJSON("", true)},
		{name: "inactive account", status: http.StatusOK, body: loginJSON("secret-api-key", false)},
		{name: "malformed json", status: http.StatusOK, body: `{"id":`},
		{name: "trailing garbage", status: http.StatusOK, body: loginJSON("secret-api-key", true) + ` trailing`},
		{name: "trailing json value", status: http.StatusOK, body: loginJSON("secret-api-key", true) + `{}`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sessions := newTestSessionStore()
			saveTestSession(t, sessions)
			before, beforeKey, err := sessions.Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
				return jsonResponse(test.status, test.body), nil
			}}, sessions)

			_, err = client.Login(context.Background(), "yawei@example.com", "password")
			if !errors.Is(err, ErrInvalidLogin) {
				t.Fatalf("Login() error = %v, want ErrInvalidLogin", err)
			}
			if errors.Is(err, ErrSessionPersist) {
				t.Errorf("invalid login response matched ErrSessionPersist: %v", err)
			}
			after, afterKey, loadErr := sessions.Load(context.Background())
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if !reflect.DeepEqual(after, before) || afterKey != beforeKey {
				t.Error("invalid login response overwrote the existing session")
			}
		})
	}
}

func TestSuccessBodiesAreBoundedAndMustContainOneJSONValue(t *testing.T) {
	oversized := strings.Repeat(" ", maxJSONBodyBytes) + `{"count":1}`
	tests := []struct {
		name   string
		body   string
		output bool
	}{
		{name: "decoded output over limit", body: oversized, output: true},
		{name: "drained output over limit", body: oversized, output: false},
		{name: "generic trailing garbage", body: `{"count":1} trailing`, output: true},
		{name: "generic trailing json value", body: `{"count":1}{}`, output: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sessions := newTestSessionStore()
			saveTestSession(t, sessions)
			client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
				return jsonResponse(http.StatusOK, test.body), nil
			}}, sessions)

			var output *UnreadCountResponse
			var response UnreadCountResponse
			if test.output {
				output = &response
			}
			err := client.Get(context.Background(), "/api/v1/notifications/unread-count", output)
			if !errors.Is(err, ErrInvalidResponse) {
				t.Fatalf("Get() error = %v, want ErrInvalidResponse", err)
			}
		})
	}
}

func TestOversizedLoginBodyIsInvalidLoginAndInvalidResponse(t *testing.T) {
	sessions := newTestSessionStore()
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusOK, strings.Repeat(" ", maxJSONBodyBytes)+loginJSON("key", true)), nil
	}}, sessions)

	_, err := client.Login(context.Background(), "yawei@example.com", "password")
	if !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("Login() error = %v, want ErrInvalidLogin", err)
	}
	if !errors.Is(err, ErrInvalidResponse) {
		t.Errorf("Login() error = %v, want it to also match ErrInvalidResponse", err)
	}
}

func TestLoginRequiresIsAdminField(t *testing.T) {
	sessions := newTestSessionStore()
	body := strings.Replace(loginJSON("secret-api-key", true), `"is_admin":false,`, "", 1)
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusOK, body), nil
	}}, sessions)

	_, err := client.Login(context.Background(), "yawei@example.com", "password")
	if !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("Login() error = %v, want ErrInvalidLogin", err)
	}
	if _, _, loadErr := sessions.Load(context.Background()); !errors.Is(loadErr, auth.ErrNoSession) {
		t.Errorf("missing is_admin persisted a session: %v", loadErr)
	}
}

func TestLoginRejectsUnsafeIdentityValuesBeforeSessionSave(t *testing.T) {
	tests := []struct {
		name      string
		overrides map[string]any
	}{
		{name: "email control", overrides: map[string]any{"email": "yawei\n@example.com"}},
		{name: "email internal whitespace", overrides: map[string]any{"email": "yawei @example.com"}},
		{name: "email leading whitespace", overrides: map[string]any{"email": " yawei@example.com"}},
		{name: "name control", overrides: map[string]any{"name": "yawei\n"}},
		{name: "name over 255 runes", overrides: map[string]any{"name": strings.Repeat("营", 256)}},
		{name: "full name leading whitespace", overrides: map[string]any{"full_name": " 纪亚伟"}},
		{name: "full name control", overrides: map[string]any{"full_name": "纪亚\r伟"}},
		{name: "full name over 255 runes", overrides: map[string]any{"full_name": strings.Repeat("营", 256)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sessions := newTestSessionStore()
			client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
				return jsonResponse(http.StatusOK, loginResponseJSON(test.overrides)), nil
			}}, sessions)

			_, err := client.Login(context.Background(), "yawei@example.com", "password")
			if !errors.Is(err, ErrInvalidLogin) {
				t.Fatalf("Login() error = %v, want ErrInvalidLogin", err)
			}
			if !errors.Is(err, ErrInvalidIdentityHeader) {
				t.Errorf("Login() error = %v, want it to match ErrInvalidIdentityHeader", err)
			}
			if _, _, loadErr := sessions.Load(context.Background()); !errors.Is(loadErr, auth.ErrNoSession) {
				t.Errorf("unsafe identity persisted a session: %v", loadErr)
			}
		})
	}
}

func TestLoginRejectsHeaderBoundCredentialValues(t *testing.T) {
	tests := []struct {
		name      string
		overrides map[string]any
	}{
		{name: "id newline", overrides: map[string]any{"id": "4\n2"}},
		{name: "id over 64 runes", overrides: map[string]any{"id": strings.Repeat("用", 65)}},
		{name: "session id space", overrides: map[string]any{"session_id": "session 1"}},
		{name: "session id control", overrides: map[string]any{"session_id": "session\x001"}},
		{name: "session id over 256 runes", overrides: map[string]any{"session_id": strings.Repeat("s", 257)}},
		{name: "api key whitespace", overrides: map[string]any{"api_key": "secret key"}},
		{name: "api key non-ascii", overrides: map[string]any{"api_key": "密钥"}},
		{name: "api key over 512 bytes", overrides: map[string]any{"api_key": strings.Repeat("k", 513)}},
		{name: "email over 320 bytes", overrides: map[string]any{"email": strings.Repeat("e", 321)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sessions := newTestSessionStore()
			client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
				return jsonResponse(http.StatusOK, loginResponseJSON(test.overrides)), nil
			}}, sessions)

			_, err := client.Login(context.Background(), "yawei@example.com", "password")
			if !errors.Is(err, ErrInvalidLogin) {
				t.Fatalf("Login() error = %v, want ErrInvalidLogin", err)
			}
			if _, _, loadErr := sessions.Load(context.Background()); !errors.Is(loadErr, auth.ErrNoSession) {
				t.Errorf("invalid header credential persisted a session: %v", loadErr)
			}
		})
	}
}

func TestLoginIdentityValidationRejectsInvalidUTF8(t *testing.T) {
	response := &LoginResponse{
		Email: string([]byte{0xff, 0xfe}),
		Name:  "yawei",
	}
	err := auth.ValidateSessionCredentials(auth.Session{
		UserID:    "42",
		SessionID: "session-1",
		Email:     response.Email,
		Name:      response.Name,
	}, "key")
	if !errors.Is(err, auth.ErrInvalidHeaderCredential) {
		t.Errorf("ValidateSessionCredentials() error = %v, want ErrInvalidHeaderCredential", err)
	}
}

func TestDrainedSuccessBodyStillSucceedsWithinLimit(t *testing.T) {
	sessions := newTestSessionStore()
	saveTestSession(t, sessions)
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{"ignored":true}`), nil
	}}, sessions)

	if err := client.Get(context.Background(), "/api/v1/health", nil); err != nil {
		t.Fatalf("Get() error = %v, want nil", err)
	}
}

func loginJSON(apiKey string, active bool) string {
	activeValue := "false"
	if active {
		activeValue = "true"
	}
	return `{
		"id":"42",
		"name":"yawei",
		"email":"yawei@example.com",
		"full_name":"纪亚伟",
		"is_admin":false,
		"is_active":` + activeValue + `,
		"role_type":"operator",
		"session_id":"session-1",
		"api_key":"` + apiKey + `"
	}`
}

func loginResponseJSON(overrides map[string]any) string {
	values := map[string]any{
		"id":         "42",
		"name":       "yawei",
		"email":      "yawei@example.com",
		"full_name":  "纪亚伟",
		"is_admin":   false,
		"is_active":  true,
		"role_type":  "operator",
		"session_id": "session-1",
		"api_key":    "secret-api-key",
	}
	for key, value := range overrides {
		values[key] = value
	}
	payload, err := json.Marshal(values)
	if err != nil {
		panic(err)
	}
	return string(payload)
}
