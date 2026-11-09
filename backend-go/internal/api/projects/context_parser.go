package projects

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
)

var ErrContextParserUnavailable = errors.New("project context parser unavailable")

const contextParserSystemPrompt = `你是一位跨境电商项目背景配置专家。

将用户输入的自然语言项目背景描述解析为一个 JSON 对象。对象中的 key 是简洁的中文维度名，value 是可独立理解的完整描述。维度可以包括工厂供货、生产能力、季节性、增长趋势、风险备注、项目优势、团队配置、竞品分析、物流方案、资金安排等。

只输出一个 JSON 对象，不要输出 Markdown、解释或其他文字。输入信息不足时返回空对象 {}。`

// ContextParser converts a natural-language project description into the
// structured object persisted by the project context endpoint.
type ContextParser interface {
	Parse(context.Context, string) (map[string]any, error)
}

// AIContextParser is the production adapter over the shared AI provider.
type AIContextParser struct {
	provider ai.Provider
	model    string
}

func NewAIContextParser(provider ai.Provider, model string) ContextParser {
	return &AIContextParser{
		provider: provider,
		model:    strings.TrimSpace(model),
	}
}

func (parser *AIContextParser) Parse(
	ctx context.Context,
	description string,
) (map[string]any, error) {
	description = strings.TrimSpace(description)
	if description == "" {
		return nil, errors.New("description is required")
	}
	if parser == nil || parser.provider == nil || !parser.provider.Configured() {
		return nil, ErrContextParserUnavailable
	}

	content, _, err := parser.provider.Complete(ctx, ai.ChatRequest{
		Model: parser.model,
		Messages: []ai.Message{
			{Role: "system", Content: contextParserSystemPrompt},
			{Role: "user", Content: description},
		},
		Temperature: 0,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrContextParserUnavailable, err)
	}
	result, err := decodeContextParserResult(content)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrContextParserUnavailable, err)
	}
	return result, nil
}

func decodeContextParserResult(content string) (map[string]any, error) {
	content = trimContextMarkdown(content)
	if content == "" {
		return nil, errors.New("empty AI response")
	}

	decoder := json.NewDecoder(bytes.NewReader([]byte(content)))
	decoder.UseNumber()
	var result map[string]any
	if err := decoder.Decode(&result); err != nil {
		return nil, fmt.Errorf("decode context JSON: %w", err)
	}
	if result == nil {
		return nil, errors.New("context result must be a JSON object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return nil, errors.New("multiple JSON values")
	} else if !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("decode trailing context JSON: %w", err)
	}
	return result, nil
}

func trimContextMarkdown(content string) string {
	content = strings.TrimSpace(content)
	switch {
	case strings.HasPrefix(content, "```json"):
		content = strings.TrimSpace(strings.TrimPrefix(content, "```json"))
	case strings.HasPrefix(content, "```"):
		content = strings.TrimSpace(strings.TrimPrefix(content, "```"))
	}
	if strings.HasSuffix(content, "```") {
		content = strings.TrimSpace(strings.TrimSuffix(content, "```"))
	}
	return content
}
