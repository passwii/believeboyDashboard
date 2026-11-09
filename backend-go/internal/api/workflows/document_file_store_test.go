package workflows

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalDocumentFileStoreOnlyOpensWhitelistedPaths(t *testing.T) {
	root := t.TempDir()
	filename := workflowDocumentFiles[DocumentKeyAmazonRegistrationForm]
	if err := os.WriteFile(filepath.Join(root, filename), []byte("xlsx"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewLocalDocumentFileStore(root)
	if err != nil {
		t.Fatalf("NewLocalDocumentFileStore() error = %v", err)
	}
	reader, err := store.OpenDocument(context.Background(), DocumentKeyAmazonRegistrationForm)
	if err != nil {
		t.Fatalf("OpenDocument() error = %v", err)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = reader.Close()
	if string(data) != "xlsx" {
		t.Fatalf("document bytes = %q", data)
	}
	if _, err := store.OpenDocument(context.Background(), "../../etc/passwd"); !errors.Is(err, ErrDocumentNotFound) {
		t.Fatalf("unsafe key error = %v, want ErrDocumentNotFound", err)
	}
	if _, err := store.OpenDocument(context.Background(), DocumentKeyWorldFirstRegistration); !errors.Is(err, ErrDocumentNotFound) {
		t.Fatalf("missing document error = %v, want ErrDocumentNotFound", err)
	}
}
