package product_analysis_reports

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

var (
	errResultPathUnsafe  = errors.New("result path is unsafe")
	errResultFileMissing = errors.New("result file is missing")
)

func safeHTTPSURL(raw string) (*url.URL, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, "\r\n") {
		return nil, false
	}
	for _, char := range raw {
		if unicode.IsControl(char) {
			return nil, false
		}
	}
	parsed, err := url.Parse(raw)
	if err != nil ||
		!strings.EqualFold(parsed.Scheme, "https") ||
		parsed.Host == "" ||
		parsed.Hostname() == "" ||
		parsed.User != nil ||
		parsed.Opaque != "" ||
		parsed.Fragment != "" {
		return nil, false
	}
	return parsed, true
}

func safeStoredPath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, "\r\n\x00") {
		return "", errResultPathUnsafe
	}
	for _, char := range raw {
		if unicode.IsControl(char) {
			return "", errResultPathUnsafe
		}
	}

	slashPath := strings.ReplaceAll(raw, `\`, "/")
	if strings.HasPrefix(slashPath, "/") {
		return "", errResultPathUnsafe
	}
	for _, segment := range strings.Split(slashPath, "/") {
		if segment == ".." {
			return "", errResultPathUnsafe
		}
	}
	cleaned := filepath.Clean(filepath.FromSlash(slashPath))
	if cleaned == "." || cleaned == ".." || filepath.IsAbs(cleaned) {
		return "", errResultPathUnsafe
	}
	return cleaned, nil
}

// localAbsoluteResultPath reports whether raw is a server-side absolute path.
// It must be consulted before any URL parsing: url.Parse reads a Windows drive
// letter ("C:") as a scheme, and filepath.IsAbs does not treat "/abs/path" as
// absolute on Windows (it has no volume name). Both forms can be persisted by
// the worker, so both count as local paths on every platform.
func localAbsoluteResultPath(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	if filepath.IsAbs(raw) {
		return true
	}
	// Windows reports "/abs/path" as relative; a POSIX-rooted path recorded by
	// a Linux worker must still be routed through the result-root check.
	return filepath.Separator == '\\' &&
		(strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, `\`))
}

// resolveLocalResultFile resolves a path only if its canonical target remains
// inside the server-controlled result root. Symlink escapes are rejected.
func resolveLocalResultFile(root, raw string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", ErrStorageNotConfigured
	}
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, "\r\n\x00") {
		return "", errResultPathUnsafe
	}
	for _, char := range raw {
		if unicode.IsControl(char) {
			return "", errResultPathUnsafe
		}
	}

	rootAbsolute, err := filepath.Abs(root)
	if err != nil {
		return "", errResultFileMissing
	}
	candidate := raw
	if !filepath.IsAbs(candidate) {
		slashPath := strings.ReplaceAll(candidate, `\`, "/")
		relative, relErr := safeStoredPath(slashPath)
		if relErr != nil {
			return "", relErr
		}
		candidate = filepath.Join(rootAbsolute, relative)
	} else {
		candidate = filepath.Clean(candidate)
	}

	if _, err := relativeInside(rootAbsolute, candidate); err != nil {
		return "", errResultPathUnsafe
	}

	resolvedRoot, err := filepath.EvalSymlinks(rootAbsolute)
	if err != nil {
		return "", errResultFileMissing
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", errResultFileMissing
	}
	if _, err := relativeInside(resolvedRoot, resolvedCandidate); err != nil {
		return "", errResultPathUnsafe
	}
	info, err := os.Stat(resolvedCandidate)
	if err != nil || !info.Mode().IsRegular() {
		return "", errResultFileMissing
	}
	return resolvedCandidate, nil
}

func relativeInside(root, candidate string) (string, error) {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return "", err
	}
	if relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relative) {
		return "", errResultPathUnsafe
	}
	return relative, nil
}

// hasURLScheme reports whether scheme denotes a real URL scheme. url.Parse
// reports a Windows drive letter as a scheme: url.Parse(`C:\tmp\result.xlsx`)
// yields scheme "c", so testing parsed.Scheme != "" would classify every
// absolute Windows path as a URL and reject it as not found.
func hasURLScheme(scheme string) bool {
	return len(scheme) > 1
}

// isLocalAbsolutePath reports whether raw is an absolute filesystem path on the
// current platform. It also accepts POSIX-style absolute paths on Windows,
// where filepath.IsAbs("/absolute/result.xlsx") is false and such a value would
// otherwise be treated as a relative stored key.
func isLocalAbsolutePath(raw string) bool {
	if filepath.IsAbs(raw) || filepath.VolumeName(raw) != "" {
		return true
	}
	return strings.HasPrefix(raw, "/")
}
