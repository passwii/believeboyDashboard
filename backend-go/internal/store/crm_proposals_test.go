package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
)

func TestLocalProposalStorageRejectsPathTraversal(t *testing.T) {
	storage, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"../escape", "/absolute", "crm-proposals/../../escape"} {
		if err := storage.PutObject(context.Background(), key, []byte("x"), "text/plain"); err == nil {
			t.Fatalf("PutObject(%q) succeeded, want path rejection", key)
		}
	}
}

func TestLocalProposalStorageRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	storage, err := NewLocalProposalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := storage.PutObject(
		context.Background(),
		"escape/payload.html",
		[]byte("x"),
		"text/html",
	); err == nil {
		t.Fatal("symlink escape should be rejected")
	}
}

func TestLocalProposalStoragePutGetDeleteAndChunkedUpload(t *testing.T) {
	storage, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "crm-proposals/1/v1/raw.html"
	if err := storage.PutObject(ctx, key, []byte("raw"), "text/html"); err != nil {
		t.Fatalf("PutObject() error = %v", err)
	}
	data, err := storage.GetObject(ctx, key)
	if err != nil || string(data) != "raw" {
		t.Fatalf("GetObject() = %q, %v", data, err)
	}

	owner := "user-1"
	meta, err := storage.InitChunkUpload(ctx, crm.ChunkUploadInitInput{
		OwnerID: &owner, Filename: "proposal.html", Size: 5, ContentType: "text/html",
	})
	if err != nil {
		t.Fatalf("InitChunkUpload() error = %v", err)
	}
	if meta.TotalChunks != 1 || meta.ChunkSize != crmChunkSize {
		t.Fatalf("meta = %#v", meta)
	}
	size, err := storage.WriteChunk(ctx, meta.UploadID, 0, []byte("hello"), &owner, false)
	if err != nil || size != 5 {
		t.Fatalf("WriteChunk() = %d, %v", size, err)
	}
	assembled, assembledMeta, err := storage.AssembleChunkUpload(ctx, meta.UploadID, &owner, false)
	if err != nil || string(assembled) != "hello" {
		t.Fatalf("AssembleChunkUpload() = %q, %v", assembled, err)
	}
	if assembledMeta.Status != "assembling" {
		t.Fatalf("assembled status = %q", assembledMeta.Status)
	}
	if err := storage.MarkChunkUploadFinalized(ctx, meta.UploadID, 9, 2); err != nil {
		t.Fatalf("MarkChunkUploadFinalized() error = %v", err)
	}
	finalMeta, err := storage.ReadChunkUpload(ctx, meta.UploadID, &owner, false)
	if err != nil || finalMeta.Status != "finalized" ||
		finalMeta.FinalProposalID == nil || *finalMeta.FinalProposalID != 9 ||
		finalMeta.FinalVersionNo == nil || *finalMeta.FinalVersionNo != 2 {
		t.Fatalf("final meta = %#v, err=%v", finalMeta, err)
	}
	if err := storage.DeleteObject(ctx, key); err != nil {
		t.Fatalf("DeleteObject() error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(storage.root, filepath.FromSlash(key))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted object stat error = %v", err)
	}
}

func TestLocalProposalStorageChunkUploadEnforcesOwner(t *testing.T) {
	storage, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := "owner"
	other := "other"
	meta, err := storage.InitChunkUpload(context.Background(), crm.ChunkUploadInitInput{
		OwnerID: &owner, Filename: "proposal.html", Size: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = storage.WriteChunk(context.Background(), meta.UploadID, 0, []byte("hello"), &other, false)
	if err == nil {
		t.Fatal("expected owner mismatch to fail")
	}
	var apiErr *crm.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 403 {
		t.Fatalf("error = %v, want 403 APIError", err)
	}
}

func TestLocalProposalStorageRequiresConfiguredRoot(t *testing.T) {
	if _, err := NewLocalProposalStorage(""); err == nil {
		t.Fatal("empty storage root should fail closed")
	}
}
