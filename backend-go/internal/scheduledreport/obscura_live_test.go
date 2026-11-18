package scheduledreport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func liveObscuraCDPURL(t *testing.T) string {
	t.Helper()
	cdpURL := strings.TrimSpace(os.Getenv("OBSCURA_CDP_URL"))
	if cdpURL == "" {
		t.Skip("OBSCURA_CDP_URL not set")
	}
	return cdpURL
}

func pngDimensions(data []byte) (int, int, error) {
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, err
	}
	return config.Width, config.Height, nil
}

// TestCaptureLongReportWithObscuraNotCropped guards the defect where reports
// taller than obscuraMaxCSSHeight (formerly 5000) were cropped: content that
// needs more than one CDP bitmap must be stitched, and the last pixels of the
// report must be present in the PNG.
func TestCaptureLongReportWithObscuraNotCropped(t *testing.T) {
	cdpURL := liveObscuraCDPURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	html := `<html><body style="margin:0">` +
		`<div style="height:6000px;background:#ffffff"></div>` +
		`<div style="height:300px;background:#ff0000"></div>` +
		`</body></html>`
	start := time.Now()
	data, err := CaptureReportPNGWithObscura(ctx, html, cdpURL, 420, 6000, 3)
	if err != nil {
		t.Fatalf("CaptureReportPNGWithObscura long report: %v", err)
	}
	width, height, err := pngDimensions(data)
	if err != nil {
		t.Fatalf("decode long report png: %v", err)
	}
	t.Logf("long report png=%dx%d bytes=%d in %s", width, height, len(data), time.Since(start).Round(time.Millisecond))
	if width != 420*3 {
		t.Fatalf("width = %d, want %d", width, 420*3)
	}
	// 6000 + 300 CSS px content (+1 anti-clip row) at scale 3.
	if height < 6290*3 {
		t.Fatalf("height = %d, want at least %d (report bottom likely cropped)", height, 6290*3)
	}
	image, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode long report image: %v", err)
	}
	// The last anti-clipping row can be unreachable by scrolling; inspect a
	// row just above the very last pixel row instead.
	bottom := image.Bounds().Max.Y - 5
	for _, x := range []int{10, 630, 1250} {
		r, g, b, _ := image.At(x, bottom).RGBA()
		if r < 0xf000 || g > 0x1000 || b > 0x1000 {
			t.Fatalf("bottom pixel (%d,%d) = (%04x,%04x,%04x), want red report tail", x, bottom, r, g, b)
		}
	}
	topR, _, _, _ := image.At(10, 0).RGBA()
	if topR < 0xf000 {
		t.Fatalf("top pixel is not the white report body: %04x", topR)
	}
}

func TestCaptureRejectsOverTallReport(t *testing.T) {
	cdpURL := liveObscuraCDPURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	html := `<html><body style="margin:0"><div style="height:` +
		fmt.Sprintf("%d", obscuraMaxCSSHeight+1000) +
		`px;background:#fff"></div></body></html>`
	_, err := CaptureReportPNGWithObscura(ctx, html, cdpURL, 420, 6000, 3)
	if err == nil || !strings.Contains(err.Error(), "exceeds the Obscura screenshot limit") {
		t.Fatalf("error = %v, want descriptive over-height error", err)
	}
}

func TestObscuraCJKGlyphs(t *testing.T) {
	cdpURL := liveObscuraCDPURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client, err := dialObscuraCDP(ctx, cdpURL)
	if err != nil {
		t.Fatalf("dial Obscura: %v", err)
	}
	defer client.close()
	missing, err := obscuraCJKGlyphsMissing(ctx, client, cdpURL)
	if err != nil {
		t.Fatalf("CJK probe: %v", err)
	}
	t.Logf("CJK glyphs missing=%v", missing)
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OBSCURA_EXPECT_CJK"))) {
	case "present":
		if missing {
			t.Fatalf("expected readable CJK glyphs, got tofu")
		}
	case "missing":
		if !missing {
			t.Fatalf("expected tofu, got readable CJK glyphs")
		}
	}
}

func TestObscuraCaptureCleansUpTargets(t *testing.T) {
	cdpURL := liveObscuraCDPURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	before, err := liveObscuraTargetCount(ctx, cdpURL)
	if err != nil {
		t.Fatalf("count targets: %v", err)
	}
	html := RenderDailyReportHTML(sampleReportData(), false)
	for i := 0; i < 3; i++ {
		if _, err := CaptureReportPNGWithObscura(ctx, html, cdpURL, 420, 6000, 3); err != nil {
			t.Fatalf("capture %d: %v", i, err)
		}
	}
	time.Sleep(300 * time.Millisecond)
	after, err := liveObscuraTargetCount(ctx, cdpURL)
	if err != nil {
		t.Fatalf("count targets after capture: %v", err)
	}
	t.Logf("targets before=%d after=%d", before, after)
	if after > before {
		t.Fatalf("target leak: before=%d after=%d", before, after)
	}
}

func liveObscuraTargetCount(ctx context.Context, cdpURL string) (int, error) {
	discovery := strings.TrimSpace(cdpURL)
	if strings.Contains(discovery, "/devtools/") {
		index := strings.Index(discovery, "/devtools/")
		discovery = discovery[:index]
	}
	discovery = strings.TrimRight(discovery, "/") + "/json/list"
	if strings.HasPrefix(discovery, "ws://") {
		discovery = "http://" + strings.TrimPrefix(discovery, "ws://")
	}
	if strings.HasPrefix(discovery, "wss://") {
		discovery = "https://" + strings.TrimPrefix(discovery, "wss://")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, discovery, nil)
	if err != nil {
		return 0, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return 0, err
	}
	var targets []map[string]any
	if err := json.Unmarshal(body, &targets); err != nil {
		return 0, err
	}
	return len(targets), nil
}
