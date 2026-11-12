package mailer

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultBaseURL          = "https://api.resend.com"
	defaultTimeout          = 30 * time.Second
	defaultMaxResponseBytes = int64(1 * 1024 * 1024)
	defaultMaxMessageBytes  = int64(10 * 1024 * 1024)
	maxIdempotencyKeyBytes  = 256
	// maxAttachmentBytes caps one attachment so a runaway screenshot cannot
	// inflate the request past the provider limit.
	maxAttachmentBytes = int64(20 * 1024 * 1024)
	// maxAttachmentNameBytes keeps filenames inside what mail clients render.
	maxAttachmentNameBytes = 255
)

// Config controls Resend delivery. BaseURL is injectable so tests and
// self-hosted compatible relays can run without external network calls.
type Config struct {
	APIKey           string
	From             string
	BaseURL          string
	Timeout          time.Duration
	MaxResponseBytes int64
	MaxMessageBytes  int64
	HTTPClient       *http.Client
}

// Message contains the fields supported by the Resend email endpoint. At
// least one of HTML or Text must be present.
type Message struct {
	To             string
	Subject        string
	HTML           string
	Text           string
	IdempotencyKey string
	Attachments    []Attachment
}

// Attachment is one base64-encoded file carried with the message. Content is
// raw bytes; encoding happens at request build time.
type Attachment struct {
	Filename string
	Content  []byte
}

// Result is returned after a successful provider response.
type Result struct {
	ID         string
	StatusCode int
}

// Mailer sends transactional email through Resend.
type Mailer struct {
	baseURL          string
	apiKey           string
	from             string
	timeout          time.Duration
	maxResponseBytes int64
	maxMessageBytes  int64
	client           *http.Client
	configErr        error
}

// New builds a fail-closed Mailer. An absent API key is allowed at
// construction so optional background services can start; Send will refuse to
// make a request until the key is configured through a new Mailer instance.
func New(config Config) *Mailer {
	baseURL := strings.TrimSpace(config.BaseURL)
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	normalizedBaseURL, err := validateBaseURL(baseURL)
	if err != nil {
		return &Mailer{configErr: err}
	}

	timeout := config.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	if timeout < 0 {
		return &Mailer{configErr: fmt.Errorf("mailer timeout must be positive")}
	}
	maxResponseBytes := config.MaxResponseBytes
	if maxResponseBytes == 0 {
		maxResponseBytes = defaultMaxResponseBytes
	}
	if maxResponseBytes < 0 {
		return &Mailer{configErr: fmt.Errorf("mailer max response bytes must be positive")}
	}
	maxMessageBytes := config.MaxMessageBytes
	if maxMessageBytes == 0 {
		maxMessageBytes = defaultMaxMessageBytes
	}
	if maxMessageBytes < 0 {
		return &Mailer{configErr: fmt.Errorf("mailer max message bytes must be positive")}
	}

	apiKey := strings.TrimSpace(config.APIKey)
	if apiKey != "" && containsControl(apiKey) {
		return &Mailer{configErr: fmt.Errorf("mailer API key contains control characters")}
	}
	from := strings.TrimSpace(config.From)
	if from == "" {
		return &Mailer{configErr: fmt.Errorf("mailer from address is required")}
	}
	normalizedFrom, err := normalizeMailbox(from)
	if err != nil {
		return &Mailer{configErr: fmt.Errorf("mailer from address: %w", err)}
	}

	client := config.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}

	return &Mailer{
		baseURL:          normalizedBaseURL,
		apiKey:           apiKey,
		from:             normalizedFrom,
		timeout:          timeout,
		maxResponseBytes: maxResponseBytes,
		maxMessageBytes:  maxMessageBytes,
		client:           client,
	}
}

// Configured reports whether Send can make a request without failing closed.
func (mailer *Mailer) Configured() bool {
	return mailer != nil && mailer.configErr == nil && mailer.apiKey != "" && mailer.from != ""
}

// Send sends one Resend email request. It does not retry implicitly: when a
// caller or queue retries, pass the same IdempotencyKey so Resend can dedupe.
func (mailer *Mailer) Send(
	ctx context.Context,
	message Message,
) (Result, error) {
	if mailer == nil {
		return Result{}, ErrNotConfigured
	}
	if mailer.configErr != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrNotConfigured, mailer.configErr)
	}
	if mailer.apiKey == "" {
		return Result{}, fmt.Errorf("%w: RESEND_API_KEY is empty", ErrNotConfigured)
	}
	if mailer.from == "" {
		return Result{}, fmt.Errorf("%w: sender address is empty", ErrNotConfigured)
	}
	if ctx == nil {
		return Result{}, invalidMessage("context is nil")
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}

	to, err := normalizeMailbox(message.To)
	if err != nil {
		return Result{}, invalidMessage("invalid recipient: " + err.Error())
	}
	subject := strings.TrimSpace(message.Subject)
	if subject == "" {
		return Result{}, invalidMessage("subject is required")
	}
	if len(subject) > 998 || containsControl(subject) {
		return Result{}, invalidMessage("subject is invalid")
	}
	if strings.TrimSpace(message.HTML) == "" && strings.TrimSpace(message.Text) == "" {
		return Result{}, invalidMessage("html or text body is required")
	}
	if int64(len(message.HTML)+len(message.Text)) > mailer.maxMessageBytes {
		return Result{}, fmt.Errorf(
			"%w: body exceeds %d bytes",
			ErrInvalidMessage,
			mailer.maxMessageBytes,
		)
	}
	idempotencyKey := message.IdempotencyKey
	if idempotencyKey != "" {
		if len(idempotencyKey) > maxIdempotencyKeyBytes || containsControl(idempotencyKey) {
			return Result{}, invalidMessage("idempotency key is invalid")
		}
	}

	attachments, err := encodeAttachments(message.Attachments)
	if err != nil {
		return Result{}, err
	}

	payload := struct {
		From        string              `json:"from"`
		To          []string            `json:"to"`
		Subject     string              `json:"subject"`
		HTML        string              `json:"html,omitempty"`
		Text        string              `json:"text,omitempty"`
		Attachments []encodedAttachment `json:"attachments,omitempty"`
	}{
		From:        mailer.from,
		To:          []string{to},
		Subject:     subject,
		HTML:        message.HTML,
		Text:        message.Text,
		Attachments: attachments,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Result{}, fmt.Errorf("mailer: encode request: %w", err)
	}

	operationContext, cancel := context.WithTimeout(ctx, mailer.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		operationContext,
		http.MethodPost,
		mailer.baseURL+"/emails",
		bytes.NewReader(body),
	)
	if err != nil {
		return Result{}, fmt.Errorf("mailer: create request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+mailer.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "believeboy-dashboard-go/1.0")
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}

	response, err := mailer.client.Do(request)
	if err != nil {
		if contextErr := operationContext.Err(); contextErr != nil {
			return Result{}, contextErr
		}
		return Result{}, fmt.Errorf("mailer: send request: %w", err)
	}
	defer response.Body.Close()

	responseBody, err := readLimited(response.Body, mailer.maxResponseBytes)
	if err != nil {
		if contextErr := operationContext.Err(); contextErr != nil {
			return Result{}, contextErr
		}
		return Result{}, err
	}

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return Result{}, decodeAPIError(response.StatusCode, response.Header, responseBody)
	}

	var payloadResponse struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(responseBody, &payloadResponse); err != nil {
		return Result{}, fmt.Errorf("%w: decode response: %v", ErrMalformedResponse, err)
	}
	if strings.TrimSpace(payloadResponse.ID) == "" {
		return Result{}, fmt.Errorf("%w: response id is empty", ErrMalformedResponse)
	}
	return Result{ID: payloadResponse.ID, StatusCode: response.StatusCode}, nil
}

type encodedAttachment struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

// encodeAttachments validates and base64-encodes message attachments. Rejecting
// empty, oversized, or unsafe filenames here keeps the provider request
// well-formed instead of failing mid-flight.
func encodeAttachments(attachments []Attachment) ([]encodedAttachment, error) {
	if len(attachments) == 0 {
		return nil, nil
	}
	encoded := make([]encodedAttachment, 0, len(attachments))
	for index, attachment := range attachments {
		name := strings.TrimSpace(attachment.Filename)
		if name == "" {
			return nil, invalidMessage(fmt.Sprintf("attachment %d: filename is required", index))
		}
		if len(name) > maxAttachmentNameBytes || containsControl(name) || strings.ContainsAny(name, "/\\") {
			return nil, invalidMessage(fmt.Sprintf("attachment %d: filename is unsafe", index))
		}
		if len(attachment.Content) == 0 {
			return nil, invalidMessage(fmt.Sprintf("attachment %d: content is empty", index))
		}
		if int64(len(attachment.Content)) > maxAttachmentBytes {
			return nil, fmt.Errorf("%w: attachment %d exceeds %d bytes", ErrInvalidMessage, index, maxAttachmentBytes)
		}
		encoded = append(encoded, encodedAttachment{
			Filename: name,
			Content:  base64.StdEncoding.EncodeToString(attachment.Content),
		})
	}
	return encoded, nil
}

// SendText is a convenience wrapper for text-only transactional messages.
func (mailer *Mailer) SendText(
	ctx context.Context,
	to string,
	subject string,
	text string,
	idempotencyKey string,
) (Result, error) {
	return mailer.Send(ctx, Message{
		To:             to,
		Subject:        subject,
		Text:           text,
		IdempotencyKey: idempotencyKey,
	})
}

func readLimited(reader io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("mailer: read response: %w", err)
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("%w: response exceeds %d bytes", ErrResponseTooLarge, maxBytes)
	}
	return body, nil
}

func decodeAPIError(statusCode int, header http.Header, body []byte) error {
	var payload struct {
		Name    string `json:"name"`
		Message string `json:"message"`
	}
	message := ""
	_ = json.Unmarshal(body, &payload)
	if payload.Name != "" || payload.Message != "" {
		message = strings.TrimSpace(payload.Message)
	} else {
		message = truncate(strings.TrimSpace(string(body)), 2048)
	}
	return &APIError{
		StatusCode: statusCode,
		Name:       strings.TrimSpace(payload.Name),
		Message:    message,
		RetryAfter: parseRetryAfter(header.Get("Retry-After")),
	}
}

func parseRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if retryAt, err := http.ParseTime(value); err == nil {
		if wait := time.Until(retryAt); wait > 0 {
			return wait
		}
	}
	return 0
}

func normalizeMailbox(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 512 || containsControl(value) {
		return "", fmt.Errorf("mailbox is invalid")
	}
	address, err := mail.ParseAddress(value)
	if err != nil || address.Address == "" {
		return "", fmt.Errorf("mailbox is invalid")
	}
	if address.Name == "" {
		return address.Address, nil
	}
	return value, nil
}

func validateBaseURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("mailer base URL must be absolute")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", fmt.Errorf("mailer base URL must use HTTPS")
	}
	if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return "", fmt.Errorf("mailer base URL must use HTTPS except for loopback tests")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("mailer base URL must not contain credentials, query, or fragment")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func containsControl(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

func truncate(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	return value[:maxBytes]
}
