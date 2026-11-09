package ai_file_upload

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
	"golang.org/x/text/encoding/simplifiedchinese"
)

const (
	maxExcelRows      = 1000
	maxExcelCols      = 20
	maxSheetCount     = 3
	maxPreviewRows    = 20
	maxImagePixels    = 100_000_000
	maxImageDimension = 20000
)

func decodeText(content []byte) string {
	if utf8.Valid(content) {
		return string(content)
	}
	if decoded, err := simplifiedchinese.GBK.NewDecoder().Bytes(content); err == nil {
		return string(decoded)
	}
	return string(content)
}

func extractText(filename string, content []byte) (string, bool, *string) {
	return "【文件：" + filename + "】\n" + decodeText(content), false, nil
}

func extractCSV(
	filename string,
	content []byte,
) (string, bool, *string, *extractError) {
	reader := csv.NewReader(strings.NewReader(decodeText(content)))
	reader.FieldsPerRecord = -1
	records := make([][]string, 0, maxExcelRows+1)
	for len(records) < maxExcelRows+1 {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", false, nil, &extractError{
				status: http.StatusUnprocessableEntity,
				detail: "CSV 解析失败：" + err.Error(),
			}
		}
		records = append(records, record)
	}
	truncated := len(records) > maxExcelRows
	if truncated {
		records = records[:maxExcelRows]
	}
	if len(records) == 0 {
		return "", false, nil, &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "CSV 解析失败：文件没有数据行",
		}
	}
	columns := maxColumns(records)
	var note *string
	if truncated {
		value := fmt.Sprintf("（内容已截断，仅显示前 %d 行）", maxExcelRows)
		note = &value
	}
	var builder strings.Builder
	builder.WriteString("【文件：" + filename + "】\n")
	builder.WriteString(fmt.Sprintf("行数：%d，列数：%d\n", len(records), columns))
	builder.WriteString("列名：" + strings.Join(limitCells(records[0]), " | ") + "\n\n")
	builder.WriteString("数据预览（前 20 行）：\n")
	preview := records
	if len(preview) > maxPreviewRows {
		preview = preview[:maxPreviewRows]
	}
	for _, row := range preview {
		builder.WriteString(strings.Join(limitCells(row), "\t"))
		builder.WriteString("\n")
	}
	return strings.TrimRight(builder.String(), "\n"), truncated, note, nil
}

func extractXLSX(
	filename string,
	content []byte,
) (string, bool, *string, *extractError) {
	archive, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return "", false, nil, &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "Excel 解析失败：" + err.Error(),
		}
	}
	sharedStrings, err := readSharedStrings(archive)
	if err != nil {
		return "", false, nil, &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "Excel 解析失败：" + err.Error(),
		}
	}
	sheetNames := readSheetNames(archive)
	sheetPaths := worksheetPaths(archive)
	if len(sheetPaths) == 0 {
		return "", false, nil, &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "Excel 解析失败：未找到工作表",
		}
	}
	if len(sheetPaths) > maxSheetCount {
		sheetPaths = sheetPaths[:maxSheetCount]
	}
	var builder strings.Builder
	builder.WriteString("【文件：" + filename + "】\n")
	names := sheetNames
	if len(names) > len(sheetPaths) {
		names = names[:len(sheetPaths)]
	}
	builder.WriteString("工作表：" + strings.Join(names, ", ") + "\n")
	truncated := false
	for index, path := range sheetPaths {
		rows, rowErr := readWorksheet(archive, path, sharedStrings)
		if rowErr != nil {
			rows = nil
		}
		name := path
		if index < len(names) && strings.TrimSpace(names[index]) != "" {
			name = names[index]
		}
		if len(rows) > maxExcelRows {
			truncated = true
			rows = rows[:maxExcelRows]
		}
		builder.WriteString(fmt.Sprintf("\n=== 工作表：%s ===\n", name))
		builder.WriteString(fmt.Sprintf("行数：%d，列数：%d\n", len(rows), maxColumns(rows)))
		if len(rows) > 0 {
			builder.WriteString("列名：" + strings.Join(limitCells(rows[0]), " | ") + "\n")
			builder.WriteString("数据预览（前 10 行）：\n")
			preview := rows
			if len(preview) > 10 {
				preview = preview[:10]
			}
			for _, row := range preview {
				builder.WriteString(strings.Join(limitCells(row), "\t"))
				builder.WriteString("\n")
			}
		}
	}
	var note *string
	if truncated {
		value := fmt.Sprintf("（部分工作表内容已截断，仅显示前 %d 行）", maxExcelRows)
		note = &value
	}
	return strings.TrimRight(builder.String(), "\n"), truncated, note, nil
}

func extractImage(filename string, content []byte) (string, *extractError) {
	config, _, err := image.DecodeConfig(bytes.NewReader(content))
	if err != nil {
		return "", &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "图片解析失败：" + err.Error(),
		}
	}
	if config.Width <= 0 || config.Height <= 0 ||
		config.Width > maxImageDimension || config.Height > maxImageDimension ||
		int64(config.Width)*int64(config.Height) > maxImagePixels {
		return "", &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "图片解析失败：图片尺寸无效或过大",
		}
	}
	return fmt.Sprintf(
		"【图片文件：%s】\n尺寸：%dx%d\n请描述这张图片的内容。",
		filename,
		config.Width,
		config.Height,
	), nil
}

func extractPDF(
	filename string,
	content []byte,
) (string, bool, *string, *extractError) {
	if !bytes.HasPrefix(bytes.TrimSpace(content), []byte("%PDF-")) {
		return "", false, nil, &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "PDF 解析失败：文件头无效",
		}
	}
	reader, err := pdf.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return "", false, nil, &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "PDF 解析失败：" + err.Error(),
		}
	}
	totalPages := reader.NumPage()
	pagesToExtract := totalPages
	if pagesToExtract > 20 {
		pagesToExtract = 20
	}
	var builder strings.Builder
	builder.WriteString("【PDF 文件：" + filename + "】\n")
	builder.WriteString(fmt.Sprintf("总页数：%d，提取页数：%d\n", totalPages, pagesToExtract))
	for pageNumber := 1; pageNumber <= pagesToExtract; pageNumber++ {
		page := reader.Page(pageNumber)
		if page.V.IsNull() {
			continue
		}
		text, pageErr := page.GetPlainText(nil)
		if pageErr != nil {
			text = ""
		}
		builder.WriteString(fmt.Sprintf("\n--- 第 %d 页 ---\n", pageNumber))
		if strings.TrimSpace(text) == "" {
			builder.WriteString("（无文本内容）\n")
		} else {
			builder.WriteString(truncateRunes(text, 3000))
			builder.WriteString("\n")
		}
	}
	truncated := totalPages > pagesToExtract
	var note *string
	if truncated {
		value := fmt.Sprintf("（内容已截断，仅提取前 %d 页，共 %d 页）", pagesToExtract, totalPages)
		note = &value
	}
	return strings.TrimRight(builder.String(), "\n"), truncated, note, nil
}

func readSharedStrings(archive *zip.Reader) ([]string, error) {
	entry := findZipEntry(archive, "xl/sharedStrings.xml")
	if entry == nil {
		return nil, nil
	}
	data, err := readZipEntry(entry, 20*1024*1024)
	if err != nil {
		return nil, err
	}
	var document struct {
		Items []struct {
			Texts []string `xml:"t"`
		} `xml:"si"`
	}
	if err := xml.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	values := make([]string, 0, len(document.Items))
	for _, item := range document.Items {
		values = append(values, strings.Join(item.Texts, ""))
	}
	return values, nil
}

func readSheetNames(archive *zip.Reader) []string {
	entry := findZipEntry(archive, "xl/workbook.xml")
	if entry == nil {
		return nil
	}
	data, err := readZipEntry(entry, 10*1024*1024)
	if err != nil {
		return nil
	}
	var workbook struct {
		Sheets []struct {
			Name string `xml:"name,attr"`
		} `xml:"sheets>sheet"`
	}
	if err := xml.Unmarshal(data, &workbook); err != nil {
		return nil
	}
	names := make([]string, 0, len(workbook.Sheets))
	for _, sheet := range workbook.Sheets {
		names = append(names, strings.TrimSpace(sheet.Name))
	}
	return names
}

func worksheetPaths(archive *zip.Reader) []string {
	paths := make([]string, 0)
	for _, file := range archive.File {
		if strings.HasPrefix(file.Name, "xl/worksheets/sheet") &&
			strings.HasSuffix(file.Name, ".xml") {
			paths = append(paths, file.Name)
		}
	}
	sort.Slice(paths, func(left, right int) bool {
		return worksheetNumber(paths[left]) < worksheetNumber(paths[right])
	})
	return paths
}

func worksheetNumber(path string) int {
	base := strings.TrimSuffix(filepathBase(path), ".xml")
	base = strings.TrimPrefix(base, "sheet")
	value, _ := strconv.Atoi(base)
	return value
}

func filepathBase(path string) string {
	if index := strings.LastIndex(path, "/"); index >= 0 {
		return path[index+1:]
	}
	return path
}

type xlsxSheet struct {
	Rows []xlsxRow `xml:"sheetData>row"`
}

type xlsxRow struct {
	Cells []xlsxCell `xml:"c"`
}

type xlsxCell struct {
	Reference string `xml:"r,attr"`
	Type      string `xml:"t,attr"`
	Value     string `xml:"v"`
	Inline    string `xml:"is>t"`
}

func readWorksheet(
	archive *zip.Reader,
	path string,
	sharedStrings []string,
) ([][]string, error) {
	entry := findZipEntry(archive, path)
	if entry == nil {
		return nil, errors.New("worksheet not found")
	}
	data, err := readZipEntry(entry, 20*1024*1024)
	if err != nil {
		return nil, err
	}
	var sheet xlsxSheet
	if err := xml.Unmarshal(data, &sheet); err != nil {
		return nil, err
	}
	rows := make([][]string, 0, len(sheet.Rows))
	for _, sourceRow := range sheet.Rows {
		row := make([]string, 0, maxExcelCols)
		for _, cell := range sourceRow.Cells {
			if len(row) >= maxExcelCols {
				break
			}
			value := cell.Value
			switch cell.Type {
			case "s":
				index, convErr := strconv.Atoi(strings.TrimSpace(cell.Value))
				if convErr == nil && index >= 0 && index < len(sharedStrings) {
					value = sharedStrings[index]
				}
			case "inlineStr":
				value = cell.Inline
			}
			row = append(row, value)
		}
		rows = append(rows, row)
		if len(rows) > maxExcelRows {
			break
		}
	}
	return rows, nil
}

func findZipEntry(archive *zip.Reader, name string) *zip.File {
	for _, entry := range archive.File {
		if entry.Name == name {
			return entry
		}
	}
	return nil
}

func readZipEntry(entry *zip.File, limit int64) ([]byte, error) {
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("worksheet content is too large")
	}
	return data, nil
}

func maxColumns(rows [][]string) int {
	columns := 0
	for _, row := range rows {
		if len(row) > columns {
			columns = len(row)
		}
	}
	if columns > maxExcelCols {
		return maxExcelCols
	}
	return columns
}

func limitCells(row []string) []string {
	if len(row) > maxExcelCols {
		return row[:maxExcelCols]
	}
	return row
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
