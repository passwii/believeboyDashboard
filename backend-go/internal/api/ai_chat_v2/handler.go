package ai_chat_v2

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"github.com/redis/go-redis/v9"
)

type Handler struct {
	store    ai_chat.Store
	cfg      config.Config
	provider ai.Provider
	searcher ai.Searcher

	backendMu  sync.Mutex
	backend    ai.StreamBackend
	backendErr error
}

func NewHandler(store ai_chat.Store, cfg config.Config) *Handler {
	return NewHandlerWithOptions(store, cfg, Options{})
}

func NewHandlerWithOptions(store ai_chat.Store, cfg config.Config, options Options) *Handler {
	provider := options.Provider
	if provider == nil {
		provider = ai_chat.ProviderFromConfig(cfg)
	}
	searcher := options.Searcher
	if searcher == nil {
		searcher = ai.NewTavilySearcher(ai.WebSearchConfig{
			BaseURL:    cfg.AIChatWebSearchBaseURL,
			APIKey:     cfg.AIChatWebSearchAPIKey,
			Topic:      cfg.AIChatWebSearchTopic,
			Depth:      cfg.AIChatWebSearchDepth,
			MaxResults: cfg.AIChatWebSearchMaxResults,
			Timeout:    time.Duration(cfg.AIChatTimeoutSeconds) * time.Second,
		})
	}
	return &Handler{
		store:    store,
		cfg:      cfg,
		provider: provider,
		searcher: searcher,
		backend:  options.Backend,
	}
}

func (handler *Handler) Stream(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := parseConversationID(w, r)
	if !ok {
		return
	}
	payload, ok := decodeMessageCreate(w, r)
	if !ok {
		return
	}
	userID := ai_chat.RequestUserID(r)
	if userID == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		return
	}
	conversation, err := handler.store.GetConversation(r.Context(), conversationID, userID)
	if err != nil {
		if errors.Is(err, ai_chat.ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		} else {
			httpapi.WriteInternalServerError(w)
		}
		return
	}
	if conversation == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		return
	}
	backend, err := handler.streamBackend()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Redis Stream 不可用")
		return
	}

	lastEventID := strings.TrimSpace(r.Header.Get("Last-Event-ID"))
	if lastEventID != "" {
		handler.serveStream(w, r, backend, conversationID, lastEventID, false, nil)
		return
	}

	if payload.Regenerate && !payload.EnableWebSearch {
		httpapi.WriteDetail(w, http.StatusBadRequest, "重新生成仅在启用联网搜索时支持")
		return
	}
	requestedModel := ""
	if payload.Model != nil {
		requestedModel = *payload.Model
	}
	requestedEffort := ""
	if payload.ReasoningEffort != nil {
		requestedEffort = *payload.ReasoningEffort
	}
	model, effort, err := ai_chat.ResolveChatModel(
		r.Context(),
		handler.provider,
		handler.cfg,
		requestedModel,
		requestedEffort,
	)
	if err != nil {
		writeModelError(w, err)
		return
	}
	backupModel := ""
	if candidate := strings.TrimSpace(handler.cfg.AIChatBackupModel); candidate != "" && candidate != model {
		if resolved, _, backupErr := ai_chat.ResolveChatModel(
			r.Context(),
			handler.provider,
			handler.cfg,
			candidate,
			"",
		); backupErr == nil {
			backupModel = resolved
		}
	}
	history, err := handler.store.ListMessages(r.Context(), conversationID, userID)
	if err != nil {
		if errors.Is(err, ai_chat.ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		} else {
			httpapi.WriteInternalServerError(w)
		}
		return
	}
	prepared, status, detail := prepareTurn(history, payload)
	if status != 0 {
		httpapi.WriteDetail(w, status, detail)
		return
	}

	var searchResult ai.SearchResult
	if payload.EnableWebSearch {
		if handler.searcher == nil || !handler.searcher.Configured() {
			httpapi.WriteDetail(
				w,
				http.StatusServiceUnavailable,
				"联网搜索未配置，请检查 backend/.env 中的 AI_CHAT_WEB_SEARCH_* 变量",
			)
			return
		}
		searchResult, err = handler.searcher.Search(
			r.Context(),
			prepared.userContent,
			handler.cfg.AIChatWebSearchMaxResults,
		)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusBadGateway, "Web search request failed: "+err.Error())
			return
		}
	}

	if err := backend.Begin(r.Context(), conversationID); err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Redis Stream 不可用")
		return
	}
	var userMessage ai_chat.Message
	var assistantMessage ai_chat.Message
	if prepared.regenerate {
		assistantMessage, err = handler.store.ReplaceAssistant(
			r.Context(),
			conversationID,
			userID,
			prepared.targetAssistant.ID,
			model,
		)
		userMessage = prepared.targetUser
	} else {
		userMessage, assistantMessage, err = handler.store.AppendTurn(
			r.Context(),
			conversationID,
			userID,
			prepared.userContent,
			model,
		)
	}
	if err != nil {
		_ = backend.End(context.Background(), conversationID)
		if errors.Is(err, ai_chat.ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		} else {
			httpapi.WriteInternalServerError(w)
		}
		return
	}

	messages := buildPromptMessages(
		handler.cfg,
		prepared.contextMessages,
		prepared.userContent,
		payload,
		searchResult.Context,
	)
	conversationSnapshot := *conversation
	finalize := func(ctx context.Context, result RunResult) (*DonePayload, error) {
		return handler.finalizeTurn(
			ctx,
			conversationSnapshot,
			userMessage,
			assistantMessage,
			prepared.userContent,
			payload.Regenerate,
			searchResult.Cards,
			searchResult.TimeRange,
			result,
		)
	}
	maxDuration := handler.cfg.AIChatStreamMaxDurationSeconds
	if maxDuration <= 0 {
		maxDuration = 900
	}
	turnContext, cancelTurn := context.WithTimeout(
		context.Background(),
		time.Duration(maxDuration)*time.Second,
	)
	runner := NewRunner(backend, handler.provider)
	runInput := RunInput{
		ConversationID:  conversationID,
		Model:           model,
		BackupModel:     backupModel,
		ReasoningEffort: effort,
		Messages:        messages,
		Finalize:        finalize,
	}
	launch := func() {
		go func() {
			defer cancelTurn()
			runner.Run(turnContext, runInput)
		}()
	}
	handler.serveStream(w, r, backend, conversationID, "0", true, launch)
}

func (handler *Handler) Cancel(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := parseConversationID(w, r)
	if !ok {
		return
	}
	userID := ai_chat.RequestUserID(r)
	if userID == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		return
	}
	conversation, err := handler.store.GetConversation(r.Context(), conversationID, userID)
	if err != nil {
		if errors.Is(err, ai_chat.ErrNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		} else {
			httpapi.WriteInternalServerError(w)
		}
		return
	}
	if conversation == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Conversation not found")
		return
	}
	backend, err := handler.streamBackend()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Redis Stream 不可用")
		return
	}
	cancelled, err := backend.Cancel(r.Context(), conversationID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"cancelled": cancelled})
}

func (handler *Handler) serveStream(
	w http.ResponseWriter,
	r *http.Request,
	backend ai.StreamBackend,
	conversationID int64,
	fromID string,
	cancelOnDisconnect bool,
	launch func(),
) {
	subscription, err := backend.Subscribe(r.Context(), conversationID, fromID)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Redis Stream 不可用")
		return
	}
	defer subscription.Close()

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	if launch != nil {
		launch()
	}

	for {
		entry, ok, err := subscription.Next(r.Context())
		if err != nil {
			if r.Context().Err() != nil {
				if cancelOnDisconnect {
					_, _ = backend.Cancel(context.Background(), conversationID)
				}
				return
			}
			_, _ = w.Write(ai.EncodeSSE(ai.NewErrorEvent("internal", "内部错误", 0), ""))
			if cancelOnDisconnect {
				_, _ = backend.Cancel(context.Background(), conversationID)
			}
			return
		}
		if !ok {
			if r.Context().Err() != nil && cancelOnDisconnect {
				_, _ = backend.Cancel(context.Background(), conversationID)
			}
			return
		}
		if entry.Kind == "begin" {
			continue
		}
		var data []byte
		if entry.Kind == "done" {
			data = append([]byte("data: "), entry.Data...)
			data = append(data, '\n', '\n')
		} else {
			data = ai.EncodeSSE(json.RawMessage(entry.Data), entry.ID)
		}
		if _, err := w.Write(data); err != nil {
			if cancelOnDisconnect {
				_, _ = backend.Cancel(context.Background(), conversationID)
			}
			return
		}
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		if entry.EventType == "message_stop" {
			return
		}
	}
}

func (handler *Handler) finalizeTurn(
	ctx context.Context,
	conversation ai_chat.Conversation,
	userMessage ai_chat.Message,
	assistantMessage ai_chat.Message,
	userContent string,
	regenerate bool,
	searchCards []ai.SourceCard,
	searchTimeRange string,
	result RunResult,
) (*DonePayload, error) {
	var sourcesJSON *string
	if len(searchCards) > 0 {
		data, err := json.Marshal(searchCards)
		if err == nil {
			value := string(data)
			sourcesJSON = &value
		}
	}
	var timeRange *string
	if strings.TrimSpace(searchTimeRange) != "" {
		value := searchTimeRange
		timeRange = &value
	}
	finalizedMessage, finalizedConversation, err := handler.store.FinalizeAssistant(
		ctx,
		ai_chat.FinalizeInput{
			ConversationID:     conversation.ID,
			AssistantMessageID: assistantMessage.ID,
			UserID:             conversation.UserID,
			Content:            result.FullText,
			SearchSourcesJSON:  sourcesJSON,
			SearchTimeRange:    timeRange,
			PromptTokens:       result.Usage.InputTokens,
			CompletionTokens:   result.Usage.OutputTokens,
			TotalTokens:        result.Usage.TotalTokens,
			DurationMS:         result.DurationMS,
			Complete:           result.Complete,
		},
	)
	if err != nil {
		return nil, err
	}
	titleRegenerated := false
	if result.Complete &&
		!regenerate &&
		conversation.Title == ai_chat.DefaultConversationTitle &&
		strings.TrimSpace(result.FullText) != "" {
		title := ai_chat.GenerateTurnTitle(
			ctx,
			handler.provider,
			handler.cfg,
			userContent,
			result.FullText,
		)
		if title != "" {
			updated, updateErr := handler.store.UpdateConversation(
				ctx,
				conversation.ID,
				conversation.UserID,
				&title,
			)
			if updateErr == nil {
				*finalizedConversation = updated
				titleRegenerated = true
			}
		}
	}
	return &DonePayload{
		Type:              "done",
		UserMessage:       ai_chat.SerializeMessage(userMessage),
		AssistantMessage:  ai_chat.SerializeMessage(*finalizedMessage),
		ConversationTitle: finalizedConversation.Title,
		TokenUsage: TokenUsage{
			PromptTokens:     result.Usage.InputTokens,
			CompletionTokens: result.Usage.OutputTokens,
			TotalTokens:      result.Usage.TotalTokens,
		},
		ConversationTokenUsage: ConversationTokenUsage{
			PromptTokens:     finalizedConversation.TotalPromptTokens,
			CompletionTokens: finalizedConversation.TotalCompletionTokens,
			TotalTokens:      finalizedConversation.TotalTokens,
		},
		DurationMS:       result.DurationMS,
		TitleRegenerated: titleRegenerated,
	}, nil
}

func (handler *Handler) streamBackend() (ai.StreamBackend, error) {
	handler.backendMu.Lock()
	defer handler.backendMu.Unlock()
	if handler.backend != nil {
		return handler.backend, nil
	}
	if handler.backendErr != nil {
		return nil, handler.backendErr
	}
	backend, err := NewStreamBackendFromConfig(handler.cfg)
	if err != nil {
		handler.backendErr = err
		return nil, err
	}
	handler.backend = backend
	return backend, nil
}

func (handler *Handler) Close() error {
	handler.backendMu.Lock()
	defer handler.backendMu.Unlock()
	if handler.backend == nil {
		return nil
	}
	return handler.backend.Close()
}

func NewStreamBackendFromConfig(cfg config.Config) (ai.StreamBackend, error) {
	redisURL := strings.TrimSpace(cfg.AIChatRedisURL)
	if redisURL != "" {
		options, err := redis.ParseURL(redisURL)
		if err == nil {
			client := redis.NewClient(options)
			pingContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			err = client.Ping(pingContext).Err()
			cancel()
			if err == nil {
				return ai.NewRedisStreamBackend(
					client,
					cfg.AIChatStreamPrefix,
					cfg.AIChatStreamTTLSeconds,
					cfg.AIChatStreamMaxLen,
				), nil
			}
			_ = client.Close()
		}
	}
	if cfg.AIChatStreamMemoryFallback && !isProductionEnvironment(cfg.AppEnv) {
		return ai.NewMemoryStreamBackend(), nil
	}
	return nil, ai.ErrStreamUnavailable
}

func isProductionEnvironment(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "production", "prod":
		return true
	default:
		return false
	}
}

type preparedTurn struct {
	userContent     string
	contextMessages []ai_chat.Message
	targetUser      ai_chat.Message
	targetAssistant ai_chat.Message
	regenerate      bool
}

func prepareTurn(
	history []ai_chat.Message,
	payload ai_chat.MessageCreate,
) (preparedTurn, int, string) {
	if payload.Regenerate {
		if len(history) < 2 {
			return preparedTurn{}, http.StatusBadRequest, "没有可重新生成的消息"
		}
		targetIndex := -1
		if payload.TargetMessageID != nil {
			for index, item := range history {
				if item.ID == *payload.TargetMessageID {
					targetIndex = index
					break
				}
			}
			if targetIndex < 0 {
				return preparedTurn{}, http.StatusNotFound, "指定的消息不存在"
			}
		} else {
			targetIndex = len(history) - 1
		}
		if targetIndex == 0 || targetIndex >= len(history) {
			return preparedTurn{}, http.StatusBadRequest, "指定消息的前一条不是用户消息，无法重新生成"
		}
		targetAssistant := history[targetIndex]
		targetUser := history[targetIndex-1]
		if targetAssistant.Role != "assistant" || targetUser.Role != "user" {
			return preparedTurn{}, http.StatusBadRequest, "当前会话末尾消息不支持重新生成"
		}
		userContent := strings.TrimSpace(targetUser.Content)
		if userContent == "" {
			return preparedTurn{}, http.StatusBadRequest, "消息内容不能为空"
		}
		return preparedTurn{
			userContent:     userContent,
			contextMessages: history[:targetIndex-1],
			targetUser:      targetUser,
			targetAssistant: targetAssistant,
			regenerate:      true,
		}, 0, ""
	}
	userContent := strings.TrimSpace(payload.Content)
	if userContent == "" {
		return preparedTurn{}, http.StatusBadRequest, "消息内容不能为空"
	}
	return preparedTurn{
		userContent:     userContent,
		contextMessages: history,
	}, 0, ""
}

func buildPromptMessages(
	cfg config.Config,
	history []ai_chat.Message,
	userContent string,
	payload ai_chat.MessageCreate,
	searchContext string,
) []ai.Message {
	messages := make([]ai.Message, 0)
	messages = append(messages, ai.Message{
		Role: "system",
		Content: "你是一个有用的 AI 助手，回答简洁准确。今天的日期是 " +
			time.Now().Format("2006-01-02") + "，回答涉及时间时请以此为参照。",
	})
	if systemPrompt := strings.TrimSpace(payload.SystemPrompt); systemPrompt != "" {
		messages = append(messages, ai.Message{Role: "system", Content: systemPrompt})
	}
	if strings.TrimSpace(searchContext) != "" {
		messages = append(messages, ai.Message{Role: "system", Content: searchContext})
	}
	limit := cfg.AIChatMaxConversationTurns * 2
	if limit <= 0 {
		limit = 20
	}
	start := len(history) - limit
	if start < 0 {
		start = 0
	}
	for _, item := range history[start:] {
		if strings.TrimSpace(item.Content) == "" {
			continue
		}
		messages = append(messages, ai.Message{Role: item.Role, Content: item.Content})
	}
	messages = append(messages, ai.Message{Role: "user", Content: userContent})
	if payload.AttachedFileContent != nil {
		content := strings.TrimSpace(*payload.AttachedFileContent)
		if content != "" {
			name := "file"
			if payload.AttachedFileName != nil && strings.TrimSpace(*payload.AttachedFileName) != "" {
				name = strings.TrimSpace(*payload.AttachedFileName)
			}
			messages = append(messages, ai.Message{
				Role: "system",
				Content: "【用户附加文件：" + name + "】\n" + content +
					"\n请根据上述附加文件内容回答用户问题。如果用户没有明确提问，请先总结文件的主要内容。",
			})
		}
	}
	return messages
}

func decodeMessageCreate(w http.ResponseWriter, r *http.Request) (ai_chat.MessageCreate, bool) {
	var payload ai_chat.MessageCreate
	if r.Body == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return payload, false
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1024*1024+1))
	if err := decoder.Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return payload, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != nil && !errors.Is(err, io.EOF) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return payload, false
	}
	if len([]rune(payload.Content)) > 8000 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "content must contain at most 8000 characters")
		return payload, false
	}
	if payload.Model != nil && len([]rune(*payload.Model)) > 200 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "model must contain at most 200 characters")
		return payload, false
	}
	if payload.ReasoningEffort != nil && len([]rune(*payload.ReasoningEffort)) > 20 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "reasoning_effort must contain at most 20 characters")
		return payload, false
	}
	if payload.AttachedFileContent != nil && len([]rune(*payload.AttachedFileContent)) > 55000 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "attached_file_content must contain at most 55000 characters")
		return payload, false
	}
	if payload.AttachedFileName != nil && len([]rune(*payload.AttachedFileName)) > 500 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "attached_file_name must contain at most 500 characters")
		return payload, false
	}
	return payload, true
}

func parseConversationID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "conversation_id"))
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid conversation_id")
		return 0, false
	}
	if value <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "conversation_id must be a positive integer")
		return 0, false
	}
	return value, true
}

func writeModelError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ai_chat.ErrProviderUnavailable):
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "后端 AI Provider 未配置，请检查 backend/.env")
	case errors.Is(err, ai_chat.ErrModelNotAllowed):
		httpapi.WriteDetail(w, http.StatusBadRequest, "所选模型不在允许列表中")
	case errors.Is(err, ai_chat.ErrReasoningNotSupported):
		httpapi.WriteDetail(w, http.StatusBadRequest, "当前模型不支持思考强度设置")
	default:
		httpapi.WriteInternalServerError(w)
	}
}
