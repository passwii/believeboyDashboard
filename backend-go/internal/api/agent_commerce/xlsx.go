package agent_commerce

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"fmt"
	"html"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxExportRows = 50000

const (
	xlsxStyleNormal = iota
	xlsxStyleHeader
	xlsxStyleTitle
	xlsxStyleWrap
	xlsxStyleUSD
	xlsxStyleRMB
	xlsxStylePercent
	xlsxStyleNumber
	xlsxStyleInteger
)

type xlsxCell struct {
	Value any
	Style int
}

type xlsxImage struct {
	Row    int
	Column int
	Data   []byte
}

type xlsxSheet struct {
	Name         string
	Rows         [][]xlsxCell
	Images       []xlsxImage
	ColumnWidths map[int]int
	RowHeights   map[int]int
}

func newXLSXSheets(sheets []xlsxSheet) ([]byte, error) {
	if len(sheets) == 0 {
		sheets = []xlsxSheet{{Name: "Sheet1"}}
	}
	totalRows := 0
	for _, sheet := range sheets {
		totalRows += len(sheet.Rows)
	}
	if totalRows > maxExportRows {
		return nil, ErrExportTooLarge
	}
	mediaFiles, mediaIndexes := collectXLSXMedia(sheets)

	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	if err := writeZipEntry(writer, "[Content_Types].xml", contentTypesXML(sheets)); err != nil {
		return nil, err
	}
	if err := writeZipEntry(writer, "_rels/.rels", packageRelationshipsXML()); err != nil {
		return nil, err
	}
	if err := writeZipEntry(writer, "xl/workbook.xml", workbookXML(sheets)); err != nil {
		return nil, err
	}
	if err := writeZipEntry(writer, "xl/_rels/workbook.xml.rels", workbookRelationshipsXML(len(sheets))); err != nil {
		return nil, err
	}
	if err := writeZipEntry(writer, "xl/styles.xml", stylesXML()); err != nil {
		return nil, err
	}
	for index, sheet := range sheets {
		if err := writeZipEntry(
			writer,
			fmt.Sprintf("xl/worksheets/sheet%d.xml", index+1),
			worksheetXML(sheet),
		); err != nil {
			return nil, err
		}
	}
	drawingIndex := 0
	for sheetIndex, sheet := range sheets {
		if len(sheet.Images) == 0 {
			continue
		}
		drawingIndex++
		if err := writeZipEntry(
			writer,
			fmt.Sprintf("xl/worksheets/_rels/sheet%d.xml.rels", sheetIndex+1),
			worksheetRelationshipsXML(drawingIndex),
		); err != nil {
			return nil, err
		}
		if err := writeZipEntry(
			writer,
			fmt.Sprintf("xl/drawings/drawing%d.xml", drawingIndex),
			drawingXML(sheet.Images),
		); err != nil {
			return nil, err
		}
		if err := writeZipEntry(
			writer,
			fmt.Sprintf("xl/drawings/_rels/drawing%d.xml.rels", drawingIndex),
			drawingRelationshipsXML(sheet.Images, mediaIndexes),
		); err != nil {
			return nil, err
		}
	}
	for index, content := range mediaFiles {
		if err := writeZipBytes(
			writer,
			fmt.Sprintf("xl/media/image%d.png", index+1),
			content,
		); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("close xlsx: %w", err)
	}
	return buffer.Bytes(), nil
}

func writeZipEntry(writer *zip.Writer, name string, content string) error {
	return writeZipBytes(writer, name, []byte(content))
}

func writeZipBytes(writer *zip.Writer, name string, content []byte) error {
	entry, err := writer.Create(name)
	if err != nil {
		return fmt.Errorf("create xlsx entry %s: %w", name, err)
	}
	if _, err := entry.Write(content); err != nil {
		return fmt.Errorf("write xlsx entry %s: %w", name, err)
	}
	return nil
}

func contentTypesXML(sheets []xlsxSheet) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	builder.WriteString(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`)
	builder.WriteString(`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`)
	builder.WriteString(`<Default Extension="xml" ContentType="application/xml"/>`)
	if hasXLSXImages(sheets) {
		builder.WriteString(`<Default Extension="png" ContentType="image/png"/>`)
	}
	builder.WriteString(`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`)
	builder.WriteString(`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`)
	for index := range sheets {
		builder.WriteString(fmt.Sprintf(
			`<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
			index+1,
		))
	}
	drawingIndex := 0
	for _, sheet := range sheets {
		if len(sheet.Images) == 0 {
			continue
		}
		drawingIndex++
		builder.WriteString(fmt.Sprintf(
			`<Override PartName="/xl/drawings/drawing%d.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
			drawingIndex,
		))
	}
	builder.WriteString(`</Types>`)
	return builder.String()
}

func packageRelationshipsXML() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
		`</Relationships>`
}

func workbookXML(sheets []xlsxSheet) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	builder.WriteString(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`)
	builder.WriteString(`<sheets>`)
	names := make(map[string]bool)
	for index, sheet := range sheets {
		name := safeSheetName(sheet.Name, index, names)
		builder.WriteString(fmt.Sprintf(
			`<sheet name="%s" sheetId="%d" r:id="rId%d"/>`,
			xmlEscape(name),
			index+1,
			index+1,
		))
	}
	builder.WriteString(`</sheets><calcPr calcId="0"/></workbook>`)
	return builder.String()
}

func workbookRelationshipsXML(sheetCount int) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	builder.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for index := 0; index < sheetCount; index++ {
		builder.WriteString(fmt.Sprintf(
			`<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`,
			index+1,
			index+1,
		))
	}
	builder.WriteString(fmt.Sprintf(
		`<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
		sheetCount+1,
	))
	builder.WriteString(`</Relationships>`)
	return builder.String()
}

func stylesXML() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
		`<numFmts count="4">` +
		`<numFmt numFmtId="164" formatCode="$#,##0.00;[Red]-$#,##0.00"/>` +
		`<numFmt numFmtId="165" formatCode="RMB #,##0.00;[Red]-RMB #,##0.00"/>` +
		`<numFmt numFmtId="166" formatCode="0.00%"/>` +
		`<numFmt numFmtId="167" formatCode="0.0000"/>` +
		`</numFmts>` +
		`<fonts count="3">` +
		`<font><sz val="10"/><name val="Microsoft YaHei"/></font>` +
		`<font><b/><sz val="10"/><name val="Microsoft YaHei"/></font>` +
		`<font><b/><sz val="14"/><name val="Microsoft YaHei"/></font>` +
		`</fonts>` +
		`<fills count="4">` +
		`<fill><patternFill patternType="none"/></fill>` +
		`<fill><patternFill patternType="gray125"/></fill>` +
		`<fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill>` +
		`<fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill>` +
		`</fills>` +
		`<borders count="2">` +
		`<border><left/><right/><top/><bottom/><diagonal/></border>` +
		`<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>` +
		`</borders>` +
		`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
		`<cellXfs count="9">` +
		`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
		`<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
		`<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
		`<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
		`<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>` +
		`<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>` +
		`<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>` +
		`<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>` +
		`<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>` +
		`</cellXfs>` +
		`<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
		`</styleSheet>`
}

func worksheetXML(sheet xlsxSheet) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	builder.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`)
	if len(sheet.Images) > 0 {
		builder.WriteString(` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`)
	}
	builder.WriteString(`>`)
	builder.WriteString(`<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>`)
	builder.WriteString(`<sheetFormatPr defaultRowHeight="15"/>`)
	builder.WriteString(columnWidthsXML(sheet))
	builder.WriteString(`<sheetData>`)
	for rowIndex, row := range sheet.Rows {
		builder.WriteString(fmt.Sprintf(`<row r="%d"`, rowIndex+1))
		if height, ok := sheet.RowHeights[rowIndex+1]; ok && height > 0 {
			builder.WriteString(fmt.Sprintf(` ht="%d" customHeight="1"`, height))
		}
		builder.WriteString(`>`)
		for columnIndex, cell := range row {
			if cell.Value == nil {
				continue
			}
			builder.WriteString(cellXML(rowIndex+1, columnIndex+1, cell))
		}
		builder.WriteString(`</row>`)
	}
	builder.WriteString(`</sheetData>`)
	if len(sheet.Images) > 0 {
		builder.WriteString(`<drawing r:id="rId1"/>`)
	}
	builder.WriteString(`</worksheet>`)
	return builder.String()
}

func columnWidthsXML(sheet xlsxSheet) string {
	rows := sheet.Rows
	maxColumns := 0
	widths := make([]int, 0)
	for _, row := range rows {
		if len(row) > maxColumns {
			maxColumns = len(row)
		}
	}
	for column := range sheet.ColumnWidths {
		if column > maxColumns {
			maxColumns = column
		}
	}
	if maxColumns == 0 {
		return ""
	}
	widths = make([]int, maxColumns)
	for _, row := range rows {
		for index, cell := range row {
			length := displayLength(cell.Value) + 2
			if length > widths[index] {
				widths[index] = length
			}
		}
	}
	for column, width := range sheet.ColumnWidths {
		if column > 0 && column <= len(widths) && width > widths[column-1] {
			widths[column-1] = width
		}
	}
	var builder strings.Builder
	builder.WriteString(`<cols>`)
	for index, width := range widths {
		if width < 10 {
			width = 10
		}
		if width > 42 {
			width = 42
		}
		builder.WriteString(fmt.Sprintf(
			`<col min="%d" max="%d" width="%d" customWidth="1"/>`,
			index+1,
			index+1,
			width,
		))
	}
	builder.WriteString(`</cols>`)
	return builder.String()
}

func hasXLSXImages(sheets []xlsxSheet) bool {
	for _, sheet := range sheets {
		if len(sheet.Images) > 0 {
			return true
		}
	}
	return false
}

type xlsxMediaKey [sha256.Size]byte

func collectXLSXMedia(sheets []xlsxSheet) ([][]byte, map[xlsxMediaKey]int) {
	mediaFiles := make([][]byte, 0)
	indexes := make(map[xlsxMediaKey]int)
	for _, sheet := range sheets {
		for _, item := range sheet.Images {
			key := xlsxMediaKey(sha256.Sum256(item.Data))
			if _, exists := indexes[key]; exists {
				continue
			}
			mediaFiles = append(mediaFiles, item.Data)
			indexes[key] = len(mediaFiles)
		}
	}
	return mediaFiles, indexes
}

func worksheetRelationshipsXML(drawingIndex int) string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		fmt.Sprintf(
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing%d.xml"/>`,
			drawingIndex,
		) +
		`</Relationships>`
}

func drawingXML(images []xlsxImage) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	builder.WriteString(`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`)
	for index, item := range images {
		row := item.Row - 1
		if row < 0 {
			row = 0
		}
		column := item.Column - 1
		if column < 0 {
			column = 0
		}
		builder.WriteString(`<xdr:oneCellAnchor>`)
		builder.WriteString(fmt.Sprintf(
			`<xdr:from><xdr:col>%d</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>%d</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`,
			column,
			row,
		))
		builder.WriteString(`<xdr:ext cx="952500" cy="952500"/>`)
		builder.WriteString(`<xdr:pic><xdr:nvPicPr>`)
		builder.WriteString(fmt.Sprintf(
			`<xdr:cNvPr id="%d" name="Picture %d" descr="Product image"/>`,
			index+2,
			index+1,
		))
		builder.WriteString(`<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`)
		builder.WriteString(fmt.Sprintf(
			`<xdr:blipFill><a:blip r:embed="rId%d"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`,
			index+1,
		))
		builder.WriteString(`<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>`)
		builder.WriteString(`</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`)
	}
	builder.WriteString(`</xdr:wsDr>`)
	return builder.String()
}

func drawingRelationshipsXML(
	images []xlsxImage,
	indexes map[xlsxMediaKey]int,
) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	builder.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for index, item := range images {
		key := xlsxMediaKey(sha256.Sum256(item.Data))
		builder.WriteString(fmt.Sprintf(
			`<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="/xl/media/image%d.png"/>`,
			index+1,
			indexes[key],
		))
	}
	builder.WriteString(`</Relationships>`)
	return builder.String()
}

func normalizeXLSXImage(data []byte) ([]byte, bool) {
	if len(data) == 0 || len(data) > 5*1024*1024 {
		return nil, false
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 ||
		config.Width > 2048 || config.Height > 2048 ||
		int64(config.Width)*int64(config.Height) > 4_000_000 {
		return nil, false
	}
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, false
	}
	bounds := decoded.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width > 100 || height > 100 {
		scale := math.Min(float64(100)/float64(width), float64(100)/float64(height))
		width = max(1, int(math.Round(float64(width)*scale)))
		height = max(1, int(math.Round(float64(height)*scale)))
		thumbnail := image.NewRGBA(image.Rect(0, 0, width, height))
		for y := 0; y < height; y++ {
			sourceY := bounds.Min.Y + min(bounds.Dy()-1, y*bounds.Dy()/height)
			for x := 0; x < width; x++ {
				sourceX := bounds.Min.X + min(bounds.Dx()-1, x*bounds.Dx()/width)
				thumbnail.Set(x, y, decoded.At(sourceX, sourceY))
			}
		}
		decoded = thumbnail
	}
	var output bytes.Buffer
	if err := png.Encode(&output, decoded); err != nil {
		return nil, false
	}
	return output.Bytes(), true
}

func cellXML(row, column int, cell xlsxCell) string {
	ref := xlsxColumn(column) + strconv.Itoa(row)
	style := cell.Style
	switch value := cell.Value.(type) {
	case string:
		if style <= 0 {
			return fmt.Sprintf(
				`<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`,
				ref,
				xmlEscape(cleanXMLText(value)),
			)
		}
		return fmt.Sprintf(
			`<c r="%s" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`,
			ref,
			style,
			xmlEscape(cleanXMLText(value)),
		)
	default:
		if style <= 0 {
			return fmt.Sprintf(`<c r="%s">%s</c>`, ref, numberXML(value))
		}
		return fmt.Sprintf(`<c r="%s" s="%d">%s</c>`, ref, style, numberXML(value))
	}
}

func numberXML(value any) string {
	switch typed := value.(type) {
	case int:
		return `<v>` + strconv.Itoa(typed) + `</v>`
	case int64:
		return `<v>` + strconv.FormatInt(typed, 10) + `</v>`
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return `<v>0</v>`
		}
		return `<v>` + strconv.FormatFloat(typed, 'f', -1, 64) + `</v>`
	case float32:
		return `<v>` + strconv.FormatFloat(float64(typed), 'f', -1, 32) + `</v>`
	case string:
		return `<v>` + xmlEscape(typed) + `</v>`
	default:
		return `<v>` + xmlEscape(fmt.Sprint(value)) + `</v>`
	}
}

func displayLength(value any) int {
	if value == nil {
		return 0
	}
	switch typed := value.(type) {
	case string:
		return runeCount(typed)
	case float64, float32:
		return 14
	default:
		return runeCount(fmt.Sprint(value))
	}
}

func xlsxColumn(index int) string {
	var buffer strings.Builder
	for index > 0 {
		index--
		buffer.WriteByte(byte('A' + index%26))
		index /= 26
	}
	result := buffer.String()
	bytes := []byte(result)
	for left, right := 0, len(bytes)-1; left < right; left, right = left+1, right-1 {
		bytes[left], bytes[right] = bytes[right], bytes[left]
	}
	return string(bytes)
}

func safeSheetName(base string, index int, used map[string]bool) string {
	base = strings.TrimSpace(base)
	if base == "" {
		base = fmt.Sprintf("Sheet%d", index+1)
	}
	base = strings.NewReplacer("\\", "-", "/", "-", "?", "-", "*", "-", "[", "-", "]", "-", ":", "-").Replace(base)
	if runeCount(base) > 31 {
		base = truncateRunes(base, 31)
	}
	if base == "" {
		base = fmt.Sprintf("Sheet%d", index+1)
	}
	name := base
	suffix := 1
	for used[name] {
		suffix++
		suffixText := fmt.Sprintf("-%d", suffix)
		available := 31 - runeCount(suffixText)
		name = truncateRunes(base, available) + suffixText
	}
	used[name] = true
	return name
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func runeCount(value string) int {
	return utf8.RuneCountInString(value)
}

func cleanXMLText(value string) string {
	var builder strings.Builder
	for _, character := range value {
		if character == '\t' || character == '\n' || character == '\r' ||
			(character >= 0x20 && character <= 0xD7FF) ||
			(character >= 0xE000 && character <= 0xFFFD) ||
			(character >= 0x10000 && character <= 0x10FFFF) {
			builder.WriteRune(character)
		}
	}
	return builder.String()
}

func xmlEscape(value string) string {
	return html.EscapeString(cleanXMLText(value))
}
