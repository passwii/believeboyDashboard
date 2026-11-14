package store

import (
	"context"
	"errors"
	"io"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
)

// ProposalObjectBucket is the read/delete surface of an R2 bucket used as a
// read fallback for historical proposal objects.
type ProposalObjectBucket interface {
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
}

// FallbackProposalStorage keeps new proposal writes in local storage and
// serves historical objects from R2 when the local copy is absent. Buckets are
// tried in order. The gateway passes R2_BUCKET_NAME (where FastAPI wrote every
// historical object) and, only when one is configured, an optional private
// bucket ahead of it.
type FallbackProposalStorage struct {
	local   *LocalProposalStorage
	buckets []ProposalObjectBucket
}

func NewFallbackProposalStorage(
	local *LocalProposalStorage,
	buckets ...ProposalObjectBucket,
) *FallbackProposalStorage {
	return &FallbackProposalStorage{local: local, buckets: buckets}
}

// BucketCount reports how many R2 buckets are configured as read fallbacks.
// It lets gateway wiring tests assert the private-bucket-unset path without
// reaching into storage internals.
func (storage *FallbackProposalStorage) BucketCount() int {
	if storage == nil {
		return 0
	}
	return len(storage.buckets)
}

func (storage *FallbackProposalStorage) PutObject(
	ctx context.Context,
	key string,
	data []byte,
	contentType string,
) error {
	return storage.local.PutObject(ctx, key, data, contentType)
}

func (storage *FallbackProposalStorage) GetObject(
	ctx context.Context,
	key string,
) ([]byte, error) {
	data, err := storage.local.GetObject(ctx, key)
	if err == nil || !isProposalObjectNotFound(err) {
		return data, err
	}
	var lastErr error
	for _, bucket := range storage.buckets {
		body, err := bucket.Get(ctx, key)
		if err != nil {
			if isProposalObjectNotFound(err) {
				continue
			}
			// A failure in one bucket must not hide an object that still exists
			// in the next one; only report the failure if nothing was found.
			lastErr = err
			continue
		}
		data, readErr := io.ReadAll(body)
		_ = body.Close()
		if readErr != nil {
			return nil, readErr
		}
		return data, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, crm.NewAPIError(404, "方案文件不存在")
}

func (storage *FallbackProposalStorage) DeleteObject(
	ctx context.Context,
	key string,
) error {
	firstErr := storage.local.DeleteObject(ctx, key)
	for _, bucket := range storage.buckets {
		if err := bucket.Delete(ctx, key); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (storage *FallbackProposalStorage) InitChunkUpload(
	ctx context.Context,
	input crm.ChunkUploadInitInput,
) (crm.ChunkUploadMeta, error) {
	return storage.local.InitChunkUpload(ctx, input)
}

func (storage *FallbackProposalStorage) WriteChunk(
	ctx context.Context,
	uploadID string,
	index int,
	data []byte,
	ownerID *string,
	isAdmin bool,
) (int64, error) {
	return storage.local.WriteChunk(ctx, uploadID, index, data, ownerID, isAdmin)
}

func (storage *FallbackProposalStorage) ReadChunkUpload(
	ctx context.Context,
	uploadID string,
	ownerID *string,
	isAdmin bool,
) (crm.ChunkUploadMeta, error) {
	return storage.local.ReadChunkUpload(ctx, uploadID, ownerID, isAdmin)
}

func (storage *FallbackProposalStorage) AssembleChunkUpload(
	ctx context.Context,
	uploadID string,
	ownerID *string,
	isAdmin bool,
) ([]byte, crm.ChunkUploadMeta, error) {
	return storage.local.AssembleChunkUpload(ctx, uploadID, ownerID, isAdmin)
}

func (storage *FallbackProposalStorage) MarkChunkUploadFinalized(
	ctx context.Context,
	uploadID string,
	proposalID int64,
	versionNo int,
) error {
	return storage.local.MarkChunkUploadFinalized(ctx, uploadID, proposalID, versionNo)
}

func isProposalObjectNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, blob.ErrObjectNotFound) {
		return true
	}
	var apiErr *crm.APIError
	return errors.As(err, &apiErr) && apiErr.Status == 404
}

var _ crm.ProposalStorage = (*FallbackProposalStorage)(nil)
