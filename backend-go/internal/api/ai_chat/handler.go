package ai_chat

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store    Store
	cfg      config.Config
	provider ai.Provider
}

func NewHandler(store Store, cfg config.Config, provider ai.Provider) *Handler {
	return &Handler{store: store, cfg: cfg, provider: provider}
}

func (handler *Handler) GetConfig(w http.ResponseWriter, r *http.Request) {
	providerConfigured := handler.provider != nil && handler.provider.Configured()
	models := make([]string, 0)
	defaultModel := strings.TrimSpace(handler.cfg.AIChatDefaultModel)
	if providerConfigured {
		if resolved, err := handler.provider.AvailableModels(r.Context()); err == nil {
			models = resolved
		}
	}
	if len(models) == 0 && defaultModel != "" {
		models = []string{defaultModel}
	}
	blocked := commaSet(handler.cfg.AIChatModelBlocklist)
	unique := make([]string, 0, len(models))
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" || blocked[model] || seen[model] {
			continue
		}
		seen[model] = true
		unique = append(unique, model)
	}
	if len(unique) == 0 && defaultModel != "" && !blocked[defaultModel] {
		unique = []string{defaultModel}
	}
	resolvedDefault := defaultModel
	if _, ok := seen[resolvedDefault]; !ok && len(unique) > 0 {
		resolvedDefault = unique[0]
	}
	premium := filterVisibleModels(unique, commaSet(handler.cfg.AIChatPremiumModels))
	basic := filterVisibleModels(unique, commaSet(handler.cfg.AIChatBasicModels))
	reasoning := filterVisibleModels(unique, commaSet(handler.cfg.AIChatReasoningModels))
	effort := NormalizeReasoningEffort(handler.cfg.AIChatDefaultReasoningEffort)
	if effort == "" {
		effort = "medium"
	}
	response := AIConfigResponse{
		ProviderConfigured:     providerConfigured,
		WebSearchConfigured:    webSearchConfigured(handler.cfg),
		Models:                 unique,
		DefaultModel:           resolvedDefault,
		PremiumModels:          premium,
		BasicModels:            basic,
		ReasoningModels:        reasoning,
		DefaultReasoningEffort: effort,
		TimeoutSeconds:         handler.cfg.AIChatTimeoutSeconds,
		MaxConversationTurns:   handler.cfg.AIChatMaxConversationTurns,
		WebSearchMaxResults:    handler.cfg.AIChatWebSearchMaxResults,
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) ListConversations(w http.ResponseWriter, r *http.Request) {
	userID := RequestUserID(r)
	if userID == nil {
		_ = httpapi.WriteJSON(w, http.StatusOK, []ConversationResponse{})
		return
	}
	rows, err := handler.store.ListConversations(r.Context(), userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	items := make([]ConversationResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, SerializeConversation(row))
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (handler *Handler) CreateConversation(w http.ResponseWriter, r *http.Request) {
	userID := RequestUserID(r)
	if userID == nil {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "缺少用户身份")
		return
	}
	var payload struct {
		Title *string `json:"title"`
	}
	if !decodeJSONBody(w, r, &payload) {
		return
	}
	title := DefaultConversationTitle
	if payload.Title != nil {
		trimmed := strings.TrimSpace(*payload.Title)
		if len([]rune(trimmed)) > 255 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "title must contain at most 255 characters")
			return
		}
		if trimmed != "" {
			title = trimmed
		}
	}
	row, err := handler.store.CreateConversation(r.Context(), title, *userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, SerializeConversation(row))
}

func (handler *Handler) DeleteConversation(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := requirePositivePathID(w, r, "conversation_id")
	if !ok {
		return
	}
	userID := RequestUserID(r)
	if _, ok := handler.ownedConversation(w, r, conversationID, userID); !ok {
		return
	}
	deleted, err := handler.store.DeleteConversation(r.Context(), conversationID, userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !deleted {
		httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) UpdateConversation(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := requirePositivePathID(w, r, "conversation_id")
	if !ok {
		return
	}
	var payload struct {
		Title *string `json:"title"`
	}
	if !decodeJSONBody(w, r, &payload) {
		return
	}
	if payload.Title != nil && len([]rune(strings.TrimSpace(*payload.Title))) > 255 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "title must contain at most 255 characters")
		return
	}
	userID := RequestUserID(r)
	if _, ok := handler.ownedConversation(w, r, conversationID, userID); !ok {
		return
	}
	var title *string
	if payload.Title != nil {
		normalized := strings.TrimSpace(*payload.Title)
		if normalized == "" {
			normalized = DefaultConversationTitle
		}
		title = &normalized
	}
	row, err := handler.store.UpdateConversation(r.Context(), conversationID, userID, title)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, SerializeConversation(row))
}

func (handler *Handler) RegenerateTitle(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := requirePositivePathID(w, r, "conversation_id")
	if !ok {
		return
	}
	userID := RequestUserID(r)
	conversation, ok := handler.ownedConversation(w, r, conversationID, userID)
	if !ok {
		return
	}
	messages, err := handler.store.ListMessages(r.Context(), conversationID, userID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	title := GenerateConversationTitle(r.Context(), handler.provider, handler.cfg, messages)
	regenerated := title != ""
	if regenerated {
		updated, err := handler.store.UpdateConversation(r.Context(), conversationID, userID, &title)
		if err != nil {
			httpapi.WriteInternalServerError(w)
			return
		}
		*conversation = updated
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ConversationTitleRegenerateResponse{
		Conversation: SerializeConversation(*conversation),
		Regenerated:  regenerated,
	})
}

func (handler *Handler) ListMessages(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := requirePositivePathID(w, r, "conversation_id")
	if !ok {
		return
	}
	userID := RequestUserID(r)
	if _, ok := handler.ownedConversation(w, r, conversationID, userID); !ok {
		return
	}
	messages, err := handler.store.ListMessages(r.Context(), conversationID, userID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	items := make([]MessageResponse, 0, len(messages))
	for _, message := range messages {
		items = append(items, SerializeMessage(message))
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (handler *Handler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := requirePositivePathID(w, r, "conversation_id")
	if !ok {
		return
	}
	messageID, ok := requirePositivePathID(w, r, "message_id")
	if !ok {
		return
	}
	userID := RequestUserID(r)
	if _, ok := handler.ownedConversation(w, r, conversationID, userID); !ok {
		return
	}
	if _, err := handler.store.GetMessage(r.Context(), conversationID, messageID, userID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Message not found")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	deleted, err := handler.store.DeleteMessage(r.Context(), conversationID, messageID, userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !deleted {
		httpapi.WriteDetail(w, http.StatusNotFound, "Message not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) UpdateMessage(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := requirePositivePathID(w, r, "conversation_id")
	if !ok {
		return
	}
	messageID, ok := requirePositivePathID(w, r, "message_id")
	if !ok {
		return
	}
	var payload struct {
		Content *string `json:"content"`
	}
	if !decodeJSONBody(w, r, &payload) {
		return
	}
	if payload.Content == nil || len([]rune(*payload.Content)) == 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "content must contain 1 to 8000 characters")
		return
	}
	content := strings.TrimSpace(*payload.Content)
	if len([]rune(content)) > 8000 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "content must contain 1 to 8000 characters")
		return
	}
	if content == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "消息内容不能为空")
		return
	}
	userID := RequestUserID(r)
	if _, ok := handler.ownedConversation(w, r, conversationID, userID); !ok {
		return
	}
	message, err := handler.store.GetMessage(r.Context(), conversationID, messageID, userID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Message not found")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	if message.Role != "user" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "只能编辑用户消息")
		return
	}
	updated, err := handler.store.UpdateMessage(r.Context(), conversationID, messageID, userID, content)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Message not found")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, SerializeMessage(updated))
}

func (handler *Handler) ownedConversation(
	w http.ResponseWriter,
	r *http.Request,
	conversationID int64,
	userID *int64,
) (*Conversation, bool) {
	if userID == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		return nil, false
	}
	conversation, err := handler.store.GetConversation(r.Context(), conversationID, userID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		} else {
			httpapi.WriteInternalServerError(w)
		}
		return nil, false
	}
	if conversation == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		return nil, false
	}
	return conversation, true
}

func SerializeConversation(row Conversation) ConversationResponse {
	return ConversationResponse{
		ID:                    row.ID,
		Title:                 row.Title,
		CreatedAt:             httpapi.Timestamp(row.CreatedAt),
		UpdatedAt:             httpapi.Timestamp(row.UpdatedAt),
		TotalPromptTokens:     row.TotalPromptTokens,
		TotalCompletionTokens: row.TotalCompletionTokens,
		TotalTokens:           row.TotalTokens,
	}
}

func SerializeMessage(row Message) MessageResponse {
	sources := make([]map[string]any, 0)
	if row.SearchSources != nil {
		if parsed, err := parseSearchSources(*row.SearchSources); err == nil {
			sources = parsed
		}
	}
	return MessageResponse{
		ID:               row.ID,
		ConversationID:   row.ConversationID,
		Role:             row.Role,
		Content:          row.Content,
		SearchSources:    sources,
		SearchTimeRange:  row.SearchTimeRange,
		IsComplete:       row.IsComplete,
		PromptTokens:     row.PromptTokens,
		CompletionTokens: row.CompletionTokens,
		TotalTokens:      row.TotalTokens,
		DurationMS:       row.DurationMS,
		CreatedAt:        httpapi.Timestamp(row.CreatedAt),
	}
}

func parseSearchSources(raw string) ([]map[string]any, error) {
	var sources []map[string]any
	if err := json.Unmarshal([]byte(raw), &sources); err != nil {
		return nil, err
	}
	if sources == nil {
		return []map[string]any{}, nil
	}
	return sources, nil
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, target any) bool {
	if r.Body == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1024*1024+1))
	if err := decoder.Decode(target); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != nil && !errors.Is(err, io.EOF) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	return true
}

func requirePositivePathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid "+name)
		return 0, false
	}
	if value <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be a positive integer")
		return 0, false
	}
	return value, true
}

type AIConfigResponse struct {
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

func filterVisibleModels(models []string, wanted map[string]bool) []string {
	visible := make([]string, 0)
	for _, model := range models {
		if wanted[strings.ToLower(model)] {
			visible = append(visible, model)
		}
	}
	return visible
}

func webSearchConfigured(cfg config.Config) bool {
	rawURL := strings.TrimSpace(cfg.AIChatWebSearchBaseURL)
	if rawURL == "" || strings.TrimSpace(cfg.AIChatWebSearchAPIKey) == "" {
		return false
	}
	return ai.ValidateWebSearchBaseURL(rawURL)
}
