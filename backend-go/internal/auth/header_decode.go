package auth

import (
	"encoding/base64"
	"net/url"
	"strings"
	"unicode/utf8"
)

// DecodeHeaderValue matches FastAPI deps._decode_header_value: try standard
// Base64, then raw Base64 only for valid UTF-8, then URL decoding.
func DecodeHeaderValue(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}

	if decoded, ok := pythonBase64Decode(value); ok && utf8.Valid(decoded) {
		return strings.TrimSpace(string(decoded))
	}

	if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	return strings.TrimSpace(value)
}

// pythonBase64Decode mirrors base64.b64decode(..., validate=False): non-alphabet
// bytes are ignored, padding is inferred, and a remainder of one is rejected.
func pythonBase64Decode(value string) ([]byte, bool) {
	filtered := strings.Map(func(char rune) rune {
		switch {
		case char >= 'A' && char <= 'Z',
			char >= 'a' && char <= 'z',
			char >= '0' && char <= '9',
			char == '+',
			char == '/',
			char == '=':
			return char
		default:
			return -1
		}
	}, value)
	if filtered == "" {
		return nil, false
	}
	hasPadding := strings.Contains(filtered, "=")
	dataCharacters := len(strings.TrimRight(filtered, "="))
	if dataCharacters%4 == 1 {
		return nil, false
	}
	firstPadding := strings.IndexByte(filtered, '=')
	if firstPadding < 0 {
		firstPadding = len(filtered)
	}
	unpadded := filtered[:firstPadding]
	if unpadded == "" {
		return []byte{}, true
	}
	padding := len(filtered) - firstPadding
	remainder := len(unpadded) % 4
	requiredPadding := 0
	if remainder != 0 {
		requiredPadding = 4 - remainder
	}
	if padding < requiredPadding {
		return nil, false
	}
	if !hasPadding && padding == 0 && remainder != 0 {
		return nil, false
	}
	padded := unpadded
	for len(padded)%4 != 0 {
		padded += "="
	}
	decoded, err := base64.StdEncoding.DecodeString(padded)
	if err != nil {
		return nil, false
	}
	return decoded, true
}
