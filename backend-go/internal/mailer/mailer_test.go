package mailer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMailerSendSuccessWithHeadersAndPayload(t *testing.T) {
	t.Parallel()
	var mutex sync.Mutex
	var received struct {
		Method        string
		Path          string
		Authorization string
		ContentType   string
		Idempotency   string
		Payload       struct {
			From    string   `json:"from"`
			To      []string `json:"to"`
			Subject string   `json:"subject"`
			HTML    string   `json:"html"`
			Text    string   `json:"text"`
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		received.Method = request.Method
		received.Path = request.URL.Path
		received.Authorization = request.Header.Get("Authorization")
		received.ContentType = request.Header.Get("Content-Type")
		received.Idempotency = request.Header.Get("Idempotency-Key")
		body, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(body, &received.Payload)
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"id":"email_123"}`))
	}))
	defer server.Close()

	mailer := New(Config{
		APIKey:     "re_test_secret",
		From:       "alerts@example.com",
		BaseURL:    server.URL,
		Timeout:    time.Second,
		HTTPClient: server.Client(),
	})
	result, err := mailer.Send(context.Background(), Message{
		To:             "Person <person@example.com>",
		Subject:        "Daily report",
		HTML:           "<p>report</p>",
		Text:           "report",
		IdempotencyKey: "report:2026-11-08",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if result.ID != "email_123" || result.StatusCode != http.StatusOK {
		t.Fatalf("Send() result = %#v", result)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if received.Method != http.MethodPost || received.Path != "/emails" {
		t.Fatalf("request = %s %s", received.Method, received.Path)
	}
	if received.Authorization != "Bearer re_test_secret" {
		t.Fatalf("Authorization = %q", received.Authorization)
	}
	if received.ContentType != "application/json" {
		t.Fatalf("Content-Type = %q", received.ContentType)
	}
	if received.Idempotency != "report:2026-11-08" {
		t.Fatalf("Idempotency-Key = %q", received.Idempotency)
	}
	if received.Payload.From != "alerts@example.com" ||
		received.Payload.Subject != "Daily report" ||
		received.Payload.HTML != "<p>report</p>" ||
		received.Payload.Text != "report" {
		t.Fatalf("payload = %#v", received.Payload)
	}
	if len(received.Payload.To) != 1 || received.Payload.To[0] != "Person <person@example.com>" {
		t.Fatalf("to = %#v", received.Payload.To)
	}
}

func TestMailerSendAcceptsTextOnly(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"id":"email_text"}`))
	}))
	defer server.Close()
	mailer := New(Config{
		APIKey:     "key",
		From:       "alerts@example.com",
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
	})
	result, err := mailer.SendText(context.Background(), "person@example.com", "Subject", "body", "")
	if err != nil {
		t.Fatalf("SendText() error = %v", err)
	}
	if result.ID != "email_text" {
		t.Fatalf("SendText() result = %#v", result)
	}
}

func TestMailerProviderErrors(t *testing.T) {
	t.Parallel()
	testCases := []struct {
		name           string
		status         int
		body           string
		retryAfter     string
		wantStatus     int
		wantRetryAfter time.Duration
	}{
		{
			name:       "client error",
			status:     http.StatusUnprocessableEntity,
			body:       `{"name":"validation_error","message":"invalid to"}`,
			wantStatus: http.StatusUnprocessableEntity,
		},
		{
			name:           "server error",
			status:         http.StatusServiceUnavailable,
			body:           `{"name":"internal_error","message":"try later"}`,
			retryAfter:     "2",
			wantStatus:     http.StatusServiceUnavailable,
			wantRetryAfter: 2 * time.Second,
		},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if testCase.retryAfter != "" {
					writer.Header().Set("Retry-After", testCase.retryAfter)
				}
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(testCase.status)
				_, _ = writer.Write([]byte(testCase.body))
			}))
			defer server.Close()
			mailer := New(Config{
				APIKey:     "super-secret-key",
				From:       "alerts@example.com",
				BaseURL:    server.URL,
				HTTPClient: server.Client(),
			})
			_, err := mailer.Send(context.Background(), Message{
				To:      "person@example.com",
				Subject: "Subject",
				Text:    "body",
			})
			var apiError *APIError
			if !errors.As(err, &apiError) {
				t.Fatalf("Send() error = %T %v, want *APIError", err, err)
			}
			if apiError.StatusCode != testCase.wantStatus || apiError.Name == "" || apiError.Message == "" {
				t.Fatalf("APIError = %#v", apiError)
			}
			if apiError.RetryAfter != testCase.wantRetryAfter {
				t.Fatalf("RetryAfter = %s, want %s", apiError.RetryAfter, testCase.wantRetryAfter)
			}
			if strings.Contains(err.Error(), "super-secret-key") {
				t.Fatalf("error leaks API key: %v", err)
			}
		})
	}
}

func TestMailerMalformedSuccessResponses(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{`, `{}`, `{"id":""}`, `not-json`} {
		body := body
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(http.StatusOK)
				_, _ = writer.Write([]byte(body))
			}))
			defer server.Close()
			mailer := New(Config{
				APIKey:     "key",
				From:       "alerts@example.com",
				BaseURL:    server.URL,
				HTTPClient: server.Client(),
			})
			_, err := mailer.Send(context.Background(), Message{
				To:      "person@example.com",
				Subject: "Subject",
				Text:    "body",
			})
			if !errors.Is(err, ErrMalformedResponse) {
				t.Fatalf("Send() error = %v, want ErrMalformedResponse", err)
			}
		})
	}
}

func TestMailerMissingKeyFailsClosed(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	mailer := New(Config{
		From:       "alerts@example.com",
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
	})
	if mailer.Configured() {
		t.Fatal("Configured() = true without API key")
	}
	_, err := mailer.Send(context.Background(), Message{
		To:      "person@example.com",
		Subject: "Subject",
		Text:    "body",
	})
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("Send() error = %v, want ErrNotConfigured", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("missing key made %d requests, want 0", calls.Load())
	}
}

func TestMailerRejectsInvalidMessageBeforeNetwork(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	mailer := New(Config{
		APIKey:          "key",
		From:            "alerts@example.com",
		BaseURL:         server.URL,
		HTTPClient:      server.Client(),
		MaxMessageBytes: 8,
	})

	_, err := mailer.Send(context.Background(), Message{
		To:      "person@example.com",
		Subject: "Subject",
		Text:    "too large",
	})
	if !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("Send() error = %v, want ErrInvalidMessage", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid message made %d requests, want 0", calls.Load())
	}
}

func TestMailerResponseSizeLimit(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"id":"` + strings.Repeat("x", 100) + `"}`))
	}))
	defer server.Close()
	mailer := New(Config{
		APIKey:           "key",
		From:             "alerts@example.com",
		BaseURL:          server.URL,
		HTTPClient:       server.Client(),
		MaxResponseBytes: 16,
	})
	_, err := mailer.Send(context.Background(), Message{
		To:      "person@example.com",
		Subject: "Subject",
		Text:    "body",
	})
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("Send() error = %v, want ErrResponseTooLarge", err)
	}
}

func TestMailerContextCancellationAndTimeout(t *testing.T) {
	t.Parallel()
	t.Run("already cancelled", func(t *testing.T) {
		t.Parallel()
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls.Add(1)
			writer.WriteHeader(http.StatusOK)
		}))
		defer server.Close()
		mailer := New(Config{
			APIKey:     "key",
			From:       "alerts@example.com",
			BaseURL:    server.URL,
			HTTPClient: server.Client(),
		})
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := mailer.Send(ctx, Message{
			To:      "person@example.com",
			Subject: "Subject",
			Text:    "body",
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Send() error = %v, want context.Canceled", err)
		}
		if calls.Load() != 0 {
			t.Fatalf("cancelled request made %d calls, want 0", calls.Load())
		}
	})

	t.Run("request timeout", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			select {
			case <-request.Context().Done():
			case <-time.After(time.Second):
			}
		}))
		defer server.Close()
		mailer := New(Config{
			APIKey:     "key",
			From:       "alerts@example.com",
			BaseURL:    server.URL,
			HTTPClient: server.Client(),
			Timeout:    75 * time.Millisecond,
		})
		started := time.Now()
		_, err := mailer.Send(context.Background(), Message{
			To:      "person@example.com",
			Subject: "Subject",
			Text:    "body",
		})
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Send() error = %v, want context deadline", err)
		}
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("timeout took %s, want under 1s", elapsed)
		}
	})
}

func TestMailerRejectsNonLoopbackHTTPBaseURL(t *testing.T) {
	t.Parallel()
	mailer := New(Config{
		APIKey:  "key",
		From:    "alerts@example.com",
		BaseURL: "http://example.com",
	})
	if mailer.Configured() {
		t.Fatal("Configured() = true for insecure base URL")
	}
	_, err := mailer.Send(context.Background(), Message{
		To:      "person@example.com",
		Subject: "Subject",
		Text:    "body",
	})
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("Send() error = %v, want ErrNotConfigured", err)
	}
}
