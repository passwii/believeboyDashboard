package scheduledreport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	obscuraDefaultScale       = 3
	obscuraDefaultTimeout     = 45 * time.Second
	obscuraMaxCSSHeight       = 5000
	obscuraMaxCDPCommandTime  = 30 * time.Second
	obscuraInitialViewportH   = 1000
	obscuraRenderSettleWindow = 150 * time.Millisecond
)

// ObscuraScreenshotRenderer captures report HTML through Obscura's CDP server.
type ObscuraScreenshotRenderer struct {
	CDPURL            string
	DeviceScaleFactor int
	Timeout           time.Duration
}

func (renderer ObscuraScreenshotRenderer) Capture(
	ctx context.Context,
	html string,
	width, height int,
) ([]byte, error) {
	scale := renderer.DeviceScaleFactor
	if scale <= 0 {
		scale = obscuraDefaultScale
	}
	timeout := renderer.Timeout
	if timeout <= 0 {
		timeout = obscuraDefaultTimeout
	}
	renderCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return CaptureReportPNGWithObscura(renderCtx, html, renderer.CDPURL, width, height, scale)
}

// CaptureReportPNGWithObscura renders self-contained report HTML to PNG using
// Obscura's Chrome DevTools Protocol server. It measures the document height and
// captures that viewport, avoiding the large blank area produced by a fixed
// 6000px browser window. height is treated as a maximum CSS-pixel height.
func CaptureReportPNGWithObscura(
	ctx context.Context,
	html, cdpURL string,
	width, height, deviceScaleFactor int,
) ([]byte, error) {
	if strings.TrimSpace(html) == "" {
		return nil, fmt.Errorf("screenshot html is empty")
	}
	if strings.TrimSpace(cdpURL) == "" {
		return nil, fmt.Errorf("obscura CDP URL is required")
	}
	if width <= 0 {
		width = 420
	}
	if height <= 0 {
		height = 6000
	}
	if height > obscuraMaxCSSHeight {
		height = obscuraMaxCSSHeight
	}
	if deviceScaleFactor <= 0 {
		deviceScaleFactor = obscuraDefaultScale
	}

	client, err := dialObscuraCDP(ctx, cdpURL)
	if err != nil {
		return nil, err
	}
	defer client.close()

	targetID, err := client.createTarget(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = client.call(closeCtx, "Target.closeTarget", map[string]any{"targetId": targetID}, "")
	}()

	sessionID, err := client.attachTarget(ctx, targetID)
	if err != nil {
		return nil, err
	}
	if _, err := client.call(ctx, "Page.enable", nil, sessionID); err != nil {
		return nil, fmt.Errorf("enable CDP page: %w", err)
	}

	initialHeight := height
	if initialHeight > obscuraInitialViewportH {
		initialHeight = obscuraInitialViewportH
	}
	if _, err := client.call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             width,
		"height":            initialHeight,
		"deviceScaleFactor": deviceScaleFactor,
		"mobile":            false,
	}, sessionID); err != nil {
		return nil, fmt.Errorf("set initial viewport: %w", err)
	}

	loadEvent := client.expectEvent("Page.loadEventFired")
	if _, err := client.call(ctx, "Page.navigate", map[string]any{
		"url": dataHTMLURL(html),
	}, sessionID); err != nil {
		return nil, fmt.Errorf("navigate report HTML: %w", err)
	}
	if _, err := client.waitEvent(ctx, loadEvent, "Page.loadEventFired"); err != nil {
		return nil, err
	}

	if _, err := client.call(ctx, "Runtime.evaluate", map[string]any{
		"expression":    `document.fonts ? document.fonts.ready.then(() => true) : true`,
		"awaitPromise":  true,
		"returnByValue": true,
	}, sessionID); err != nil {
		return nil, fmt.Errorf("wait for report fonts: %w", err)
	}
	waitForRenderSettle(ctx)

	contentHeight, err := measuredContentHeight(ctx, client, sessionID)
	if err != nil {
		return nil, err
	}
	if contentHeight < 1 {
		return nil, fmt.Errorf("report content height is zero")
	}
	if contentHeight > height {
		contentHeight = height
	}
	if _, err := client.call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             width,
		"height":            contentHeight + 1,
		"deviceScaleFactor": deviceScaleFactor,
		"mobile":            false,
	}, sessionID); err != nil {
		return nil, fmt.Errorf("set final viewport: %w", err)
	}
	waitForRenderSettle(ctx)

	raw, err := client.call(ctx, "Page.captureScreenshot", map[string]any{
		"format": "png",
	}, sessionID)
	if err != nil {
		return nil, fmt.Errorf("capture Obscura screenshot: %w", err)
	}
	var screenshot struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &screenshot); err != nil {
		return nil, fmt.Errorf("decode Obscura screenshot response: %w", err)
	}
	data, err := base64.StdEncoding.DecodeString(screenshot.Data)
	if err != nil {
		return nil, fmt.Errorf("decode Obscura screenshot: %w", err)
	}
	if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		return nil, fmt.Errorf("Obscura screenshot did not produce a PNG")
	}
	return data, nil
}

func waitForRenderSettle(ctx context.Context) {
	select {
	case <-ctx.Done():
	case <-time.After(obscuraRenderSettleWindow):
	}
}

func measuredContentHeight(ctx context.Context, client *obscuraCDPClient, sessionID string) (int, error) {
	raw, err := client.call(ctx, "Runtime.evaluate", map[string]any{
		"expression": `(() => {
			const documentElement = document.documentElement;
			const body = document.body;
			return Math.max(
				documentElement ? documentElement.scrollHeight : 0,
				body ? body.scrollHeight : 0
			);
		})()`,
		"returnByValue": true,
	}, sessionID)
	if err != nil {
		return 0, fmt.Errorf("measure report content: %w", err)
	}
	var evaluated struct {
		Result struct {
			Value float64 `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &evaluated); err != nil {
		return 0, fmt.Errorf("decode report content height: %w", err)
	}
	return int(evaluated.Result.Value), nil
}

func dataHTMLURL(html string) string {
	return "data:text/html;charset=utf-8," + strings.ReplaceAll(url.QueryEscape(html), "+", "%20")
}

type obscuraCDPError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type obscuraCDPMessage struct {
	ID        int64            `json:"id,omitempty"`
	Method    string           `json:"method,omitempty"`
	SessionID string           `json:"sessionId,omitempty"`
	Params    json.RawMessage  `json:"params,omitempty"`
	Result    json.RawMessage  `json:"result,omitempty"`
	Error     *obscuraCDPError `json:"error,omitempty"`
}

type obscuraCDPClient struct {
	conn        *websocket.Conn
	writeMu     sync.Mutex
	idMu        sync.Mutex
	nextID      int64
	mu          sync.Mutex
	pending     map[int64]chan obscuraCDPMessage
	eventWfs    map[string][]chan json.RawMessage
	callTimeout time.Duration
}

func dialObscuraCDP(ctx context.Context, rawURL string) (*obscuraCDPClient, error) {
	webSocketURL, err := resolveObscuraWebSocketURL(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, response, err := dialer.DialContext(ctx, webSocketURL, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("connect to Obscura CDP: %w", err)
	}
	client := &obscuraCDPClient{
		conn:        conn,
		nextID:      1,
		pending:     map[int64]chan obscuraCDPMessage{},
		eventWfs:    map[string][]chan json.RawMessage{},
		callTimeout: obscuraMaxCDPCommandTime,
	}
	go client.readLoop()
	return client, nil
}

func resolveObscuraWebSocketURL(ctx context.Context, rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("OBSCURA_CDP_URL must be an absolute URL")
	}

	if strings.Contains(parsed.Path, "/devtools/") {
		switch parsed.Scheme {
		case "http":
			parsed.Scheme = "ws"
		case "https":
			parsed.Scheme = "wss"
		case "ws", "wss":
		default:
			return "", fmt.Errorf("OBSCURA_CDP_URL must use http, https, ws, or wss")
		}
		return parsed.String(), nil
	}

	discovery := *parsed
	switch discovery.Scheme {
	case "ws":
		discovery.Scheme = "http"
	case "wss":
		discovery.Scheme = "https"
	case "http", "https":
	default:
		return "", fmt.Errorf("OBSCURA_CDP_URL must use http, https, ws, or wss")
	}
	if !strings.HasSuffix(discovery.Path, "/json/version") {
		discovery.Path = strings.TrimRight(discovery.Path, "/") + "/json/version"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, discovery.String(), nil)
	if err != nil {
		return "", err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("discover Obscura CDP endpoint: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Obscura CDP discovery returned %s", response.Status)
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&version); err != nil {
		return "", fmt.Errorf("decode Obscura CDP discovery: %w", err)
	}
	if strings.TrimSpace(version.WebSocketDebuggerURL) == "" {
		return "", fmt.Errorf("Obscura CDP discovery omitted webSocketDebuggerUrl")
	}
	return version.WebSocketDebuggerURL, nil
}

func (client *obscuraCDPClient) readLoop() {
	for {
		var message obscuraCDPMessage
		if err := client.conn.ReadJSON(&message); err != nil {
			return
		}
		if message.ID != 0 {
			client.mu.Lock()
			response := client.pending[message.ID]
			delete(client.pending, message.ID)
			client.mu.Unlock()
			if response != nil {
				response <- message
			}
			continue
		}
		if message.Method == "" {
			continue
		}
		client.mu.Lock()
		waiters := client.eventWfs[message.Method]
		client.eventWfs[message.Method] = nil
		client.mu.Unlock()
		for _, waiter := range waiters {
			waiter <- message.Params
		}
	}
}

func (client *obscuraCDPClient) call(
	ctx context.Context,
	method string,
	params any,
	sessionID string,
) (json.RawMessage, error) {
	client.idMu.Lock()
	id := client.nextID
	client.nextID++
	client.idMu.Unlock()

	response := make(chan obscuraCDPMessage, 1)
	client.mu.Lock()
	client.pending[id] = response
	client.mu.Unlock()
	defer func() {
		client.mu.Lock()
		delete(client.pending, id)
		client.mu.Unlock()
	}()

	message := map[string]any{"id": id, "method": method}
	if params != nil {
		message["params"] = params
	}
	if sessionID != "" {
		message["sessionId"] = sessionID
	}
	client.writeMu.Lock()
	err := client.conn.WriteJSON(message)
	client.writeMu.Unlock()
	if err != nil {
		return nil, err
	}

	timer := time.NewTimer(client.callTimeout)
	defer timer.Stop()
	select {
	case result := <-response:
		if result.Error != nil {
			return nil, fmt.Errorf("%s: %s (%d)", method, result.Error.Message, result.Error.Code)
		}
		return result.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("%s timed out", method)
	}
}

func (client *obscuraCDPClient) expectEvent(method string) <-chan json.RawMessage {
	waiter := make(chan json.RawMessage, 1)
	client.mu.Lock()
	client.eventWfs[method] = append(client.eventWfs[method], waiter)
	client.mu.Unlock()
	return waiter
}

func (client *obscuraCDPClient) waitEvent(
	ctx context.Context,
	waiter <-chan json.RawMessage,
	method string,
) (json.RawMessage, error) {
	timer := time.NewTimer(client.callTimeout)
	defer timer.Stop()
	select {
	case params := <-waiter:
		return params, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("timed out waiting for %s", method)
	}
}

func (client *obscuraCDPClient) createTarget(ctx context.Context) (string, error) {
	raw, err := client.call(ctx, "Target.createTarget", map[string]any{"url": "about:blank"}, "")
	if err != nil {
		return "", fmt.Errorf("create Obscura page target: %w", err)
	}
	var result struct {
		TargetID string `json:"targetId"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("decode Obscura target: %w", err)
	}
	if strings.TrimSpace(result.TargetID) == "" {
		return "", fmt.Errorf("Obscura returned an empty page target")
	}
	return result.TargetID, nil
}

func (client *obscuraCDPClient) attachTarget(ctx context.Context, targetID string) (string, error) {
	raw, err := client.call(ctx, "Target.attachToTarget", map[string]any{
		"targetId": targetID,
		"flatten":  true,
	}, "")
	if err != nil {
		return "", fmt.Errorf("attach to Obscura page target: %w", err)
	}
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("decode Obscura target session: %w", err)
	}
	if strings.TrimSpace(result.SessionID) == "" {
		return "", fmt.Errorf("Obscura returned an empty target session")
	}
	return result.SessionID, nil
}

func (client *obscuraCDPClient) close() {
	_ = client.conn.Close()
}
