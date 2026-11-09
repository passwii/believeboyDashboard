package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/ledongthuc/pdf"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_label"
)

const (
	gapPT              = 6.0
	lineAdvanceEM      = 1.2
	bottomMarginHardMM = 3.0
	sideMarginMM       = 3.0
	maxTextLines       = 3
	maxTextChars       = 200
	minFontSize        = 5.0
	maxFontSize        = 20.0
	fallbackFontSize   = 8.0
	mmToPT             = 72.0 / 25.4
	sizeTolerancePT    = 0.5
)

var (
	fnskuRegex = regexp.MustCompile(`^X00[0-9A-Z]{7}$`)

	helveticaWidths = []int{
		278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
		556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
		1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
		667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
		333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
		556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
	}
)

func helveticaCharWidth(ch rune, fontSize float64) float64 {
	if ch >= 32 && ch <= 126 {
		return float64(helveticaWidths[ch-32]) / 1000.0 * fontSize
	}
	return 0.5 * fontSize
}

func helveticaStringWidth(s string, fontSize float64) float64 {
	var total float64
	for _, ch := range s {
		total += helveticaCharWidth(ch, fontSize)
	}
	return total
}

func formatPDFObject(v reflect.Value) string {
	if !v.IsValid() {
		return "null"
	}
	typeName := v.Type().Name()
	if typeName == "objptr" {
		id := v.FieldByName("id").Uint()
		gen := v.FieldByName("gen").Uint()
		return fmt.Sprintf("%d %d R", id, gen)
	}
	if typeName == "name" {
		return "/" + v.String()
	}
	if typeName == "keyword" {
		return v.String()
	}
	switch v.Kind() {
	case reflect.Interface:
		if v.IsNil() {
			return "null"
		}
		return formatPDFObject(v.Elem())
	case reflect.Map:
		var keys []string
		keyMap := make(map[string]reflect.Value)
		for _, k := range v.MapKeys() {
			ks := k.String()
			keys = append(keys, ks)
			keyMap[ks] = v.MapIndex(k)
		}
		sort.Strings(keys)
		var buf bytes.Buffer
		buf.WriteString("<<")
		for _, k := range keys {
			buf.WriteString(" /")
			buf.WriteString(k)
			buf.WriteString(" ")
			buf.WriteString(formatPDFObject(keyMap[k]))
		}
		buf.WriteString(" >>")
		return buf.String()
	case reflect.Slice:
		var buf bytes.Buffer
		buf.WriteString("[")
		for i := 0; i < v.Len(); i++ {
			buf.WriteString(" ")
			buf.WriteString(formatPDFObject(v.Index(i)))
		}
		buf.WriteString(" ]")
		return buf.String()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.FormatInt(v.Int(), 10)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return strconv.FormatUint(v.Uint(), 10)
	case reflect.Float32, reflect.Float64:
		return strconv.FormatFloat(v.Float(), 'f', -1, 64)
	case reflect.Bool:
		return strconv.FormatBool(v.Bool())
	case reflect.String:
		return fmt.Sprintf("(%s)", escapePDFString(v.String()))
	default:
		return fmt.Sprint(v.Interface())
	}
}

func escapePDFString(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "(", "\\(")
	s = strings.ReplaceAll(s, ")", "\\)")
	return s
}

type textLine struct {
	text   string
	x0     float64
	x1     float64
	top    float64
	size   float64
	bottom float64
}

type placedLine struct {
	text     string
	x        float64
	baseline float64
	size     float64
	top      float64
	bottom   float64
}

type ProductLabelService struct{}

func NewProductLabelService() *ProductLabelService {
	return &ProductLabelService{}
}

func normalizeTextLines(raw string) []string {
	var res []string
	for _, l := range strings.Split(raw, "\n") {
		t := strings.TrimSpace(l)
		if t != "" {
			res = append(res, t)
			if len(res) == maxTextLines {
				break
			}
		}
	}
	return res
}

func findFNSKULineIndex(lines []textLine) int {
	matches := make([]int, 0)
	for idx, l := range lines {
		cand1 := strings.ToUpper(strings.TrimSpace(l.text))
		cand2 := strings.ToUpper(strings.ReplaceAll(l.text, " ", ""))
		if fnskuRegex.MatchString(cand1) || fnskuRegex.MatchString(cand2) {
			matches = append(matches, idx)
		}
	}
	if len(matches) == 1 {
		return matches[0]
	}
	return -1
}

func resolveProductBlock(lines []textLine) ([]textLine, error) {
	if len(lines) == 0 {
		return nil, errors.New("该 PDF 提取不到任何文字，无法定位插入点。")
	}
	if len(lines) == 1 {
		return lines, nil
	}

	fnskuIdx := findFNSKULineIndex(lines)
	if fnskuIdx >= 0 {
		block := lines[fnskuIdx+1:]
		if len(block) == 0 {
			return nil, errors.New("商品名块为空（FNSKU 行之后没有可定位的内容），无法确定插入点。")
		}
		return block, nil
	}

	leftEdge := lines[0].x0
	for _, l := range lines[1:] {
		if l.x0 < leftEdge {
			leftEdge = l.x0
		}
	}

	firstLeftIdx := 0
	for idx, l := range lines {
		if math.Abs(l.x0-leftEdge) <= sizeTolerancePT {
			firstLeftIdx = idx
			break
		}
	}

	block := lines[firstLeftIdx:]
	if len(block) == 0 {
		return nil, errors.New("商品名块为空（FNSKU 行之后没有可定位的内容），无法确定插入点。")
	}
	return block, nil
}

func (s *ProductLabelService) Generate(_ context.Context, input product_label.GenerateInput) ([]byte, string, error) {
	stem := strings.TrimSuffix(input.Filename, filepath.Ext(input.Filename))
	if stem == "" {
		stem = "label"
	}
	outFilename := fmt.Sprintf("%s-labeled.pdf", stem)

	text := strings.TrimSpace(input.Text)
	if len([]rune(text)) > maxTextChars {
		return nil, "", fmt.Errorf("文案过长，请控制在 %d 字以内。", maxTextChars)
	}

	textLines := normalizeTextLines(text)
	if len(textLines) == 0 && !input.MadeInChina {
		return nil, "", errors.New("请至少填写「文案」或勾选「Made In China」。")
	}

	// 1. Open PDF
	r, err := pdf.NewReader(bytes.NewReader(input.PDFBytes), int64(len(input.PDFBytes)))
	if err != nil {
		return nil, "", errors.New("无法解析该 PDF，请确认文件未损坏。")
	}

	numPages := r.NumPage()
	if numPages != 1 {
		return nil, "", fmt.Errorf("仅支持单页产品标签，该文件有 %d 页。请先拆分成单个标签再上传。", numPages)
	}

	page := r.Page(1)
	rot := page.V.Key("Rotate").Int64() % 360
	if rot != 0 {
		return nil, "", fmt.Errorf("该 PDF 带 %d° 页面旋转，叠加会错位，暂不支持。请在 PDF 工具里先把页面「另存为」正向版本再上传。", rot)
	}

	// Page frame (MediaBox / CropBox)
	boxVal := page.V.Key("CropBox")
	if boxVal.Kind() == pdf.Null || boxVal.Len() != 4 {
		boxVal = page.V.Key("MediaBox")
	}
	if boxVal.Kind() == pdf.Null || boxVal.Len() != 4 {
		return nil, "", errors.New("该 PDF 的页面尺寸异常，无法处理。")
	}

	boxLeft := boxVal.Index(0).Float64()
	boxBottom := boxVal.Index(1).Float64()
	boxRight := boxVal.Index(2).Float64()
	boxTop := boxVal.Index(3).Float64()
	pageWidth := boxRight - boxLeft
	pageHeight := boxTop - boxBottom

	if pageWidth <= 0 || pageHeight <= 0 {
		return nil, "", errors.New("该 PDF 的页面尺寸异常，无法处理。")
	}
	if math.Abs(boxLeft) > sizeTolerancePT || math.Abs(boxBottom) > sizeTolerancePT {
		return nil, "", errors.New("该 PDF 的页面框原点不在左下角（CropBox 有偏移），叠加会导致错位，暂不支持。")
	}

	// 2. Extract words and group into lines
	chars := page.Content().Text
	if len(chars) == 0 {
		return nil, "", errors.New("该 PDF 提取不到任何文字（可能是纯图片标签），无法定位插入点。")
	}

	type lineGroup struct {
		y     float64
		size  float64
		chars []pdf.Text
	}
	var groups []*lineGroup
	for _, ch := range chars {
		found := false
		for _, g := range groups {
			if math.Abs(ch.Y-g.y) <= 0.5*g.size {
				g.chars = append(g.chars, ch)
				found = true
				break
			}
		}
		if !found {
			sz := ch.FontSize
			if sz <= 0 {
				sz = fallbackFontSize
			}
			groups = append(groups, &lineGroup{
				y:     ch.Y,
				size:  sz,
				chars: []pdf.Text{ch},
			})
		}
	}

	// Sort lines top-to-bottom (descending Y in PDF coordinates)
	sort.Slice(groups, func(i, j int) bool {
		return groups[i].y > groups[j].y
	})

	var lines []textLine
	for _, g := range groups {
		var strBuilder strings.Builder
		startX := g.chars[0].X
		curX := startX
		for _, ch := range g.chars {
			strBuilder.WriteString(ch.S)
			if len(ch.S) > 0 {
				for _, r := range ch.S {
					curX += helveticaCharWidth(r, g.size)
				}
			}
		}
		txt := strings.TrimSpace(strBuilder.String())
		if txt == "" {
			continue
		}
		top := pageHeight - (g.y + g.size)
		lines = append(lines, textLine{
			text:   txt,
			x0:     startX,
			x1:     curX,
			top:    top,
			size:   g.size,
			bottom: top + g.size,
		})
	}

	if len(lines) == 0 {
		return nil, "", errors.New("该 PDF 提取不到任何文字（可能是纯图片标签），无法定位插入点。")
	}

	// 3. Resolve product block
	block, err := resolveProductBlock(lines)
	if err != nil {
		return nil, "", err
	}

	// Calculate median font size of product block
	var sizes []float64
	for _, l := range block {
		sizes = append(sizes, l.size)
	}
	sort.Float64s(sizes)
	fontSize := sizes[len(sizes)/2]

	if fontSize < minFontSize || fontSize > maxFontSize {
		return nil, "", fmt.Errorf("商品名字号异常（%.1fpt），不在可处理的 %.0f–%.0fpt 区间内。", fontSize, minFontSize, maxFontSize)
	}

	insertBottom := block[0].bottom
	xLeft := block[0].x0
	for _, l := range block {
		if l.bottom > insertBottom {
			insertBottom = l.bottom
		}
		if l.x0 < xLeft {
			xLeft = l.x0
		}
	}

	availableWidth := pageWidth - xLeft - (sideMarginMM * mmToPT)
	if availableWidth <= 0 {
		return nil, "", errors.New("标签可用宽度不足，无法写入文案。")
	}

	availableBottom := pageHeight - (bottomMarginHardMM * mmToPT)
	remaining := availableBottom - insertBottom
	rowSize := fontSize

	reqHeight := func(fontSz float64) float64 {
		if len(textLines) == 0 && !input.MadeInChina {
			return 0.0
		}
		labelsH := 0.0
		if len(textLines) > 0 {
			labelsH += fontSz
			if len(textLines) > 1 {
				labelsH += float64(len(textLines)-1) * lineAdvanceEM * fontSz
			}
			if input.MadeInChina {
				labelsH += gapPT + fontSz
			}
		} else {
			labelsH += fontSz
		}
		return gapPT + labelsH
	}

	if reqHeight(rowSize) > remaining {
		for rowSize > 6.0 && reqHeight(rowSize) > remaining {
			rowSize = math.Max(6.0, rowSize-0.1)
		}
		if reqHeight(rowSize) > remaining {
			return nil, "", fmt.Errorf("标签底部空间不足：商品名结束于 %.1fpt，新增内容在最小 6pt 字号和两个 6pt 段间距下仍需 %.1fpt，页面硬边距内仅余 %.1fpt。请缩短文案或选用更大的标签。",
				insertBottom, reqHeight(6.0), remaining)
		}
	}

	var placed []placedLine
	appendLine := func(txt string, top float64) error {
		needed := helveticaStringWidth(txt, rowSize)
		if needed > availableWidth {
			return fmt.Errorf("文案「%s」过宽：需要 %.1fpt，标签可用宽度仅 %.1fpt。请缩短文案或改用更小的标签。", txt, needed, availableWidth)
		}
		baseline := pageHeight - (top + 0.75*rowSize)
		placed = append(placed, placedLine{
			text:     txt,
			x:        xLeft,
			baseline: baseline,
			size:     rowSize,
			top:      top,
			bottom:   top + rowSize,
		})
		return nil
	}

	for idx, txt := range textLines {
		var top float64
		if idx == 0 {
			top = insertBottom + gapPT
		} else {
			top = placed[len(placed)-1].top + lineAdvanceEM*rowSize
		}
		if err := appendLine(txt, top); err != nil {
			return nil, "", err
		}
	}

	if input.MadeInChina {
		var top float64
		if len(placed) > 0 {
			top = placed[len(placed)-1].bottom + gapPT
		} else {
			top = insertBottom + gapPT
		}
		if err := appendLine("Made In China", top); err != nil {
			return nil, "", err
		}
	}

	if len(placed) == 0 {
		return nil, "", errors.New("请至少填写「文案」或勾选「Made In China」。")
	}

	finalBottom := placed[0].bottom
	for _, l := range placed {
		if l.bottom > finalBottom {
			finalBottom = l.bottom
		}
	}
	bottomMargin := pageHeight - finalBottom
	if bottomMargin < bottomMarginHardMM*mmToPT {
		return nil, "", fmt.Errorf("插入后底部只剩 %.2fpt（%.2fmm），低于 %.0fmm 硬性安全边距，热敏机边缘会裁字。请减少文案行数或换用更大的标签。",
			bottomMargin, bottomMargin/mmToPT, bottomMarginHardMM)
	}

	// 4. Construct PDF incremental update
	trailerSize := r.Trailer().Key("Size").Int64()
	rootPtr := reflect.ValueOf(r.Trailer().Key("Root")).FieldByName("ptr")
	rootID := rootPtr.FieldByName("id").Uint()

	pageVal := reflect.ValueOf(page.V)
	pagePtr := pageVal.FieldByName("ptr")
	pageID := pagePtr.FieldByName("id").Uint()

	contentsVal := reflect.ValueOf(page.V.Key("Contents"))
	var contentRefs []string
	if contentsVal.FieldByName("data").Kind() == reflect.Slice {
		slice := contentsVal.FieldByName("data")
		for i := 0; i < slice.Len(); i++ {
			elemPtr := slice.Index(i).FieldByName("ptr")
			contentRefs = append(contentRefs, fmt.Sprintf("%d 0 R", elemPtr.FieldByName("id").Uint()))
		}
	} else {
		contentsPtr := contentsVal.FieldByName("ptr")
		contentRefs = append(contentRefs, fmt.Sprintf("%d 0 R", contentsPtr.FieldByName("id").Uint()))
	}

	// Deep copy page resources preserving /XObject, /ExtGState, /ColorSpace, etc.
	res := page.V.Key("Resources")
	var fontEntries []string
	var resourceEntries []string
	hasProcSet := false

	resVal := reflect.ValueOf(res)
	var resData reflect.Value
	if resVal.IsValid() {
		resData = resVal.FieldByName("data")
	}
	if resData.IsValid() && resData.Kind() == reflect.Interface && !resData.IsNil() {
		resData = resData.Elem()
	}

	if resData.IsValid() && resData.Kind() == reflect.Map {
		for _, k := range resData.MapKeys() {
			keyName := k.String()
			val := resData.MapIndex(k)
			if keyName == "Font" {
				fonts := res.Key("Font")
				for _, fk := range fonts.Keys() {
					fVal := fonts.Key(fk)
					fPtr := reflect.ValueOf(fVal).FieldByName("ptr")
					if fPtr.IsValid() && fPtr.FieldByName("id").Uint() > 0 {
						fontEntries = append(fontEntries, fmt.Sprintf("/%s %d %d R", fk, fPtr.FieldByName("id").Uint(), fPtr.FieldByName("gen").Uint()))
					} else {
						fData := reflect.ValueOf(fVal).FieldByName("data")
						fontEntries = append(fontEntries, fmt.Sprintf("/%s %s", fk, formatPDFObject(fData)))
					}
				}
			} else {
				if keyName == "ProcSet" {
					hasProcSet = true
				}
				resourceEntries = append(resourceEntries, fmt.Sprintf("/%s %s", keyName, formatPDFObject(val)))
			}
		}
	} else {
		fonts := res.Key("Font")
		for _, fk := range fonts.Keys() {
			fVal := fonts.Key(fk)
			fPtr := reflect.ValueOf(fVal).FieldByName("ptr")
			if fPtr.IsValid() && fPtr.FieldByName("id").Uint() > 0 {
				fontEntries = append(fontEntries, fmt.Sprintf("/%s %d %d R", fk, fPtr.FieldByName("id").Uint(), fPtr.FieldByName("gen").Uint()))
			}
		}
	}

	// MediaBox
	mbVal := page.V.Key("MediaBox")
	var mbStr string
	if mbVal.Len() == 4 {
		mbStr = fmt.Sprintf("[ %v %v %v %v ]", mbVal.Index(0), mbVal.Index(1), mbVal.Index(2), mbVal.Index(3))
	} else {
		mbStr = fmt.Sprintf("[ 0 0 %v %v ]", pageWidth, pageHeight)
	}

	parentPtr := reflect.ValueOf(page.V.Key("Parent")).FieldByName("ptr")
	parentID := parentPtr.FieldByName("id").Uint()

	maxID := trailerSize
	if int64(pageID) >= maxID {
		maxID = int64(pageID) + 1
	}
	fontID := maxID
	overlayID := maxID + 1
	newSize := maxID + 2

	fontEntries = append(fontEntries, fmt.Sprintf("/F_OL %d 0 R", fontID))
	contentRefs = append(contentRefs, fmt.Sprintf("%d 0 R", overlayID))

	// Overlay stream content
	var streamBuf bytes.Buffer
	streamBuf.WriteString("q\nBT\n")
	for _, pl := range placed {
		streamBuf.WriteString(fmt.Sprintf("/F_OL %.2f Tf\n", pl.size))
		streamBuf.WriteString(fmt.Sprintf("1 0 0 1 %.2f %.2f Tm\n", pl.x, pl.baseline))
		streamBuf.WriteString(fmt.Sprintf("(%s) Tj\n", escapePDFString(pl.text)))
	}
	streamBuf.WriteString("ET\nQ\n")

	streamBytes := streamBuf.Bytes()

	sort.Strings(fontEntries)
	resourceEntries = append(resourceEntries, fmt.Sprintf("/Font << %s >>", strings.Join(fontEntries, " ")))
	if !hasProcSet {
		resourceEntries = append(resourceEntries, "/ProcSet [ /PDF /Text /ImageB /ImageC /ImageI ]")
	}
	sort.Strings(resourceEntries)
	resourcesStr := fmt.Sprintf("<< %s >>", strings.Join(resourceEntries, " "))

	objFont := fmt.Sprintf("%d 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n", fontID)
	objOverlay := fmt.Sprintf("%d 0 obj\n<< /Length %d >>\nstream\n%sendstream\nendobj\n", overlayID, len(streamBytes), streamBytes)
	objPage := fmt.Sprintf("%d 0 obj\n<< /Type /Page /Parent %d 0 R /MediaBox %s /Contents [ %s ] /Resources %s >>\nendobj\n",
		pageID, parentID, mbStr, strings.Join(contentRefs, " "), resourcesStr)

	startxrefIdx := bytes.LastIndex(input.PDFBytes, []byte("startxref"))
	var prevXref int64
	if startxrefIdx >= 0 {
		fields := strings.Fields(string(input.PDFBytes[startxrefIdx:]))
		if len(fields) >= 2 {
			prevXref, _ = strconv.ParseInt(fields[1], 10, 64)
		}
	}

	offsetBase := len(input.PDFBytes)
	offPage := offsetBase
	offFont := offPage + len(objPage)
	offOverlay := offFont + len(objFont)
	offXref := offOverlay + len(objOverlay)

	xrefStr := fmt.Sprintf("xref\n%d 1\n%010d 00000 n \n%d 2\n%010d 00000 n \n%010d 00000 n \n",
		pageID, offPage, fontID, offFont, offOverlay)

	trailerStr := fmt.Sprintf("trailer\n<<\n/Root %d 0 R\n/Size %d\n/Prev %d\n>>\nstartxref\n%d\n%%%%EOF\n",
		rootID, newSize, prevXref, offXref)

	var out bytes.Buffer
	out.Write(input.PDFBytes)
	out.WriteString(objPage)
	out.WriteString(objFont)
	out.WriteString(objOverlay)
	out.WriteString(xrefStr)
	out.WriteString(trailerStr)

	return out.Bytes(), outFilename, nil
}
