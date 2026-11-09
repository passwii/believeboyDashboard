package store

import (
	"archive/zip"
	"bytes"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
)

type monthlyAccountingXLSXCell struct {
	value  string
	number bool
}

func renderMonthlyAccountingDetailXLSX(
	detail *monthly_reports.MonthlyFinancialAccountingDetailResponse,
) ([]byte, error) {
	currency := "USD"
	if len(detail.Rows) > 0 &&
		detail.Rows[0].CurrencyCode != nil &&
		strings.TrimSpace(*detail.Rows[0].CurrencyCode) != "" {
		currency = strings.TrimSpace(*detail.Rows[0].CurrencyCode)
	}
	rows := [][]monthlyAccountingXLSXCell{
		monthlyAccountingStringRow([]string{
			"Income",
			"收入",
			"In金额（" + currency + "）",
			"In源表",
			"",
			"Expense",
			"支出",
			"Ex金额（" + currency + "）",
			"Ex源表",
		}),
	}
	for _, line := range detail.Rows {
		rows = append(rows, []monthlyAccountingXLSXCell{
			monthlyAccountingStringCell(line.IncomeEN),
			monthlyAccountingStringCell(line.IncomeZH),
			monthlyAccountingNumberCell(line.IncomeAmountUSD),
			monthlyAccountingStringCell(line.IncomeSource),
			monthlyAccountingStringCell(""),
			monthlyAccountingStringCell(line.ExpenseEN),
			monthlyAccountingStringCell(line.ExpenseZH),
			monthlyAccountingNumberCell(line.ExpenseAmountUSD),
			monthlyAccountingStringCell(line.ExpenseSource),
		})
	}

	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	entries := map[string][]byte{
		"[Content_Types].xml":        monthlyAccountingContentTypesXML(),
		"_rels/.rels":                monthlyAccountingRootRelationshipsXML(),
		"docProps/core.xml":          monthlyAccountingCorePropertiesXML(detail),
		"docProps/app.xml":           monthlyAccountingAppPropertiesXML(),
		"xl/workbook.xml":            monthlyAccountingWorkbookXML(),
		"xl/_rels/workbook.xml.rels": monthlyAccountingWorkbookRelationshipsXML(),
		"xl/styles.xml":              monthlyAccountingStylesXML(),
		"xl/worksheets/sheet1.xml":   monthlyAccountingWorksheetXML(rows),
	}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0o600)
		writer, err := archive.CreateHeader(header)
		if err != nil {
			_ = archive.Close()
			return nil, fmt.Errorf("create accounting xlsx entry %s: %w", name, err)
		}
		if _, err := writer.Write(entries[name]); err != nil {
			_ = archive.Close()
			return nil, fmt.Errorf("write accounting xlsx entry %s: %w", name, err)
		}
	}
	if err := archive.Close(); err != nil {
		return nil, fmt.Errorf("close accounting xlsx: %w", err)
	}
	return buffer.Bytes(), nil
}

func monthlyAccountingWorksheetXML(rows [][]monthlyAccountingXLSXCell) []byte {
	var buffer strings.Builder
	buffer.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	buffer.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
	buffer.WriteString(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`)
	buffer.WriteString(`<cols><col min="1" max="1" width="36" customWidth="1"/><col min="2" max="2" width="24" customWidth="1"/><col min="3" max="3" width="18" customWidth="1"/><col min="4" max="5" width="30" customWidth="1"/><col min="6" max="6" width="36" customWidth="1"/><col min="7" max="8" width="22" customWidth="1"/><col min="9" max="9" width="30" customWidth="1"/></cols>`)
	buffer.WriteString(`<sheetData>`)
	for rowIndex, row := range rows {
		buffer.WriteString(`<row r="`)
		buffer.WriteString(fmt.Sprintf("%d", rowIndex+1))
		buffer.WriteString(`">`)
		for columnIndex, cell := range row {
			buffer.WriteString(`<c r="`)
			buffer.WriteString(monthlyAccountingExcelColumn(columnIndex + 1))
			buffer.WriteString(fmt.Sprintf("%d", rowIndex+1))
			buffer.WriteString(`"`)
			if rowIndex == 0 {
				buffer.WriteString(` s="1"`)
			}
			if cell.number {
				buffer.WriteString(`><v>`)
				buffer.WriteString(cell.value)
				buffer.WriteString(`</v></c>`)
			} else {
				buffer.WriteString(` t="inlineStr"><is><t xml:space="preserve">`)
				buffer.WriteString(monthlyAccountingXMLEscape(cell.value))
				buffer.WriteString(`</t></is></c>`)
			}
		}
		buffer.WriteString(`</row>`)
	}
	buffer.WriteString(`</sheetData></worksheet>`)
	return []byte(buffer.String())
}

func monthlyAccountingWorkbookXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
		`xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
		`<sheets><sheet name="报表核算" sheetId="1" r:id="rId1"/></sheets></workbook>`)
}

func monthlyAccountingWorkbookRelationshipsXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
		`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
		`</Relationships>`)
}

func monthlyAccountingContentTypesXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
		`<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
		`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
		`<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
		`<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
		`</Types>`)
}

func monthlyAccountingRootRelationshipsXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
		`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
		`<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
		`</Relationships>`)
}

func monthlyAccountingCorePropertiesXML(
	detail *monthly_reports.MonthlyFinancialAccountingDetailResponse,
) []byte {
	now := time.Now().UTC().Format(time.RFC3339)
	title := detail.ProjectName + " " + detail.ReportMonth + " accounting detail"
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
		`xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
		`xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
		`<dc:title>` + monthlyAccountingXMLEscape(title) + `</dc:title>` +
		`<dc:creator>believeboyDashboard</dc:creator>` +
		`<cp:lastModifiedBy>believeboyDashboard</cp:lastModifiedBy>` +
		`<dcterms:created xsi:type="dcterms:W3CDTF">` + now + `</dcterms:created>` +
		`<dcterms:modified xsi:type="dcterms:W3CDTF">` + now + `</dcterms:modified>` +
		`</cp:coreProperties>`)
}

func monthlyAccountingAppPropertiesXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
		`<Application>Microsoft Excel</Application></Properties>`)
}

func monthlyAccountingStylesXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
		`<fonts count="2"><font><sz val="11"/><name val="Arial"/><family val="2"/></font>` +
		`<font><b/><sz val="11"/><name val="Arial"/><family val="2"/></font></fonts>` +
		`<fills count="3"><fill><patternFill patternType="none"/></fill>` +
		`<fill><patternFill patternType="gray125"/></fill>` +
		`<fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill></fills>` +
		`<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
		`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
		`<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
		`<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>` +
		`<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
		`</styleSheet>`)
}

func monthlyAccountingStringRow(values []string) []monthlyAccountingXLSXCell {
	cells := make([]monthlyAccountingXLSXCell, len(values))
	for index, value := range values {
		cells[index] = monthlyAccountingStringCell(value)
	}
	return cells
}

func monthlyAccountingStringCell(value string) monthlyAccountingXLSXCell {
	return monthlyAccountingXLSXCell{value: value}
}

func monthlyAccountingNumberCell(value float64) monthlyAccountingXLSXCell {
	return monthlyAccountingXLSXCell{
		value:  fmt.Sprintf("%.2f", value),
		number: true,
	}
}

func monthlyAccountingExcelColumn(column int) string {
	result := ""
	for column > 0 {
		column--
		result = string(rune('A'+column%26)) + result
		column /= 26
	}
	return result
}

func monthlyAccountingXMLEscape(value string) string {
	var buffer strings.Builder
	for _, character := range value {
		switch character {
		case '&':
			buffer.WriteString("&amp;")
		case '<':
			buffer.WriteString("&lt;")
		case '>':
			buffer.WriteString("&gt;")
		case '"':
			buffer.WriteString("&quot;")
		case '\'':
			buffer.WriteString("&apos;")
		default:
			buffer.WriteRune(character)
		}
	}
	return buffer.String()
}
