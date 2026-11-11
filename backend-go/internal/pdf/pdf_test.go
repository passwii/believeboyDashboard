package pdf

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
	"time"
)

func samplePNG(t *testing.T) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, 80, 120))
	for x := 0; x < 80; x++ {
		for y := 0; y < 120; y++ {
			source.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 200, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestPNGToPDF(t *testing.T) {
	content, err := PNGToPDF(samplePNG(t))
	if err != nil {
		t.Fatalf("PNGToPDF error: %v", err)
	}
	if !bytes.HasPrefix(content, []byte("%PDF-1.4")) {
		t.Fatalf("missing pdf header: %q", content[:8])
	}
	for _, expected := range []string{"/Type /Page", "/Subtype /Image", "startxref"} {
		if !strings.Contains(string(content), expected) {
			t.Fatalf("pdf missing %q", expected)
		}
	}
}

func TestRenderHTMLToPDF(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	content, err := RenderHTMLToPDF(ctx, "<html><body><h1>category summary</h1></body></html>", "", 620, 877)
	if err != nil {
		t.Skipf("chrome not available: %v", err)
	}
	if !bytes.HasPrefix(content, []byte("%PDF-1.4")) {
		t.Fatalf("missing pdf header")
	}
}
