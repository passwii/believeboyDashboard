package auth

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDecodeHeaderValuePrefersBase64ThenURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "standard base64", raw: base64.StdEncoding.EncodeToString([]byte("测试 用户")), want: "测试 用户"},
		{name: "padded base64", raw: base64.StdEncoding.EncodeToString([]byte("测试 用户")), want: "测试 用户"},
		{name: "padded shorthand", raw: "5rWL6K+V", want: "测试"},
		{name: "literal plus is not space", raw: "A+B", want: "A+B"},
		{name: "unpadded base64 unchanged", raw: "YWJjZA", want: "YWJjZA"},
		{name: "non-alphabet base64 chars ignored", raw: "T!WFu", want: "Man"},
		{name: "base64 whitespace ignored", raw: "TW Fu", want: "Man"},
		{name: "extra base64 padding", raw: "TWFu===", want: "Man"},
		{name: "url encoded unicode", raw: url.PathEscape("运营 A"), want: "运营 A"},
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

func TestDecodeHeaderValueRejectsUnpaddedBase64(t *testing.T) {
	if got := DecodeHeaderValue("5rWL6K+VIOeUqOaItw"); got != "5rWL6K+VIOeUqOaItw" {
		t.Errorf("DecodeHeaderValue() = %q, want unpadded Base64 unchanged", got)
	}
}

func TestDecodeHeaderValueBase64PaddingParity(t *testing.T) {
	tests := map[string]string{
		"YWJjZA=":  "YWJjZA=",
		"YWJjZA==": "abcd",
		"YWJjZA":   "YWJjZA",
		"YQ=":      "YQ=",
		"YQ==":     "a",
		"YWI=":     "ab",
		"YWJj=":    "abc",
		"TWFu===":  "Man",
	}
	for raw, want := range tests {
		t.Run(raw, func(t *testing.T) {
			if got := DecodeHeaderValue(raw); got != want {
				t.Errorf("DecodeHeaderValue(%q) = %q, want %q", raw, got, want)
			}
		})
	}
}

func TestDecodeHeaderValueBase64PaddingMatrix(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{raw: "YQ=", want: "YQ="},
		{raw: "YQ==", want: "a"},
		{raw: "YQ===", want: "a"},
		{raw: "YWI=", want: "ab"},
		{raw: "YWI==", want: "ab"},
		{raw: "YWJj", want: "abc"},
		{raw: "YWJj=", want: "abc"},
		{raw: "YWJj==", want: "abc"},
		{raw: "YWJj===", want: "abc"},
		{raw: "YWJjZA==", want: "abcd"},
		{raw: "YWJjZA===", want: "abcd"},
		{raw: "YWJjZA====", want: "abcd"},
		{raw: "TWFu", want: "Man"},
		{raw: "TWFu=", want: "Man"},
		{raw: "TWFu==", want: "Man"},
		{raw: "TWFu===", want: "Man"},
		{raw: "TWFu====", want: "Man"},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			if got := DecodeHeaderValue(tt.raw); got != tt.want {
				t.Errorf("DecodeHeaderValue(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestDecodeHeaderValueRejectsNonUTF8Base64(t *testing.T) {
	raw := base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe})
	want := url.QueryEscape(raw)
	if got := DecodeHeaderValue(want); got != raw {
		t.Errorf("DecodeHeaderValue(%q) = %q, want URL fallback %q", want, got, raw)
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

func TestHeaderCapsUseUnicodeCodePoints(t *testing.T) {
	userID := strings.Repeat("用", 64) + "尾"
	req := newRequestWithHeaders(map[string]string{"X-User-Id": userID})

	got := UserContextFromRequest(req)

	if got.UserID != strings.Repeat("用", 64) {
		t.Errorf("UserID = %q, want exactly 64 intact runes", got.UserID)
	}
	if !utf8.ValidString(got.UserID) {
		t.Errorf("UserID = %q, invalid UTF-8 after cap", got.UserID)
	}
}

func TestOperatorAndRoleCapsUseUnicodeCodePoints(t *testing.T) {
	operator := strings.Repeat("营", 255) + "尾"
	role := strings.Repeat("员", 32) + "尾"
	req := newRequestWithHeaders(map[string]string{
		"X-Operator":  operator,
		"X-Role-Type": role,
	})

	got := UserContextFromRequest(req)

	if got.Operator != strings.Repeat("营", 255) || !utf8.ValidString(got.Operator) {
		t.Errorf("Operator cap did not preserve 255 intact runes")
	}
	if got.RoleType != strings.Repeat("员", 32) || !utf8.ValidString(got.RoleType) {
		t.Errorf("RoleType cap did not preserve 32 intact runes")
	}
}

func newRequestWithHeaders(headers map[string]string) *http.Request {
	req := httptest.NewRequest("GET", "/", nil)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	return req
}
