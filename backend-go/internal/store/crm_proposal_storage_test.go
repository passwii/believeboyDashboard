package store

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
)

type fakeProposalBucket struct {
	objects map[string][]byte
	gets    []string
	deletes []string
	getErr  error
}

func newFakeProposalBucket(objects map[string]string) *fakeProposalBucket {
	bucket := &fakeProposalBucket{objects: map[string][]byte{}}
	for key, value := range objects {
		bucket.objects[key] = []byte(value)
	}
	return bucket
}

func (bucket *fakeProposalBucket) Get(_ context.Context, key string) (io.ReadCloser, error) {
	bucket.gets = append(bucket.gets, key)
	if bucket.getErr != nil {
		return nil, bucket.getErr
	}
	data, ok := bucket.objects[key]
	if !ok {
		return nil, objectNotFoundError(key)
	}
	return io.NopCloser(strings.NewReader(string(data))), nil
}

func (bucket *fakeProposalBucket) Delete(_ context.Context, key string) error {
	bucket.deletes = append(bucket.deletes, key)
	delete(bucket.objects, key)
	return nil
}

func objectNotFoundError(key string) error {
	return &crm.APIError{Status: http.StatusNotFound, Detail: "missing " + key}
}

func TestFallbackProposalStorageReadOrderLocalPrivatePublic(t *testing.T) {
	local, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	privateBucket := newFakeProposalBucket(map[string]string{"crm-proposals/7/v1/raw.html": "private"})
	publicBucket := newFakeProposalBucket(map[string]string{
		"crm-proposals/7/v1/raw.html":     "public",
		"crm-proposals/7/v1/adapted.html": "public-adapted",
	})
	storage := NewFallbackProposalStorage(local, privateBucket, publicBucket)
	ctx := context.Background()

	key := "crm-proposals/7/v1/raw.html"
	if got, err := storage.GetObject(ctx, key); err != nil || string(got) != "private" {
		t.Fatalf("GetObject() = %q, %v; want private bucket hit", got, err)
	}
	if len(privateBucket.gets) != 1 || privateBucket.gets[0] != key {
		t.Fatalf("private gets = %v", privateBucket.gets)
	}
	if len(publicBucket.gets) != 0 {
		t.Fatalf("public bucket should not be reached: %v", publicBucket.gets)
	}

	adaptedKey := "crm-proposals/7/v1/adapted.html"
	if got, err := storage.GetObject(ctx, adaptedKey); err != nil || string(got) != "public-adapted" {
		t.Fatalf("GetObject(adapted) = %q, %v; want public fallback", got, err)
	}
	if len(privateBucket.gets) != 2 || len(publicBucket.gets) != 1 {
		t.Fatalf("private gets = %v, public gets = %v", privateBucket.gets, publicBucket.gets)
	}

	if err := storage.PutObject(ctx, "crm-proposals/8/v1/raw.html", []byte("local"), "text/html"); err != nil {
		t.Fatalf("PutObject() error = %v", err)
	}
	if got, err := storage.GetObject(ctx, "crm-proposals/8/v1/raw.html"); err != nil || string(got) != "local" {
		t.Fatalf("local read = %q, %v", got, err)
	}
	if len(privateBucket.gets) != 2 || len(publicBucket.gets) != 1 {
		t.Fatalf("local hit must not touch R2: private %v public %v", privateBucket.gets, publicBucket.gets)
	}
}

func TestFallbackProposalStorageNotFoundMapsTo404(t *testing.T) {
	local, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	storage := NewFallbackProposalStorage(
		local,
		newFakeProposalBucket(nil),
		newFakeProposalBucket(nil),
	)
	_, err = storage.GetObject(context.Background(), "crm-proposals/9/v1/raw.html")
	var apiErr *crm.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatalf("error = %v, want 404 APIError", err)
	}
}

func TestFallbackProposalStoragePropagatesBucketFailure(t *testing.T) {
	local, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	privateBucket := newFakeProposalBucket(nil)
	privateBucket.getErr = errors.New("R2 unavailable")
	storage := NewFallbackProposalStorage(local, privateBucket)
	_, err = storage.GetObject(context.Background(), "crm-proposals/10/v1/raw.html")
	if err == nil || !strings.Contains(err.Error(), "R2 unavailable") {
		t.Fatalf("error = %v, want bucket failure", err)
	}
}

func TestFallbackProposalStoragePrivateFailureFallsThroughToPublic(t *testing.T) {
	local, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	privateBucket := newFakeProposalBucket(nil)
	privateBucket.getErr = errors.New("private bucket unreachable")
	publicBucket := newFakeProposalBucket(map[string]string{"crm-proposals/13/v1/raw.html": "public"})
	storage := NewFallbackProposalStorage(local, privateBucket, publicBucket)
	got, err := storage.GetObject(context.Background(), "crm-proposals/13/v1/raw.html")
	if err != nil || string(got) != "public" {
		t.Fatalf("GetObject() = %q, %v; want public fallback", got, err)
	}
}

func TestFallbackProposalStorageDeleteCleansAllBuckets(t *testing.T) {
	local, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "crm-proposals/3/v2/raw.html"
	if err := local.PutObject(ctx, key, []byte("local"), "text/html"); err != nil {
		t.Fatal(err)
	}
	privateBucket := newFakeProposalBucket(map[string]string{key: "private"})
	publicBucket := newFakeProposalBucket(map[string]string{key: "public"})
	storage := NewFallbackProposalStorage(local, privateBucket, publicBucket)

	if err := storage.DeleteObject(ctx, key); err != nil {
		t.Fatalf("DeleteObject() error = %v", err)
	}
	if _, err := local.GetObject(ctx, key); err == nil {
		t.Fatal("local object still readable after delete")
	}
	if len(privateBucket.deletes) != 1 || len(publicBucket.deletes) != 1 {
		t.Fatalf("deletes: private %v public %v", privateBucket.deletes, publicBucket.deletes)
	}
}

func TestFallbackProposalStorageChunkUploadStaysLocal(t *testing.T) {
	local, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	privateBucket := newFakeProposalBucket(nil)
	storage := NewFallbackProposalStorage(local, privateBucket)
	owner := "user-1"
	meta, err := storage.InitChunkUpload(context.Background(), crm.ChunkUploadInitInput{
		OwnerID: &owner, Filename: "proposal.html", Size: 5, ContentType: "text/html",
	})
	if err != nil {
		t.Fatalf("InitChunkUpload() error = %v", err)
	}
	if _, err := storage.WriteChunk(context.Background(), meta.UploadID, 0, []byte("hello"), &owner, false); err != nil {
		t.Fatalf("WriteChunk() error = %v", err)
	}
	if _, _, err := storage.AssembleChunkUpload(context.Background(), meta.UploadID, &owner, false); err != nil {
		t.Fatalf("AssembleChunkUpload() error = %v", err)
	}
	if len(privateBucket.gets) != 0 || len(privateBucket.deletes) != 0 {
		t.Fatalf("chunk upload touched R2: gets %v deletes %v", privateBucket.gets, privateBucket.deletes)
	}
}

func TestLocalProposalStorageKeyPrefixAvoidsDoubleDirectory(t *testing.T) {
	root := t.TempDir()
	storage, err := NewLocalProposalStorageWithKeyPrefix(root, "crm-proposals")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "crm-proposals/11/v1/raw.html"
	if err := storage.PutObject(ctx, key, []byte("raw"), "text/html"); err != nil {
		t.Fatalf("PutObject() error = %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, "11", "v1", "raw.html"))
	if err != nil || string(data) != "raw" {
		t.Fatalf("normalized path read = %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(root, "crm-proposals")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("double crm-proposals directory exists: %v", err)
	}
	if got, err := storage.GetObject(ctx, key); err != nil || string(got) != "raw" {
		t.Fatalf("GetObject() = %q, %v", got, err)
	}
}

func TestLocalProposalStorageReadsAndDeletesLegacyDoublePrefixPath(t *testing.T) {
	root := t.TempDir()
	storage, err := NewLocalProposalStorageWithKeyPrefix(root, "crm-proposals")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "crm-proposals/12/v1/raw.html"
	legacyPath := filepath.Join(root, "crm-proposals", "12", "v1", "raw.html")
	if err := os.MkdirAll(filepath.Dir(legacyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := storage.GetObject(ctx, key); err != nil || string(got) != "legacy" {
		t.Fatalf("legacy GetObject() = %q, %v", got, err)
	}
	if err := storage.DeleteObject(ctx, key); err != nil {
		t.Fatalf("legacy DeleteObject() error = %v", err)
	}
	if _, err := os.Stat(legacyPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy file still exists: %v", err)
	}
}

func TestProposalObjectBucketUsesBlobNotFoundSemantics(t *testing.T) {
	if !isProposalObjectNotFound(blob.ErrObjectNotFound) {
		t.Fatal("blob.ErrObjectNotFound must map to not-found")
	}
	if !isProposalObjectNotFound(crm.NewAPIError(http.StatusNotFound, "missing")) {
		t.Fatal("crm 404 must map to not-found")
	}
	if isProposalObjectNotFound(errors.New("R2 unavailable")) {
		t.Fatal("transport errors must not be treated as a miss")
	}
}
