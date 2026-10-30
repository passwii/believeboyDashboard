package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
)

func TestIdentityHeaderEncodingMatchesPythonFixture(t *testing.T) {
	payload, err := os.ReadFile("testdata/fastapi_header_decode.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Source  string `json:"source"`
		Version string `json:"python_version"`
		Cases   []struct {
			Value   string `json:"value"`
			Raw     string `json:"raw"`
			Decoded string `json:"decoded"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(payload, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Source != "backend/app/api/deps.py::_decode_header_value" {
		t.Fatalf("fixture source = %q", fixture.Source)
	}

	for _, test := range fixture.Cases {
		t.Run(test.Value, func(t *testing.T) {
			encoded, err := encodeIdentityHeader(test.Value, 0)
			if err != nil {
				t.Fatal(err)
			}
			if encoded != test.Raw {
				t.Errorf("encodeIdentityHeader(%q) = %q, Python fixture = %q", test.Value, encoded, test.Raw)
			}
			if got := decodeFastAPIHeaderReference(encoded); got != test.Decoded {
				t.Errorf("reference decode(%q) = %q, want %q", encoded, got, test.Decoded)
			}
		})
	}
}

func TestIdentityHeaderEncodingRejectsUnsafeValues(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		maxRunes int
	}{
		{name: "leading space", value: " 运营"},
		{name: "trailing space", value: "运营 "},
		{name: "line feed", value: "运营\nA"},
		{name: "carriage return", value: "运营\rA"},
		{name: "tab", value: "运营\tA"},
		{name: "NUL", value: "运营\x00A"},
		{name: "invalid UTF-8", value: string([]byte{0xff, 0xfe})},
		{name: "over 255 runes", value: strings.Repeat("营", 256), maxRunes: 255},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := encodeIdentityHeader(test.value, test.maxRunes); !errors.Is(err, ErrInvalidIdentityHeader) {
				t.Errorf("encodeIdentityHeader() error = %v, want ErrInvalidIdentityHeader", err)
			}
		})
	}
}

func TestIdentityHeaderAllows255Runes(t *testing.T) {
	value := strings.Repeat("营", 255)
	if _, err := encodeIdentityHeader(value, 255); err != nil {
		t.Errorf("encodeIdentityHeader(255 runes) error = %v", err)
	}
}

func TestAuthenticatedRequestRejectsLongDisplayNameBeforeHTTP(t *testing.T) {
	sessions := newTestSessionStore()
	longName := strings.Repeat("营", 256)
	secrets := newTestSecrets()
	if err := secrets.Set(auth.CredentialSecretName, mustEnvelope(t, auth.Session{
		UserID:        "42",
		Email:         "yawei@example.com",
		Name:          "yawei",
		FullName:      &longName,
		RoleType:      "operator",
		SessionID:     "session-1",
		IsActive:      true,
		GatewayOrigin: "http://gateway.test",
	}, "secret-api-key")); err != nil {
		t.Fatal(err)
	}
	sessions = auth.NewStore(auth.NewKeychain(secrets), testClock{})
	called := false
	client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
		called = true
		return jsonResponse(http.StatusOK, `{}`), nil
	}}, sessions)

	err := client.Get(context.Background(), "/api/v1/health", nil)
	if !errors.Is(err, auth.ErrInvalidHeaderCredential) {
		t.Fatalf("Get() error = %v, want auth.ErrInvalidHeaderCredential", err)
	}
	if called {
		t.Error("HTTP request ran with an invalid identity header")
	}
}

func mustEnvelope(t *testing.T, session auth.Session, apiKey string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"version": 1,
		"api_key": apiKey,
		"session": session,
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

// decodeFastAPIHeaderReference mirrors backend/app/api/deps.py exactly. It is
// deliberately separate from the encoder so the test does not assume URL
// escaping and exercises the real Base64-first behavior.
func decodeFastAPIHeaderReference(value string) string {
	if value == "" {
		return value
	}
	if decoded, err := base64.StdEncoding.DecodeString(value); err == nil {
		if text := string(decoded); validUTF8(text) {
			return text
		}
	}
	if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	return strings.TrimSpace(value)
}

func validUTF8(value string) bool {
	return utf8.ValidString(value)
}
