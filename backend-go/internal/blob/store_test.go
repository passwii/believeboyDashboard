package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStorePutSignsRequestAndReturnsPublicURL(t *testing.T) {
	t.Parallel()
	var (
		mutex        sync.Mutex
		observed     *http.Request
		observedBody []byte
	)
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read PUT body: %v", err)
		}
		mutex.Lock()
		observed = request.Clone(context.Background())
		observedBody = body
		mutex.Unlock()
		writer.WriteHeader(http.StatusOK)
	}), nil)

	publicURL, err := store.Put(
		context.Background(),
		"project/images/file.txt",
		[]byte("hello"),
		"text/plain",
	)
	if err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	mutex.Lock()
	defer mutex.Unlock()
	if observed == nil {
		t.Fatal("PUT request was not observed")
	}
	if observed.Method != http.MethodPut {
		t.Fatalf("method = %s, want PUT", observed.Method)
	}
	if got, want := observed.URL.EscapedPath(), "/test-bucket/project/images/file.txt"; got != want {
		t.Fatalf("request path = %q, want %q", got, want)
	}
	if got := observed.Header.Get("Authorization"); !strings.HasPrefix(got, "AWS4-HMAC-SHA256 ") {
		t.Fatalf("Authorization = %q, want SigV4 header", got)
	}
	if got := observed.Header.Get("Content-Type"); got != "text/plain" {
		t.Fatalf("Content-Type = %q, want text/plain", got)
	}
	if string(observedBody) != "hello" {
		t.Fatalf("PUT body = %q, want hello", observedBody)
	}
	parsedPublicURL, err := url.Parse(publicURL)
	if err != nil {
		t.Fatalf("url.Parse(publicURL) error = %v", err)
	}
	if got, want := parsedPublicURL.Path, "/test-bucket/project/images/file.txt"; got != want {
		t.Fatalf("public URL path = %q, want %q", got, want)
	}
}

func TestStorePutReaderSignsRequest(t *testing.T) {
	t.Parallel()
	var mutex sync.Mutex
	var body string
	var authorization string
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		mutex.Lock()
		body = string(raw)
		authorization = request.Header.Get("Authorization")
		mutex.Unlock()
		writer.WriteHeader(http.StatusOK)
	}), nil)

	_, err := store.PutReader(
		context.Background(),
		"reader/file.txt",
		strings.NewReader("streamed"),
		8,
		"application/octet-stream",
	)
	if err != nil {
		t.Fatalf("PutReader() error = %v", err)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if body != "streamed" {
		t.Fatalf("body = %q, want streamed", body)
	}
	if !strings.HasPrefix(authorization, "AWS4-HMAC-SHA256 ") {
		t.Fatalf("Authorization = %q, want SigV4 header", authorization)
	}
}

func TestStoreHeadSignsRequestAndReturnsMetadata(t *testing.T) {
	t.Parallel()
	lastModified := time.Date(2026, 11, 8, 10, 30, 0, 0, time.UTC)
	var mutex sync.Mutex
	var authorization string
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		authorization = request.Header.Get("Authorization")
		mutex.Unlock()
		writer.Header().Set("Content-Length", "42")
		writer.Header().Set("Content-Type", "application/pdf")
		writer.Header().Set("ETag", `"etag-value"`)
		writer.Header().Set("Last-Modified", lastModified.Format(http.TimeFormat))
		writer.WriteHeader(http.StatusOK)
	}), nil)

	info, err := store.Head(context.Background(), "reports/report.pdf")
	if err != nil {
		t.Fatalf("Head() error = %v", err)
	}
	if info.Key != "reports/report.pdf" || info.Size != 42 ||
		info.ContentType != "application/pdf" || info.ETag != `"etag-value"` {
		t.Fatalf("Head() = %#v", info)
	}
	if !info.LastModified.Equal(lastModified) {
		t.Fatalf("LastModified = %s, want %s", info.LastModified, lastModified)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if !strings.HasPrefix(authorization, "AWS4-HMAC-SHA256 ") {
		t.Fatalf("Authorization = %q, want SigV4 header", authorization)
	}
}

func TestStoreHeadMapsNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t, s3ErrorHandler(http.StatusNotFound, "NoSuchKey"), nil)
	if _, err := store.Head(context.Background(), "missing/file"); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("Head() error = %v, want ErrObjectNotFound", err)
	}
}

func TestStoreGetAndDownload(t *testing.T) {
	t.Parallel()
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Length", "12")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("hello world!"))
	}), nil)

	body, err := store.Get(context.Background(), "folder/file.txt")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	raw, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if err := body.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if string(raw) != "hello world!" {
		t.Fatalf("Get() body = %q", raw)
	}

	var destination strings.Builder
	if err := store.Download(context.Background(), "folder/file.txt", &destination); err != nil {
		t.Fatalf("Download() error = %v", err)
	}
	if destination.String() != "hello world!" {
		t.Fatalf("Download() body = %q", destination.String())
	}
}

func TestStoreGetRejectsTooLargeObject(t *testing.T) {
	t.Parallel()
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Length", "4")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("abcd"))
	}), func(config *Config) {
		config.MaxGetBytes = 3
	})

	if _, err := store.Get(context.Background(), "large.txt"); !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("Get() error = %v, want ErrObjectTooLarge", err)
	}
}

func TestStoreDeleteIsIdempotentAndSigned(t *testing.T) {
	t.Parallel()
	var mutex sync.Mutex
	var authorization string
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		authorization = request.Header.Get("Authorization")
		mutex.Unlock()
		writer.WriteHeader(http.StatusNoContent)
	}), nil)

	if err := store.Delete(context.Background(), "folder/file.txt"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if !strings.HasPrefix(authorization, "AWS4-HMAC-SHA256 ") {
		t.Fatalf("Authorization = %q, want SigV4 header", authorization)
	}
	if result := store.TryDelete(context.Background(), ""); !result.Success {
		t.Fatalf("TryDelete(empty) = %#v, want success", result)
	}
}

func TestStoreDeleteTreatsNotFoundAsSuccess(t *testing.T) {
	t.Parallel()
	store := newTestStore(t, s3ErrorHandler(http.StatusNotFound, "NoSuchKey"), nil)
	if err := store.Delete(context.Background(), "already/missing"); err != nil {
		t.Fatalf("Delete() error = %v, want nil for missing key", err)
	}
}

func TestStoreTryDeleteReturnsStructuredFailure(t *testing.T) {
	t.Parallel()
	store := newTestStore(t, s3ErrorHandler(http.StatusInternalServerError, "InternalError"), nil)
	result := store.TryDelete(context.Background(), "folder/file.txt")
	if result.Success {
		t.Fatalf("TryDelete() = %#v, want failure", result)
	}
	if result.Key != "folder/file.txt" || result.ErrorClass == "" || result.ErrorMessage == "" {
		t.Fatalf("TryDelete() = %#v", result)
	}
	if !strings.Contains(result.ErrorClass, "InternalError") && result.ErrorClass != "HTTP500" {
		t.Fatalf("ErrorClass = %q", result.ErrorClass)
	}
}

func TestStoreGetMapsProviderFailure(t *testing.T) {
	t.Parallel()
	store := newTestStore(t, s3ErrorHandler(http.StatusBadGateway, "BadGateway"), nil)
	_, err := store.Get(context.Background(), "folder/file.txt")
	if err == nil {
		t.Fatal("Get() error = nil, want provider error")
	}
	if errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("Get() error = %v, want non-not-found failure", err)
	}
}

func TestStorePresignsGetOnlyWithoutNetworkRequest(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusOK)
	}), nil)

	signedURL, err := store.PresignedGetURL(
		context.Background(),
		"folder/中文 file.pdf",
		time.Hour,
	)
	if err != nil {
		t.Fatalf("PresignedGetURL() error = %v", err)
	}
	parsed, err := url.Parse(signedURL)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	if parsed.Scheme != "http" || parsed.Host == "" {
		t.Fatalf("signed URL = %q", signedURL)
	}
	if parsed.Path != "/test-bucket/folder/中文 file.pdf" {
		t.Fatalf("signed URL path = %q", parsed.Path)
	}
	query := parsed.Query()
	if query.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" ||
		query.Get("X-Amz-Signature") == "" ||
		query.Get("X-Amz-Expires") != "3600" {
		t.Fatalf("signed URL query = %#v", query)
	}
	if calls.Load() != 0 {
		t.Fatalf("presign made %d network requests, want 0", calls.Load())
	}
}

func TestStorePresignExpiryHasUpperBound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t, http.NotFoundHandler(), nil)
	if _, err := store.PresignedGetURL(context.Background(), "file.txt", 8*24*time.Hour); !errors.Is(err, ErrInvalidExpiry) {
		t.Fatalf("PresignedGetURL() error = %v, want ErrInvalidExpiry", err)
	}
}

func TestStorePublicURLFromCDN(t *testing.T) {
	t.Parallel()
	store, err := New(Config{
		EndpointURL:     "https://r2.example.com",
		BucketName:      "test-bucket",
		AccessKeyID:     "access",
		SecretAccessKey: "secret",
		Region:          "auto",
		PublicURL:       "https://cdn.example.com/assets",
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	publicURL, err := store.PublicURL("folder/中文 file.pdf")
	if err != nil {
		t.Fatalf("PublicURL() error = %v", err)
	}
	parsed, err := url.Parse(publicURL)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	if parsed.Host != "cdn.example.com" ||
		parsed.EscapedPath() != "/assets/folder/%E4%B8%AD%E6%96%87%20file.pdf" {
		t.Fatalf("PublicURL() = %q", publicURL)
	}
}

func TestStoreRejectsUnsafeInputBeforeNetwork(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusOK)
	}), func(config *Config) {
		config.MaxPutBytes = 4
	})

	if _, err := store.Put(context.Background(), "../secret", []byte("x"), "text/plain"); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("Put(unsafe key) error = %v, want ErrInvalidKey", err)
	}
	if _, err := store.Put(context.Background(), "file.txt", []byte("12345"), "text/plain"); !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("Put(large) error = %v, want ErrObjectTooLarge", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("unsafe inputs made %d network requests, want 0", calls.Load())
	}
}

func TestStoreHonorsContextCancellation(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusOK)
	}), nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Head(ctx, "file.txt"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Head(cancelled) error = %v, want context.Canceled", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("cancelled request made %d network calls, want 0", calls.Load())
	}
}

func TestStoreTimeout(t *testing.T) {
	t.Parallel()
	store := newTestStore(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case <-request.Context().Done():
		case <-time.After(time.Second):
		}
	}), func(config *Config) {
		config.Timeout = 75 * time.Millisecond
	})
	started := time.Now()
	_, err := store.Head(context.Background(), "file.txt")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Head() error = %v, want context deadline", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("timeout took %s, want under 1s", elapsed)
	}
}

func TestNewRejectsIncompleteOrUnsafeConfigWithoutSecrets(t *testing.T) {
	t.Parallel()
	_, err := New(Config{
		EndpointURL:     "http://example.com",
		BucketName:      "bucket",
		AccessKeyID:     "access",
		SecretAccessKey: "super-secret",
	})
	if err == nil {
		t.Fatal("New() error = nil, want HTTPS validation error")
	}
	if strings.Contains(err.Error(), "super-secret") || strings.Contains(err.Error(), "access") {
		t.Fatalf("New() error leaks credentials: %v", err)
	}

	_, err = New(Config{
		EndpointURL: "https://r2.example.com",
		BucketName:  "bucket",
		AccessKeyID: "access",
	})
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("New(missing secret) error = %v, want ErrNotConfigured", err)
	}
}

func newTestStore(
	t *testing.T,
	handler http.Handler,
	configure func(*Config),
) *Store {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	config := Config{
		EndpointURL:      server.URL,
		BucketName:       "test-bucket",
		AccessKeyID:      "test-access",
		SecretAccessKey:  "test-secret",
		Region:           "auto",
		Timeout:          2 * time.Second,
		RetryMaxAttempts: 1,
		HTTPClient:       server.Client(),
	}
	if configure != nil {
		configure(&config)
	}
	store, err := New(config)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return store
}

func s3ErrorHandler(statusCode int, code string) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/xml")
		writer.WriteHeader(statusCode)
		_, _ = fmt.Fprintf(
			writer,
			"<Error><Code>%s</Code><Message>request failed</Message></Error>",
			code,
		)
	})
}
