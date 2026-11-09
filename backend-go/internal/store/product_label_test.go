package store

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/ledongthuc/pdf"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_label"
)

func makeTestPDF(opts ...func(map[string]any)) []byte {
	cfg := map[string]any{
		"width":      288.0,
		"height":     432.0,
		"rotate":     0,
		"pages":      1,
		"image_only": false,
		"cropbox":    "",
	}
	for _, o := range opts {
		o(cfg)
	}

	w := cfg["width"].(float64)
	h := cfg["height"].(float64)
	rot := cfg["rotate"].(int)
	pages := cfg["pages"].(int)
	imageOnly := cfg["image_only"].(bool)
	cropbox := cfg["cropbox"].(string)

	var stream string
	if !imageOnly {
		stream = "q\nBT\n/F1 9 Tf\n1 0 0 1 18 343.1 Tm\n(X004ABCDEF) Tj\nET\nBT\n/F1 8 Tf\n1 0 0 1 18 324 Tm\n(Wireless Bluetooth Earbuds) Tj\nET\nBT\n/F1 8 Tf\n1 0 0 1 18 314 Tm\n(with Charging Case) Tj\nET\nQ\n"
	} else {
		stream = "q\n10 10 100 100 re\nf\nQ\n"
	}

	obj4 := fmt.Sprintf("4 0 obj\n<< /Length %d >>\nstream\n%sendstream\nendobj\n", len(stream), stream)
	obj5 := "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n"

	cropStr := ""
	if cropbox != "" {
		cropStr = fmt.Sprintf(" /CropBox %s", cropbox)
	}

	var kids []string
	var pageObjs []string
	if pages == 1 {
		kids = append(kids, "3 0 R")
		pageObjs = append(pageObjs, fmt.Sprintf("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 %v %v ]%s /Rotate %d /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ProcSet [ /PDF /Text ] >> >>\nendobj\n", w, h, cropStr, rot))
	} else {
		kids = append(kids, "3 0 R", "6 0 R")
		pageObjs = append(pageObjs, fmt.Sprintf("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 %v %v ]%s /Rotate %d /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ProcSet [ /PDF /Text ] >> >>\nendobj\n", w, h, cropStr, rot))
		pageObjs = append(pageObjs, fmt.Sprintf("6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 %v %v ] /Rotate 0 /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ProcSet [ /PDF /Text ] >> >>\nendobj\n", w, h))
	}

	obj1 := "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
	obj2 := fmt.Sprintf("2 0 obj\n<< /Type /Pages /Kids [ %s ] /Count %d >>\nendobj\n", strings.Join(kids, " "), pages)

	header := "%PDF-1.4\n"
	totalObjs := 5
	if pages > 1 {
		totalObjs = 6
	}

	var allObjs = []string{obj1, obj2}
	allObjs = append(allObjs, pageObjs...)
	allObjs = append(allObjs, obj4, obj5)

	offsets := make([]int, len(allObjs))
	curOff := len(header)
	for i, o := range allObjs {
		offsets[i] = curOff
		curOff += len(o)
	}
	offXref := curOff

	var xrefBuf bytes.Buffer
	xrefBuf.WriteString(fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", totalObjs+1))
	// Object 1..N
	// Need to map objID to offset
	objMap := make(map[int]int)
	objMap[1] = offsets[0]
	objMap[2] = offsets[1]
	objMap[3] = offsets[2]
	if pages == 1 {
		objMap[4] = offsets[3]
		objMap[5] = offsets[4]
	} else {
		objMap[6] = offsets[3]
		objMap[4] = offsets[4]
		objMap[5] = offsets[5]
	}

	for id := 1; id <= totalObjs; id++ {
		xrefBuf.WriteString(fmt.Sprintf("%010d 00000 n \n", objMap[id]))
	}

	trailer := fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", totalObjs+1, offXref)

	var buf bytes.Buffer
	buf.WriteString(header)
	for _, o := range allObjs {
		buf.WriteString(o)
	}
	buf.WriteString(xrefBuf.String())
	buf.WriteString(trailer)
	return buf.Bytes()
}

func TestProductLabelServiceSuccess(t *testing.T) {
	svc := NewProductLabelService()
	inPDF := makeTestPDF()

	out, name, err := svc.Generate(context.Background(), product_label.GenerateInput{
		Filename:    "my-label.pdf",
		PDFBytes:    inPDF,
		Text:        "Designed in California",
		MadeInChina: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if name != "my-label-labeled.pdf" {
		t.Fatalf("unexpected output name: %s", name)
	}
	if len(out) == 0 {
		t.Fatal("expected non-empty output")
	}

	// Verify with PDF reader
	r, err := pdf.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatalf("failed to read output PDF: %v", err)
	}
	if r.NumPage() != 1 {
		t.Fatalf("expected 1 page, got %d", r.NumPage())
	}
	plain, err := r.Page(1).GetPlainText(nil)
	if err != nil {
		t.Fatalf("failed to get plain text: %v", err)
	}
	if !strings.Contains(plain, "X004ABCDEF") {
		t.Fatalf("output should contain original FNSKU, got: %q", plain)
	}
	if !strings.Contains(plain, "Designed in California") {
		t.Fatalf("output should contain added text, got: %q", plain)
	}
	if !strings.Contains(plain, "Made In China") {
		t.Fatalf("output should contain Made In China, got: %q", plain)
	}
}

func TestProductLabelServiceMadeInChinaOnly(t *testing.T) {
	svc := NewProductLabelService()
	inPDF := makeTestPDF()

	out, name, err := svc.Generate(context.Background(), product_label.GenerateInput{
		Filename:    "my-label.pdf",
		PDFBytes:    inPDF,
		Text:        "",
		MadeInChina: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if name != "my-label-labeled.pdf" {
		t.Fatalf("unexpected name: %s", name)
	}

	r, err := pdf.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatalf("failed to read output PDF: %v", err)
	}
	plain, err := r.Page(1).GetPlainText(nil)
	if err != nil {
		t.Fatalf("failed to get plain text: %v", err)
	}
	if !strings.Contains(plain, "Made In China") {
		t.Fatalf("expected Made In China in plain text, got: %q", plain)
	}
}

func TestProductLabelServiceFailClosedErrors(t *testing.T) {
	svc := NewProductLabelService()
	ctx := context.Background()

	// 1. Corrupt PDF
	_, _, err := svc.Generate(ctx, product_label.GenerateInput{
		Filename: "bad.pdf",
		PDFBytes: []byte("not a pdf"),
		Text:     "Hi",
	})
	if err == nil || !strings.Contains(err.Error(), "无法解析该 PDF") {
		t.Fatalf("expected corrupt PDF error, got %v", err)
	}

	// 2. Empty content
	_, _, err = svc.Generate(ctx, product_label.GenerateInput{
		Filename:    "label.pdf",
		PDFBytes:    makeTestPDF(),
		Text:        "   ",
		MadeInChina: false,
	})
	if err == nil || !strings.Contains(err.Error(), "至少填写") {
		t.Fatalf("expected at least one field error, got %v", err)
	}

	// 3. Text too long (> 200 runes)
	_, _, err = svc.Generate(ctx, product_label.GenerateInput{
		Filename: "label.pdf",
		PDFBytes: makeTestPDF(),
		Text:     strings.Repeat("长", 201),
	})
	if err == nil || !strings.Contains(err.Error(), "过长") {
		t.Fatalf("expected text too long error, got %v", err)
	}

	// 4. Multi-page
	multiPDF := makeTestPDF(func(m map[string]any) { m["pages"] = 2 })
	_, _, err = svc.Generate(ctx, product_label.GenerateInput{
		Filename: "multi.pdf",
		PDFBytes: multiPDF,
		Text:     "Hi",
	})
	if err == nil || !strings.Contains(err.Error(), "仅支持单页") {
		t.Fatalf("expected multi-page error, got %v", err)
	}

	// 5. Rotated
	rotPDF := makeTestPDF(func(m map[string]any) { m["rotate"] = 90 })
	_, _, err = svc.Generate(ctx, product_label.GenerateInput{
		Filename: "rot.pdf",
		PDFBytes: rotPDF,
		Text:     "Hi",
	})
	if err == nil || !strings.Contains(err.Error(), "页面旋转") {
		t.Fatalf("expected rotation error, got %v", err)
	}

	// 6. CropBox offset
	cropPDF := makeTestPDF(func(m map[string]any) { m["cropbox"] = "[ 10 10 288 432 ]" })
	_, _, err = svc.Generate(ctx, product_label.GenerateInput{
		Filename: "crop.pdf",
		PDFBytes: cropPDF,
		Text:     "Hi",
	})
	if err == nil || !strings.Contains(err.Error(), "原点不在左下角") {
		t.Fatalf("expected cropbox offset error, got %v", err)
	}

	// 7. Image-only (no text)
	imgPDF := makeTestPDF(func(m map[string]any) { m["image_only"] = true })
	_, _, err = svc.Generate(ctx, product_label.GenerateInput{
		Filename: "img.pdf",
		PDFBytes: imgPDF,
		Text:     "Hi",
	})
	if err == nil || !strings.Contains(err.Error(), "提取不到任何文字") {
		t.Fatalf("expected image-only error, got %v", err)
	}

	// 8. Text too wide
	_, _, err = svc.Generate(ctx, product_label.GenerateInput{
		Filename: "label.pdf",
		PDFBytes: makeTestPDF(),
		Text:     strings.Repeat("W", 80),
	})
	if err == nil || !strings.Contains(err.Error(), "过宽") {
		t.Fatalf("expected text too wide error, got %v", err)
	}
}

func TestProductLabelDeepResourcePreservation(t *testing.T) {
	svc := NewProductLabelService()

	// Construct a PDF that contains /XObject, /ExtGState, and /ColorSpace in its page /Resources
	stream := "q\nBT\n/F1 9 Tf\n1 0 0 1 18 343.1 Tm\n(X004ABCDEF) Tj\nET\nQ\n"
	obj4 := fmt.Sprintf("4 0 obj\n<< /Length %d >>\nstream\n%sendstream\nendobj\n", len(stream), stream)
	obj5 := "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n"
	obj6 := "6 0 obj\n<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /BitsPerComponent 8 /ColorSpace /DeviceGray >>\nstream\n0123456789endstream\nendobj\n"
	page3 := "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 288 432 ] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /ImBarcode 6 0 R >> /ExtGState << /GS1 << /Type /ExtGState /ca 0.8 >> >> /ColorSpace << /CS1 /DeviceRGB >> /ProcSet [ /PDF /Text /ImageB ] >> >>\nendobj\n"
	obj1 := "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
	obj2 := "2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n"

	header := "%PDF-1.4\n"
	allObjs := []string{obj1, obj2, page3, obj4, obj5, obj6}
	offsets := make([]int, len(allObjs))
	curOff := len(header)
	for i, o := range allObjs {
		offsets[i] = curOff
		curOff += len(o)
	}
	offXref := curOff

	var xrefBuf bytes.Buffer
	xrefBuf.WriteString(fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", len(allObjs)+1))
	for _, off := range offsets {
		xrefBuf.WriteString(fmt.Sprintf("%010d 00000 n \n", off))
	}
	trailer := fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(allObjs)+1, offXref)

	var buf bytes.Buffer
	buf.WriteString(header)
	for _, o := range allObjs {
		buf.WriteString(o)
	}
	buf.WriteString(xrefBuf.String())
	buf.WriteString(trailer)
	rawPDF := buf.Bytes()

	out, _, err := svc.Generate(context.Background(), product_label.GenerateInput{
		Filename:    "label_with_resources.pdf",
		PDFBytes:    rawPDF,
		Text:        "Item 123",
		MadeInChina: true,
	})
	if err != nil {
		t.Fatalf("unexpected generate error: %v", err)
	}

	r, err := pdf.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatalf("failed to read output PDF: %v", err)
	}
	p := r.Page(1)
	res := p.V.Key("Resources")

	// Verify XObject preserved
	xobj := res.Key("XObject")
	if xobj.IsNull() {
		t.Fatal("expected /XObject in /Resources, got null")
	}
	if xobj.Key("ImBarcode").IsNull() {
		t.Fatalf("expected /ImBarcode in /XObject, got null: %s", xobj.String())
	}

	// Verify ExtGState preserved
	extGState := res.Key("ExtGState")
	if extGState.IsNull() {
		t.Fatal("expected /ExtGState in /Resources, got null")
	}
	if extGState.Key("GS1").IsNull() {
		t.Fatalf("expected /GS1 in /ExtGState, got null: %s", extGState.String())
	}

	// Verify ColorSpace preserved
	cs := res.Key("ColorSpace")
	if cs.IsNull() {
		t.Fatal("expected /ColorSpace in /Resources, got null")
	}
	if cs.Key("CS1").IsNull() {
		t.Fatalf("expected /CS1 in /ColorSpace, got null: %s", cs.String())
	}

	// Verify both original font /F1 and added overlay font /F_OL exist
	fonts := res.Key("Font")
	if fonts.Key("F1").IsNull() {
		t.Fatal("expected /F1 font preserved")
	}
	if fonts.Key("F_OL").IsNull() {
		t.Fatal("expected /F_OL overlay font added")
	}

	plain, err := p.GetPlainText(nil)
	if err != nil {
		t.Fatalf("failed to get plain text: %v", err)
	}
	if !strings.Contains(plain, "Item 123") || !strings.Contains(plain, "Made In China") {
		t.Fatalf("plain text missing added text, got: %q", plain)
	}
}
