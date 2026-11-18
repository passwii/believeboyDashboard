package scheduledreport

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDataHTMLURLEncodesSpacesAndCJK(t *testing.T) {
	got := dataHTMLURL("<html><body>中文 report</body></html>")
	if !strings.HasPrefix(got, "data:text/html;charset=utf-8,") {
		t.Fatalf("data URL prefix = %q", got)
	}
	if strings.Contains(got, "+") {
		t.Fatalf("data URL must not use '+' for spaces: %q", got)
	}
	if !strings.Contains(got, "%20") || !strings.Contains(got, "%E4%B8%AD") {
		t.Fatalf("data URL did not encode spaces/CJK: %q", got)
	}
}

func TestResolveObscuraWebSocketURLDirect(t *testing.T) {
	got, err := resolveObscuraWebSocketURL(context.Background(), "ws://127.0.0.1:9222/devtools/browser")
	if err != nil {
		t.Fatalf("resolve direct URL: %v", err)
	}
	if got != "ws://127.0.0.1:9222/devtools/browser" {
		t.Fatalf("resolved URL = %q", got)
	}
}

func TestResolveObscuraWebSocketURLDiscovery(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]string{
			"webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser",
		})
	}))
	defer server.Close()

	got, err := resolveObscuraWebSocketURL(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("resolve discovery URL: %v", err)
	}
	if requestedPath != "/json/version" {
		t.Fatalf("discovery path = %q, want /json/version", requestedPath)
	}
	if got != "ws://127.0.0.1:9222/devtools/browser" {
		t.Fatalf("resolved URL = %q", got)
	}
}

func TestNewScreenshotRendererSelectsObscuraFirst(t *testing.T) {
	renderer := NewScreenshotRenderer("http://127.0.0.1:9222", "/usr/bin/chromium")
	if _, ok := renderer.(ObscuraScreenshotRenderer); !ok {
		t.Fatalf("renderer = %T, want ObscuraScreenshotRenderer", renderer)
	}
	renderer = NewScreenshotRenderer("", "/usr/bin/chromium")
	if _, ok := renderer.(ChromeScreenshotRenderer); !ok {
		t.Fatalf("renderer = %T, want ChromeScreenshotRenderer", renderer)
	}
	if renderer := NewScreenshotRenderer("", ""); renderer != nil {
		t.Fatalf("renderer = %T, want nil", renderer)
	}
}

func TestCaptureReportPNGWithObscuraRejectsEmptyInputs(t *testing.T) {
	if _, err := CaptureReportPNGWithObscura(context.Background(), "", "http://127.0.0.1:9222", 420, 600, 3); err == nil {
		t.Fatal("empty HTML should fail")
	}
	if _, err := CaptureReportPNGWithObscura(context.Background(), "<html></html>", "", 420, 600, 3); err == nil {
		t.Fatal("empty CDP URL should fail")
	}
}

func TestCaptureReportPNGWithObscura(t *testing.T) {
	cdpURL := strings.TrimSpace(os.Getenv("OBSCURA_CDP_URL"))
	if cdpURL == "" {
		t.Skip("OBSCURA_CDP_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	html := `<html><body style="margin:0;background:#f3f4f6;font-family:sans-serif">
		<h1 style="margin:0;padding:24px;color:#111827">每日运营报告</h1>
		<p style="padding:0 24px">Obscura CDP screenshot</p>
	</body></html>`
	data, err := CaptureReportPNGWithObscura(ctx, html, cdpURL, 320, 600, 2)
	if err != nil {
		t.Fatalf("CaptureReportPNGWithObscura error: %v", err)
	}
	if len(data) < 100 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("unexpected png bytes: %d", len(data))
	}
}

func TestCaptureDailyReportWithObscura(t *testing.T) {
	cdpURL := strings.TrimSpace(os.Getenv("OBSCURA_CDP_URL"))
	if cdpURL == "" {
		t.Skip("OBSCURA_CDP_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	data, err := CaptureReportPNGWithObscura(
		ctx,
		RenderDailyReportHTML(sampleReportData(), false),
		cdpURL,
		420,
		6000,
		3,
	)
	if err != nil {
		t.Fatalf("CaptureDailyReportWithObscura error: %v", err)
	}
	if len(data) < 100 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("unexpected png bytes: %d", len(data))
	}
	if output := strings.TrimSpace(os.Getenv("OBSCURA_REPORT_OUT")); output != "" {
		if err := os.WriteFile(output, data, 0o600); err != nil {
			t.Fatalf("write report screenshot: %v", err)
		}
	}
}

func TestObscuraMaxSegmentCSSHeight(t *testing.T) {
	for _, tc := range []struct {
		width, scale int
		min, max     int
	}{
		{420, 3, 4000, 4438},
		{420, 2, 9000, 9990},
		{1280, 1, 12000, 13110},
	} {
		got := obscuraMaxSegmentCSSHeight(tc.width, tc.scale)
		if got < tc.min || got > tc.max {
			t.Fatalf("obscuraMaxSegmentCSSHeight(%d,%d) = %d, want %d-%d", tc.width, tc.scale, got, tc.min, tc.max)
		}
		if pixels := (tc.width * tc.scale) * (got * tc.scale); pixels >= obscuraMaxBitmapPixels {
			t.Fatalf("segment %dx%d exceeds bitmap ceiling: %d >= %d", tc.width*tc.scale, got*tc.scale, pixels, obscuraMaxBitmapPixels)
		}
	}
	if got := obscuraMaxSegmentCSSHeight(0, 3); got != 0 {
		t.Fatalf("zero width = %d, want 0", got)
	}
}

func TestAnalyzeObscuraCJKGlyphProbe(t *testing.T) {
	cells := []int{10, 74, 138, 202, 266, 330}
	render := func(drawGlyph func(*image.RGBA, int, int)) []byte {
		img := image.NewRGBA(image.Rect(0, 0, obscuraCJKProbeWidth, obscuraCJKProbeHeight))
		for i := 0; i < img.Bounds().Dx(); i++ {
			for j := 0; j < img.Bounds().Dy(); j++ {
				img.SetRGBA(i, j, color.RGBA{R: 255, G: 255, B: 255, A: 255})
			}
		}
		for _, left := range cells {
			drawGlyph(img, left, 20)
		}
		var buffer bytes.Buffer
		if err := png.Encode(&buffer, img); err != nil {
			t.Fatalf("encode probe png: %v", err)
		}
		return buffer.Bytes()
	}
	tofuPNG := render(func(img *image.RGBA, left, top int) {
		// Hollow box: tofu .notdef glyph at 56px is roughly 15x37 px.
		for x := 0; x < 15; x++ {
			for y := 0; y < 37; y++ {
				if x == 0 || x == 14 || y == 0 || y == 36 {
					img.SetRGBA(left+22+x, top+y, color.RGBA{A: 255})
				}
			}
		}
	})
	glyphPNG := render(func(img *image.RGBA, left, top int) {
		for x := 0; x < 52; x++ {
			for y := 0; y < 52; y++ {
				if x == 0 || y == 0 || (x >= 20 && x <= 30) || (y >= 10 && y <= 16) {
					img.SetRGBA(left+4+x, top+2+y, color.RGBA{A: 255})
				}
			}
		}
	})
	if missing, err := analyzeObscuraCJKGlyphProbe(tofuPNG); err != nil || !missing {
		t.Fatalf("tofu probe missing=%v err=%v, want missing=true", missing, err)
	}
	if missing, err := analyzeObscuraCJKGlyphProbe(glyphPNG); err != nil || missing {
		t.Fatalf("glyph probe missing=%v err=%v, want missing=false", missing, err)
	}
}

func TestObscuraScreenshotTimeoutIsReported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	renderer := ObscuraScreenshotRenderer{CDPURL: server.URL, Timeout: 200 * time.Millisecond}
	start := time.Now()
	_, err := renderer.Capture(context.Background(), "<html><body>超时测试</body></html>", 420, 600)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("error = %v, want timeout message", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("timeout took %s, want under 3s", elapsed)
	}
}

func TestDataHTMLURLLargePayload(t *testing.T) {
	html := strings.Repeat("<p>中文运营报告 1234567890 abcdef</p>", 20000)
	dataURL := dataHTMLURL(html)
	if !strings.HasPrefix(dataURL, "data:text/html;charset=utf-8,") {
		t.Fatalf("large data URL prefix = %q", dataURL[:40])
	}
	if strings.Contains(dataURL, "+") {
		t.Fatal("large data URL must not use '+' for spaces")
	}
	if len(dataURL) <= len(html) {
		t.Fatalf("large data URL length %d should exceed html length %d", len(dataURL), len(html))
	}
	if len(dataURL) < 500000 {
		t.Fatalf("large data URL length = %d, want >= 500000", len(dataURL))
	}
}
