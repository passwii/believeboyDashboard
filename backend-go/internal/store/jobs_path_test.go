package store

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/jobs"
)

func TestJobResultPathCannotEscapeControlledRoot(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "result.csv")
	if err := os.WriteFile(inside, []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.ResolveResultPath(root, "result.csv"); err != nil {
		t.Fatalf("safe result path rejected: %v", err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.ResolveResultPath(root, outside); err == nil {
		t.Fatal("absolute outside result path was accepted")
	}
	if _, err := jobs.ResolveResultPath(root, "../secret"); err == nil {
		t.Fatal("relative traversal result path was accepted")
	}

	link := filepath.Join(root, "escape.csv")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := jobs.ResolveResultPath(root, "escape.csv"); err == nil {
		t.Fatal("symlink escape result path was accepted")
	}
}
