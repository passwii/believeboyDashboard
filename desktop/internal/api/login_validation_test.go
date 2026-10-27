package api

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
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
