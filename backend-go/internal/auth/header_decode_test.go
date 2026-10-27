package auth

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDecodeHeaderValuePrefersBase64ThenURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "standard base64", raw: base64.StdEncoding.EncodeToString([]byte("测试 用户")), want: "测试 用户"},
		{name: "raw base64", raw: base64.RawStdEncoding.EncodeToString([]byte("测试 用户")), want: "测试 用户"},
		{name: "python raw shorthand", raw: "5rWL6K+V", want: "测试"},
		{name: "url encoded unicode", raw: url.QueryEscape("运营 A"), want: "运营 A"},
		{name: "TWFu compatibility", raw: "TWFu", want: "Man"},
		{name: "plain value", raw: "user-123", want: "user-123"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DecodeHeaderValue(tt.raw); got != tt.want {
				t.Errorf("DecodeHeaderValue(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestDecodeHeaderValueRejectsNonUTF8Base64(t *testing.T) {
	raw := base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe})
	if got := DecodeHeaderValue(raw); got != raw {
		t.Errorf("DecodeHeaderValue(%q) = %q, want URL fallback unchanged", raw, got)
	}
}

func TestDecodeHeaderValueTrims(t *testing.T) {
	if got := DecodeHeaderValue("  user-123  "); got != "user-123" {
		t.Errorf("DecodeHeaderValue() = %q, want trimmed", got)
	}
}

func TestUserContextAppliesFastAPIHeaderCaps(t *testing.T) {
	longUserID := strings.Repeat("u", 70)
	longOperator := strings.Repeat("o", 260)
	req := newRequestWithHeaders(map[string]string{
		"X-User-Id":  longUserID,
		"X-Operator": longOperator,
	})

	got := UserContextFromRequest(req)

	if len(got.UserID) != 64 || got.UserID != longUserID[:64] {
		t.Errorf("UserID length = %d, want capped 64", len(got.UserID))
	}
	if len(got.Operator) != 255 || got.Operator != longOperator[:255] {
		t.Errorf("Operator length = %d, want capped 255", len(got.Operator))
	}
}

func newRequestWithHeaders(headers map[string]string) *http.Request {
	req := httptest.NewRequest("GET", "/", nil)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	return req
}
