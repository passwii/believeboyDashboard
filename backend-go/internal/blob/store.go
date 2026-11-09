package blob

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// ObjectStore is the storage surface used by uploads, report delivery, and
// other Go domains.
type ObjectStore interface {
	Put(ctx context.Context, key string, data []byte, contentType string) (string, error)
	PutReader(ctx context.Context, key string, reader io.Reader, size int64, contentType string) (string, error)
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Download(ctx context.Context, key string, destination io.Writer) error
	Delete(ctx context.Context, key string) error
	TryDelete(ctx context.Context, key string) DeleteResult
	Head(ctx context.Context, key string) (ObjectInfo, error)
	PublicURL(key string) (string, error)
	PresignedGetURL(ctx context.Context, key string, expiry time.Duration) (string, error)
}

// Store implements ObjectStore with the AWS S3 SDK and SigV4 signing.
type Store struct {
	client     *s3.Client
	presigner  *s3.PresignClient
	bucketName string
	publicURL  string
	maxPut     int64
	maxGet     int64
	timeout    time.Duration
}

var _ ObjectStore = (*Store)(nil)

// New constructs a fail-closed S3-compatible client. The endpoint must use
// HTTPS unless it is a loopback URL used by tests.
func New(config Config) (*Store, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}

	credentials := aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{
			AccessKeyID:     normalized.accessKeyID,
			SecretAccessKey: normalized.secretAccessKey,
		}, nil
	})

	client := s3.New(s3.Options{
		Region:                     normalized.region,
		BaseEndpoint:               aws.String(normalized.endpointURL),
		Credentials:                credentials,
		HTTPClient:                 normalized.httpClient,
		UsePathStyle:               true,
		RetryMaxAttempts:           normalized.retryMaxAttempts,
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})

	return &Store{
		client:     client,
		presigner:  s3.NewPresignClient(client),
		bucketName: normalized.bucketName,
		publicURL:  normalized.publicURL,
		maxPut:     normalized.maxPutBytes,
		maxGet:     normalized.maxGetBytes,
		timeout:    normalized.timeout,
	}, nil
}

func (store *Store) Put(
	ctx context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	return store.PutReader(ctx, key, bytes.NewReader(data), int64(len(data)), contentType)
}

func (store *Store) PutReader(
	ctx context.Context,
	key string,
	reader io.Reader,
	size int64,
	contentType string,
) (string, error) {
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	if reader == nil {
		return "", fmt.Errorf("blob put: reader is nil")
	}
	if size < 0 {
		return "", fmt.Errorf("%w: %d", ErrInvalidSize, size)
	}
	if size > store.maxPut {
		return "", fmt.Errorf("%w: %d bytes exceeds %d", ErrObjectTooLarge, size, store.maxPut)
	}
	contentType = strings.TrimSpace(contentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if len(contentType) > 1024 || containsControl(contentType) {
		return "", fmt.Errorf("blob put: invalid content type")
	}
	if ctx == nil {
		return "", fmt.Errorf("blob put: context is nil")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	operationContext, cancel := store.operationContext(ctx)
	defer cancel()
	_, err := store.client.PutObject(operationContext, &s3.PutObjectInput{
		Bucket:        aws.String(store.bucketName),
		Key:           aws.String(key),
		Body:          reader,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String(contentType),
	})
	if err != nil {
		return "", fmt.Errorf("blob put %q: %w", key, err)
	}
	return store.PublicURL(key)
}

func (store *Store) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ValidateKey(key); err != nil {
		return nil, err
	}
	if ctx == nil {
		return nil, fmt.Errorf("blob get: context is nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	operationContext, cancel := store.operationContext(ctx)
	output, err := store.client.GetObject(operationContext, &s3.GetObjectInput{
		Bucket: aws.String(store.bucketName),
		Key:    aws.String(key),
	})
	if err != nil {
		cancel()
		return nil, normalizeObjectError("get", key, err)
	}
	if output.Body == nil {
		cancel()
		return nil, fmt.Errorf("blob get %q: empty response body", key)
	}
	if output.ContentLength != nil && *output.ContentLength > store.maxGet {
		_ = output.Body.Close()
		cancel()
		return nil, fmt.Errorf(
			"%w: %d bytes exceeds %d",
			ErrObjectTooLarge,
			*output.ContentLength,
			store.maxGet,
		)
	}
	return newBoundedReadCloser(output.Body, store.maxGet, cancel), nil
}

func (store *Store) Download(
	ctx context.Context,
	key string,
	destination io.Writer,
) error {
	if destination == nil {
		return fmt.Errorf("blob download: destination is nil")
	}
	body, err := store.Get(ctx, key)
	if err != nil {
		return err
	}
	defer body.Close()

	written, err := io.Copy(destination, body)
	if err != nil {
		if ctx != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("blob download %q: %w", key, err)
	}
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	if written > store.maxGet {
		return fmt.Errorf("%w: %d bytes exceeds %d", ErrObjectTooLarge, written, store.maxGet)
	}
	return nil
}

func (store *Store) Delete(ctx context.Context, key string) error {
	return store.TryDelete(ctx, key).Err()
}

func (store *Store) TryDelete(ctx context.Context, key string) DeleteResult {
	result := DeleteResult{Key: key}
	if key == "" {
		result.Success = true
		return result
	}
	if err := ValidateKey(key); err != nil {
		return failedDeleteResult(result, err)
	}
	if ctx == nil {
		return failedDeleteResult(result, fmt.Errorf("blob delete: context is nil"))
	}
	if err := ctx.Err(); err != nil {
		return failedDeleteResult(result, err)
	}

	operationContext, cancel := store.operationContext(ctx)
	defer cancel()
	_, err := store.client.DeleteObject(operationContext, &s3.DeleteObjectInput{
		Bucket: aws.String(store.bucketName),
		Key:    aws.String(key),
	})
	if err != nil && !isNotFound(err) {
		return failedDeleteResult(result, err)
	}
	result.Success = true
	return result
}

func (store *Store) Head(ctx context.Context, key string) (ObjectInfo, error) {
	if err := ValidateKey(key); err != nil {
		return ObjectInfo{}, err
	}
	if ctx == nil {
		return ObjectInfo{}, fmt.Errorf("blob head: context is nil")
	}
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}

	operationContext, cancel := store.operationContext(ctx)
	defer cancel()
	output, err := store.client.HeadObject(operationContext, &s3.HeadObjectInput{
		Bucket: aws.String(store.bucketName),
		Key:    aws.String(key),
	})
	if err != nil {
		return ObjectInfo{}, normalizeObjectError("head", key, err)
	}

	info := ObjectInfo{
		Key:         key,
		ContentType: aws.ToString(output.ContentType),
		ETag:        aws.ToString(output.ETag),
	}
	if output.ContentLength != nil {
		info.Size = *output.ContentLength
	}
	if output.LastModified != nil {
		info.LastModified = *output.LastModified
	}
	return info, nil
}

func (store *Store) PublicURL(key string) (string, error) {
	if store == nil || strings.TrimSpace(store.publicURL) == "" {
		return "", ErrNotConfigured
	}
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	return store.publicURL + "/" + escapeObjectKey(key), nil
}

func (store *Store) PresignedGetURL(
	ctx context.Context,
	key string,
	expiry time.Duration,
) (string, error) {
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	if expiry <= 0 {
		expiry = defaultPresignExpiry
	}
	if expiry > maxPresignExpiry {
		return "", fmt.Errorf(
			"%w: expiry %s exceeds %s",
			ErrInvalidExpiry,
			expiry,
			maxPresignExpiry,
		)
	}
	if ctx == nil {
		return "", fmt.Errorf("blob presign: context is nil")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	operationContext, cancel := store.operationContext(ctx)
	defer cancel()
	request, err := store.presigner.PresignGetObject(
		operationContext,
		&s3.GetObjectInput{
			Bucket: aws.String(store.bucketName),
			Key:    aws.String(key),
		},
		s3.WithPresignExpires(expiry),
	)
	if err != nil {
		return "", fmt.Errorf("blob presign get %q: %w", key, err)
	}
	if request.Method != http.MethodGet {
		return "", fmt.Errorf("blob presign get: unexpected method %q", request.Method)
	}
	return request.URL, nil
}

func (store *Store) operationContext(parent context.Context) (context.Context, context.CancelFunc) {
	if store.timeout <= 0 {
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, store.timeout)
}

func normalizeObjectError(operation, key string, err error) error {
	if isNotFound(err) {
		return fmt.Errorf("%w: %s %q: %v", ErrObjectNotFound, operation, key, err)
	}
	return fmt.Errorf("blob %s %q: %w", operation, key, err)
}

func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		switch apiError.ErrorCode() {
		case "NoSuchKey", "NotFound":
			return true
		}
	}
	var responseError *smithyhttp.ResponseError
	return errors.As(err, &responseError) && responseError.HTTPStatusCode() == http.StatusNotFound
}

func failedDeleteResult(result DeleteResult, err error) DeleteResult {
	result.Success = false
	result.ErrorClass = deleteErrorClass(err)
	result.ErrorMessage = err.Error()
	result.cause = err
	return result
}

func deleteErrorClass(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "ContextCancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "TimeoutError"
	}
	if errors.Is(err, ErrInvalidKey) {
		return "InvalidKey"
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) && apiError.ErrorCode() != "" {
		return apiError.ErrorCode()
	}
	var responseError *smithyhttp.ResponseError
	if errors.As(err, &responseError) {
		return fmt.Sprintf("HTTP%d", responseError.HTTPStatusCode())
	}
	return fmt.Sprintf("%T", err)
}

func containsControl(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

type boundedReadCloser struct {
	body      io.ReadCloser
	maxBytes  int64
	readBytes int64
	cancel    context.CancelFunc
	closeOnce sync.Once
	failed    bool
}

func newBoundedReadCloser(
	body io.ReadCloser,
	maxBytes int64,
	cancel context.CancelFunc,
) *boundedReadCloser {
	return &boundedReadCloser{
		body:     body,
		maxBytes: maxBytes,
		cancel:   cancel,
	}
}

func (reader *boundedReadCloser) Read(buffer []byte) (int, error) {
	if reader.failed {
		return 0, ErrObjectTooLarge
	}
	count, err := reader.body.Read(buffer)
	if count > 0 {
		remaining := reader.maxBytes - reader.readBytes
		if int64(count) > remaining {
			reader.failed = true
			reader.readBytes = reader.maxBytes
			if remaining <= 0 {
				return 0, ErrObjectTooLarge
			}
			return int(remaining), ErrObjectTooLarge
		}
		reader.readBytes += int64(count)
	}
	return count, err
}

func (reader *boundedReadCloser) Close() error {
	var closeErr error
	reader.closeOnce.Do(func() {
		closeErr = reader.body.Close()
		reader.cancel()
	})
	return closeErr
}
