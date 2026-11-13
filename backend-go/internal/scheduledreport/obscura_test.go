package scheduledreport

import (
	"context"
	"encoding/json"
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
