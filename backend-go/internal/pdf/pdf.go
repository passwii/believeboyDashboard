// Package pdf provides minimal HTML-to-PDF rendering via headless Chrome and
// PNG-to-PDF wrapping for report exports.
package pdf

import (
	"bytes"
	"compress/zlib"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// RenderHTMLToPDF renders HTML with headless Chrome, then embeds the raster
// page into a single-page A4 PDF. This avoids CJK font embedding in PDF.
func RenderHTMLToPDF(ctx context.Context, html, chromePath string, width, height int) ([]byte, error) {
	pngData, err := capturePNG(ctx, html, chromePath, width, height)
	if err != nil {
		return nil, err
	}
	return PNGToPDF(pngData)
}

func capturePNG(ctx context.Context, html, chromePath string, width, height int) ([]byte, error) {
	if strings.TrimSpace(html) == "" {
		return nil, fmt.Errorf("pdf html is empty")
	}
	chrome, err := resolveChrome(chromePath)
	if err != nil {
		return nil, err
	}
	if width <= 0 {
		width = 1240
	}
	if height <= 0 {
		height = 1754
	}
	tempDir, err := os.MkdirTemp("", "category-pdf-*")
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
		"--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
		"--hide-scrollbars", "--force-device-scale-factor=2",
		fmt.Sprintf("--window-size=%d,%d", width, height),
		"--virtual-time-budget=3000", "--screenshot=" + pngPath, "file://" + htmlPath,
	}
	command := exec.CommandContext(ctx, chrome, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("chrome render: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return os.ReadFile(pngPath)
}

func resolveChrome(configured string) (string, error) {
	candidates := []string{
		configured, os.Getenv("CHROME_BIN"),
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome",
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

// PNGToPDF embeds a PNG as a single full-page image in a minimal PDF.
func PNGToPDF(pngData []byte) ([]byte, error) {
	decoded, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		return nil, fmt.Errorf("decode png: %w", err)
	}
	bounds := decoded.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("invalid image bounds")
	}
	rgba := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			red, green, blue, alpha := decoded.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			if alpha < 0xffff {
				red = red*alpha/0xffff + (0xffff - alpha)
				green = green*alpha/0xffff + (0xffff - alpha)
				blue = blue*alpha/0xffff + (0xffff - alpha)
			}
			rgba.SetRGBA(x, y, color.RGBA{
				R: uint8(red >> 8), G: uint8(green >> 8), B: uint8(blue >> 8), A: 255,
			})
		}
	}
	rgb := make([]byte, 0, width*height*3)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			index := rgba.PixOffset(x, y)
			rgb = append(rgb, rgba.Pix[index], rgba.Pix[index+1], rgba.Pix[index+2])
		}
	}
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	if _, err := writer.Write(rgb); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	pageWidth, pageHeight := 595, 842
	content := fmt.Sprintf("q %d 0 0 %d 0 0 cm /Im0 Do Q", pageWidth, pageHeight)
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>", pageWidth, pageHeight),
		fmt.Sprintf("<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n%s\nendstream", width, height, compressed.Len(), compressed.Bytes()),
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content),
	}
	var buffer bytes.Buffer
	buffer.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for index, object := range objects {
		offsets[index] = buffer.Len()
		fmt.Fprintf(&buffer, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xrefOffset := buffer.Len()
	fmt.Fprintf(&buffer, "xref\n0 %d\n", len(objects)+1)
	buffer.WriteString("0000000000 65535 f \n")
	for _, offset := range offsets {
		fmt.Fprintf(&buffer, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&buffer, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xrefOffset)
	return buffer.Bytes(), nil
}
