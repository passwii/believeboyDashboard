package ai_chat

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestAIChatRegistrarRegistersNineRoutes(t *testing.T) {
	handler := NewHandler(&fakeAIStore{}, testAIChatConfig(), &fakeAIProvider{})
	router := chi.NewRouter()
	registrar := &Registrar{handler: handler}
	registrar.RegisterRoutes(router, passthroughMiddleware)

	registered := make(map[string]bool)
	err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		registered[method+" "+route] = true
		return nil
	})
	if err != nil {
		t.Fatalf("Walk() error = %v", err)
	}
	for _, route := range []string{
		"GET /api/v1/ai/config",
		"GET /api/v1/ai/conversations",
		"POST /api/v1/ai/conversations",
		"DELETE /api/v1/ai/conversations/{conversation_id}",
		"PATCH /api/v1/ai/conversations/{conversation_id}",
		"POST /api/v1/ai/conversations/{conversation_id}/regenerate-title",
		"GET /api/v1/ai/conversations/{conversation_id}/messages",
		"DELETE /api/v1/ai/conversations/{conversation_id}/messages/{message_id}",
		"PATCH /api/v1/ai/conversations/{conversation_id}/messages/{message_id}",
	} {
		if !registered[route] {
			t.Errorf("route %s is not registered", route)
		}
	}
}

func TestAIChatConfigUsesProviderModelsAndFilters(t *testing.T) {
	provider := &fakeAIProvider{models: []string{"model-a", "premium", "reasoning", "blocked"}}
	handler := NewHandler(&fakeAIStore{}, testAIChatConfig(), provider)
	recorder := httptest.NewRecorder()
	handler.GetConfig(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/ai/config", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		ProviderConfigured     bool     `json:"provider_configured"`
		WebSearchConfigured    bool     `json:"web_search_configured"`
		Models                 []string `json:"models"`
		DefaultModel           string   `json:"default_model"`
		PremiumModels          []string `json:"premium_models"`
		BasicModels            []string `json:"basic_models"`
		ReasoningModels        []string `json:"reasoning_models"`
		DefaultReasoningEffort string   `json:"default_reasoning_effort"`
		TimeoutSeconds         int      `json:"timeout_seconds"`
		MaxConversationTurns   int      `json:"max_conversation_turns"`
		WebSearchMaxResults    int      `json:"web_search_max_results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !response.ProviderConfigured || !response.WebSearchConfigured {
		t.Errorf("configured flags = %t/%t", response.ProviderConfigured, response.WebSearchConfigured)
	}
	if strings.Join(response.Models, ",") != "model-a,premium,reasoning" {
		t.Errorf("models = %#v", response.Models)
	}
	if response.DefaultModel != "model-a" {
		t.Errorf("default_model = %q", response.DefaultModel)
	}
	if strings.Join(response.PremiumModels, ",") != "premium" ||
		strings.Join(response.BasicModels, ",") != "model-a" ||
		strings.Join(response.ReasoningModels, ",") != "reasoning" {
		t.Errorf("model groups = %#v/%#v/%#v", response.PremiumModels, response.BasicModels, response.ReasoningModels)
	}
	if response.DefaultReasoningEffort != "medium" || response.TimeoutSeconds != 90 ||
		response.MaxConversationTurns != 10 || response.WebSearchMaxResults != 5 {
		t.Errorf("config scalars = %#v", response)
	}
}

func TestAIChatWebSearchConfigRequiresHTTPS(t *testing.T) {
	cfg := testAIChatConfig()
	cfg.AIChatWebSearchBaseURL = "http://127.0.0.1:8080"
	if webSearchConfigured(cfg) {
		t.Fatal("webSearchConfigured() = true for non-HTTPS URL")
	}
	cfg.AIChatWebSearchBaseURL = "https://search.example"
	if !webSearchConfigured(cfg) {
		t.Fatal("webSearchConfigured() = false for valid HTTPS URL")
	}
}

func TestAIChatListReturnsEmptyForMissingIdentity(t *testing.T) {
	store := &fakeAIStore{}
	handler := NewHandler(store, testAIChatConfig(), &fakeAIProvider{})
	recorder := httptest.NewRecorder()
	handler.ListConversations(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/ai/conversations", nil))

	if recorder.Code != http.StatusOK || recorder.Body.String() != `[]` {
		t.Fatalf("response = %d %s, want []", recorder.Code, recorder.Body.String())
	}
	if store.listCalls != 0 {
		t.Errorf("store ListConversations calls = %d, want 0", store.listCalls)
	}
}

func TestAIChatParseUserIDMatchesPythonIntegerGrammar(t *testing.T) {
	for raw, want := range map[string]int64{
		"42":   42,
		"1_0":  10,
		"+7":   7,
		"-3":   -3,
		"0007": 7,
	} {
		got := ParseUserID(raw)
		if got == nil || *got != want {
			t.Errorf("ParseUserID(%q) = %#v, want %d", raw, got, want)
		}
	}
	for _, raw := range []string{"", "abc", "1.5", "1__0", "_1", "1_", "QQ==", "999999999999999999999999"} {
		if got := ParseUserID(raw); got != nil {
			t.Errorf("ParseUserID(%q) = %d, want nil", raw, *got)
		}
	}
}

func TestAIChatCreateRequiresIdentityAndCreatesConversation(t *testing.T) {
	t.Run("missing identity", func(t *testing.T) {
		handler := NewHandler(&fakeAIStore{}, testAIChatConfig(), &fakeAIProvider{})
		recorder := httptest.NewRecorder()
		handler.CreateConversation(
			recorder,
			httptest.NewRequest(http.MethodPost, "/api/v1/ai/conversations", strings.NewReader(`{"title":"x"}`)),
		)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("success", func(t *testing.T) {
		created := testConversation(7, "  新对话  ")
		store := &fakeAIStore{createdConversation: &created}
		handler := NewHandler(store, testAIChatConfig(), &fakeAIProvider{})
		request := identityRequest(http.MethodPost, "/api/v1/ai/conversations", `{"title":"  "}`, 42)
		recorder := httptest.NewRecorder()
		handler.CreateConversation(recorder, request)

		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
		if store.createTitle != "新对话" || store.createUserID != 42 {
			t.Errorf("create args = %q/%d", store.createTitle, store.createUserID)
		}
		want := `{"id":7,"title":"  新对话  ","created_at":"2026-11-01T02:03:04.123000Z","updated_at":"2026-11-01T02:03:04.123000Z","total_prompt_tokens":0,"total_completion_tokens":0,"total_tokens":0}`
		if recorder.Body.String() != want {
			t.Errorf("body = %s, want %s", recorder.Body.String(), want)
		}
	})
}

func TestAIChatConversationOwnershipMismatchReturns404(t *testing.T) {
	store := &fakeAIStore{getErr: ErrNotFound}
	handler := NewHandler(store, testAIChatConfig(), &fakeAIProvider{})
	request := identityRequest(http.MethodDelete, "/api/v1/ai/conversations/7", "", 99)
	request = withPathParams(request, map[string]string{"conversation_id": "7"})
	recorder := httptest.NewRecorder()
	handler.DeleteConversation(recorder, request)

	if recorder.Code != http.StatusNotFound || recorder.Body.String() != `{"detail":"Conversation not found"}` {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
	if store.deleteCalls != 0 {
		t.Errorf("DeleteConversation calls = %d, want 0", store.deleteCalls)
	}
}

func TestAIChatMessagePatchOnlyAllowsUserMessages(t *testing.T) {
	conversation := testConversation(7, "新对话")
	assistant := testMessage(10, 7, "assistant", "answer")
	store := &fakeAIStore{conversation: &conversation, message: &assistant}
	handler := NewHandler(store, testAIChatConfig(), &fakeAIProvider{})
	request := identityRequest(
		http.MethodPatch,
		"/api/v1/ai/conversations/7/messages/10",
		`{"content":"new"}`,
		42,
	)
	request = withPathParams(request, map[string]string{
		"conversation_id": "7",
		"message_id":      "10",
	})
	recorder := httptest.NewRecorder()
	handler.UpdateMessage(recorder, request)
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != `{"detail":"只能编辑用户消息"}` {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}

	user := testMessage(10, 7, "user", "old")
	conversation = testConversation(7, "新对话")
	store = &fakeAIStore{conversation: &conversation, message: &user}
	request = identityRequest(
		http.MethodPatch,
		"/api/v1/ai/conversations/7/messages/10",
		`{"content":" updated "}`,
		42,
	)
	request = withPathParams(request, map[string]string{
		"conversation_id": "7",
		"message_id":      "10",
	})
	recorder = httptest.NewRecorder()
	NewHandler(store, testAIChatConfig(), &fakeAIProvider{}).UpdateMessage(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.updateContent != "updated" {
		t.Errorf("updated content = %q", store.updateContent)
	}
}

func TestAIChatRegenerateTitleReturnsProviderTitle(t *testing.T) {
	conversation := testConversation(7, "新对话")
	store := &fakeAIStore{
		conversation: &conversation,
		messages: []Message{
			testMessage(1, 7, "user", "how to migrate"),
			testMessage(2, 7, "assistant", "use tests first"),
		},
	}
	provider := &fakeAIProvider{completeContent: "Go 后端迁移"}
	handler := NewHandler(store, testAIChatConfig(), provider)
	request := identityRequest(
		http.MethodPost,
		"/api/v1/ai/conversations/7/regenerate-title",
		"",
		42,
	)
	request = withPathParams(request, map[string]string{"conversation_id": "7"})
	recorder := httptest.NewRecorder()
	handler.RegenerateTitle(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if provider.completeCalls != 1 {
		t.Errorf("provider Complete calls = %d, want 1", provider.completeCalls)
	}
	if store.updatedTitle != "Go 后端迁移" {
		t.Errorf("updated title = %q", store.updatedTitle)
	}
	var response struct {
		Conversation map[string]any `json:"conversation"`
		Regenerated  bool           `json:"regenerated"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !response.Regenerated || response.Conversation["title"] != "Go 后端迁移" {
		t.Errorf("response = %#v", response)
	}
}

func testAIChatConfig() config.Config {
	return config.Config{
		AppEnv:                       "test",
		AIChatProviderBaseURL:        "https://provider.example/v1",
		AIChatProviderAPIKey:         "key",
		AIChatDefaultModel:           "model-a",
		AIChatModelBlocklist:         "blocked",
		AIChatPremiumModels:          "premium",
		AIChatBasicModels:            "model-a",
		AIChatReasoningModels:        "reasoning",
		AIChatDefaultReasoningEffort: "medium",
		AIChatTimeoutSeconds:         90,
		AIChatWebSearchBaseURL:       "https://search.example",
		AIChatWebSearchAPIKey:        "search-key",
		AIChatWebSearchMaxResults:    5,
		AIChatMaxConversationTurns:   10,
	}
}

func testConversation(id int64, title string) Conversation {
	createdAt := time.Date(2026, 11, 1, 2, 3, 4, 123000000, time.UTC)
	return Conversation{
		ID:        id,
		UserID:    int64Pointer(42),
		Title:     title,
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}
}

func testMessage(id, conversationID int64, role, content string) Message {
	return Message{
		ID:             id,
		ConversationID: conversationID,
		Role:           role,
		Content:        content,
		IsComplete:     true,
		CreatedAt:      time.Date(2026, 11, 1, 2, 3, 4, 123000000, time.UTC),
	}
}

func identityRequest(method, target, body string, userID int64) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		UserID: strconv.FormatInt(userID, 10),
	}))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func withPathParams(request *http.Request, values map[string]string) *http.Request {
	routeContext := chi.NewRouteContext()
	for key, value := range values {
		routeContext.URLParams.Add(key, value)
	}
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}

func passthroughMiddleware(next http.Handler) http.Handler { return next }

func int64Pointer(value int64) *int64 { return &value }

type fakeAIProvider struct {
	models          []string
	modelErr        error
	completeContent string
	completeUsage   ai.Usage
	completeErr     error
	completeCalls   int
	streamChunks    []ai.Chunk
	streamUsage     ai.Usage
	streamErr       error
	streamCalls     int
	lastRequests    []ai.ChatRequest
}

func (provider *fakeAIProvider) Configured() bool {
	return true
}

func (provider *fakeAIProvider) AvailableModels(context.Context) ([]string, error) {
	return provider.models, provider.modelErr
}

func (provider *fakeAIProvider) Complete(
	_ context.Context,
	request ai.ChatRequest,
) (string, ai.Usage, error) {
	provider.completeCalls++
	provider.lastRequests = append(provider.lastRequests, request)
	return provider.completeContent, provider.completeUsage, provider.completeErr
}

func (provider *fakeAIProvider) Stream(
	_ context.Context,
	request ai.ChatRequest,
	emit func(ai.Chunk) error,
) (ai.Usage, error) {
	provider.streamCalls++
	provider.lastRequests = append(provider.lastRequests, request)
	for _, chunk := range provider.streamChunks {
		if err := emit(chunk); err != nil {
			return provider.streamUsage, err
		}
	}
	return provider.streamUsage, provider.streamErr
}

type fakeAIStore struct {
	conversations         []Conversation
	createdConversation   *Conversation
	conversation          *Conversation
	messages              []Message
	message               *Message
	err                   error
	getErr                error
	listErr               error
	listCalls             int
	createTitle           string
	createUserID          int64
	deleteCalls           int
	updateContent         string
	updatedTitle          string
	userID                *int64
	appendUser            Message
	appendAssistant       Message
	replaceAssistantValue Message
	finalized             *FinalizeInput
}

func (store *fakeAIStore) ListConversations(context.Context, *int64) ([]Conversation, error) {
	if store.userID == nil {
		store.listCalls++
	}
	return store.conversations, store.listErr
}

func (store *fakeAIStore) CreateConversation(_ context.Context, title string, userID int64) (Conversation, error) {
	store.createTitle = title
	store.createUserID = userID
	if store.createdConversation == nil {
		return Conversation{}, store.err
	}
	return *store.createdConversation, store.err
}

func (store *fakeAIStore) GetConversation(_ context.Context, _ int64, userID *int64) (*Conversation, error) {
	store.userID = userID
	return store.conversation, store.getErr
}

func (store *fakeAIStore) UpdateConversation(
	_ context.Context,
	_ int64,
	_ *int64,
	title *string,
) (Conversation, error) {
	if title != nil {
		store.updatedTitle = *title
		if store.conversation != nil {
			store.conversation.Title = *title
		}
	}
	if store.conversation == nil {
		return Conversation{}, store.err
	}
	return *store.conversation, store.err
}

func (store *fakeAIStore) DeleteConversation(context.Context, int64, *int64) (bool, error) {
	store.deleteCalls++
	return true, store.err
}

func (store *fakeAIStore) ListMessages(context.Context, int64, *int64) ([]Message, error) {
	return store.messages, store.listErr
}

func (store *fakeAIStore) GetMessage(context.Context, int64, int64, *int64) (*Message, error) {
	return store.message, store.getErr
}

func (store *fakeAIStore) UpdateMessage(
	_ context.Context,
	_ int64,
	_ int64,
	_ *int64,
	content string,
) (Message, error) {
	store.updateContent = content
	if store.message == nil {
		return Message{}, store.err
	}
	return *store.message, store.err
}

func (store *fakeAIStore) DeleteMessage(context.Context, int64, int64, *int64) (bool, error) {
	return true, store.err
}

func (store *fakeAIStore) AppendTurn(
	context.Context,
	int64,
	*int64,
	string,
	string,
) (Message, Message, error) {
	return store.appendUser, store.appendAssistant, store.err
}

func (store *fakeAIStore) ReplaceAssistant(
	context.Context,
	int64,
	*int64,
	int64,
	string,
) (Message, error) {
	return store.replaceAssistantValue, store.err
}

func (store *fakeAIStore) FinalizeAssistant(
	_ context.Context,
	input FinalizeInput,
) (*Message, *Conversation, error) {
	store.finalized = &input
	return &store.appendAssistant, store.conversation, store.err
}

var _ Store = (*fakeAIStore)(nil)
var _ ai.Provider = (*fakeAIProvider)(nil)
