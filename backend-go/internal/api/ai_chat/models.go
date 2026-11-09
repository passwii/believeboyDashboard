package ai_chat

import (
	"context"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func NormalizeReasoningEffort(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "medium", "high":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func ResolveChatModel(
	ctx context.Context,
	provider ai.Provider,
	cfg config.Config,
	requestedModel string,
	requestedEffort string,
) (string, string, error) {
	if provider == nil || !provider.Configured() {
		return "", "", ErrProviderUnavailable
	}
	defaultModel := strings.TrimSpace(cfg.AIChatDefaultModel)
	models, err := provider.AvailableModels(ctx)
	if err != nil || len(models) == 0 {
		models = nil
		if defaultModel != "" {
			models = []string{defaultModel}
		}
	}
	blocked := commaSet(cfg.AIChatModelBlocklist)
	allowed := make([]string, 0, len(models))
	seen := make(map[string]struct{}, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" || blocked[model] {
			continue
		}
		if _, exists := seen[model]; exists {
			continue
		}
		seen[model] = struct{}{}
		allowed = append(allowed, model)
	}
	selected := strings.TrimSpace(requestedModel)
	if selected == "" {
		selected = defaultModel
		if (selected == "" || blocked[selected]) && len(allowed) > 0 {
			selected = allowed[0]
		}
	}
	if selected == "" {
		return "", "", ErrProviderUnavailable
	}
	if len(allowed) > 0 {
		allowedModel := false
		for _, model := range allowed {
			if model == selected {
				allowedModel = true
				break
			}
		}
		if !allowedModel {
			return "", "", ErrModelNotAllowed
		}
	} else if selected != defaultModel || blocked[selected] {
		return "", "", ErrModelNotAllowed
	}
	effort := NormalizeReasoningEffort(requestedEffort)
	if strings.TrimSpace(requestedEffort) != "" && effort == "" {
		return "", "", ErrReasoningNotSupported
	}
	if effort != "" {
		supported := commaSet(cfg.AIChatReasoningModels)
		if !supported[strings.ToLower(selected)] {
			return "", "", ErrReasoningNotSupported
		}
	}
	return selected, effort, nil
}

func commaSet(raw string) map[string]bool {
	result := make(map[string]bool)
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			result[item] = true
		}
	}
	return result
}
