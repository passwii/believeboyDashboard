package scheduledreport

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"testing"
	"time"
)

func TestResizePNG(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 300, 600))
	for x := 0; x < 300; x++ {
		for y := 0; y < 600; y++ {
			source.Set(x, y, color.RGBA{R: 10, G: 20, B: 30, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatal(err)
	}
	resized, err := ResizePNG(buffer.Bytes(), 3)
	if err != nil {
		t.Fatalf("ResizePNG error: %v", err)
	}
	decoded, err := png.Decode(bytes.NewReader(resized))
	if err != nil {
		t.Fatal(err)
	}
	if bounds := decoded.Bounds(); bounds.Dx() != 100 || bounds.Dy() != 200 {
		t.Fatalf("resized = %dx%d", bounds.Dx(), bounds.Dy())
	}
}

func TestCaptureReportPNG(t *testing.T) {
	chrome, err := resolveChrome("")
	if err != nil {
		t.Skip("chrome not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	data, err := CaptureReportPNG(ctx, "<html><body><h1>report</h1></body></html>", chrome, 320, 600)
	if err != nil {
		t.Fatalf("CaptureReportPNG error: %v", err)
	}
	if len(data) < 100 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("unexpected png bytes: %d", len(data))
	}
}
