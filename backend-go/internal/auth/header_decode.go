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

	for _, encoding := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
	} {
		decoded, err := encoding.DecodeString(value)
		if err == nil && utf8.Valid(decoded) {
			return strings.TrimSpace(string(decoded))
		}
	}

	if decoded, err := url.QueryUnescape(value); err == nil {
		value = decoded
	} else if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	return strings.TrimSpace(value)
}
