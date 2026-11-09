package blob

import (
	"errors"
	"fmt"
	"time"
)

var (
	// ErrNotConfigured is returned when an operation needs an object store that
	// was not constructed with complete credentials.
	ErrNotConfigured = errors.New("blob: object store not configured")
	// ErrInvalidKey is returned for object names that could escape the logical
	// prefix or contain characters unsafe for transport and logs.
	ErrInvalidKey = errors.New("blob: invalid object key")
	// ErrInvalidSize is returned when the caller-provided object size is
	// negative.
	ErrInvalidSize = errors.New("blob: invalid object size")
	// ErrObjectTooLarge is returned when an object exceeds a configured byte
	// limit.
	ErrObjectTooLarge = errors.New("blob: object too large")
	// ErrObjectNotFound is returned when an object does not exist.
	ErrObjectNotFound = errors.New("blob: object not found")
	// ErrInvalidExpiry is returned when a presigned URL expiry is over the
	// SigV4 maximum.
	ErrInvalidExpiry = errors.New("blob: invalid presigned URL expiry")
)

// ObjectInfo is the metadata returned by Head.
type ObjectInfo struct {
	Key          string
	Size         int64
	ContentType  string
	ETag         string
	LastModified time.Time
}

// DeleteResult is the structured outcome of an idempotent delete operation.
//
// Missing objects are reported as Success because S3 DeleteObject is
// idempotent. A failed RPC keeps the key and a non-secret error classification
// so callers can persist it for a later retry.
type DeleteResult struct {
	Key          string
	Success      bool
	ErrorClass   string
	ErrorMessage string

	cause error
}

// Err returns the underlying error for a failed deletion. It returns nil for
// successful and already-missing objects.
func (result DeleteResult) Err() error {
	if result.Success {
		return nil
	}
	if result.cause != nil {
		return fmt.Errorf("delete blob %q: %w", result.Key, result.cause)
	}
	message := result.ErrorMessage
	if message == "" {
		message = result.ErrorClass
	}
	if message == "" {
		message = "unknown error"
	}
	return fmt.Errorf("delete blob %q: %s", result.Key, message)
}
