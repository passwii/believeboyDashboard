package jobs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ResolveResultPath only accepts a result inside resultRoot. Symlinks are
// resolved before the containment check so an in-root link cannot escape.
func ResolveResultPath(resultRoot, requested string) (string, error) {
	root := strings.TrimSpace(resultRoot)
	requested = strings.TrimSpace(requested)
	if root == "" || requested == "" {
		return "", errors.New("result path is empty")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absRequested, err := filepath.Abs(requested)
	if err != nil {
		return "", err
	}
	candidate := absRequested
	if !filepath.IsAbs(requested) {
		candidate = filepath.Join(absRoot, filepath.FromSlash(requested))
	}
	if err := ensureInside(absRoot, candidate); err != nil {
		return "", err
	}

	resolvedRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		return "", err
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	if err := ensureInside(resolvedRoot, resolvedCandidate); err != nil {
		return "", err
	}
	info, err := os.Stat(resolvedCandidate)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("result path is not a regular file")
	}
	return resolvedCandidate, nil
}

func ensureInside(root, candidate string) error {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return err
	}
	if relative == "." || filepath.IsAbs(relative) ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		relative == ".." {
		return fmt.Errorf("path escapes controlled root")
	}
	return nil
}

func osStatRegular(path string) (os.FileInfo, error) {
	return os.Stat(path)
}
