package scheduledreport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"log/slog"
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
	obscuraMaxCDPCommandTime  = 30 * time.Second
	obscuraInitialViewportH   = 1000
	obscuraRenderSettleWindow = 150 * time.Millisecond
	obscuraDefaultWidth       = 420

	// obscuraMaxBitmapPixels is Chrome's CDP screenshot bitmap ceiling
	// (Skia refuses screenshots whose width*height exceeds 4096*4096 pixels).
	// Tall reports are captured in vertical segments so the final image is not
	// truncated at this limit.
	obscuraMaxBitmapPixels = 4096 * 4096

	// obscuraMaxCSSHeight is a safety ceiling for report content. Content taller
	// than this fails with a descriptive error instead of being silently cropped.
	obscuraMaxCSSHeight = 12000

	obscuraCJKProbeWidth  = 420
	obscuraCJKProbeHeight = 160
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
	data, err := CaptureReportPNGWithObscura(renderCtx, html, renderer.CDPURL, width, height, scale)
	if err != nil && errors.Is(err, context.DeadlineExceeded) {
		return nil, fmt.Errorf("obscura screenshot timed out after %s: %w", timeout, err)
	}
	return data, err
}

// CaptureReportPNGWithObscura renders self-contained report HTML to PNG using
// Obscura's Chrome DevTools Protocol server. It measures the document height and
// captures exactly that content height. When the content exceeds Chrome's
// screenshot bitmap limit, it captures the page in vertical segments and
// stitches them so long reports are never silently cropped at the viewport.
//
// height is the legacy window height. It only bounds the initial viewport; the
// captured image follows the measured document height, not the caller's window.
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
		width = obscuraDefaultWidth
	}
	if deviceScaleFactor <= 0 {
		deviceScaleFactor = obscuraDefaultScale
	}
	initialHeight := height
	if initialHeight <= 0 {
		initialHeight = obscuraInitialViewportH
	}
	if initialHeight > obscuraInitialViewportH {
		initialHeight = obscuraInitialViewportH
	}
	maxSegmentHeight := obscuraMaxSegmentCSSHeight(width, deviceScaleFactor)
	if maxSegmentHeight < 1 {
		return nil, fmt.Errorf(
			"obscura screenshot width %d at scale %d exceeds Chrome's %d-pixel bitmap limit",
			width, deviceScaleFactor, obscuraMaxBitmapPixels,
		)
	}

	client, err := dialObscuraCDP(ctx, cdpURL)
	if err != nil {
		return nil, err
	}
	defer client.close()

	warnIfObscuraCJKGlyphsMissing(ctx, client, cdpURL)

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
	if contentHeight > obscuraMaxCSSHeight {
		return nil, fmt.Errorf(
			"report content height %d CSS px exceeds the Obscura screenshot limit of %d CSS px; refusing to crop the report",
			contentHeight, obscuraMaxCSSHeight,
		)
	}
	// +1 avoids clipping the last row of descenders.
	totalCSSHeight := contentHeight + 1
	if totalCSSHeight <= maxSegmentHeight {
		return captureObscuraViewport(ctx, client, sessionID, width, totalCSSHeight, deviceScaleFactor)
	}
	return captureObscuraTallReport(ctx, client, sessionID, width, totalCSSHeight, deviceScaleFactor)
}

func obscuraMaxSegmentCSSHeight(width, scale int) int {
	if width <= 0 || scale <= 0 {
		return 0
	}
	pixelsPerCSSRow := width * scale * scale
	if pixelsPerCSSRow <= 0 {
		return 0
	}
	maxCSS := obscuraMaxBitmapPixels / pixelsPerCSSRow
	// Keep a small margin so anti-aliasing/rounding cannot cross the hard limit.
	maxCSS -= maxCSS / 50
	return maxCSS
}

// captureObscuraViewport sets the emulated viewport to height CSS pixels and
// captures the visible area.
func captureObscuraViewport(
	ctx context.Context,
	client *obscuraCDPClient,
	sessionID string,
	width, height, scale int,
) ([]byte, error) {
	if _, err := client.call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             width,
		"height":            height,
		"deviceScaleFactor": scale,
		"mobile":            false,
	}, sessionID); err != nil {
		return nil, fmt.Errorf("set final viewport: %w", err)
	}
	waitForRenderSettle(ctx)
	return captureObscuraViewportPNG(ctx, client, sessionID)
}

func captureObscuraViewportPNG(ctx context.Context, client *obscuraCDPClient, sessionID string) ([]byte, error) {
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

// captureObscuraTallReport captures content taller than a single CDP bitmap by
// scrolling the viewport and stitching the segments into one PNG.
func captureObscuraTallReport(
	ctx context.Context,
	client *obscuraCDPClient,
	sessionID string,
	width, totalCSSHeight, scale int,
) ([]byte, error) {
	segmentHeight := obscuraMaxSegmentCSSHeight(width, scale)
	if segmentHeight < 1 {
		return nil, fmt.Errorf("obscura segment height is zero")
	}
	canvas := image.NewRGBA(image.Rect(0, 0, width*scale, totalCSSHeight*scale))
	for start := 0; start < totalCSSHeight; start += segmentHeight {
		rows := segmentHeight
		if remaining := totalCSSHeight - start; remaining < rows {
			rows = remaining
		}
		if _, err := client.call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
			"width":             width,
			"height":            segmentHeight,
			"deviceScaleFactor": scale,
			"mobile":            false,
		}, sessionID); err != nil {
			return nil, fmt.Errorf("set segment viewport at %d CSS px: %w", start, err)
		}
		scrollRaw, err := client.call(ctx, "Runtime.evaluate", map[string]any{
			"expression":    fmt.Sprintf("window.scrollTo(0, %d); window.scrollY", start),
			"returnByValue": true,
		}, sessionID)
		if err != nil {
			return nil, fmt.Errorf("scroll report to %d CSS px: %w", start, err)
		}
		var scrolled struct {
			Result struct {
				Value float64 `json:"value"`
			} `json:"result"`
		}
		if err := json.Unmarshal(scrollRaw, &scrolled); err != nil {
			return nil, fmt.Errorf("decode report scroll position: %w", err)
		}
		actualScroll := int(scrolled.Result.Value)
		if actualScroll < 0 {
			actualScroll = 0
		}
		if actualScroll > start {
			actualScroll = start
		}
		waitForRenderSettle(ctx)

		segment, err := captureObscuraViewportPNG(ctx, client, sessionID)
		if err != nil {
			return nil, fmt.Errorf("capture segment at %d CSS px: %w", start, err)
		}
		segmentImage, err := png.Decode(bytes.NewReader(segment))
		if err != nil {
			return nil, fmt.Errorf("decode segment PNG at %d CSS px: %w", start, err)
		}
		bounds := segmentImage.Bounds()
		if bounds.Dx() < width*scale {
			return nil, fmt.Errorf("segment PNG at %d CSS px is %d px wide, want %d", start, bounds.Dx(), width*scale)
		}
		// Browsers clamp scrolling near the bottom of the page. Read back the
		// actual scroll offset so the overlap is cropped instead of duplicated.
		sourceOffsetCSS := start - actualScroll
		if sourceOffsetCSS < 0 {
			sourceOffsetCSS = 0
		}
		if sourceOffsetCSS >= segmentHeight {
			return nil, fmt.Errorf(
				"segment at %d CSS px starts %d rows below the captured viewport (segment height %d)",
				start, sourceOffsetCSS, segmentHeight,
			)
		}
		if sourceOffsetCSS+rows > segmentHeight {
			// Browsers clamp scrolling near the end of the document, so the
			// final anti-clipping row can be unreachable; capture what exists.
			rows = segmentHeight - sourceOffsetCSS
		}
		sourceRect := image.Rect(0, sourceOffsetCSS*scale, width*scale, (sourceOffsetCSS+rows)*scale)
		if !sourceRect.In(bounds) {
			return nil, fmt.Errorf(
				"segment PNG at %d CSS px is %dx%d, need at least %dx%d",
				start, bounds.Dx(), bounds.Dy(), sourceRect.Max.X, sourceRect.Max.Y,
			)
		}
		destinationRect := image.Rect(0, start*scale, width*scale, (start+rows)*scale)
		draw.Draw(canvas, destinationRect, segmentImage, sourceRect.Min, draw.Src)
	}
	var output bytes.Buffer
	if err := png.Encode(&output, canvas); err != nil {
		return nil, fmt.Errorf("encode stitched report PNG: %w", err)
	}
	return output.Bytes(), nil
}

// obscuraCJKProbeHTML renders six CJK glyphs at fixed positions so a missing
// font can be detected from the screenshot (hollow tofu boxes versus real glyphs).
const obscuraCJKProbeHTML = `<html><body style="margin:0;background:#fff"><div style="position:relative;width:420px;height:160px;background:#fff">` +
	`<div style="position:absolute;left:10px;top:20px;width:60px;font:56px/1 sans-serif;text-align:center">每</div>` +
	`<div style="position:absolute;left:74px;top:20px;width:60px;font:56px/1 sans-serif;text-align:center">运</div>` +
	`<div style="position:absolute;left:138px;top:20px;width:60px;font:56px/1 sans-serif;text-align:center">营</div>` +
	`<div style="position:absolute;left:202px;top:20px;width:60px;font:56px/1 sans-serif;text-align:center">报</div>` +
	`<div style="position:absolute;left:266px;top:20px;width:60px;font:56px/1 sans-serif;text-align:center">告</div>` +
	`<div style="position:absolute;left:330px;top:20px;width:60px;font:56px/1 sans-serif;text-align:center">日</div>` +
	`</div></body></html>`

var (
	obscuraCJKCheckCache sync.Map // cdpURL -> bool (true means CJK glyphs are missing)
	obscuraCJKWarned     sync.Map // cdpURL -> struct{} (warning already emitted)
)

func warnIfObscuraCJKGlyphsMissing(ctx context.Context, client *obscuraCDPClient, cdpURL string) {
	missing, err := obscuraCJKGlyphsMissing(ctx, client, cdpURL)
	if err != nil || !missing {
		return
	}
	if _, alreadyWarned := obscuraCJKWarned.LoadOrStore(cdpURL, struct{}{}); alreadyWarned {
		return
	}
	slog.Warn(
		"Obscura renders CJK text as tofu boxes; CJK fonts are not loaded. Start Obscura with --font-dir pointing at a CJK font directory (for example --font-dir frontend/public/fonts).",
		"cdp_url", cdpURL,
	)
}

// obscuraCJKGlyphsMissing renders a probe page and reports whether the six CJK
// glyphs came back as hollow .notdef boxes. The result is cached per CDP URL.
func obscuraCJKGlyphsMissing(ctx context.Context, client *obscuraCDPClient, cdpURL string) (bool, error) {
	if cached, ok := obscuraCJKCheckCache.Load(cdpURL); ok {
		return cached.(bool), nil
	}
	targetID, err := client.createTarget(ctx)
	if err != nil {
		return false, fmt.Errorf("create CJK probe target: %w", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = client.call(closeCtx, "Target.closeTarget", map[string]any{"targetId": targetID}, "")
	}()
	sessionID, err := client.attachTarget(ctx, targetID)
	if err != nil {
		return false, fmt.Errorf("attach CJK probe target: %w", err)
	}
	if _, err := client.call(ctx, "Page.enable", nil, sessionID); err != nil {
		return false, fmt.Errorf("enable CJK probe page: %w", err)
	}
	if _, err := client.call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             obscuraCJKProbeWidth,
		"height":            obscuraCJKProbeHeight,
		"deviceScaleFactor": 1,
		"mobile":            false,
	}, sessionID); err != nil {
		return false, fmt.Errorf("set CJK probe viewport: %w", err)
	}
	loadEvent := client.expectEvent("Page.loadEventFired")
	if _, err := client.call(ctx, "Page.navigate", map[string]any{
		"url": dataHTMLURL(obscuraCJKProbeHTML),
	}, sessionID); err != nil {
		return false, fmt.Errorf("navigate CJK probe page: %w", err)
	}
	if _, err := client.waitEvent(ctx, loadEvent, "Page.loadEventFired"); err != nil {
		return false, err
	}
	waitForRenderSettle(ctx)
	probePNG, err := captureObscuraViewportPNG(ctx, client, sessionID)
	if err != nil {
		return false, fmt.Errorf("capture CJK probe page: %w", err)
	}
	missing, err := analyzeObscuraCJKGlyphProbe(probePNG)
	if err != nil {
		return false, err
	}
	obscuraCJKCheckCache.Store(cdpURL, missing)
	return missing, nil
}

func analyzeObscuraCJKGlyphProbe(data []byte) (bool, error) {
	probeImage, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return false, fmt.Errorf("decode CJK probe PNG: %w", err)
	}
	bounds := probeImage.Bounds()
	if bounds.Dx() < obscuraCJKProbeWidth || bounds.Dy() < obscuraCJKProbeHeight {
		return false, fmt.Errorf(
			"CJK probe PNG is %dx%d, want at least %dx%d",
			bounds.Dx(), bounds.Dy(), obscuraCJKProbeWidth, obscuraCJKProbeHeight,
		)
	}
	chars := []int{10, 74, 138, 202, 266, 330}
	readable := 0
	for _, cellLeft := range chars {
		if obscuraProbeCellLooksLikeGlyph(probeImage, cellLeft, 20, 60, 76) {
			readable++
		}
	}
	// Real CJK glyphs draw strokes through the center of the cell; hollow tofu
	// boxes keep the center empty and are only ~15 px wide at this font size.
	return readable < 3, nil
}

func obscuraProbeCellLooksLikeGlyph(img image.Image, cellLeft, cellTop, cellWidth, cellHeight int) bool {
	minX, minY, maxX, maxY := cellWidth, cellHeight, -1, -1
	for y := 0; y < cellHeight; y++ {
		for x := 0; x < cellWidth; x++ {
			if obscuraProbeInk(img, cellLeft+x, cellTop+y) {
				if x < minX {
					minX = x
				}
				if y < minY {
					minY = y
				}
				if x > maxX {
					maxX = x
				}
				if y > maxY {
					maxY = y
				}
			}
		}
	}
	if maxX < 0 {
		return false
	}
	width := maxX - minX + 1
	height := maxY - minY + 1
	if width < 20 || height < 20 {
		// Tofu boxes at this font size are about 15 px wide.
		return false
	}
	centerX0 := minX + width*3/10
	centerX1 := minX + width*7/10
	centerY0 := minY + height*3/10
	centerY1 := minY + height*7/10
	centerInk, centerPixels := 0, 0
	for y := centerY0; y <= centerY1; y++ {
		for x := centerX0; x <= centerX1; x++ {
			centerPixels++
			if obscuraProbeInk(img, cellLeft+x, cellTop+y) {
				centerInk++
			}
		}
	}
	if centerPixels == 0 {
		return false
	}
	return float64(centerInk)/float64(centerPixels) >= 0.05
}

func obscuraProbeInk(img image.Image, x, y int) bool {
	r, g, b, _ := img.At(x, y).RGBA()
	return r < 0xf000 || g < 0xf000 || b < 0xf000
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
	_ = client.conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(time.Second),
	)
	time.Sleep(100 * time.Millisecond)
	_ = client.conn.Close()
}
