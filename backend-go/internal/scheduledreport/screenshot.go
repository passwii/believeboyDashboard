package scheduledreport

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
	xdraw "golang.org/x/image/draw"
)

// ScreenshotResult holds uploaded screenshot keys and public URLs.
type ScreenshotResult struct {
	FullKey  string
	FullURL  string
	ThumbKey string
	ThumbURL string
}

// CaptureReportPNG renders an HTML document to PNG with headless Chrome.
// The HTML is expected to be a self-contained report page.
func CaptureReportPNG(ctx context.Context, html string, chromePath string, width, height int) ([]byte, error) {
	if strings.TrimSpace(html) == "" {
		return nil, fmt.Errorf("screenshot html is empty")
	}
	chrome, err := resolveChrome(chromePath)
	if err != nil {
		return nil, err
	}
	if width <= 0 {
		width = 420
	}
	if height <= 0 {
		height = 6000
	}
	tempDir, err := os.MkdirTemp("", "report-screenshot-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)
	htmlPath := filepath.Join(tempDir, "report.html")
	pngPath := filepath.Join(tempDir, "report.png")
	if err := os.WriteFile(htmlPath, []byte(html), 0o600); err != nil {
		return nil, err
	}
	args := []string{
		"--headless=new",
		"--disable-gpu",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--hide-scrollbars",
		"--force-device-scale-factor=3",
		fmt.Sprintf("--window-size=%d,%d", width, height),
		"--virtual-time-budget=3000",
		"--screenshot=" + pngPath,
		"file://" + htmlPath,
	}
	command := exec.CommandContext(ctx, chrome, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("chrome screenshot: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	data, err := os.ReadFile(pngPath)
	if err != nil {
		return nil, err
	}
	if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		return nil, fmt.Errorf("chrome screenshot did not produce a PNG")
	}
	return data, nil
}

func resolveChrome(configured string) (string, error) {
	candidates := []string{
		configured,
		os.Getenv("CHROME_BIN"),
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/chromium-browser",
		"/usr/bin/chromium",
		"/usr/bin/google-chrome",
	}
	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	if path, err := exec.LookPath("chromium"); err == nil {
		return path, nil
	}
	if path, err := exec.LookPath("google-chrome"); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("chrome binary not found; set CHROME_BIN")
}

// ResizePNG scales a PNG by the given divisor using CatmullRom.
func ResizePNG(data []byte, divisor int) ([]byte, error) {
	if divisor <= 1 {
		return data, nil
	}
	source, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	bounds := source.Bounds()
	width := bounds.Dx() / divisor
	height := bounds.Dy() / divisor
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}
	destination := image.NewRGBA(image.Rect(0, 0, width, height))
	xdraw.CatmullRom.Scale(destination, destination.Bounds(), source, bounds, xdraw.Over, nil)
	var output bytes.Buffer
	if err := png.Encode(&output, destination); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// UploadScreenshot uploads full and thumbnail screenshots to object storage.
func UploadScreenshot(
	ctx context.Context,
	store blob.ObjectStore,
	fullPNG, thumbPNG []byte,
	projectName, reportDate, frequency, country string,
	now time.Time,
) (ScreenshotResult, error) {
	result := ScreenshotResult{}
	if store == nil {
		return result, fmt.Errorf("object store is required")
	}
	projectSlug := sanitizeScreenshotSegment(projectName)
	if projectSlug == "" {
		projectSlug = "project"
	}
	timestamp := now.Format("20060102T150405")
	filename := fmt.Sprintf("%s_%s_%s_%s.png", reportDate, frequency, country, timestamp)
	fullKey := fmt.Sprintf("%s/scheduled-reports/full/%s", projectSlug, filename)
	thumbKey := fmt.Sprintf("%s/scheduled-reports/thumb/%s_thumb.png", projectSlug, filename)
	fullURL, err := store.Put(ctx, fullKey, fullPNG, "image/png")
	if err != nil {
		return result, err
	}
	thumbURL, err := store.Put(ctx, thumbKey, thumbPNG, "image/png")
	if err != nil {
		return result, err
	}
	result.FullKey, result.FullURL = fullKey, fullURL
	result.ThumbKey, result.ThumbURL = thumbKey, thumbURL
	return result, nil
}

func sanitizeScreenshotSegment(value string) string {
	value = strings.TrimSpace(value)
	replacer := strings.NewReplacer("/", "_", "\\", "_", "\x00", "")
	return replacer.Replace(value)
}
