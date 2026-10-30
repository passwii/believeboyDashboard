package httpserver

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestProxyFallbackPreservesRequest(t *testing.T) {
	type capturedRequest struct {
		method   string
		path     string
		rawQuery string
		header   http.Header
		body     []byte
	}

	received := make(chan capturedRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read upstream body: %v", err)
		}
		received <- capturedRequest{
			method:   r.Method,
			path:     r.URL.Path,
			rawQuery: r.URL.RawQuery,
			header:   r.Header.Clone(),
			body:     body,
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(upstream.Close)

	gateway := newTestGateway(t, upstream.URL)
	body := []byte(`{"email":"operator@example.com","remember":true}`)
	req, err := http.NewRequest(
		http.MethodPost,
		gateway.URL+"/api/v1/auth/login?operator=alice&scope=a%2Fb&timezone=Asia%2FShanghai",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	req.Header.Set("Authorization", "Bearer access-token")
	req.Header.Set("X-API-Key", "client-api-key")
	req.Header.Set("X-Client-Id", "bb-macos-client")
	req.Header.Set("X-Operator", "alice")
	req.Header.Set("X-Is-Admin", "true")
	req.Header.Set("X-Trusted-Proxy-Secret", "test-proxy-secret")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Range", "items=0-99")

	resp, err := gateway.Client().Do(req)
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}

	got := <-received
	if got.method != http.MethodPost {
		t.Errorf("method = %q, want %q", got.method, http.MethodPost)
	}
	if got.path != "/api/v1/auth/login" {
		t.Errorf("path = %q, want %q", got.path, "/api/v1/auth/login")
	}
	if got.rawQuery != "operator=alice&scope=a%2Fb&timezone=Asia%2FShanghai" {
		t.Errorf("raw query = %q, want it unchanged", got.rawQuery)
	}
	if !bytes.Equal(got.body, body) {
		t.Errorf("body = %q, want %q", got.body, body)
	}

	wantHeaders := map[string]string{
		"Authorization": "Bearer access-token",
		"X-Api-Key":     "client-api-key",
		"X-Client-Id":   "bb-macos-client",
		"X-Operator":    "alice",
		"X-Is-Admin":    "true",
		"Content-Type":  "application/json",
		"Accept":        "application/json",
		"Range":         "items=0-99",
	}
	for key, want := range wantHeaders {
		if value := got.header.Get(key); value != want {
			t.Errorf("header %s = %q, want %q", key, value, want)
		}
	}
	if got.header.Get("X-Trusted-Proxy-Secret") != "" {
		t.Error("trusted proxy secret was forwarded for a non-master request")
	}
}

func TestProxyFallbackRejectsMasterKeyWithoutTrustedProxySecret(t *testing.T) {
	var upstreamHit atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamHit.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)

	gateway := newTestGateway(t, upstream.URL)
	req, err := http.NewRequest(http.MethodGet, gateway.URL+"/api/v1/projects/manage", nil)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	req.Header.Set("X-API-Key", "test-api-key")
	req.Header.Set("X-User-Id", "victim-user")

	resp, err := gateway.Client().Do(req)
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", resp.StatusCode, body)
	}
	if upstreamHit.Load() {
		t.Fatal("FastAPI fallback was reached with an untrusted master key")
	}
}

func TestProxyFallbackRejectsRepeatedAPIKeyMasterWithoutTrustedProxySecret(t *testing.T) {
	var upstreamHit atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamHit.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)

	gateway := newTestGateway(t, upstream.URL)
	req, err := http.NewRequest(
		http.MethodGet,
		gateway.URL+"/api/v1/projects/manage?api_key=decoy&api_key=test-api-key",
		nil,
	)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	req.Header.Set("X-User-Id", "victim-user")

	resp, err := gateway.Client().Do(req)
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", resp.StatusCode, body)
	}
	if upstreamHit.Load() {
		t.Fatal("FastAPI fallback was reached with a repeated master key")
	}
}

func TestProxyFallbackAllowsMasterKeyWithTrustedProxySecretAndStripsIt(t *testing.T) {
	receivedHeader := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeader <- r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(upstream.Close)

	gateway := newTestGateway(t, upstream.URL)
	req, err := http.NewRequest(http.MethodGet, gateway.URL+"/api/v1/projects/manage", nil)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	req.Header.Set("X-API-Key", "test-api-key")
	req.Header.Set("X-Trusted-Proxy-Secret", "test-proxy-secret")
	req.Header.Set("X-User-Id", "proxied-user")

	resp, err := gateway.Client().Do(req)
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want 204; body = %s", resp.StatusCode, body)
	}
	got := <-receivedHeader
	if got.Get("X-Trusted-Proxy-Secret") != "" {
		t.Fatal("trusted proxy secret was forwarded upstream")
	}
	if got.Get("X-User-Id") != "proxied-user" {
		t.Errorf("X-User-Id = %q, want proxied-user", got.Get("X-User-Id"))
	}
}

func TestProxyFallbackPreservesResponse(t *testing.T) {
	responseBody := []byte(`{"status":"ok","items":[1,2,3]}`)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("X-FastAPI-Trace", "trace-456")
		w.Header().Add("X-FastAPI-Multi", "one")
		w.Header().Add("X-FastAPI-Multi", "two")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write(responseBody)
	}))
	t.Cleanup(upstream.Close)

	gateway := newTestGateway(t, upstream.URL)
	resp, err := gateway.Client().Get(gateway.URL + "/api/v1/system-management/profile")
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}

	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusAccepted)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want it unchanged", got)
	}
	if got := resp.Header.Get("X-FastAPI-Trace"); got != "trace-456" {
		t.Errorf("X-FastAPI-Trace = %q, want %q", got, "trace-456")
	}
	if got := resp.Header.Values("X-FastAPI-Multi"); len(got) != 2 || got[0] != "one" || got[1] != "two" {
		t.Errorf("X-FastAPI-Multi = %#v, want [one two]", got)
	}
	if !bytes.Equal(body, responseBody) {
		t.Errorf("body = %q, want %q", body, responseBody)
	}
}

func TestProxyFallbackPassesMultipartBody(t *testing.T) {
	var multipartBody bytes.Buffer
	writer := multipart.NewWriter(&multipartBody)
	filePart, err := writer.CreateFormFile("file", "sample.txt")
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if _, err := filePart.Write([]byte("hello multipart")); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.WriteField("note", "preserve this body"); err != nil {
		t.Fatalf("WriteField() error = %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	type capturedMultipart struct {
		contentType   string
		contentLength int64
		body          []byte
	}
	received := make(chan capturedMultipart, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read multipart body: %v", err)
		}
		received <- capturedMultipart{
			contentType:   r.Header.Get("Content-Type"),
			contentLength: r.ContentLength,
			body:          body,
		}
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(upstream.Close)

	gateway := newTestGateway(t, upstream.URL)
	req, err := http.NewRequest(http.MethodPost, gateway.URL+"/api/v1/uploads", bytes.NewReader(multipartBody.Bytes()))
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := gateway.Client().Do(req)
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusCreated)
	}

	got := <-received
	if got.contentType != writer.FormDataContentType() {
		t.Errorf("Content-Type = %q, want %q", got.contentType, writer.FormDataContentType())
	}
	if got.contentLength != int64(multipartBody.Len()) {
		t.Errorf("Content-Length = %d, want %d", got.contentLength, multipartBody.Len())
	}
	if !bytes.Equal(got.body, multipartBody.Bytes()) {
		t.Errorf("multipart body was modified")
	}
}

func TestProxyFallbackStreamsSSE(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseUpstream := func() {
		releaseOnce.Do(func() {
			close(release)
		})
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = fmt.Fprint(w, "data: second\n\n")
		w.(http.Flusher).Flush()
	}))
	t.Cleanup(func() {
		releaseUpstream()
		upstream.Close()
	})

	gateway := newTestGateway(t, upstream.URL)
	t.Cleanup(releaseUpstream)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, gateway.URL+"/api/v1/events", nil)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext() error = %v", err)
	}

	resp, err := gateway.Client().Do(req)
	if err != nil {
		t.Fatalf("gateway request error = %v", err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("Content-Type = %q, want %q", got, "text/event-stream")
	}

	reader := bufio.NewReader(resp.Body)
	firstLine := readLineWithin(t, reader, 2*time.Second)
	if firstLine != "data: first\n" {
		t.Errorf("first SSE line = %q, want %q", firstLine, "data: first\n")
	}
	releaseUpstream()
}

func TestProxyFallbackCancelsUpstreamRequest(t *testing.T) {
	upstreamStarted := make(chan struct{})
	upstreamCanceled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(upstreamStarted)
		<-r.Context().Done()
		close(upstreamCanceled)
	}))
	t.Cleanup(upstream.Close)

	gateway := newTestGateway(t, upstream.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	requestErr := make(chan error, 1)
	go func() {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, gateway.URL+"/api/v1/slow", nil)
		if err != nil {
			requestErr <- err
			return
		}
		resp, err := gateway.Client().Do(req)
		if resp != nil {
			_ = resp.Body.Close()
		}
		requestErr <- err
	}()

	select {
	case <-upstreamStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request did not start")
	}

	cancel()

	select {
	case <-upstreamCanceled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request context was not canceled")
	}

	select {
	case err := <-requestErr:
		if err == nil {
			t.Fatal("gateway request error = nil, want cancellation error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("gateway request did not stop after client cancellation")
	}
}

func newTestGateway(t *testing.T, upstreamURL string) *httptest.Server {
	t.Helper()

	handler, err := NewRouter(config.Config{
		Addr:               "127.0.0.1:8200",
		FastAPIOrigin:      upstreamURL,
		APIKey:             "test-api-key",
		TrustedProxySecret: "test-proxy-secret",
		DatabaseURL:        "postgres://localhost/believeboy",
		RedisURL:           "redis://localhost:6379/0",
		OwnedModules:       map[string]bool{},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), OwnedStores{})
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}

	gateway := httptest.NewServer(handler)
	t.Cleanup(gateway.Close)
	return gateway
}

func readLineWithin(t *testing.T, reader *bufio.Reader, timeout time.Duration) string {
	t.Helper()

	type result struct {
		line string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		line, err := reader.ReadString('\n')
		done <- result{line: line, err: err}
	}()

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("read SSE line: %v", got.err)
		}
		return got.line
	case <-time.After(timeout):
		t.Fatal("SSE line was not flushed promptly")
		return ""
	}
}
