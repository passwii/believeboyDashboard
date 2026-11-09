package ai_chat

import (
	"context"
	"errors"
	"time"
)

const DefaultConversationTitle = "新对话"

var ErrNotFound = errors.New("ai chat record not found")

var (
	ErrProviderUnavailable   = errors.New("ai provider unavailable")
	ErrModelNotAllowed       = errors.New("selected model is not allowed")
	ErrReasoningNotSupported = errors.New("selected model does not support reasoning effort")
)

type Conversation struct {
	ID                    int64
	UserID                *int64
	Title                 string
	CreatedAt             time.Time
	UpdatedAt             time.Time
	TotalPromptTokens     int
	TotalCompletionTokens int
	TotalTokens           int
}

type Message struct {
	ID               int64
	ConversationID   int64
	Role             string
	Content          string
	SearchSources    *string
	SearchTimeRange  *string
	IsComplete       bool
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	DurationMS       *int
	Model            string
	CreatedAt        time.Time
}

type ConversationResponse struct {
	ID                    int64  `json:"id"`
	Title                 string `json:"title"`
	CreatedAt             string `json:"created_at"`
	UpdatedAt             string `json:"updated_at"`
	TotalPromptTokens     int    `json:"total_prompt_tokens"`
	TotalCompletionTokens int    `json:"total_completion_tokens"`
	TotalTokens           int    `json:"total_tokens"`
}

type MessageResponse struct {
	ID               int64            `json:"id"`
	ConversationID   int64            `json:"conversation_id"`
	Role             string           `json:"role"`
	Content          string           `json:"content"`
	SearchSources    []map[string]any `json:"search_sources"`
	SearchTimeRange  *string          `json:"search_time_range"`
	IsComplete       bool             `json:"is_complete"`
	PromptTokens     int              `json:"prompt_tokens"`
	CompletionTokens int              `json:"completion_tokens"`
	TotalTokens      int              `json:"total_tokens"`
	DurationMS       *int             `json:"duration_ms"`
	CreatedAt        string           `json:"created_at"`
}

type ConversationTitleRegenerateResponse struct {
	Conversation ConversationResponse `json:"conversation"`
	Regenerated  bool                 `json:"regenerated"`
}

type MessageCreate struct {
	Content             string  `json:"content"`
	Model               *string `json:"model"`
	SystemPrompt        string  `json:"system_prompt"`
	ReasoningEffort     *string `json:"reasoning_effort"`
	Regenerate          bool    `json:"regenerate"`
	TargetMessageID     *int64  `json:"target_message_id"`
	EnableWebSearch     bool    `json:"enable_web_search"`
	AttachedFileContent *string `json:"attached_file_content"`
	AttachedFileName    *string `json:"attached_file_name"`
}

type FinalizeInput struct {
	ConversationID     int64
	AssistantMessageID int64
	UserID             *int64
	Content            string
	SearchSourcesJSON  *string
	SearchTimeRange    *string
	PromptTokens       int
	CompletionTokens   int
	TotalTokens        int
	DurationMS         int
	Complete           bool
}

type Store interface {
	ListConversations(context.Context, *int64) ([]Conversation, error)
	CreateConversation(context.Context, string, int64) (Conversation, error)
	GetConversation(context.Context, int64, *int64) (*Conversation, error)
	UpdateConversation(context.Context, int64, *int64, *string) (Conversation, error)
	DeleteConversation(context.Context, int64, *int64) (bool, error)
	ListMessages(context.Context, int64, *int64) ([]Message, error)
	GetMessage(context.Context, int64, int64, *int64) (*Message, error)
	UpdateMessage(context.Context, int64, int64, *int64, string) (Message, error)
	DeleteMessage(context.Context, int64, int64, *int64) (bool, error)
	AppendTurn(context.Context, int64, *int64, string, string) (Message, Message, error)
	ReplaceAssistant(context.Context, int64, *int64, int64, string) (Message, error)
	FinalizeAssistant(context.Context, FinalizeInput) (*Message, *Conversation, error)
}
