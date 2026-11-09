package ai_chat_usage

import (
	"context"
	"time"
)

type Store interface {
	ListSnapshots(context.Context, int64, time.Time, time.Time) ([]SnapshotRow, error)
	Freshness(context.Context) (Freshness, error)
}

type SnapshotRow struct {
	DataDate          time.Time
	Model             string
	PromptTokens      int
	CompletionTokens  int
	TotalTokens       int
	MessageCount      int
	ConversationCount int
}

type Freshness struct {
	LatestDataDate   *time.Time
	LatestComputedAt *time.Time
}

type UsageRange string

const (
	UsageRange7D  UsageRange = "7d"
	UsageRange30D UsageRange = "30d"
	UsageRange90D UsageRange = "90d"
)

var usageRangeDays = map[UsageRange]int{
	UsageRange7D:  7,
	UsageRange30D: 30,
	UsageRange90D: 90,
}

type DailyPoint struct {
	Date             string `json:"date"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	TotalTokens      int    `json:"total_tokens"`
	MessageCount     int    `json:"message_count"`
}

type UsageModelSummary struct {
	Model            string `json:"model"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	TotalTokens      int    `json:"total_tokens"`
	MessageCount     int    `json:"message_count"`
}

type UsageTotals struct {
	PromptTokens      int `json:"prompt_tokens"`
	CompletionTokens  int `json:"completion_tokens"`
	TotalTokens       int `json:"total_tokens"`
	MessageCount      int `json:"message_count"`
	ConversationCount int `json:"conversation_count"`
}

type SnapshotFreshness struct {
	LatestDataDate   *string `json:"latest_data_date"`
	LatestComputedAt *string `json:"latest_computed_at"`
}

type StatsResponse struct {
	Range             UsageRange          `json:"range"`
	StartDate         string              `json:"start_date"`
	EndDate           string              `json:"end_date"`
	Totals            UsageTotals         `json:"totals"`
	Daily             []DailyPoint        `json:"daily"`
	ByModel           []UsageModelSummary `json:"by_model"`
	SnapshotFreshness SnapshotFreshness   `json:"snapshot_freshness"`
}
