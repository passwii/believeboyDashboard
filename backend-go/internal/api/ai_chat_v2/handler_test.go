package ai_chat_v2

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestAIChatV2RegistrarRegistersTwoRoutes(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrarWithOptions(
		&fakeV2Store{},
		testV2Config(),
		Options{Provider: &fakeV2Provider{}, Backend: ai.NewMemoryStreamBackend()},
	).RegisterRoutes(router, passthroughMiddleware)
	registered := make(map[string]bool)
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		registered[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("Walk() error = %v", err)
	}
	for _, route := range []string{
		"POST /api/v1/ai/conversations/{conversation_id}/messages/stream",
		"POST /api/v1/ai/conversations/{conversation_id}/cancel",
	} {
		if !registered[route] {
			t.Errorf("route %s is not registered", route)
		}
	}
}

func TestAIChatV2StreamUnconfiguredProviderReturns503BeforeStoreWrite(t *testing.T) {
	store := &fakeV2Store{conversation: v2Conversation(7, "新对话")}
	provider := &fakeV2Provider{configured: false}
	handler := NewHandlerWithOptions(store, testV2Config(), Options{
		Provider: provider,
		Backend:  ai.NewMemoryStreamBackend(),
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"hello"}`,
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Stream(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.appendCalls != 0 {
		t.Errorf("AppendTurn calls = %d, want 0", store.appendCalls)
	}
}

func TestAIChatV2StreamReturnsAnthropicEventsAndFinalizesDone(t *testing.T) {
	store := &fakeV2Store{
		conversation: v2Conversation(7, "新对话"),
		userMessage:  v2Message(1, 7, "user", "hello", true),
		assistant:    v2Message(2, 7, "assistant", "", false),
	}
	provider := &fakeV2Provider{
		models:          []string{"model-a"},
		streamChunks:    []ai.Chunk{{Type: ai.ChunkContent, Text: "你好"}},
		streamUsage:     ai.Usage{InputTokens: 4, OutputTokens: 2, TotalTokens: 6},
		completeContent: "问候",
	}
	handler := NewHandlerWithOptions(store, testV2Config(), Options{
		Provider: provider,
		Backend:  ai.NewMemoryStreamBackend(),
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"hello","model":"model-a"}`,
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Stream(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "text/event-stream; charset=utf-8" {
		t.Errorf("Content-Type = %q", contentType)
	}
	events := parseSSEEvents(t, recorder.Body.String())
	if len(events) < 5 {
		t.Fatalf("events = %#v", events)
	}
	if events[0].Payload["type"] != "message_start" || events[0].ID == "" {
		t.Errorf("first event = %#v", events[0])
	}
	if events[1].Payload["type"] != "content_block_start" ||
		events[2].Payload["type"] != "content_block_delta" {
		t.Errorf("content events = %#v", events[:3])
	}
	var done map[string]any
	for _, event := range events {
		if event.Payload["type"] == "done" {
			done = event.Payload
		}
	}
	if done == nil {
		t.Fatalf("done event missing: %#v", events)
	}
	assistant := done["assistant_message"].(map[string]any)
	if assistant["content"] != "你好" || assistant["total_tokens"].(float64) != 6 {
		t.Errorf("done assistant = %#v", assistant)
	}
	if done["conversation_title"] != "问候" || done["title_regenerated"] != true {
		t.Errorf("done title fields = %#v", done)
	}
	usage := done["token_usage"].(map[string]any)
	if usage["total_tokens"].(float64) != 6 {
		t.Errorf("token_usage = %#v", usage)
	}
	if store.finalized == nil || store.finalized.TotalTokens != 6 || !store.finalized.Complete {
		t.Errorf("finalize input = %#v", store.finalized)
	}
	if store.updatedTitle != "问候" {
		t.Errorf("updated title = %q", store.updatedTitle)
	}
	if provider.streamCalls != 1 || provider.completeCalls != 1 {
		t.Errorf("provider calls = stream %d complete %d", provider.streamCalls, provider.completeCalls)
	}
}

func TestAIChatV2ResumeUsesLastEventIDWithoutCreatingTurn(t *testing.T) {
	backend := ai.NewMemoryStreamBackend()
	ctx := context.Background()
	if err := backend.Begin(ctx, 7); err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	firstID, err := backend.Append(ctx, 7, "event", ai.NewMessageStart("message-1", "model-a", 1))
	if err != nil {
		t.Fatalf("Append(first) error = %v", err)
	}
	_, _ = backend.Append(ctx, 7, "event", ai.NewContentBlockDeltaText(0, "resumed"))
	_, _ = backend.Append(ctx, 7, "event", ai.NewMessageStop())
	if err := backend.End(ctx, 7); err != nil {
		t.Fatalf("End() error = %v", err)
	}

	store := &fakeV2Store{conversation: v2Conversation(7, "新对话")}
	handler := NewHandlerWithOptions(store, testV2Config(), Options{
		Provider: &fakeV2Provider{models: []string{"model-a"}},
		Backend:  backend,
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{}`,
		42,
	)
	request.Header.Set("Last-Event-ID", firstID)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Stream(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	events := parseSSEEvents(t, recorder.Body.String())
	if len(events) != 2 || events[0].Payload["type"] != "content_block_delta" {
		t.Errorf("resumed events = %#v", events)
	}
	if store.appendCalls != 0 || providerStreamCalls(handler) != 0 {
		t.Errorf("resume created a turn")
	}
}

func TestAIChatV2CancelFinalizesPartialContent(t *testing.T) {
	store := &fakeV2Store{
		conversation: v2Conversation(7, "新对话"),
		userMessage:  v2Message(1, 7, "user", "hello", true),
		assistant:    v2Message(2, 7, "assistant", "", false),
	}
	started := make(chan struct{})
	provider := &fakeV2Provider{
		models:        []string{"model-a"},
		streamChunks:  []ai.Chunk{{Type: ai.ChunkContent, Text: "partial"}},
		streamBlock:   true,
		streamStarted: started,
	}
	backend := ai.NewMemoryStreamBackend()
	handler := NewHandlerWithOptions(store, testV2Config(), Options{Provider: provider, Backend: backend})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"hello","model":"model-a"}`,
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.Stream(recorder, request)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("provider stream did not start")
	}
	cancelled, err := backend.Cancel(context.Background(), 7)
	if err != nil || !cancelled {
		t.Fatalf("Cancel() = (%t, %v)", cancelled, err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream handler did not stop after cancel")
	}
	if store.finalized == nil || store.finalized.Content != "partial" {
		t.Errorf("finalize input = %#v, want partial content", store.finalized)
	}
	if !strings.Contains(recorder.Body.String(), `"type":"error"`) ||
		!strings.Contains(recorder.Body.String(), `"code":"cancelled"`) {
		t.Errorf("cancel stream = %s", recorder.Body.String())
	}
}

func TestAIChatV2ValidationAndOwnershipStatuses(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		userID       *int64
		conversation *ai_chat.Conversation
		want         int
	}{
		{name: "invalid json", body: `{`, userID: int64Value(42), conversation: v2Conversation(7, "新对话"), want: http.StatusUnprocessableEntity},
		{name: "empty content", body: `{"content":"   "}`, userID: int64Value(42), conversation: v2Conversation(7, "新对话"), want: http.StatusBadRequest},
		{name: "missing identity", body: `{"content":"hello"}`, want: http.StatusNotFound},
		{name: "not found", body: `{"content":"hello"}`, userID: int64Value(42), want: http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeV2Store{conversation: tt.conversation}
			handler := NewHandlerWithOptions(store, testV2Config(), Options{
				Provider: &fakeV2Provider{models: []string{"model-a"}},
				Backend:  ai.NewMemoryStreamBackend(),
			})
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/v1/ai/conversations/7/messages/stream",
				strings.NewReader(tt.body),
			)
			request.Header.Set("Content-Type", "application/json")
			if tt.userID != nil {
				request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
					UserID: strconv.FormatInt(*tt.userID, 10),
				}))
			}
			request = withV2PathParam(request, "7")
			recorder := httptest.NewRecorder()
			handler.Stream(recorder, request)
			if recorder.Code != tt.want {
				t.Fatalf("status = %d, want %d; body = %s", recorder.Code, tt.want, recorder.Body.String())
			}
		})
	}
}

func TestAIChatV2WebSearchDisabledReturns503BeforeStoreWrite(t *testing.T) {
	store := &fakeV2Store{conversation: v2Conversation(7, "新对话")}
	handler := NewHandlerWithOptions(store, testV2Config(), Options{
		Provider: &fakeV2Provider{models: []string{"model-a"}},
		Backend:  ai.NewMemoryStreamBackend(),
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"hello","enable_web_search":true}`,
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Stream(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.appendCalls != 0 {
		t.Errorf("AppendTurn calls = %d, want 0", store.appendCalls)
	}
}

func TestAIChatV2StoreFailureReturns500(t *testing.T) {
	store := &fakeV2Store{
		conversation: v2Conversation(7, "新对话"),
		appendErr:    errors.New("database down"),
	}
	handler := NewHandlerWithOptions(store, testV2Config(), Options{
		Provider: &fakeV2Provider{models: []string{"model-a"}},
		Backend:  ai.NewMemoryStreamBackend(),
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"hello","model":"model-a"}`,
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Stream(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAIChatV2CancelEndpointReturnsFalseWhenNoActiveStream(t *testing.T) {
	store := &fakeV2Store{conversation: v2Conversation(7, "新对话")}
	backend := ai.NewMemoryStreamBackend()
	handler := NewHandlerWithOptions(store, testV2Config(), Options{
		Provider: &fakeV2Provider{models: []string{"model-a"}},
		Backend:  backend,
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/cancel",
		"",
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Cancel(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Body.String() != `{"cancelled":false}` {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestAIStreamMemoryFallbackRequiresExplicitNonProductionMode(t *testing.T) {
	cfg := testV2Config()
	cfg.AIChatRedisURL = ""
	cfg.AIChatStreamMemoryFallback = false
	if _, err := NewStreamBackendFromConfig(cfg); !errors.Is(err, ai.ErrStreamUnavailable) {
		t.Fatalf("fallback disabled error = %v, want ErrStreamUnavailable", err)
	}
	cfg.AIChatStreamMemoryFallback = true
	cfg.AppEnv = "production"
	if _, err := NewStreamBackendFromConfig(cfg); !errors.Is(err, ai.ErrStreamUnavailable) {
		t.Fatalf("production fallback error = %v, want ErrStreamUnavailable", err)
	}
	cfg.AppEnv = "test"
	backend, err := NewStreamBackendFromConfig(cfg)
	if err != nil {
		t.Fatalf("explicit test fallback error = %v", err)
	}
	if _, ok := backend.(*ai.MemoryStreamBackend); !ok {
		t.Fatalf("fallback backend = %T, want memory", backend)
	}
	_ = backend.Close()
}

func TestAIChatV2RunnerDeadlineEmitsTimeoutAndFinalizesPartial(t *testing.T) {
	backend := ai.NewMemoryStreamBackend()
	if err := backend.Begin(context.Background(), 7); err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	provider := &fakeV2Provider{
		models:       []string{"model-a"},
		streamChunks: []ai.Chunk{{Type: ai.ChunkContent, Text: "partial"}},
		streamBlock:  true,
	}
	finalized := make(chan RunResult, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	NewRunner(backend, provider).Run(ctx, RunInput{
		ConversationID: 7,
		Model:          "model-a",
		Messages:       []ai.Message{{Role: "user", Content: "hello"}},
		Finalize: func(_ context.Context, result RunResult) (*DonePayload, error) {
			finalized <- result
			return nil, nil
		},
	})
	select {
	case result := <-finalized:
		if result.FullText != "partial" || result.Complete || result.StopReason != "timeout" {
			t.Errorf("finalized result = %#v", result)
		}
	default:
		t.Fatal("runner did not finalize timed-out stream")
	}
	subscription, err := backend.Subscribe(context.Background(), 7, "0")
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer subscription.Close()
	foundTimeout := false
	for {
		entry, ok, err := subscription.Next(context.Background())
		if err != nil || !ok {
			break
		}
		if strings.Contains(string(entry.Data), `"code":"timeout"`) {
			foundTimeout = true
		}
	}
	if !foundTimeout {
		t.Fatal("timed-out stream omitted timeout SSE event")
	}
}

func TestAIChatV2RegenerateTargetReplacesAssistantAndUsesSearch(t *testing.T) {
	conversation := v2Conversation(7, "已有标题")
	store := &fakeV2Store{
		conversation: conversation,
		messages: []ai_chat.Message{
			v2Message(1, 7, "user", "original question", true),
			v2Message(2, 7, "assistant", "original answer", true),
		},
		assistant: v2Message(4, 7, "assistant", "", false),
	}
	searcher := &fakeV2Searcher{
		configured: true,
		result: ai.SearchResult{
			Cards:     []ai.SourceCard{{Title: "source", URL: "https://example.com"}},
			Context:   "search context",
			TimeRange: "month",
		},
	}
	provider := &fakeV2Provider{
		models:       []string{"model-a"},
		streamChunks: []ai.Chunk{{Type: ai.ChunkContent, Text: "new answer"}},
		streamUsage:  ai.Usage{InputTokens: 2, OutputTokens: 2, TotalTokens: 4},
	}
	handler := NewHandlerWithOptions(store, testV2Config(), Options{
		Provider: provider,
		Searcher: searcher,
		Backend:  ai.NewMemoryStreamBackend(),
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"","model":"model-a","regenerate":true,"target_message_id":2,"enable_web_search":true}`,
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Stream(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.replaceCalls != 1 || store.appendCalls != 0 {
		t.Errorf("store calls = replace %d append %d", store.replaceCalls, store.appendCalls)
	}
	if searcher.calls != 1 || provider.streamCalls != 1 {
		t.Errorf("external calls = search %d stream %d", searcher.calls, provider.streamCalls)
	}
	if len(provider.lastRequests) == 0 {
		t.Fatal("provider request was not captured")
	}
	messages := provider.lastRequests[0].Messages
	foundSearchContext := false
	for _, message := range messages {
		if message.Role == "system" && message.Content == "search context" {
			foundSearchContext = true
		}
	}
	if !foundSearchContext {
		t.Errorf("provider messages omit search context: %#v", messages)
	}
}

func TestAIChatV2RetriesBackupModelBeforeStreamingOutput(t *testing.T) {
	cfg := testV2Config()
	cfg.AIChatBackupModel = "backup-model"
	store := &fakeV2Store{
		conversation: v2Conversation(7, "existing"),
		userMessage:  v2Message(1, 7, "user", "hello", true),
		assistant:    v2Message(2, 7, "assistant", "", false),
	}
	provider := &fakeV2Provider{
		models:       []string{"model-a", "backup-model"},
		streamChunks: []ai.Chunk{{Type: ai.ChunkContent, Text: "backup answer"}},
		streamUsage:  ai.Usage{InputTokens: 2, OutputTokens: 3, TotalTokens: 5},
		modelErrors:  map[string]error{"model-a": errors.New("primary unavailable")},
	}
	handler := NewHandlerWithOptions(store, cfg, Options{
		Provider: provider,
		Backend:  ai.NewMemoryStreamBackend(),
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"hello","model":"model-a"}`,
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Stream(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if provider.streamCalls != 2 {
		t.Fatalf("stream calls = %d, want primary + backup", provider.streamCalls)
	}
	if store.finalized == nil || store.finalized.Content != "backup answer" ||
		store.finalized.TotalTokens != 5 {
		t.Errorf("finalize input = %#v", store.finalized)
	}
	if !strings.Contains(recorder.Body.String(), `"text":"backup answer"`) {
		t.Errorf("stream body = %s", recorder.Body.String())
	}
}

func TestAIChatV2EmptyProviderStreamReturnsErrorInsteadOfDone(t *testing.T) {
	store := &fakeV2Store{
		conversation: v2Conversation(7, "existing"),
		userMessage:  v2Message(1, 7, "user", "hello", true),
		assistant:    v2Message(2, 7, "assistant", "", false),
	}
	provider := &fakeV2Provider{models: []string{"model-a"}}
	handler := NewHandlerWithOptions(store, testV2Config(), Options{
		Provider: provider,
		Backend:  ai.NewMemoryStreamBackend(),
	})
	request := v2IdentityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"hello","model":"model-a"}`,
		42,
	)
	request = withV2PathParam(request, "7")
	recorder := httptest.NewRecorder()
	handler.Stream(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), `"type":"done"`) {
		t.Errorf("empty provider stream emitted done: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"message":"模型未返回内容"`) {
		t.Errorf("empty provider stream error = %s", recorder.Body.String())
	}
	if store.finalized == nil || store.finalized.Complete {
		t.Errorf("finalize = %#v, want incomplete", store.finalized)
	}
}

type sseTestEvent struct {
	ID      string
	Payload map[string]any
}

type fakeV2Searcher struct {
	configured bool
	result     ai.SearchResult
	err        error
	calls      int
}

func (searcher *fakeV2Searcher) Configured() bool { return searcher.configured }

func (searcher *fakeV2Searcher) Search(
	context.Context,
	string,
	int,
) (ai.SearchResult, error) {
	searcher.calls++
	return searcher.result, searcher.err
}

func parseSSEEvents(t *testing.T, raw string) []sseTestEvent {
	t.Helper()
	parsed := make([]sseTestEvent, 0)
	for _, block := range strings.Split(strings.TrimSpace(raw), "\n\n") {
		event := sseTestEvent{}
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "id: "):
				event.ID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "data: "):
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event.Payload); err != nil {
					t.Fatalf("decode SSE data: %v; block=%q", err, block)
				}
			}
		}
		if event.Payload != nil {
			parsed = append(parsed, event)
		}
	}
	return parsed
}

func testV2Config() config.Config {
	return config.Config{
		AppEnv:                         "test",
		AIChatProviderBaseURL:          "https://provider.example/v1",
		AIChatProviderAPIKey:           "key",
		AIChatDefaultModel:             "model-a",
		AIChatReasoningModels:          "model-a",
		AIChatDefaultReasoningEffort:   "medium",
		AIChatTimeoutSeconds:           90,
		AIChatMaxConversationTurns:     10,
		AIChatWebSearchBaseURL:         "https://search.example",
		AIChatWebSearchAPIKey:          "",
		AIChatWebSearchMaxResults:      5,
		AIChatStreamMaxDurationSeconds: 900,
	}
}

func v2Conversation(id int64, title string) *ai_chat.Conversation {
	createdAt := time.Date(2026, 11, 1, 2, 3, 4, 123000000, time.UTC)
	userID := int64(42)
	return &ai_chat.Conversation{
		ID: id, UserID: &userID, Title: title, CreatedAt: createdAt, UpdatedAt: createdAt,
	}
}

func v2Message(id, conversationID int64, role, content string, complete bool) ai_chat.Message {
	return ai_chat.Message{
		ID: id, ConversationID: conversationID, Role: role, Content: content,
		IsComplete: complete, Model: "unknown",
		CreatedAt: time.Date(2026, 11, 1, 2, 3, 4, 123000000, time.UTC),
	}
}

func v2IdentityRequest(method, target, body string, userID int64) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		UserID: strconv.FormatInt(userID, 10),
	}))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func withV2PathParam(request *http.Request, conversationID string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("conversation_id", conversationID)
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}

func passthroughMiddleware(next http.Handler) http.Handler { return next }

func int64Value(value int64) *int64 { return &value }

func providerStreamCalls(handler *Handler) int {
	provider := handler.provider.(*fakeV2Provider)
	return provider.streamCalls
}

type fakeV2Provider struct {
	configured      bool
	models          []string
	modelErr        error
	streamChunks    []ai.Chunk
	streamUsage     ai.Usage
	streamErr       error
	streamCalls     int
	streamBlock     bool
	streamStarted   chan struct{}
	completeContent string
	completeErr     error
	completeCalls   int
	lastRequests    []ai.ChatRequest
	modelErrors     map[string]error
	mu              sync.Mutex
}

func (provider *fakeV2Provider) Configured() bool {
	if provider.configured || provider.models != nil || provider.streamChunks != nil || provider.completeContent != "" {
		return true
	}
	return provider.configured
}

func (provider *fakeV2Provider) AvailableModels(context.Context) ([]string, error) {
	return provider.models, provider.modelErr
}

func (provider *fakeV2Provider) Complete(
	_ context.Context,
	request ai.ChatRequest,
) (string, ai.Usage, error) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.completeCalls++
	provider.lastRequests = append(provider.lastRequests, request)
	return provider.completeContent, ai.Usage{}, provider.completeErr
}

func (provider *fakeV2Provider) Stream(
	ctx context.Context,
	request ai.ChatRequest,
	emit func(ai.Chunk) error,
) (ai.Usage, error) {
	provider.mu.Lock()
	provider.streamCalls++
	provider.lastRequests = append(provider.lastRequests, request)
	modelErr := provider.modelErrors[request.Model]
	provider.mu.Unlock()
	if modelErr != nil {
		return ai.Usage{}, modelErr
	}
	for _, chunk := range provider.streamChunks {
		if err := emit(chunk); err != nil {
			return provider.streamUsage, err
		}
	}
	if provider.streamBlock {
		if provider.streamStarted != nil {
			close(provider.streamStarted)
		}
		<-ctx.Done()
		return provider.streamUsage, ctx.Err()
	}
	return provider.streamUsage, provider.streamErr
}

type fakeV2Store struct {
	conversation *ai_chat.Conversation
	messages     []ai_chat.Message
	userMessage  ai_chat.Message
	assistant    ai_chat.Message
	finalized    *ai_chat.FinalizeInput
	appendCalls  int
	replaceCalls int
	updatedTitle string
	err          error
	getErr       error
	appendErr    error
	replaceErr   error
	finalizeErr  error
}

func (store *fakeV2Store) ListConversations(context.Context, *int64) ([]ai_chat.Conversation, error) {
	return nil, store.err
}

func (store *fakeV2Store) CreateConversation(context.Context, string, int64) (ai_chat.Conversation, error) {
	return ai_chat.Conversation{}, store.err
}

func (store *fakeV2Store) GetConversation(context.Context, int64, *int64) (*ai_chat.Conversation, error) {
	return store.conversation, store.getErr
}

func (store *fakeV2Store) UpdateConversation(
	_ context.Context,
	_ int64,
	_ *int64,
	title *string,
) (ai_chat.Conversation, error) {
	if title != nil {
		store.updatedTitle = *title
		if store.conversation != nil {
			store.conversation.Title = *title
		}
	}
	if store.conversation == nil {
		return ai_chat.Conversation{}, store.err
	}
	return *store.conversation, store.err
}

func (store *fakeV2Store) DeleteConversation(context.Context, int64, *int64) (bool, error) {
	return true, store.err
}

func (store *fakeV2Store) ListMessages(context.Context, int64, *int64) ([]ai_chat.Message, error) {
	return store.messages, store.err
}

func (store *fakeV2Store) GetMessage(context.Context, int64, int64, *int64) (*ai_chat.Message, error) {
	return nil, store.err
}

func (store *fakeV2Store) UpdateMessage(context.Context, int64, int64, *int64, string) (ai_chat.Message, error) {
	return ai_chat.Message{}, store.err
}

func (store *fakeV2Store) DeleteMessage(context.Context, int64, int64, *int64) (bool, error) {
	return true, store.err
}

func (store *fakeV2Store) AppendTurn(
	_ context.Context,
	_ int64,
	_ *int64,
	_ string,
	_ string,
) (ai_chat.Message, ai_chat.Message, error) {
	store.appendCalls++
	return store.userMessage, store.assistant, store.appendErr
}

func (store *fakeV2Store) ReplaceAssistant(
	context.Context,
	int64,
	*int64,
	int64,
	string,
) (ai_chat.Message, error) {
	store.replaceCalls++
	return store.assistant, store.replaceErr
}

func (store *fakeV2Store) FinalizeAssistant(
	_ context.Context,
	input ai_chat.FinalizeInput,
) (*ai_chat.Message, *ai_chat.Conversation, error) {
	store.finalized = &input
	message := store.assistant
	message.Content = input.Content
	message.IsComplete = input.Complete
	message.PromptTokens = input.PromptTokens
	message.CompletionTokens = input.CompletionTokens
	message.TotalTokens = input.TotalTokens
	duration := input.DurationMS
	message.DurationMS = &duration
	conversation := *store.conversation
	conversation.TotalPromptTokens = input.PromptTokens
	conversation.TotalCompletionTokens = input.CompletionTokens
	conversation.TotalTokens = input.TotalTokens
	return &message, &conversation, store.finalizeErr
}

var _ ai_chat.Store = (*fakeV2Store)(nil)
var _ ai.Provider = (*fakeV2Provider)(nil)
var _ ai.Searcher = (*fakeV2Searcher)(nil)
