package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var ErrWebSearchNotConfigured = errors.New("web search not configured")

type WebSearchConfig struct {
	BaseURL    string
	APIKey     string
	Topic      string
	Depth      string
	MaxResults int
	Timeout    time.Duration
	HTTPClient *http.Client
}

type Searcher interface {
	Configured() bool
	Search(context.Context, string, int) (SearchResult, error)
}

type SearchResult struct {
	Answer    string
	Cards     []SourceCard
	Context   string
	TimeRange string
}

type SourceCard struct {
	Title   string   `json:"title"`
	URL     string   `json:"url"`
	Snippet string   `json:"snippet"`
	Domain  string   `json:"domain"`
	Score   *float64 `json:"score"`
	Favicon string   `json:"favicon,omitempty"`
}

type TavilySearcher struct {
	baseURL    string
	apiKey     string
	topic      string
	depth      string
	maxResults int
	timeout    time.Duration
	client     *http.Client
	configured bool
}

func NewTavilySearcher(config WebSearchConfig) *TavilySearcher {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	client := config.HTTPClient
	allowPrivate := client != nil
	if client == nil {
		client = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	baseURL, valid := validateWebSearchBaseURL(config.BaseURL, allowPrivate)
	topic := strings.TrimSpace(config.Topic)
	if topic == "" {
		topic = "general"
	}
	depth := strings.TrimSpace(config.Depth)
	if depth == "" {
		depth = "advanced"
	}
	return &TavilySearcher{
		baseURL:    baseURL,
		apiKey:     strings.TrimSpace(config.APIKey),
		topic:      topic,
		depth:      depth,
		maxResults: config.MaxResults,
		timeout:    timeout,
		client:     client,
		configured: valid && strings.TrimSpace(config.APIKey) != "",
	}
}

func (searcher *TavilySearcher) Configured() bool {
	return searcher != nil && searcher.configured
}

func (searcher *TavilySearcher) Search(
	ctx context.Context,
	query string,
	maxResults int,
) (SearchResult, error) {
	if !searcher.Configured() {
		return SearchResult{}, ErrWebSearchNotConfigured
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return SearchResult{}, errors.New("web search query is empty")
	}
	limit := maxResults
	if limit <= 0 || (searcher.maxResults > 0 && limit > searcher.maxResults) {
		limit = searcher.maxResults
	}
	if limit <= 0 {
		limit = 5
	}
	if limit > 100 {
		limit = 100
	}
	timeRange := detectTimeRange(query)
	payload := map[string]any{
		"query":               buildWebSearchQuery(query),
		"topic":               searcher.topic,
		"search_depth":        searcher.depth,
		"max_results":         limit,
		"time_range":          timeRange,
		"include_answer":      true,
		"include_raw_content": true,
		"include_favicon":     true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return SearchResult{}, err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		searcher.baseURL+"/search",
		bytes.NewReader(body),
	)
	if err != nil {
		return SearchResult{}, err
	}
	request.Header.Set("Authorization", "Bearer "+searcher.apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := searcher.client.Do(request)
	if err != nil {
		return SearchResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		errorBody, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return SearchResult{}, &WebSearchError{
			StatusCode: response.StatusCode,
			Message:    strings.TrimSpace(string(errorBody)),
		}
	}
	var payloadResponse struct {
		Answer  string `json:"answer"`
		Results []struct {
			Title      string          `json:"title"`
			URL        string          `json:"url"`
			Content    string          `json:"content"`
			RawContent string          `json:"raw_content"`
			Score      json.RawMessage `json:"score"`
			Favicon    string          `json:"favicon"`
		} `json:"results"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payloadResponse); err != nil {
		return SearchResult{}, fmt.Errorf("decode web search response: %w", err)
	}
	cards := make([]SourceCard, 0, limit)
	for _, result := range payloadResponse.Results {
		if len(cards) >= limit {
			break
		}
		title := strings.TrimSpace(result.Title)
		if title == "" {
			title = "未命名结果"
		}
		sourceURL := strings.TrimSpace(result.URL)
		if sourceURL == "" {
			continue
		}
		snippet := strings.TrimSpace(result.Content)
		if snippet == "" {
			snippet = strings.TrimSpace(result.RawContent)
		}
		snippet = truncateText(snippet, 500)
		domain := ""
		if parsed, parseErr := url.Parse(sourceURL); parseErr == nil {
			domain = parsed.Hostname()
		}
		card := SourceCard{
			Title:   title,
			URL:     sourceURL,
			Snippet: snippet,
			Domain:  domain,
			Score:   parseScore(result.Score),
			Favicon: strings.TrimSpace(result.Favicon),
		}
		cards = append(cards, card)
	}
	searchResult := SearchResult{
		Answer:    strings.TrimSpace(payloadResponse.Answer),
		Cards:     cards,
		TimeRange: timeRange,
	}
	searchResult.Context = buildSearchContext(query, searchResult)
	return searchResult, nil
}

type WebSearchError struct {
	StatusCode int
	Message    string
}

func (err *WebSearchError) Error() string {
	if err == nil {
		return "web search error"
	}
	return fmt.Sprintf("web search failed (%d): %s", err.StatusCode, err.Message)
}

func validateWebSearchBaseURL(raw string, allowPrivate bool) (string, bool) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || strings.HasPrefix(host, "127.") || strings.HasPrefix(host, "10.") ||
		strings.HasPrefix(host, "192.168.") || strings.HasPrefix(host, "169.254.") {
		if !allowPrivate {
			return "", false
		}
	}
	if ip := net.ParseIP(host); ip != nil && !allowPrivate {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
			return "", false
		}
	}
	return raw, true
}

func ValidateWebSearchBaseURL(raw string) bool {
	_, valid := validateWebSearchBaseURL(raw, false)
	return valid
}

func buildWebSearchQuery(query string) string {
	return strings.TrimSpace(query) + "\n当前日期：" + time.Now().Format("2006-01-02") +
		"。请优先返回最近发布、最近更新、时效性最强的结果。"
}

func detectTimeRange(query string) string {
	normalized := strings.ToLower(strings.ReplaceAll(query, " ", ""))
	switch {
	case containsAny(normalized, "今天", "今日", "昨天", "昨日", "近1天", "最近1天"):
		return "day"
	case containsAny(normalized, "今年", "去年", "近一年", "最近一年", "近365天"):
		return "year"
	case containsAny(normalized, "本月", "这个月", "上个月", "近30天", "最近30天", "最近"):
		return "month"
	case containsAny(normalized, "本周", "这周", "上周", "近7天", "最近7天", "最近一周"):
		return "week"
	default:
		return "month"
	}
}

func containsAny(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if strings.Contains(value, candidate) {
			return true
		}
	}
	return false
}

func parseScore(raw json.RawMessage) *float64 {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err == nil {
		return &number
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if parsed, err := strconv.ParseFloat(text, 64); err == nil {
			return &parsed
		}
	}
	return nil
}

func buildSearchContext(query string, result SearchResult) string {
	var builder strings.Builder
	builder.WriteString("以下是系统刚刚执行的联网搜索结果，请将其作为补充事实依据来回答用户问题。\n")
	builder.WriteString("要求：优先引用可信来源；结果不足或互相冲突时需明确说明；不要编造结果里没有的细节。\n")
	builder.WriteString("搜索词：" + query + "\n")
	if result.Answer != "" {
		builder.WriteString("\n搜索摘要：\n" + result.Answer + "\n")
	}
	if len(result.Cards) == 0 {
		builder.WriteString("\n搜索结果：未返回有效结果。")
		return builder.String()
	}
	builder.WriteString("\n搜索结果：\n")
	for index, card := range result.Cards {
		builder.WriteString(fmt.Sprintf("%d. %s\n来源域名：%s\n链接：%s\n摘要：%s\n\n",
			index+1,
			card.Title,
			card.Domain,
			card.URL,
			card.Snippet,
		))
	}
	return strings.TrimSpace(builder.String())
}

func truncateText(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "..."
}
