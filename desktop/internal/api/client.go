package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
)

const (
	defaultHTTPTimeout = 15 * time.Second
	maxErrorBodyBytes  = 64 << 10
)

var (
	ErrUnauthorized       = errors.New("api: unauthorized")
	ErrForbidden          = errors.New("api: forbidden")
	ErrRateLimited        = errors.New("api: rate limited")
	ErrNetwork            = errors.New("api: network error")
	ErrUnexpectedStatus   = errors.New("api: unexpected status")
	ErrInvalidResponse    = errors.New("api: invalid response")
	ErrSessionUnavailable = errors.New("api: session unavailable")
)

// HTTPClient is injectable so tests never open a network connection.
type HTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

// SessionStore is the subset of auth.Store used by the API client.
type SessionStore interface {
	Load(ctx context.Context) (auth.Session, string, error)
	Save(ctx context.Context, session auth.Session, apiKey string) error
	Clear(ctx context.Context) error
}

type ClientConfig struct {
	BaseURL    string
	ClientID   string
	HTTPClient HTTPClient
	Sessions   SessionStore
}

type Client struct {
	baseURL  string
	clientID string
	http     HTTPClient
	sessions SessionStore
}

func NewClient(config ClientConfig) (*Client, error) {
	baseURL, err := normalizeBaseURL(config.BaseURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.ClientID) == "" {
		return nil, fmt.Errorf("api: client_id is required")
	}
	if config.Sessions == nil {
		return nil, fmt.Errorf("api: session store is required")
	}

	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHTTPTimeout}
	}

	return &Client{
		baseURL:  baseURL,
		clientID: strings.TrimSpace(config.ClientID),
		http:     httpClient,
		sessions: config.Sessions,
	}, nil
}

func (c *Client) Login(
	ctx context.Context,
	email string,
	password string,
) (*LoginResponse, error) {
	requestBody := LoginRequest{Email: email, Password: password}
	var response LoginResponse
	if err := c.doJSON(
		ctx,
		http.MethodPost,
		"/api/v1/auth/login",
		requestBody,
		&response,
		map[string]string{
			"X-Client-Id": "bb-macos-" + c.clientID,
		},
		false,
	); err != nil {
		return nil, err
	}

	session := auth.Session{
		UserID:    response.ID,
		Email:     response.Email,
		Name:      response.Name,
		FullName:  response.FullName,
		RoleType:  string(response.RoleType),
		SessionID: response.SessionID,
		IsAdmin:   response.IsAdmin,
		IsActive:  response.IsActive,
	}
	if err := c.sessions.Save(ctx, session, response.APIKey); err != nil {
		return nil, fmt.Errorf("api: persist login session: %w", err)
	}
	return &response, nil
}

// Get sends an authenticated GET request and decodes its JSON response.
func (c *Client) Get(ctx context.Context, path string, output any) error {
	return c.doJSON(ctx, http.MethodGet, path, nil, output, nil, true)
}

// Do sends an authenticated request and decodes its JSON response.
func (c *Client) Do(
	ctx context.Context,
	method string,
	path string,
	body any,
	output any,
) error {
	return c.doJSON(ctx, method, path, body, output, nil, true)
}

// Logout removes the API key and session from the Keychain. The non-secret
// client_id remains in config.json, so the next login keeps the same key slot.
func (c *Client) Logout(ctx context.Context) error {
	if err := c.sessions.Clear(ctx); err != nil {
		return fmt.Errorf("api: clear session: %w", err)
	}
	return nil
}

func (c *Client) doJSON(
	ctx context.Context,
	method string,
	path string,
	body any,
	output any,
	extraHeaders map[string]string,
	authenticated bool,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if c == nil {
		return fmt.Errorf("api: nil client")
	}
	if c.http == nil || c.sessions == nil {
		return fmt.Errorf("api: client is not initialized")
	}

	var requestBody io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("api: encode request: %w", err)
		}
		requestBody = bytes.NewReader(payload)
	}

	endpoint, err := c.endpoint(path)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, requestBody)
	if err != nil {
		return fmt.Errorf("api: create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	for key, value := range extraHeaders {
		req.Header.Set(key, value)
	}
	if authenticated {
		session, apiKey, err := c.sessions.Load(ctx)
		if errors.Is(err, auth.ErrNoSession) {
			return ErrSessionUnavailable
		}
		if err != nil {
			return fmt.Errorf("api: load session: %w", err)
		}
		applySessionHeaders(req.Header, session, apiKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return &NetworkError{Cause: err}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return decodeHTTPError(resp)
	}
	if output == nil || resp.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}

	decoder := json.NewDecoder(resp.Body)
	if err := decoder.Decode(output); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return fmt.Errorf("%w: decode %s %s: %v", ErrInvalidResponse, method, path, err)
	}
	return nil
}

func (c *Client) endpoint(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("api: request path is required")
	}
	if parsed, err := url.Parse(path); err == nil && parsed.IsAbs() {
		return "", fmt.Errorf("api: absolute request paths are not allowed")
	}
	return c.baseURL + "/" + strings.TrimLeft(path, "/"), nil
}

func normalizeBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("api: base URL is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("api: invalid base URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("api: base URL must use http or https")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("api: base URL host is required")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("api: base URL must not contain a query or fragment")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func applySessionHeaders(header http.Header, session auth.Session, apiKey string) {
	header.Set("X-API-Key", apiKey)
	header.Set("X-Session-Id", session.SessionID)
	header.Set("X-User-Id", session.UserID)
	header.Set("X-User-Email", encodeHeaderValue(session.Email))
	header.Set("X-User-Name", encodeHeaderValue(session.DisplayName()))
	header.Set("X-Operator", encodeHeaderValue(session.DisplayName()))
	header.Set("X-Is-Admin", strconv.FormatBool(session.IsAdmin))
}

// encodeHeaderValue matches encodeURIComponent closely enough for FastAPI's
// path-unescape decoding, including "+" and "@" which PathEscape leaves raw.
func encodeHeaderValue(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

func decodeHTTPError(resp *http.Response) error {
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyBytes))
	errorValue := &HTTPError{
		StatusCode: resp.StatusCode,
		RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
	}
	if readErr == nil && len(body) > 0 {
		var envelope errorEnvelope
		if err := json.Unmarshal(body, &envelope); err == nil {
			errorValue.Code = envelope.Code
			errorValue.Message = envelope.Message
			errorValue.RequestID = envelope.RequestID
			if errorValue.Message == "" {
				errorValue.Message = envelope.Detail
			}
			if envelope.RetryAfterSeconds > 0 {
				errorValue.RetryAfter = time.Duration(envelope.RetryAfterSeconds) * time.Second
			}
		}
	}
	return errorValue
}

type errorEnvelope struct {
	Detail            string `json:"detail"`
	Code              string `json:"code"`
	Message           string `json:"message"`
	RequestID         string `json:"request_id"`
	RetryAfterSeconds int    `json:"retry_after_seconds"`
}

func parseRetryAfter(raw string) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(raw); err == nil {
		if delay := time.Until(when); delay > 0 {
			return delay
		}
	}
	return 0
}

// HTTPError is returned for a non-2xx response. Use errors.Is with one of the
// exported API sentinel errors to handle a stable status class.
type HTTPError struct {
	StatusCode int
	Code       string
	Message    string
	RequestID  string
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string {
	message := e.Message
	if message == "" {
		message = http.StatusText(e.StatusCode)
	}
	return fmt.Sprintf("api: HTTP %d: %s", e.StatusCode, message)
}

func (e *HTTPError) Is(target error) bool {
	switch e.StatusCode {
	case http.StatusUnauthorized:
		return target == ErrUnauthorized
	case http.StatusForbidden:
		return target == ErrForbidden
	case http.StatusTooManyRequests:
		return target == ErrRateLimited
	default:
		return target == ErrUnexpectedStatus
	}
}

// NetworkError is returned when the transport cannot complete a request.
type NetworkError struct {
	Cause error
}

func (e *NetworkError) Error() string {
	if e.Cause == nil {
		return ErrNetwork.Error()
	}
	return fmt.Sprintf("%s: %v", ErrNetwork, e.Cause)
}

func (e *NetworkError) Unwrap() error {
	return e.Cause
}

func (e *NetworkError) Is(target error) bool {
	return target == ErrNetwork
}
