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
