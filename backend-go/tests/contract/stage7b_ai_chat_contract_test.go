package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat_usage"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat_v2"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_file_upload"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestStage7BAIChatContract(t *testing.T) {
	chatStore := stage7BNewChatStore()
	usageStore := &stage7BUsageStore{
		freshness: ai_chat_usage.Freshness{
			LatestDataDate: stage7BTimePointer(time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)),
		},
		rows: []ai_chat_usage.SnapshotRow{{
			DataDate:          time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC),
			Model:             "model-a",
			PromptTokens:      3,
			CompletionTokens:  4,
			TotalTokens:       7,
			MessageCount:      1,
			ConversationCount: 1,
		}},
	}
	provider := &stage7BProvider{models: []string{"model-a", "reasoning"}}
	cfg := stage7BConfig()
	backend := ai.NewMemoryStreamBackend()
	router := stage7BRouter(chatStore, usageStore, provider, cfg, backend)

	configRecorder := stage7BRequest(router, http.MethodGet, "/api/v1/ai/config", "")
	if configRecorder.Code != http.StatusOK {
		t.Fatalf("config status = %d, body=%s", configRecorder.Code, configRecorder.Body.String())
	}
	configBody := stage7BObject(t, configRecorder.Body.Bytes())
	for _, key := range []string{
		"provider_configured", "web_search_configured", "models", "default_model",
		"premium_models", "basic_models", "reasoning_models",
		"default_reasoning_effort", "timeout_seconds", "max_conversation_turns",
		"web_search_max_results",
	} {
		if _, ok := configBody[key]; !ok {
			t.Errorf("config missing %q: %#v", key, configBody)
		}
	}

	listRecorder := stage7BRequest(router, http.MethodGet, "/api/v1/ai/conversations", "")
	if listRecorder.Code != http.StatusOK || !strings.Contains(listRecorder.Body.String(), `"id":7`) {
		t.Errorf("list = %d %s", listRecorder.Code, listRecorder.Body.String())
	}
	createRecorder := stage7BRequest(
		router,
		http.MethodPost,
		"/api/v1/ai/conversations",
		`{"title":"title"}`,
	)
	if createRecorder.Code != http.StatusOK {
		t.Fatalf("create = %d %s", createRecorder.Code, createRecorder.Body.String())
	}
	created := stage7BObject(t, createRecorder.Body.Bytes())
	for _, key := range []string{
		"id", "title", "created_at", "updated_at",
		"total_prompt_tokens", "total_completion_tokens", "total_tokens",
	} {
		if _, ok := created[key]; !ok {
			t.Errorf("create missing %q", key)
		}
	}

	patchConversationRecorder := stage7BRequest(
		router,
		http.MethodPatch,
		"/api/v1/ai/conversations/7",
		`{"title":"renamed"}`,
	)
	if patchConversationRecorder.Code != http.StatusOK {
		t.Errorf("patch conversation = %d %s", patchConversationRecorder.Code, patchConversationRecorder.Body.String())
	}
	titleRecorder := stage7BRequest(
		router,
		http.MethodPost,
		"/api/v1/ai/conversations/7/regenerate-title",
		"",
	)
	titleBody := stage7BObject(t, titleRecorder.Body.Bytes())
	if titleRecorder.Code != http.StatusOK || titleBody["regenerated"] != true {
		t.Errorf("regenerate title = %d %#v", titleRecorder.Code, titleBody)
	}

	messagesRecorder := stage7BRequest(
		router,
		http.MethodGet,
		"/api/v1/ai/conversations/7/messages",
		"",
	)
	if messagesRecorder.Code != http.StatusOK {
		t.Fatalf("messages = %d %s", messagesRecorder.Code, messagesRecorder.Body.String())
	}
	var messages []map[string]any
	if err := json.Unmarshal(messagesRecorder.Body.Bytes(), &messages); err != nil {
		t.Fatalf("decode messages: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("messages = %#v", messages)
	}
	for _, key := range []string{
		"id", "conversation_id", "role", "content", "search_sources",
		"search_time_range", "is_complete", "prompt_tokens",
		"completion_tokens", "total_tokens", "duration_ms", "created_at",
	} {
		if _, ok := messages[0][key]; !ok {
			t.Errorf("message missing %q: %#v", key, messages[0])
		}
	}
	patchMessageRecorder := stage7BRequest(
		router,
		http.MethodPatch,
		"/api/v1/ai/conversations/7/messages/1",
		`{"content":"updated"}`,
	)
	if patchMessageRecorder.Code != http.StatusOK ||
		!strings.Contains(patchMessageRecorder.Body.String(), `"content":"updated"`) {
		t.Errorf("patch message = %d %s", patchMessageRecorder.Code, patchMessageRecorder.Body.String())
	}
	deleteMessageRecorder := stage7BRequest(
		router,
		http.MethodDelete,
		"/api/v1/ai/conversations/7/messages/1",
		"",
	)
	if deleteMessageRecorder.Code != http.StatusNoContent || deleteMessageRecorder.Body.Len() != 0 {
		t.Errorf("delete message = %d %s", deleteMessageRecorder.Code, deleteMessageRecorder.Body.String())
	}

	usageRecorder := stage7BRequest(router, http.MethodGet, "/api/v1/ai/usage/stats?range=7d", "")
	if usageRecorder.Code != http.StatusOK {
		t.Fatalf("usage = %d %s", usageRecorder.Code, usageRecorder.Body.String())
	}
	usageBody := stage7BObject(t, usageRecorder.Body.Bytes())
	if usageBody["range"] != "7d" || len(usageBody["daily"].([]any)) != 7 ||
		len(usageBody["by_model"].([]any)) != 1 {
		t.Errorf("usage body = %#v", usageBody)
	}

	streamRecorder := stage7BRequest(
		router,
		http.MethodPost,
		"/api/v1/ai/conversations/7/messages/stream",
		`{"content":"hello","model":"model-a"}`,
	)
	if streamRecorder.Code != http.StatusOK {
		t.Fatalf("stream = %d %s", streamRecorder.Code, streamRecorder.Body.String())
	}
	streamText := streamRecorder.Body.String()
	if !strings.Contains(streamText, `"type":"message_start"`) ||
		!strings.Contains(streamText, `"type":"done"`) ||
		!strings.Contains(streamText, `"type":"message_stop"`) {
		t.Errorf("stream events = %s", streamText)
	}

	// The v2 runner ends its stream asynchronously (defer backend.End) after
	// writing message_stop, so a /cancel issued right after the response can
	// still observe the conversation as live and return {"cancelled":true}.
	// Wait for the backend to leave the live state before asserting the
	// post-completion contract.
	waitDeadline := time.Now().Add(5 * time.Second)
	for {
		live, err := backend.IsLive(context.Background(), 7)
		if err != nil {
			t.Fatalf("IsLive() error = %v", err)
		}
		if !live {
			break
		}
		if time.Now().After(waitDeadline) {
			t.Fatal("stream did not leave live state before cancel assertion")
		}
		time.Sleep(time.Millisecond)
	}

	cancelRecorder := stage7BRequest(
		router,
		http.MethodPost,
		"/api/v1/ai/conversations/7/cancel",
		"",
	)
	if cancelRecorder.Code != http.StatusOK || cancelRecorder.Body.String() != `{"cancelled":false}` {
		t.Errorf("cancel = %d %s", cancelRecorder.Code, cancelRecorder.Body.String())
	}

	uploadRecorder := stage7BUpload(router, "sample.txt", []byte("hello"))
	if uploadRecorder.Code != http.StatusOK {
		t.Fatalf("upload = %d %s", uploadRecorder.Code, uploadRecorder.Body.String())
	}
	uploadBody := stage7BObject(t, uploadRecorder.Body.Bytes())
	for _, key := range []string{"file_name", "file_type", "content", "truncated", "truncated_note"} {
		if _, ok := uploadBody[key]; !ok {
			t.Errorf("upload missing %q", key)
		}
	}

	deleteConversationRecorder := stage7BRequest(
		router,
		http.MethodDelete,
		"/api/v1/ai/conversations/7",
		"",
	)
	if deleteConversationRecorder.Code != http.StatusNoContent {
		t.Errorf("delete conversation = %d %s", deleteConversationRecorder.Code, deleteConversationRecorder.Body.String())
	}
}

func TestStage7BAIChatResumeContract(t *testing.T) {
	backend := ai.NewMemoryStreamBackend()
	ctx := context.Background()
	if err := backend.Begin(ctx, 7); err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	firstID, err := backend.Append(ctx, 7, "event", ai.NewMessageStart("message-1", "model-a", 1))
	if err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	_, _ = backend.Append(ctx, 7, "event", ai.NewContentBlockDeltaText(0, "resume"))
	_, _ = backend.Append(ctx, 7, "event", ai.NewMessageStop())
	if err := backend.End(ctx, 7); err != nil {
		t.Fatalf("End() error = %v", err)
	}
	chatStore := stage7BNewChatStore()
	usageStore := &stage7BUsageStore{}
	cfg := stage7BConfig()
	router := stage7BRouter(chatStore, usageStore, &stage7BProvider{models: []string{"model-a"}}, cfg, backend)

	request := stage7BHTTPRequest(http.MethodPost, "/api/v1/ai/conversations/7/messages/stream", "{}")
	request.Header.Set("Last-Event-ID", firstID)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("resume = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "id: ") ||
		!strings.Contains(recorder.Body.String(), `"text":"resume"`) {
		t.Errorf("resume stream = %s", recorder.Body.String())
	}
}

func stage7BRouter(
	chatStore ai_chat.Store,
	usageStore ai_chat_usage.Store,
	provider ai.Provider,
	cfg config.Config,
	backend ai.StreamBackend,
) http.Handler {
	router := chi.NewRouter()
	passthrough := func(next http.Handler) http.Handler { return next }
	ai_chat.NewRegistrarWithProvider(chatStore, cfg, provider).RegisterRoutes(router, passthrough)
	ai_chat_v2.NewRegistrarWithOptions(
		chatStore,
		cfg,
		ai_chat_v2.Options{Provider: provider, Backend: backend},
	).RegisterRoutes(router, passthrough)
	ai_chat_usage.NewRegistrar(usageStore).RegisterRoutes(router, passthrough)
	ai_file_upload.NewRegistrar().RegisterRoutes(router, passthrough)
	return router
}

func stage7BRequest(router http.Handler, method, target, body string) *httptest.ResponseRecorder {
	request := stage7BHTTPRequest(method, target, body)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func stage7BHTTPRequest(method, target, body string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		UserID: strconv.FormatInt(42, 10),
	}))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func stage7BObject(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatalf("decode object: %v; body=%s", err, body)
	}
	return value
}

func stage7BTimePointer(value time.Time) *time.Time {
	return &value
}

func stage7BUpload(router http.Handler, filename string, content []byte) *httptest.ResponseRecorder {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", filename)
	_, _ = part.Write(content)
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/ai/upload", &body)
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		UserID: "42",
	}))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func stage7BConfig() config.Config {
	return config.Config{
		AppEnv:                         "test",
		AIChatProviderBaseURL:          "https://provider.example/v1",
		AIChatProviderAPIKey:           "key",
		AIChatDefaultModel:             "model-a",
		AIChatBasicModels:              "model-a",
		AIChatReasoningModels:          "reasoning",
		AIChatDefaultReasoningEffort:   "medium",
		AIChatTimeoutSeconds:           90,
		AIChatWebSearchBaseURL:         "https://search.example",
		AIChatWebSearchAPIKey:          "",
		AIChatWebSearchMaxResults:      5,
		AIChatMaxConversationTurns:     10,
		AIChatStreamMaxDurationSeconds: 900,
	}
}

func stage7BNewChatStore() *stage7BChatStore {
	createdAt := time.Date(2026, 11, 1, 2, 3, 4, 123000000, time.UTC)
	userID := int64(42)
	conversation := &ai_chat.Conversation{
		ID: 7, UserID: &userID, Title: "新对话",
		CreatedAt: createdAt, UpdatedAt: createdAt,
	}
	return &stage7BChatStore{
		conversation: conversation,
		messages: []ai_chat.Message{
			{
				ID: 1, ConversationID: 7, Role: "user", Content: "question",
				IsComplete: true, CreatedAt: createdAt,
			},
			{
				ID: 2, ConversationID: 7, Role: "assistant", Content: "answer",
				IsComplete: true, CreatedAt: createdAt.Add(time.Second),
			},
		},
		userMessage: ai_chat.Message{
			ID: 3, ConversationID: 7, Role: "user", Content: "hello",
			IsComplete: true, CreatedAt: createdAt.Add(2 * time.Second),
		},
		assistantMessage: ai_chat.Message{
			ID: 4, ConversationID: 7, Role: "assistant", Content: "",
			CreatedAt: createdAt.Add(3 * time.Second),
		},
	}
}

type stage7BChatStore struct {
	conversation     *ai_chat.Conversation
	messages         []ai_chat.Message
	userMessage      ai_chat.Message
	assistantMessage ai_chat.Message
	finalized        *ai_chat.FinalizeInput
}

func (store *stage7BChatStore) ListConversations(context.Context, *int64) ([]ai_chat.Conversation, error) {
	return []ai_chat.Conversation{*store.conversation}, nil
}

func (store *stage7BChatStore) CreateConversation(
	_ context.Context,
	title string,
	_ int64,
) (ai_chat.Conversation, error) {
	created := *store.conversation
	created.ID = 8
	created.Title = title
	return created, nil
}

func (store *stage7BChatStore) GetConversation(context.Context, int64, *int64) (*ai_chat.Conversation, error) {
	return store.conversation, nil
}

func (store *stage7BChatStore) UpdateConversation(
	_ context.Context,
	_ int64,
	_ *int64,
	title *string,
) (ai_chat.Conversation, error) {
	if title != nil {
		store.conversation.Title = *title
	}
	return *store.conversation, nil
}

func (store *stage7BChatStore) DeleteConversation(context.Context, int64, *int64) (bool, error) {
	return true, nil
}

func (store *stage7BChatStore) ListMessages(context.Context, int64, *int64) ([]ai_chat.Message, error) {
	return store.messages, nil
}

func (store *stage7BChatStore) GetMessage(_ context.Context, _ int64, messageID int64, _ *int64) (*ai_chat.Message, error) {
	for index := range store.messages {
		if store.messages[index].ID == messageID {
			return &store.messages[index], nil
		}
	}
	return nil, ai_chat.ErrNotFound
}

func (store *stage7BChatStore) UpdateMessage(
	_ context.Context,
	_ int64,
	messageID int64,
	_ *int64,
	content string,
) (ai_chat.Message, error) {
	message, err := store.GetMessage(context.Background(), 7, messageID, nil)
	if err != nil {
		return ai_chat.Message{}, err
	}
	message.Content = content
	return *message, nil
}

func (store *stage7BChatStore) DeleteMessage(context.Context, int64, int64, *int64) (bool, error) {
	return true, nil
}

func (store *stage7BChatStore) AppendTurn(context.Context, int64, *int64, string, string) (ai_chat.Message, ai_chat.Message, error) {
	return store.userMessage, store.assistantMessage, nil
}

func (store *stage7BChatStore) ReplaceAssistant(context.Context, int64, *int64, int64, string) (ai_chat.Message, error) {
	return store.assistantMessage, nil
}

func (store *stage7BChatStore) FinalizeAssistant(
	_ context.Context,
	input ai_chat.FinalizeInput,
) (*ai_chat.Message, *ai_chat.Conversation, error) {
	store.finalized = &input
	message := store.assistantMessage
	message.Content = input.Content
	message.IsComplete = input.Complete
	message.PromptTokens = input.PromptTokens
	message.CompletionTokens = input.CompletionTokens
	message.TotalTokens = input.TotalTokens
	conversation := *store.conversation
	conversation.TotalPromptTokens = input.PromptTokens
	conversation.TotalCompletionTokens = input.CompletionTokens
	conversation.TotalTokens = input.TotalTokens
	return &message, &conversation, nil
}

type stage7BUsageStore struct {
	rows      []ai_chat_usage.SnapshotRow
	freshness ai_chat_usage.Freshness
}

func (store *stage7BUsageStore) ListSnapshots(
	context.Context,
	int64,
	time.Time,
	time.Time,
) ([]ai_chat_usage.SnapshotRow, error) {
	return store.rows, nil
}

func (store *stage7BUsageStore) Freshness(context.Context) (ai_chat_usage.Freshness, error) {
	return store.freshness, nil
}

type stage7BProvider struct {
	models        []string
	completeCalls int
	streamCalls   int
}

func (*stage7BProvider) Configured() bool { return true }

func (provider *stage7BProvider) AvailableModels(context.Context) ([]string, error) {
	return provider.models, nil
}

func (provider *stage7BProvider) Complete(context.Context, ai.ChatRequest) (string, ai.Usage, error) {
	provider.completeCalls++
	return "合同标题", ai.Usage{}, nil
}

func (provider *stage7BProvider) Stream(
	ctx context.Context,
	_ ai.ChatRequest,
	emit func(ai.Chunk) error,
) (ai.Usage, error) {
	provider.streamCalls++
	if err := emit(ai.Chunk{Type: ai.ChunkContent, Text: "contract answer"}); err != nil {
		return ai.Usage{}, err
	}
	return ai.Usage{InputTokens: 3, OutputTokens: 4, TotalTokens: 7}, nil
}

var _ ai_chat.Store = (*stage7BChatStore)(nil)
var _ ai_chat_usage.Store = (*stage7BUsageStore)(nil)
var _ ai.Provider = (*stage7BProvider)(nil)
