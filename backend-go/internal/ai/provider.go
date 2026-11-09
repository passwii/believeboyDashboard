package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model           string
	Messages        []Message
	Temperature     float64
	ReasoningEffort string
}

type ChunkType string

const (
	ChunkThinking ChunkType = "thinking"
	ChunkContent  ChunkType = "content"
	ChunkUsage    ChunkType = "usage"
)

type Chunk struct {
	Type  ChunkType `json:"type"`
	Text  string    `json:"content,omitempty"`
	Usage *Usage    `json:"usage,omitempty"`
}

type Provider interface {
	Configured() bool
	AvailableModels(context.Context) ([]string, error)
	Complete(context.Context, ChatRequest) (string, Usage, error)
	Stream(context.Context, ChatRequest, func(Chunk) error) (Usage, error)
}

type ProviderConfig struct {
	BaseURL      string
	APIKey       string
	DefaultModel string
	Timeout      time.Duration
	HTTPClient   *http.Client
}

type OpenAIProvider struct {
	baseURL      string
	apiKey       string
	defaultModel string
	timeout      time.Duration
	client       *http.Client
}

func NewOpenAIProvider(config ProviderConfig) *OpenAIProvider {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	return &OpenAIProvider{
		baseURL:      strings.TrimRight(strings.TrimSpace(config.BaseURL), "/"),
		apiKey:       strings.TrimSpace(config.APIKey),
		defaultModel: strings.TrimSpace(config.DefaultModel),
		timeout:      timeout,
		client:       client,
	}
}

func (provider *OpenAIProvider) Configured() bool {
	return provider != nil && provider.baseURL != "" && provider.apiKey != ""
}

func (provider *OpenAIProvider) AvailableModels(ctx context.Context) ([]string, error) {
	if !provider.Configured() {
		return nil, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, provider.baseURL+"/models", nil)
	if err != nil {
		return nil, err
	}
	provider.setHeaders(req)
	resp, err := provider.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, &ProviderError{
			StatusCode: resp.StatusCode,
			Message:    strings.TrimSpace(string(body)),
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode model list: %w", err)
	}
	models := make([]string, 0, len(payload.Data))
	seen := make(map[string]struct{}, len(payload.Data))
	for _, item := range payload.Data {
		model := strings.TrimSpace(item.ID)
		if model == "" {
			continue
		}
		if _, exists := seen[model]; exists {
			continue
		}
		seen[model] = struct{}{}
		models = append(models, model)
	}
	return models, nil
}

func (provider *OpenAIProvider) Complete(
	ctx context.Context,
	request ChatRequest,
) (string, Usage, error) {
	if !provider.Configured() {
		return "", Usage{}, ErrProviderNotConfigured
	}
	model := strings.TrimSpace(request.Model)
	if model == "" {
		model = provider.defaultModel
	}
	payload := provider.payload(request, model, false)
	body, err := json.Marshal(payload)
	if err != nil {
		return "", Usage{}, err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		provider.baseURL+"/chat/completions",
		bytes.NewReader(body),
	)
	if err != nil {
		return "", Usage{}, err
	}
	provider.setHeaders(req)
	resp, err := provider.client.Do(req)
	if err != nil {
		return "", Usage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errorBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return "", Usage{}, &ProviderError{
			StatusCode: resp.StatusCode,
			Message:    strings.TrimSpace(string(errorBody)),
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage *openAIUsage `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&completion); err != nil {
		return "", Usage{}, fmt.Errorf("decode completion: %w", err)
	}
	if len(completion.Choices) == 0 {
		return "", Usage{}, ErrEmptyCompletion
	}
	content := completion.Choices[0].Message.Content
	if strings.TrimSpace(content) == "" {
		return "", Usage{}, ErrEmptyCompletion
	}
	usage := usageFromOpenAI(completion.Usage)
	return content, usage, nil
}

func (provider *OpenAIProvider) Stream(
	ctx context.Context,
	request ChatRequest,
	emit func(Chunk) error,
) (Usage, error) {
	if !provider.Configured() {
		return Usage{}, ErrProviderNotConfigured
	}
	model := strings.TrimSpace(request.Model)
	if model == "" {
		model = provider.defaultModel
	}
	payload := provider.payload(request, model, true)
	body, err := json.Marshal(payload)
	if err != nil {
		return Usage{}, err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		provider.baseURL+"/chat/completions",
		bytes.NewReader(body),
	)
	if err != nil {
		return Usage{}, err
	}
	provider.setHeaders(req)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := provider.client.Do(req)
	if err != nil {
		return Usage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errorBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return Usage{}, &ProviderError{
			StatusCode: resp.StatusCode,
			Message:    strings.TrimSpace(string(errorBody)),
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
	}

	var usage Usage
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return usage, err
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			break
		}
		var payload struct {
			Choices []struct {
				Delta struct {
					Thinking         string `json:"thinking"`
					ReasoningContent string `json:"reasoning_content"`
					Content          any    `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *openAIUsage `json:"usage"`
		}
		if err := json.Unmarshal([]byte(data), &payload); err != nil {
			continue
		}
		for _, choice := range payload.Choices {
			thinking := choice.Delta.Thinking
			if thinking == "" {
				thinking = choice.Delta.ReasoningContent
			}
			if thinking != "" {
				if err := emit(Chunk{Type: ChunkThinking, Text: thinking}); err != nil {
					return usage, err
				}
			}
			if content, ok := stringContent(choice.Delta.Content); ok && content != "" {
				if err := emit(Chunk{Type: ChunkContent, Text: content}); err != nil {
					return usage, err
				}
			}
		}
		if payload.Usage != nil {
			usage = usageFromOpenAI(payload.Usage)
			usageCopy := usage
			if err := emit(Chunk{Type: ChunkUsage, Usage: &usageCopy}); err != nil {
				return usage, err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return usage, ctxErr
		}
		return usage, err
	}
	return usage, nil
}

func (provider *OpenAIProvider) payload(request ChatRequest, model string, stream bool) map[string]any {
	temperature := request.Temperature
	if temperature == 0 {
		temperature = 0.7
	}
	payload := map[string]any{
		"model":       model,
		"messages":    request.Messages,
		"temperature": temperature,
	}
	if stream {
		payload["stream"] = true
		payload["stream_options"] = map[string]any{"include_usage": true}
	}
	if effort := strings.TrimSpace(request.ReasoningEffort); effort != "" {
		payload["reasoning"] = map[string]any{"effort": effort}
	}
	return payload
}

func (provider *OpenAIProvider) setHeaders(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+provider.apiKey)
	req.Header.Set("Content-Type", "application/json")
}

type openAIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

func usageFromOpenAI(value *openAIUsage) Usage {
	if value == nil {
		return Usage{}
	}
	total := value.TotalTokens
	if total == 0 {
		total = value.PromptTokens + value.CompletionTokens
	}
	return Usage{
		InputTokens:  value.PromptTokens,
		OutputTokens: value.CompletionTokens,
		TotalTokens:  total,
	}
}

func stringContent(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case []any:
		var builder strings.Builder
		for _, item := range typed {
			if text, ok := item.(string); ok {
				builder.WriteString(text)
				continue
			}
			if object, ok := item.(map[string]any); ok {
				if text, ok := object["text"].(string); ok {
					builder.WriteString(text)
				}
			}
		}
		return builder.String(), true
	default:
		return "", false
	}
}

type ProviderError struct {
	StatusCode int
	Message    string
	RetryAfter int
}

func (err *ProviderError) Error() string {
	if err == nil {
		return "provider error"
	}
	return fmt.Sprintf("provider request failed (%d): %s", err.StatusCode, err.Message)
}

var (
	ErrProviderNotConfigured = errors.New("ai provider not configured")
	ErrEmptyCompletion       = errors.New("ai provider returned empty content")
)

func parseRetryAfter(raw string) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	var seconds int
	if _, err := fmt.Sscanf(raw, "%d", &seconds); err == nil {
		if seconds > 0 {
			return seconds
		}
	}
	if parsed, err := http.ParseTime(raw); err == nil {
		delay := int(time.Until(parsed).Seconds())
		if delay > 0 {
			return delay
		}
	}
	return 0
}
