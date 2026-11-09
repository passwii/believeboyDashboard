package store

import (
	"path"
	"strings"
	"unicode"
)

// safeUploadFilename strips directory components and control/path characters
// while preserving a readable unicode filename.
func safeUploadFilename(name string, fallback string) string {
	name = strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	name = path.Base(name)
	name = strings.Map(func(r rune) rune {
		switch {
		case r == 0 || r == '/' || r == '\\' || unicode.IsControl(r):
			return '-'
		case r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|':
			return '-'
		default:
			return r
		}
	}, name)
	name = strings.TrimSpace(strings.Trim(name, ". -"))
	if name == "" || name == "." || name == ".." {
		return fallback
	}
	if len(name) > 255 {
		ext := path.Ext(name)
		stemLimit := 255 - len(ext)
		if stemLimit < 1 {
			return fallback
		}
		name = name[:stemLimit] + ext
	}
	return name
}

// safeStoragePathSegment is used for URL/storage folder segments such as
// project names. It keeps unicode names but removes path separators.
func safeStoragePathSegment(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	var b strings.Builder
	lastWasSpace := false
	for _, r := range value {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '_' || r == '-':
			b.WriteRune(r)
			lastWasSpace = false
		case unicode.IsSpace(r):
			if !lastWasSpace && b.Len() > 0 {
				b.WriteByte('-')
				lastWasSpace = true
			}
		default:
			if b.Len() > 0 {
				b.WriteByte('-')
			}
			lastWasSpace = false
		}
	}
	out := strings.Trim(strings.TrimSpace(b.String()), " .-_")
	if out == "" || out == "." || out == ".." {
		return fallback
	}
	if len(out) > 80 {
		out = strings.Trim(out[:80], " .-_")
		if out == "" {
			return fallback
		}
	}
	return out
}

func normalizedFileExtension(filename string) string {
	return strings.ToLower(path.Ext(strings.TrimSpace(strings.ReplaceAll(filename, "\\", "/"))))
}
