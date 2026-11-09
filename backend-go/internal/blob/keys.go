package blob

import (
	"fmt"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxObjectKeyBytes = 1024

// ValidateKey validates an S3 object key before it reaches the SDK.
//
// S3 object keys are not filesystem paths, but rejecting absolute keys,
// traversal segments, backslashes, empty segments, and control characters
// keeps every key canonical and prevents accidental local-path or URL
// traversal when callers reuse it elsewhere.
func ValidateKey(key string) error {
	if key == "" {
		return keyError("key is empty")
	}
	if !utf8.ValidString(key) {
		return keyError("key must be valid UTF-8")
	}
	if len(key) > maxObjectKeyBytes {
		return keyError(fmt.Sprintf("key exceeds %d bytes", maxObjectKeyBytes))
	}
	if strings.HasPrefix(key, "/") {
		return keyError("absolute keys are not allowed")
	}
	if strings.Contains(key, "\\") {
		return keyError("backslashes are not allowed")
	}
	for _, character := range key {
		if unicode.IsControl(character) {
			return keyError("control characters are not allowed")
		}
		if unicode.Is(unicode.Cf, character) {
			return keyError("format control characters are not allowed")
		}
	}
	for _, segment := range strings.Split(key, "/") {
		switch segment {
		case "":
			return keyError("empty path segments are not allowed")
		case ".", "..":
			return keyError("dot and dot-dot segments are not allowed")
		}
	}
	return nil
}

// ObjectKey builds a canonical object name from logical parts such as
// project, type, and filename. Each part has whitespace collapsed and is
// rejected if it contains a separator or traversal segment.
func ObjectKey(parts ...string) (string, error) {
	if len(parts) == 0 {
		return "", keyError("at least one key part is required")
	}
	normalized := make([]string, 0, len(parts))
	for _, part := range parts {
		segment, err := normalizeKeySegment(part)
		if err != nil {
			return "", err
		}
		normalized = append(normalized, segment)
	}
	key := strings.Join(normalized, "/")
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	return key, nil
}

func normalizeKeySegment(part string) (string, error) {
	if !utf8.ValidString(part) {
		return "", keyError("key part must be valid UTF-8")
	}
	for _, character := range part {
		if unicode.IsControl(character) {
			return "", keyError("key part contains a control character")
		}
		if unicode.Is(unicode.Cf, character) {
			return "", keyError("key part contains a format control character")
		}
	}
	segment := strings.Join(strings.Fields(part), " ")
	if segment == "" {
		return "", keyError("key part is empty")
	}
	if strings.ContainsAny(segment, "/\\") {
		return "", keyError("key part must not contain path separators")
	}
	if segment == "." || segment == ".." {
		return "", keyError("key part must not be a dot segment")
	}
	return segment, nil
}

func escapeObjectKey(key string) string {
	segments := strings.Split(key, "/")
	for index, segment := range segments {
		segments[index] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}

func keyError(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidKey, message)
}
