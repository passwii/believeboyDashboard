package ai_chat

import (
	"context"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func GenerateConversationTitle(
	ctx context.Context,
	provider ai.Provider,
	cfg config.Config,
	messages []Message,
) string {
	if provider == nil || !provider.Configured() || len(messages) == 0 {
		return ""
	}
	parts := make([]string, 0, 8)
	for _, item := range messages {
		if len(parts) >= 8 {
			break
		}
		content := strings.TrimSpace(item.Content)
		if content == "" {
			continue
		}
		role := "助手"
		if item.Role == "user" {
			role = "用户"
		}
		parts = append(parts, role+"："+truncateRunes(content, 400))
	}
	if len(parts) == 0 {
		return ""
	}
	return completeTitle(ctx, provider, cfg, "请基于下面的对话记录生成标题：\n\n"+strings.Join(parts, "\n\n"))
}

func GenerateTurnTitle(
	ctx context.Context,
	provider ai.Provider,
	cfg config.Config,
	userContent string,
	assistantContent string,
) string {
	userContent = strings.TrimSpace(userContent)
	assistantContent = strings.TrimSpace(assistantContent)
	if userContent == "" || assistantContent == "" {
		return ""
	}
	return completeTitle(
		ctx,
		provider,
		cfg,
		"用户消息："+truncateRunes(userContent, 400)+"\n\n助手回复："+truncateRunes(assistantContent, 800),
	)
}

func completeTitle(
	ctx context.Context,
	provider ai.Provider,
	cfg config.Config,
	userPrompt string,
) string {
	model := strings.TrimSpace(cfg.AIChatTitleModel)
	if model == "" {
		model = strings.TrimSpace(cfg.AIChatDefaultModel)
	}
	if model == "" {
		return ""
	}
	content, _, err := provider.Complete(ctx, ai.ChatRequest{
		Model: model,
		Messages: []ai.Message{
			{
				Role:    "system",
				Content: "你负责为聊天会话生成标题。只输出简短中文标题本身；不加引号、句号、解释；控制在18个中文字符以内。",
			},
			{Role: "user", Content: userPrompt},
		},
		Temperature: 0.2,
	})
	if err != nil {
		return ""
	}
	return NormalizeGeneratedTitle(content)
}

func NormalizeGeneratedTitle(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	firstLine := ""
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) != "" {
			firstLine = strings.TrimSpace(line)
			break
		}
	}
	normalized := strings.Trim(firstLine, " \"'`“”‘’")
	for _, prefix := range []string{"标题：", "标题:", "会话标题：", "会话标题:"} {
		if strings.HasPrefix(normalized, prefix) {
			normalized = strings.Trim(strings.TrimSpace(strings.TrimPrefix(normalized, prefix)), " \"'`“”‘’")
			break
		}
	}
	return strings.TrimSpace(truncateRunes(normalized, 40))
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
