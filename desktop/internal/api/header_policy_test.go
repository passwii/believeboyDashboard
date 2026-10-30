package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
)

func TestHeaderPolicyForRoute(t *testing.T) {
	tests := []struct {
		method string
		path   string
		want   HeaderEncoding
	}{
		{method: http.MethodGet, path: "/api/v1/auth/me", want: HeaderEncodingURL},
		{method: http.MethodPost, path: "/api/v1/system-management/presence/heartbeat", want: HeaderEncodingURL},
		{method: http.MethodGet, path: "/api/v1/system-management/presence?stale_after_seconds=90", want: HeaderEncodingURL},
		{method: http.MethodGet, path: "/api/v1/system-management/profile", want: HeaderEncodingBase64},
		{method: http.MethodGet, path: "/api/v1/alerts/rules", want: HeaderEncodingBase64},
		{method: http.MethodGet, path: "/api/v1/projects/manage", want: HeaderEncodingBase64},
		{method: http.MethodGet, path: "/api/v1/notifications/unread-count", want: HeaderEncodingBase64},
		{method: http.MethodGet, path: "/api/v1/health", want: HeaderEncodingBase64},
	}
	for _, test := range tests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			got, err := HeaderPolicyForRoute(test.method, test.path)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Errorf("HeaderPolicyForRoute() = %q, want %q", got, test.want)
			}
		})
	}

	if _, err := HeaderPolicyForRoute(http.MethodGet, "/api/v1/unlisted"); !errors.Is(err, ErrUnknownHeaderPolicy) {
		t.Errorf("unknown route error = %v, want ErrUnknownHeaderPolicy", err)
	}
	if _, err := HeaderPolicyForRoute(http.MethodPost, "/api/v1/system-management/profile"); !errors.Is(err, ErrUnknownHeaderPolicy) {
		t.Errorf("unknown method error = %v, want ErrUnknownHeaderPolicy", err)
	}
}

func TestEndpointPoliciesRoundTripTheirBackendDecoders(t *testing.T) {
	const (
		email    = "yawei+100%@example.com"
		fullName = "运营 🚀 + 100%"
	)
	tests := []struct {
		name   string
		method string
		path   string
		body   any
	}{
		{name: "profile uses shared decoder", method: http.MethodGet, path: "/api/v1/system-management/profile"},
		{name: "alerts uses shared decoder", method: http.MethodGet, path: "/api/v1/alerts/rules"},
		{name: "auth me uses unquote", method: http.MethodGet, path: "/api/v1/auth/me"},
		{name: "presence heartbeat uses unquote", method: http.MethodPost, path: "/api/v1/system-management/presence/heartbeat", body: map[string]string{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			policy, err := HeaderPolicyForRoute(test.method, test.path)
			if err != nil {
				t.Fatal(err)
			}
			sessions := newTestSessionStore()
			fullNameValue := fullName
			if err := sessions.Save(context.Background(), auth.Session{
				UserID:        "42",
				Email:         email,
				Name:          "yawei",
				FullName:      &fullNameValue,
				RoleType:      "operator",
				SessionID:     "session-1",
				IsActive:      true,
				GatewayOrigin: "http://gateway.test",
			}, "secret-api-key"); err != nil {
				t.Fatal(err)
			}
			httpClient := stubHTTPClient{fn: func(req *http.Request) (*http.Response, error) {
				gotEmail := req.Header.Get("X-User-Email")
				gotName := req.Header.Get("X-User-Name")
				switch policy {
				case HeaderEncodingBase64:
					if decodeFastAPIHeaderReference(gotEmail) != email {
						t.Errorf("Base64 email decode = %q, want %q", decodeFastAPIHeaderReference(gotEmail), email)
					}
					if decodeFastAPIHeaderReference(gotName) != fullName {
						t.Errorf("Base64 name decode = %q, want %q", decodeFastAPIHeaderReference(gotName), fullName)
					}
				case HeaderEncodingURL:
					if !strings.Contains(gotEmail, "%2B") ||
						!strings.Contains(gotEmail, "%25") ||
						!strings.Contains(gotEmail, "%40") {
						t.Errorf("URL email encoding = %q, want percent-encoded +, %%, @", gotEmail)
					}
					if decodeUnquoteReference(gotEmail) != email {
						t.Errorf("unquote email decode = %q, want %q", decodeUnquoteReference(gotEmail), email)
					}
					if decodeUnquoteReference(gotName) != fullName {
						t.Errorf("unquote name decode = %q, want %q", decodeUnquoteReference(gotName), fullName)
					}
				default:
					t.Fatalf("unexpected policy %q", policy)
				}
				return jsonResponse(http.StatusOK, `{}`), nil
			}}
			client := newTestClient(t, httpClient, sessions)
			var output map[string]any
			if test.method == http.MethodGet {
				err = client.Get(context.Background(), test.path, &output)
			} else {
				err = client.Do(context.Background(), test.method, test.path, test.body, &output)
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestUnknownEndpointRequiresExplicitEncodingPolicy(t *testing.T) {
	sessions := newTestSessionStore()
	saveTestSession(t, sessions)
	called := false
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		called = true
		return jsonResponse(http.StatusOK, `{}`), nil
	}}, sessions)

	err := client.Get(context.Background(), "/api/v1/unlisted", nil)
	if !errors.Is(err, ErrUnknownHeaderPolicy) {
		t.Fatalf("Get() error = %v, want ErrUnknownHeaderPolicy", err)
	}
	if called {
		t.Error("unknown endpoint reached HTTP before an explicit policy")
	}

	if err := client.GetWithHeaderPolicy(
		context.Background(),
		"/api/v1/unlisted",
		nil,
		HeaderEncodingURL,
	); err != nil {
		t.Fatalf("GetWithHeaderPolicy() error = %v", err)
	}
	if !called {
		t.Error("explicit policy did not issue the request")
	}
}

func decodeUnquoteReference(value string) string {
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return strings.TrimSpace(decoded)
}
