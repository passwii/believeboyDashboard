package ai_chat_v2

import (
	"context"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
)

type Options struct {
	Provider ai.Provider
	Searcher ai.Searcher
	Backend  ai.StreamBackend
}

type RunResult struct {
	FullText   string
	Usage      ai.Usage
	DurationMS int
	StopReason string
	Complete   bool
}

type DonePayload struct {
	Type                   string                  `json:"type"`
	UserMessage            ai_chat.MessageResponse `json:"user_message"`
	AssistantMessage       ai_chat.MessageResponse `json:"assistant_message"`
	ConversationTitle      string                  `json:"conversation_title"`
	TokenUsage             TokenUsage              `json:"token_usage"`
	ConversationTokenUsage ConversationTokenUsage  `json:"conversation_token_usage"`
	DurationMS             int                     `json:"duration_ms"`
	TitleRegenerated       bool                    `json:"title_regenerated"`
}

type TokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type ConversationTokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type FinalizeFunc func(context.Context, RunResult) (*DonePayload, error)

type RunInput struct {
	ConversationID  int64
	Model           string
	BackupModel     string
	ReasoningEffort string
	Messages        []ai.Message
	Finalize        FinalizeFunc
}
