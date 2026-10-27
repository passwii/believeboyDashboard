package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/passwii/believeboyDashboard/desktop/internal/auth"
)

const (
	defaultHTTPTimeout = 15 * time.Second
	maxErrorBodyBytes  = 64 << 10
	maxJSONBodyBytes   = 4 << 20
)

var (
	ErrUnauthorized          = errors.New("api: unauthorized")
	ErrForbidden             = errors.New("api: forbidden")
	ErrRateLimited           = errors.New("api: rate limited")
	ErrNetwork               = errors.New("api: network error")
	ErrUnexpectedStatus      = errors.New("api: unexpected status")
	ErrInvalidResponse       = errors.New("api: invalid response")
	ErrSessionUnavailable    = errors.New("api: session unavailable")
	ErrInvalidLogin          = errors.New("api: invalid login response")
	ErrInvalidIdentityHeader = errors.New("api: invalid identity header")
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

// LoginValidationError identifies a login response that is syntactically
// valid but cannot be persisted as an authenticated session.
type LoginValidationError struct {
	Reason     string
	StatusCode int
	Cause      error
}

func (e *LoginValidationError) Error() string {
	switch {
	case e.StatusCode != 0 && e.Reason != "":
		return fmt.Sprintf("%s: HTTP %d: %s", ErrInvalidLogin, e.StatusCode, e.Reason)
	case e.Reason != "":
		return fmt.Sprintf("%s: %s", ErrInvalidLogin, e.Reason)
	case e.Cause != nil:
		return fmt.Sprintf("%s: %v", ErrInvalidLogin, e.Cause)
	default:
		return ErrInvalidLogin.Error()
	}
}

func (e *LoginValidationError) Unwrap() error {
	return e.Cause
}

func (e *LoginValidationError) Is(target error) bool {
	return target == ErrInvalidLogin
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
	response, err := c.doRequest(
		ctx,
		http.MethodPost,
		"/api/v1/auth/login",
		requestBody,
		map[string]string{
			"X-Client-Id": "bb-macos-" + c.clientID,
		},
		false,
		HeaderEncodingBase64,
	)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return nil, &LoginValidationError{
			Reason:     fmt.Sprintf("unexpected HTTP status %d", response.StatusCode),
			StatusCode: response.StatusCode,
		}
	}
	body, err := readBoundedResponse(response.Body)
	if err != nil {
		return nil, &LoginValidationError{Reason: "invalid response body", Cause: err}
	}
	var login LoginResponse
	if err := decodeOneJSON(body, &login); err != nil {
		return nil, &LoginValidationError{Reason: "invalid response body", Cause: err}
	}
	if err := validateLoginResponse(&login); err != nil {
		return nil, err
	}
	if err := validateLoginIdentity(&login); err != nil {
		return nil, err
	}

	session := auth.Session{
		UserID:    login.ID,
		Email:     login.Email,
		Name:      login.Name,
		FullName:  login.FullName,
		RoleType:  string(login.RoleType),
		SessionID: login.SessionID,
		IsAdmin:   login.IsAdmin,
		IsActive:  login.IsActive,
	}
	if err := c.sessions.Save(ctx, session, login.APIKey); err != nil {
		return nil, fmt.Errorf("api: persist login session: %w", err)
	}
	return &login, nil
}

// Get sends an authenticated GET request and decodes its JSON response.
func (c *Client) Get(ctx context.Context, path string, output any) error {
	encoding, err := HeaderPolicyForRoute(http.MethodGet, path)
	if err != nil {
		return err
	}
	return c.GetWithHeaderPolicy(ctx, path, output, encoding)
}

func (c *Client) GetWithHeaderPolicy(
	ctx context.Context,
	path string,
	output any,
	encoding HeaderEncoding,
) error {
	return c.doJSON(ctx, http.MethodGet, path, nil, output, nil, true, encoding)
}

// Do sends an authenticated request and decodes its JSON response.
func (c *Client) Do(
	ctx context.Context,
	method string,
	path string,
	body any,
	output any,
) error {
	encoding, err := HeaderPolicyForRoute(method, path)
	if err != nil {
		return err
	}
	return c.DoWithHeaderPolicy(ctx, method, path, body, output, encoding)
}

func (c *Client) DoWithHeaderPolicy(
	ctx context.Context,
	method string,
	path string,
	body any,
	output any,
	encoding HeaderEncoding,
) error {
	return c.doJSON(ctx, method, path, body, output, nil, true, encoding)
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
	encoding HeaderEncoding,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	response, err := c.doRequest(ctx, method, path, body, extraHeaders, authenticated, encoding)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusNoContent || output == nil {
		return drainBoundedResponse(response.Body)
	}
	payload, err := readBoundedResponse(response.Body)
	if err != nil {
		return err
	}
	if err := decodeOneJSON(payload, output); err != nil {
		return fmt.Errorf("%w: decode %s %s: %v", ErrInvalidResponse, method, path, err)
	}
	return nil
}

func (c *Client) doRequest(
	ctx context.Context,
	method string,
	path string,
	body any,
	extraHeaders map[string]string,
	authenticated bool,
	encoding HeaderEncoding,
) (*http.Response, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c == nil {
		return nil, fmt.Errorf("api: nil client")
	}
	if c.http == nil || c.sessions == nil {
		return nil, fmt.Errorf("api: client is not initialized")
	}

	var requestBody io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("api: encode request: %w", err)
		}
		requestBody = bytes.NewReader(payload)
	}

	endpoint, err := c.endpoint(path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, requestBody)
	if err != nil {
		return nil, fmt.Errorf("api: create request: %w", err)
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
			return nil, ErrSessionUnavailable
		}
		if err != nil {
			return nil, fmt.Errorf("api: load session: %w", err)
		}
		if err := applySessionHeaders(req.Header, session, apiKey, encoding); err != nil {
			return nil, err
		}
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &NetworkError{Cause: err}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, decodeHTTPError(resp)
	}
	return resp, nil
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

func applySessionHeaders(
	header http.Header,
	session auth.Session,
	apiKey string,
	encoding HeaderEncoding,
) error {
	email, err := encodeIdentityForPolicy(session.Email, 0, true, encoding)
	if err != nil {
		return fmt.Errorf("%w: email: %v", ErrInvalidIdentityHeader, err)
	}
	name, err := encodeIdentityForPolicy(session.DisplayName(), 255, false, encoding)
	if err != nil {
		return fmt.Errorf("%w: name/operator: %v", ErrInvalidIdentityHeader, err)
	}
	header.Set("X-API-Key", apiKey)
	header.Set("X-Session-Id", session.SessionID)
	header.Set("X-User-Id", session.UserID)
	header.Set("X-User-Email", email)
	header.Set("X-User-Name", name)
	header.Set("X-Operator", name)
	header.Set("X-Is-Admin", strconv.FormatBool(session.IsAdmin))
	return nil
}

func encodeIdentityForPolicy(
	value string,
	maxRunes int,
	rejectWhitespace bool,
	encoding HeaderEncoding,
) (string, error) {
	if err := validateIdentityValue(value, maxRunes, rejectWhitespace); err != nil {
		return "", err
	}
	switch encoding {
	case HeaderEncodingBase64:
		return base64.StdEncoding.EncodeToString([]byte(value)), nil
	case HeaderEncodingURL:
		return strings.ReplaceAll(url.QueryEscape(value), "+", "%20"), nil
	default:
		return "", fmt.Errorf("%w: unknown encoding %q", ErrInvalidIdentityHeader, encoding)
	}
}

// encodeIdentityHeader uses Base64 because FastAPI's decoder tries Base64
// before URL decoding. Percent-encoded values can be mistaken for Base64 and
// never unquoted, so a Base64 payload is the only lossless representation.
func encodeIdentityHeader(value string, maxRunes int) (string, error) {
	return encodeIdentityForPolicy(value, maxRunes, false, HeaderEncodingBase64)
}

func validateIdentityValue(value string, maxRunes int, rejectWhitespace bool) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("%w: value is not valid UTF-8", ErrInvalidIdentityHeader)
	}
	if maxRunes > 0 && utf8.RuneCountInString(value) > maxRunes {
		return fmt.Errorf("%w: value exceeds %d runes", ErrInvalidIdentityHeader, maxRunes)
	}
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%w: leading or trailing whitespace", ErrInvalidIdentityHeader)
	}
	for _, char := range value {
		if unicode.IsControl(char) || unicode.Is(unicode.Zl, char) || unicode.Is(unicode.Zp, char) {
			return fmt.Errorf("%w: control or line-separator character", ErrInvalidIdentityHeader)
		}
		if rejectWhitespace && unicode.IsSpace(char) {
			return fmt.Errorf("%w: whitespace is not allowed", ErrInvalidIdentityHeader)
		}
	}
	return nil
}

func readBoundedResponse(reader io.Reader) ([]byte, error) {
	payload, err := io.ReadAll(io.LimitReader(reader, maxJSONBodyBytes+1))
	if err != nil {
		return nil, classifyBodyReadError(err)
	}
	if len(payload) > maxJSONBodyBytes {
		return nil, fmt.Errorf("%w: response body exceeds %d bytes", ErrInvalidResponse, maxJSONBodyBytes)
	}
	return payload, nil
}

func drainBoundedResponse(reader io.Reader) error {
	written, err := io.Copy(io.Discard, io.LimitReader(reader, maxJSONBodyBytes+1))
	if err != nil {
		return classifyBodyReadError(err)
	}
	if written > maxJSONBodyBytes {
		return fmt.Errorf("%w: response body exceeds %d bytes", ErrInvalidResponse, maxJSONBodyBytes)
	}
	return nil
}

func classifyBodyReadError(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("api: read response body: %w", err)
	}
	return &NetworkError{Cause: fmt.Errorf("api: read response body: %w", err)}
}

func decodeOneJSON(payload []byte, output any) error {
	if len(bytes.TrimSpace(payload)) == 0 {
		return fmt.Errorf("%w: empty response body", ErrInvalidResponse)
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidResponse, err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("%w: multiple JSON values", ErrInvalidResponse)
		}
		return fmt.Errorf("%w: trailing data: %v", ErrInvalidResponse, err)
	}
	return nil
}

func validateLoginResponse(response *LoginResponse) error {
	required := []struct {
		name  string
		value string
	}{
		{name: "id", value: response.ID},
		{name: "session_id", value: response.SessionID},
		{name: "api_key", value: response.APIKey},
		{name: "email", value: response.Email},
		{name: "name", value: response.Name},
		{name: "role_type", value: string(response.RoleType)},
	}
	for _, field := range required {
		if strings.TrimSpace(field.value) == "" {
			return &LoginValidationError{Reason: field.name + " is required"}
		}
	}
	if !response.HasIsAdmin() {
		return &LoginValidationError{Reason: "is_admin is required"}
	}
	if !response.IsActive {
		return &LoginValidationError{Reason: "is_active must be true"}
	}
	return nil
}

func validateLoginIdentity(response *LoginResponse) error {
	if err := validateIdentityValue(response.Email, 0, true); err != nil {
		return &LoginValidationError{Reason: "unsafe email", Cause: err}
	}
	if err := validateIdentityValue(response.Name, 255, false); err != nil {
		return &LoginValidationError{Reason: "unsafe name", Cause: err}
	}
	if response.FullName != nil {
		if err := validateIdentityValue(*response.FullName, 255, false); err != nil {
			return &LoginValidationError{Reason: "unsafe full_name", Cause: err}
		}
	}
	return nil
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
