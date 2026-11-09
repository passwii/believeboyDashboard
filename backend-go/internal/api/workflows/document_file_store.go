package workflows

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var workflowDocumentFiles = map[string]string{
	DocumentKeyAmazonRegistrationForm: "亚马逊_注册信息收集表.xlsx",
	DocumentKeyWorldFirstRegistration: "万里汇海外收款注册流程.pdf",
}

// LocalDocumentFileStore is a whitelist-only file source. The HTTP-facing key
// never becomes a path; only the two server-owned mappings above are opened.
type LocalDocumentFileStore struct {
	root string
}

func NewLocalDocumentFileStore(root string) (*LocalDocumentFileStore, error) {
	resolved, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workflow document root: %w", err)
	}
	resolved, err = filepath.EvalSymlinks(resolved)
	if err != nil {
		return nil, fmt.Errorf("resolve workflow document root symlinks: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("stat workflow document root: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("workflow document root is not a directory")
	}
	return &LocalDocumentFileStore{root: resolved}, nil
}

func (store *LocalDocumentFileStore) OpenDocument(
	_ context.Context,
	key string,
) (io.ReadCloser, error) {
	relative, ok := workflowDocumentFiles[key]
	if !ok {
		return nil, ErrDocumentNotFound
	}
	path := filepath.Join(store.root, relative)
	path, err := filepath.EvalSymlinks(path)
	if os.IsNotExist(err) {
		return nil, ErrDocumentNotFound
	}
	if err != nil {
		return nil, err
	}
	withinRoot, err := filepath.Rel(store.root, path)
	if err != nil || withinRoot == "." ||
		filepath.IsAbs(withinRoot) || containsParentSegment(withinRoot) {
		return nil, ErrDocumentNotFound
	}
	file, err := os.Open(path)
	return file, err
}

func containsParentSegment(path string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(path), "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}
