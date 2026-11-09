package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestOpenAIProviderStreamsThinkingTextAndUsage(t *testing.T) {
	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s, want /v1/chat/completions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Errorf("decode request: %v", err)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"thinking\":\"先分析\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":21,\"completion_tokens\":9,\"total_tokens\":30}}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)

	provider := NewOpenAIProvider(ProviderConfig{
		BaseURL:      server.URL + "/v1",
		APIKey:       "test-key",
		DefaultModel: "model-a",
		Timeout:      time.Second,
		HTTPClient:   server.Client(),
	})
	chunks := make([]Chunk, 0, 3)
	usage, err := provider.Stream(context.Background(), ChatRequest{
		Model:           "model-a",
		ReasoningEffort: "high",
		Messages: []Message{
			{Role: "system", Content: "system prompt"},
			{Role: "user", Content: "hello"},
		},
	}, func(chunk Chunk) error {
		chunks = append(chunks, chunk)
		return nil
	})
	if err != nil {
		t.Fatalf("Stream() error = %v", err)
	}
	if usage != (Usage{InputTokens: 21, OutputTokens: 9, TotalTokens: 30}) {
		t.Fatalf("usage = %#v", usage)
	}
	if len(chunks) != 3 {
		t.Fatalf("chunks = %#v, want 3 chunks", chunks)
	}
	if chunks[0].Type != ChunkThinking || chunks[0].Text != "先分析" {
		t.Errorf("thinking chunk = %#v", chunks[0])
	}
	if chunks[1].Type != ChunkContent || chunks[1].Text != "你好" {
		t.Errorf("content chunk = %#v", chunks[1])
	}
	if chunks[2].Type != ChunkUsage || chunks[2].Usage == nil {
		t.Errorf("usage chunk = %#v", chunks[2])
	}

	if requestBody["model"] != "model-a" || requestBody["stream"] != true {
		t.Errorf("request body = %#v", requestBody)
	}
	reasoning, ok := requestBody["reasoning"].(map[string]any)
	if !ok || reasoning["effort"] != "high" {
		t.Errorf("reasoning = %#v, want effort high", requestBody["reasoning"])
	}
	messages, ok := requestBody["messages"].([]any)
	if !ok || len(messages) != 2 {
		t.Fatalf("messages = %#v", requestBody["messages"])
	}
}

func TestOpenAIProviderStreamReturnsTypedHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":{"message":"rate limited"}}`, http.StatusTooManyRequests)
	}))
	t.Cleanup(server.Close)

	provider := NewOpenAIProvider(ProviderConfig{
		BaseURL:      server.URL,
		APIKey:       "key",
		DefaultModel: "model-a",
		Timeout:      time.Second,
		HTTPClient:   server.Client(),
	})
	_, err := provider.Stream(context.Background(), ChatRequest{Model: "model-a"}, func(Chunk) error {
		return nil
	})
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error = %T %v, want *ProviderError", err, err)
	}
	if providerErr.StatusCode != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", providerErr.StatusCode)
	}
}

func TestOpenAIProviderStreamCancellationClosesUpstream(t *testing.T) {
	firstChunk := make(chan struct{}, 1)
	upstreamClosed := make(chan struct{}, 1)
	var once sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		once.Do(func() { firstChunk <- struct{}{} })
		<-r.Context().Done()
		once.Do(func() {})
		upstreamClosed <- struct{}{}
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithCancel(context.Background())
	provider := NewOpenAIProvider(ProviderConfig{
		BaseURL:      server.URL,
		APIKey:       "key",
		DefaultModel: "model-a",
		Timeout:      time.Second,
		HTTPClient:   server.Client(),
	})
	streamErr := make(chan error, 1)
	go func() {
		_, err := provider.Stream(ctx, ChatRequest{Model: "model-a"}, func(Chunk) error {
			cancel()
			return nil
		})
		streamErr <- err
	}()
	select {
	case <-firstChunk:
	case <-time.After(2 * time.Second):
		t.Fatal("provider did not receive the first chunk")
	}
	select {
	case <-upstreamClosed:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not canceled")
	}
	if err := <-streamErr; !errors.Is(err, context.Canceled) {
		t.Errorf("Stream() error = %v, want context canceled", err)
	}
}

func TestOpenAIProviderCompleteAndListModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/models":
			_, _ = io.WriteString(w, `{"data":[{"id":"model-a"},{"id":"model-b"},{"id":"model-a"}]}`)
		case "/chat/completions":
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":" 标题：Go 迁移 "}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	provider := NewOpenAIProvider(ProviderConfig{
		BaseURL:      server.URL + "/",
		APIKey:       "key",
		DefaultModel: "model-a",
		Timeout:      time.Second,
		HTTPClient:   server.Client(),
	})
	models, err := provider.AvailableModels(context.Background())
	if err != nil {
		t.Fatalf("AvailableModels() error = %v", err)
	}
	if strings.Join(models, ",") != "model-a,model-b" {
		t.Errorf("models = %#v", models)
	}
	content, usage, err := provider.Complete(context.Background(), ChatRequest{
		Model:    "model-a",
		Messages: []Message{{Role: "user", Content: "title"}},
	})
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if content != " 标题：Go 迁移 " || usage.TotalTokens != 7 {
		t.Errorf("content/usage = %q/%#v", content, usage)
	}
}
