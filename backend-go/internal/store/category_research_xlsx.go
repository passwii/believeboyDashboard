package store

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"math"
	"strconv"
	"strings"
)

type exportSheet struct {
	Name string
	Rows [][]any
}

func buildCategoryXLSX(sheets []exportSheet) ([]byte, error) {
	if len(sheets) == 0 {
		return nil, fmt.Errorf("workbook must have at least one sheet")
	}
	writerBuffer := bytes.NewBuffer(nil)
	writer := zip.NewWriter(writerBuffer)
	defer writer.Close()

	if err := writeZipEntry(writer, "[Content_Types].xml", contentTypesXML(sheets)); err != nil {
		return nil, err
	}
	if err := writeZipEntry(writer, "_rels/.rels", rootRelationshipsXML()); err != nil {
		return nil, err
	}
	if err := writeZipEntry(writer, "xl/workbook.xml", workbookXML(sheets)); err != nil {
		return nil, err
	}
	if err := writeZipEntry(writer, "xl/_rels/workbook.xml.rels", workbookRelationshipsXML(sheets)); err != nil {
		return nil, err
	}
	for idx, sheet := range sheets {
		if err := writeZipEntry(
			writer,
			fmt.Sprintf("xl/worksheets/sheet%d.xml", idx+1),
			worksheetXML(sheet.Rows),
		); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return writerBuffer.Bytes(), nil
}

func writeZipEntry(writer *zip.Writer, name string, content []byte) error {
	entry, err := writer.Create(name)
	if err != nil {
		return err
	}
	_, err = entry.Write(content)
	return err
}

func contentTypesXML(sheets []exportSheet) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	b.WriteString(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`)
	b.WriteString(`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`)
	b.WriteString(`<Default Extension="xml" ContentType="application/xml"/>`)
	b.WriteString(`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`)
	for idx := range sheets {
		b.WriteString(fmt.Sprintf(
			`<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
			idx+1,
		))
	}
	b.WriteString(`</Types>`)
	return []byte(b.String())
}

func rootRelationshipsXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats-package.relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
		`</Relationships>`)
}

func workbookXML(sheets []exportSheet) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	b.WriteString(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`)
	for idx, sheet := range sheets {
		b.WriteString(fmt.Sprintf(
			`<sheet name="%s" sheetId="%d" r:id="rId%d"/>`,
			xmlEscape(normalizeSheetName(sheet.Name, idx)),
			idx+1,
			idx+1,
		))
	}
	b.WriteString(`</sheets></workbook>`)
	return []byte(b.String())
}

func workbookRelationshipsXML(sheets []exportSheet) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	b.WriteString(`<Relationships xmlns="http://schemas.openxmlformats-package.relationships">`)
	for idx := range sheets {
		b.WriteString(fmt.Sprintf(
			`<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`,
			idx+1,
			idx+1,
		))
	}
	b.WriteString(`</Relationships>`)
	return []byte(b.String())
}

func worksheetXML(rows [][]any) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	b.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for rowIdx, row := range rows {
		b.WriteString(fmt.Sprintf(`<row r="%d">`, rowIdx+1))
		for colIdx, value := range row {
			reference := fmt.Sprintf("%s%d", columnName(colIdx+1), rowIdx+1)
			switch typed := value.(type) {
			case nil:
				continue
			case string:
				b.WriteString(`<c r="` + reference + `" t="inlineStr"><is><t>` + xmlEscape(typed) + `</t></is></c>`)
			case bool:
				flag := 0
				if typed {
					flag = 1
				}
				b.WriteString(fmt.Sprintf(`<c r="%s" t="b"><v>%d</v></c>`, reference, flag))
			case int:
				b.WriteString(fmt.Sprintf(`<c r="%s"><v>%d</v></c>`, reference, typed))
			case int64:
				b.WriteString(fmt.Sprintf(`<c r="%s"><v>%d</v></c>`, reference, typed))
			case float32:
				b.WriteString(fmt.Sprintf(`<c r="%s"><v>%s</v></c>`, reference, formatNumber(float64(typed))))
			case float64:
				b.WriteString(fmt.Sprintf(`<c r="%s"><v>%s</v></c>`, reference, formatNumber(typed)))
			default:
				b.WriteString(`<c r="` + reference + `" t="inlineStr"><is><t>` + xmlEscape(fmt.Sprint(value)) + `</t></is></c>`)
			}
		}
		b.WriteString(`</row>`)
	}
	b.WriteString(`</sheetData></worksheet>`)
	return []byte(b.String())
}

func formatNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "0"
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func columnName(index int) string {
	result := ""
	for index > 0 {
		index--
		remainder := index % 26
		result = string(rune('A'+remainder)) + result
		index /= 26
	}
	return result
}

func xmlEscape(value string) string {
	var buffer bytes.Buffer
	_ = xml.EscapeText(&buffer, []byte(value))
	return buffer.String()
}

func normalizeSheetName(name string, index int) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = fmt.Sprintf("Sheet%d", index+1)
	}
	replacer := strings.NewReplacer(":", "-", "\\", "-", "/", "-", "?", "-", "*", "-", "[", "(", "]", ")")
	name = replacer.Replace(name)
	if len([]rune(name)) > 31 {
		name = string([]rune(name)[:31])
	}
	return name
}
