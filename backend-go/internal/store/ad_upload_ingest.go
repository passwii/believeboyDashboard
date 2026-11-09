package store

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type xlsxTextRun struct {
	Text string `xml:"t"`
}

type xlsxRichText struct {
	Text string        `xml:"t"`
	Runs []xlsxTextRun `xml:"r"`
}

func (text xlsxRichText) plain() string {
	var builder strings.Builder
	builder.WriteString(text.Text)
	for _, run := range text.Runs {
		builder.WriteString(run.Text)
	}
	return builder.String()
}

type xlsxSharedStrings struct {
	Items []xlsxRichText `xml:"si"`
}

type xlsxCellXML struct {
	Ref       string        `xml:"r,attr"`
	Type      string        `xml:"t,attr"`
	Value     string        `xml:"v"`
	InlineStr *xlsxRichText `xml:"is"`
}

type xlsxRowXML struct {
	Number int           `xml:"r,attr"`
	Cells  []xlsxCellXML `xml:"c"`
}

type xlsxSheetDataXML struct {
	Rows []xlsxRowXML `xml:"row"`
}

type xlsxWorksheetXML struct {
	SheetData xlsxSheetDataXML `xml:"sheetData"`
}

type xlsxSheet struct {
	Name string
	Rows []xlsxRow
}

type xlsxRow struct {
	Number int
	Cells  map[int]string
}

type xlsxWorkbook struct {
	Sheets []xlsxSheet
}

func parseXLSXWorkbook(data []byte) (*xlsxWorkbook, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("open xlsx: %w", err)
	}

	const maxExpandedXLSXBytes = 256 * 1024 * 1024
	var expanded uint64
	for _, file := range zr.File {
		expanded += file.UncompressedSize64
		if expanded > maxExpandedXLSXBytes {
			return nil, errors.New("xlsx expanded size exceeds limit")
		}
	}

	files := make(map[string]*zip.File, len(zr.File))
	for _, file := range zr.File {
		files[path.Clean(file.Name)] = file
	}

	var shared []string
	if sharedFile := files["xl/sharedStrings.xml"]; sharedFile != nil {
		body, err := readZipFile(sharedFile)
		if err != nil {
			return nil, err
		}
		var parsed xlsxSharedStrings
		if err := xml.Unmarshal(body, &parsed); err != nil {
			return nil, fmt.Errorf("parse shared strings: %w", err)
		}
		shared = make([]string, len(parsed.Items))
		for i, item := range parsed.Items {
			shared[i] = item.plain()
		}
	}

	sheetPaths, err := xlsxSheetPaths(files, zr)
	if err != nil {
		return nil, err
	}

	workbook := &xlsxWorkbook{Sheets: make([]xlsxSheet, 0, len(sheetPaths))}
	for _, sheetPath := range sheetPaths {
		file := files[path.Clean(sheetPath.Path)]
		if file == nil {
			return nil, fmt.Errorf("xlsx worksheet not found: %s", sheetPath.Path)
		}
		body, err := readZipFile(file)
		if err != nil {
			return nil, err
		}
		var parsed xlsxWorksheetXML
		if err := xml.Unmarshal(body, &parsed); err != nil {
			return nil, fmt.Errorf("parse worksheet %s: %w", sheetPath.Name, err)
		}
		rows := make([]xlsxRow, 0, len(parsed.SheetData.Rows))
		for rowIndex, rawRow := range parsed.SheetData.Rows {
			rowNumber := rawRow.Number
			if rowNumber <= 0 {
				rowNumber = rowIndex + 1
			}
			row := xlsxRow{Number: rowNumber, Cells: map[int]string{}}
			nextColumn := 1
			for _, rawCell := range rawRow.Cells {
				column := nextColumn
				if refColumn := xlsxColumnNumber(rawCell.Ref); refColumn > 0 {
					column = refColumn
				}
				nextColumn = column + 1
				value := xlsxCellValue(rawCell, shared)
				if strings.TrimSpace(value) != "" {
					row.Cells[column] = strings.TrimSpace(value)
				}
			}
			rows = append(rows, row)
		}
		workbook.Sheets = append(workbook.Sheets, xlsxSheet{Name: sheetPath.Name, Rows: rows})
	}
	if len(workbook.Sheets) == 0 {
		return nil, errors.New("xlsx workbook has no worksheets")
	}
	return workbook, nil
}

type xlsxSheetPath struct {
	Name string
	Path string
}

func xlsxSheetPaths(files map[string]*zip.File, zr *zip.Reader) ([]xlsxSheetPath, error) {
	workbookFile := files["xl/workbook.xml"]
	relsFile := files["xl/_rels/workbook.xml.rels"]
	if workbookFile != nil && relsFile != nil {
		workbookBody, err := readZipFile(workbookFile)
		if err != nil {
			return nil, err
		}
		relsBody, err := readZipFile(relsFile)
		if err != nil {
			return nil, err
		}
		var workbookXML struct {
			Sheets []struct {
				Name string `xml:"name,attr"`
				RID  string `xml:"id,attr"`
			} `xml:"sheets>sheet"`
		}
		if err := xml.Unmarshal(workbookBody, &workbookXML); err != nil {
			return nil, fmt.Errorf("parse workbook: %w", err)
		}
		var relationships struct {
			Items []struct {
				ID     string `xml:"Id,attr"`
				Target string `xml:"Target,attr"`
			} `xml:"Relationship"`
		}
		if err := xml.Unmarshal(relsBody, &relationships); err != nil {
			return nil, fmt.Errorf("parse workbook relationships: %w", err)
		}
		targets := make(map[string]string, len(relationships.Items))
		for _, relationship := range relationships.Items {
			target := strings.ReplaceAll(strings.TrimSpace(relationship.Target), "\\", "/")
			if strings.HasPrefix(target, "/") {
				target = strings.TrimPrefix(target, "/")
			} else if !strings.HasPrefix(target, "xl/") {
				target = path.Join("xl", target)
			}
			targets[relationship.ID] = target
		}
		paths := make([]xlsxSheetPath, 0, len(workbookXML.Sheets))
		for _, sheet := range workbookXML.Sheets {
			target := targets[sheet.RID]
			if target == "" {
				continue
			}
			paths = append(paths, xlsxSheetPath{Name: sheet.Name, Path: target})
		}
		if len(paths) > 0 {
			return paths, nil
		}
	}

	var paths []xlsxSheetPath
	for _, file := range zr.File {
		clean := path.Clean(file.Name)
		if strings.HasPrefix(clean, "xl/worksheets/") && strings.HasSuffix(clean, ".xml") {
			paths = append(paths, xlsxSheetPath{Name: path.Base(clean), Path: clean})
		}
	}
	sort.Slice(paths, func(i, j int) bool { return paths[i].Path < paths[j].Path })
	if len(paths) == 0 {
		return nil, errors.New("xlsx workbook has no worksheet")
	}
	return paths, nil
}

func readZipFile(file *zip.File) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, fmt.Errorf("open xlsx member %s: %w", file.Name, err)
	}
	defer reader.Close()
	body, err := io.ReadAll(io.LimitReader(reader, 64*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read xlsx member %s: %w", file.Name, err)
	}
	return body, nil
}

func xlsxCellValue(cell xlsxCellXML, shared []string) string {
	switch cell.Type {
	case "s":
		index, err := strconv.Atoi(strings.TrimSpace(cell.Value))
		if err == nil && index >= 0 && index < len(shared) {
			return shared[index]
		}
		return ""
	case "inlineStr":
		if cell.InlineStr != nil {
			return cell.InlineStr.plain()
		}
		return ""
	case "b":
		if strings.TrimSpace(cell.Value) == "1" {
			return "true"
		}
		if strings.TrimSpace(cell.Value) == "0" {
			return "false"
		}
	}
	return cell.Value
}

func xlsxColumnNumber(ref string) int {
	ref = strings.TrimSpace(strings.ToUpper(ref))
	if ref == "" {
		return 0
	}
	column := 0
	letters := 0
	for _, char := range ref {
		if char < 'A' || char > 'Z' {
			break
		}
		column = column*26 + int(char-'A'+1)
		letters++
	}
	if letters == 0 {
		return 0
	}
	return column
}

func xlsxCellRef(row, column int) string {
	var letters []byte
	for column > 0 {
		column--
		letters = append([]byte{byte('A' + column%26)}, letters...)
		column /= 26
	}
	return fmt.Sprintf("%s%d", string(letters), row)
}

func readXLSXTable(data []byte) ([]string, [][]string, error) {
	workbook, err := parseXLSXWorkbook(data)
	if err != nil {
		return nil, nil, err
	}
	sheet := workbook.Sheets[0]
	return xlsxSheetToTable(sheet)
}

func xlsxSheetToTable(sheet xlsxSheet) ([]string, [][]string, error) {
	if len(sheet.Rows) == 0 {
		return nil, nil, errors.New("empty worksheet")
	}

	maxColumn := 0
	for _, row := range sheet.Rows {
		for column := range row.Cells {
			if column > maxColumn {
				maxColumn = column
			}
		}
	}
	if maxColumn == 0 {
		return nil, nil, errors.New("empty worksheet")
	}

	headerIndex := -1
	for i, row := range sheet.Rows {
		if len(row.Cells) > 0 {
			headerIndex = i
			break
		}
	}
	if headerIndex < 0 {
		return nil, nil, errors.New("empty worksheet")
	}

	headerRow := sheet.Rows[headerIndex]
	lastHeaderColumn := 0
	for column, value := range headerRow.Cells {
		if strings.TrimSpace(value) != "" && column > lastHeaderColumn {
			lastHeaderColumn = column
		}
	}
	if lastHeaderColumn == 0 {
		return nil, nil, errors.New("worksheet has no header row")
	}
	headers := make([]string, lastHeaderColumn)
	for column := 1; column <= lastHeaderColumn; column++ {
		headers[column-1] = strings.TrimSpace(headerRow.Cells[column])
	}

	var rows [][]string
	for _, row := range sheet.Rows[headerIndex+1:] {
		if len(row.Cells) == 0 {
			continue
		}
		values := make([]string, maxColumn)
		hasValue := false
		for column, value := range row.Cells {
			if column <= 0 || column > maxColumn {
				continue
			}
			values[column-1] = strings.TrimSpace(value)
			if values[column-1] != "" {
				hasValue = true
			}
		}
		if !hasValue {
			continue
		}
		rows = append(rows, values)
	}
	for i := range rows {
		if len(rows[i]) > len(headers) {
			continue
		}
		padded := make([]string, len(headers))
		copy(padded, rows[i])
		rows[i] = padded
	}
	return headers, rows, nil
}

func xlsxSheetCells(data []byte, sheetName string) (map[string]string, error) {
	workbook, err := parseXLSXWorkbook(data)
	if err != nil {
		return nil, err
	}
	var selected *xlsxSheet
	for i := range workbook.Sheets {
		if workbook.Sheets[i].Name == sheetName {
			selected = &workbook.Sheets[i]
			break
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("Excel sheet %q not found", sheetName)
	}
	cells := map[string]string{}
	for _, row := range selected.Rows {
		for column, value := range row.Cells {
			cells[xlsxCellRef(row.Number, column)] = strings.TrimSpace(value)
		}
	}
	return cells, nil
}

type adReportSpec struct {
	reportType      string
	reportLabel     string
	extensions      []string
	requiredColumns []string
}

var adReportSpecs = []adReportSpec{
	{
		reportType:      "ad_search_term_share_report",
		reportLabel:     "搜索词展示量份额",
		extensions:      []string{".csv"},
		requiredColumns: []string{"开始日期", "结束日期", "客户搜索词", "搜索词展示量排名", "搜索词展示量份额"},
	},
	{
		reportType:      "ad_budget_report",
		reportLabel:     "预算",
		extensions:      []string{".csv"},
		requiredColumns: []string{"开始日期", "结束日期", "广告活动名称", "建议预算", "预算范围内的平均时间"},
	},
	{
		reportType:      "ad_campaign_report",
		reportLabel:     "广告活动",
		extensions:      []string{".csv"},
		requiredColumns: []string{"开始日期", "结束日期", "广告活动名称", "预算", "定位类型", "竞价策略"},
	},
	{
		reportType:      "ad_purchased_product_report",
		reportLabel:     "已购买商品",
		extensions:      []string{".xlsx"},
		requiredColumns: []string{"开始日期", "结束日期", "广告SKU", "广告ASIN", "已购买的ASIN"},
	},
	{
		reportType:      "ad_promoted_product_report",
		reportLabel:     "推广的商品",
		extensions:      []string{".xlsx", ".csv"},
		requiredColumns: []string{"开始日期", "结束日期", "广告SKU", "广告ASIN", "广告活动名称", "广告组名称"},
	},
	{
		reportType:  "ad_promoted_product_report",
		reportLabel: "推广的商品",
		extensions:  []string{".xlsx", ".csv"},
		requiredColumns: []string{
			"日期范围",
			"广告组合名称",
			"广告活动名称",
			"广告组名称",
			"投放广告活动的国家/地区",
			"推广的商品 SKU-Advertised product SKU",
			"推广的商品编号",
			"展示量",
			"点击量",
			"点击率",
			"CPC",
			"总成本",
		},
	},
	{
		reportType:      "ad_invalid_traffic_report",
		reportLabel:     "总流量和无效流量",
		extensions:      []string{".xlsx"},
		requiredColumns: []string{"开始日期", "结束日期", "广告活动名称", "总展示量", "无效展示量", "无效点击"},
	},
	{
		reportType:      "ad_placement_report",
		reportLabel:     "广告位",
		extensions:      []string{".xlsx"},
		requiredColumns: []string{"开始日期", "结束日期", "广告活动名称", "放置"},
	},
	{
		reportType:      "ad_target_report",
		reportLabel:     "搜索词投放",
		extensions:      []string{".xlsx"},
		requiredColumns: []string{"开始日期", "结束日期", "投放", "匹配类型", "搜索结果首页首位展示量份额"},
	},
	{
		reportType:      "ad_search_term_report",
		reportLabel:     "搜索词",
		extensions:      []string{".xlsx"},
		requiredColumns: []string{"开始日期", "结束日期", "投放", "匹配类型", "客户搜索词"},
	},
	{
		reportType:      "ad_time_trend_report",
		reportLabel:     "按时间查看效果",
		extensions:      []string{".xlsx"},
		requiredColumns: []string{"开始日期", "结束日期", "国家/地区", "货币", "点击量", "单次点击成本 (CPC)", "花费"},
	},
}

type adSpecMatch struct {
	spec           adReportSpec
	matchedColumns []string
	periodic       bool
}

type adParsedFile struct {
	headers            []string
	rows               [][]string
	match              adSpecMatch
	extension          string
	country            string
	detectedStartDate  *string
	detectedEndDate    *string
	detectedReportDate *string
}

func parseAdUploadData(filename string, data []byte, requestedCountry string) (*adParsedFile, error) {
	ext, err := validateAdUploadFilename(filename)
	if err != nil {
		return nil, err
	}

	var headers []string
	var rows [][]string
	switch ext {
	case ".csv":
		headers, rows, err = parseCSVHeadersAndRows(data)
	case ".xlsx":
		headers, rows, err = readXLSXTable(data)
	default:
		return nil, fmt.Errorf("unsupported extension %s", ext)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to parse file: %w", err)
	}
	headers = trimAdHeaders(headers)
	rows = trimAdRows(headers, rows)
	match := matchAdReportSpec(headers, ext)
	if match == nil {
		return nil, errors.New("未命中广告报表识别规则，请检查文件格式或表头")
	}

	rowData := newAdRowData(headers, nil, "", "", nil)
	country := adNormalizeCountry(requestedCountry)
	for _, column := range []string{"国家/地区", "投放广告活动的国家/地区"} {
		if value := rowData.first(rows, column); value != "" {
			country = adNormalizeCountry(value)
			break
		}
	}

	startDate, endDate := detectAdDateRange(rowData, rows)
	reportDate := endDate
	if reportDate == nil {
		reportDate = startDate
	}

	return &adParsedFile{
		headers:            headers,
		rows:               rows,
		match:              *match,
		extension:          ext,
		country:            country,
		detectedStartDate:  startDate,
		detectedEndDate:    endDate,
		detectedReportDate: reportDate,
	}, nil
}

func validateAdUploadFilename(filename string) (string, error) {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return "", errors.New("Missing filename")
	}
	if filepath.IsAbs(filename) || strings.Contains(filename, `\`) || strings.Contains(filename, "/") || strings.Contains(filename, "..") {
		return "", errors.New("invalid filename path")
	}
	base := filepath.Base(filename)
	if base != filename {
		return "", errors.New("invalid filename path")
	}
	ext := strings.ToLower(filepath.Ext(base))
	if ext != ".csv" && ext != ".xlsx" {
		return "", fmt.Errorf("unsupported extension %s", ext)
	}
	return ext, nil
}

func trimAdHeaders(headers []string) []string {
	trimmed := make([]string, len(headers))
	for i, header := range headers {
		trimmed[i] = strings.TrimSpace(strings.TrimPrefix(header, "\ufeff"))
	}
	return trimmed
}

func trimAdRows(headers []string, rows [][]string) [][]string {
	result := make([][]string, 0, len(rows))
	for _, row := range rows {
		empty := true
		for _, value := range row {
			if strings.TrimSpace(value) != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		if len(row) < len(headers) {
			padded := make([]string, len(headers))
			copy(padded, row)
			row = padded
		}
		result = append(result, row)
	}
	return result
}

func matchAdReportSpec(headers []string, extension string) *adSpecMatch {
	headerSet := make(map[string]bool, len(headers))
	for _, header := range headers {
		headerSet[strings.ToLower(strings.TrimSpace(header))] = true
	}
	for _, original := range adReportSpecs {
		if !extensionAllowed(original.extensions, extension) {
			continue
		}
		if matched := requiredColumnMatches(original.requiredColumns, headerSet); len(matched) == len(original.requiredColumns) {
			spec := original
			return &adSpecMatch{spec: spec, matchedColumns: matched}
		}
		periodicColumns := periodicAdRequiredColumns(original.requiredColumns)
		if matched := requiredColumnMatches(periodicColumns, headerSet); len(matched) == len(periodicColumns) {
			spec := original
			spec.requiredColumns = periodicColumns
			return &adSpecMatch{spec: spec, matchedColumns: matched, periodic: true}
		}
	}
	return nil
}

func extensionAllowed(allowed []string, extension string) bool {
	for _, candidate := range allowed {
		if strings.EqualFold(candidate, extension) {
			return true
		}
	}
	return false
}

func requiredColumnMatches(required []string, headerSet map[string]bool) []string {
	matched := make([]string, 0, len(required))
	for _, column := range required {
		if headerSet[strings.ToLower(strings.TrimSpace(column))] {
			matched = append(matched, column)
		}
	}
	return matched
}

func periodicAdRequiredColumns(required []string) []string {
	columns := append([]string(nil), required...)
	for len(columns) > 0 && (columns[0] == "开始日期" || columns[0] == "结束日期") {
		columns = columns[1:]
	}
	return append([]string{"日期"}, columns...)
}

type adRowData struct {
	headers       []string
	values        []string
	headerIndexes map[string]int
	fallbackStart string
	fallbackEnd   string
	country       string
}

func newAdRowData(headers []string, values []string, fallbackStart, fallbackEnd string, country *string) adRowData {
	indexes := make(map[string]int, len(headers))
	for i, header := range headers {
		indexes[strings.ToLower(strings.TrimSpace(header))] = i
	}
	normalizedCountry := ""
	if country != nil {
		normalizedCountry = *country
	}
	return adRowData{
		headers:       headers,
		values:        values,
		headerIndexes: indexes,
		fallbackStart: fallbackStart,
		fallbackEnd:   fallbackEnd,
		country:       normalizedCountry,
	}
}

func (row adRowData) text(columns ...string) *string {
	for _, column := range columns {
		index, ok := row.headerIndexes[strings.ToLower(strings.TrimSpace(column))]
		if !ok || index < 0 || index >= len(row.values) {
			continue
		}
		value := strings.TrimSpace(row.values[index])
		if value != "" {
			return &value
		}
	}
	return nil
}

func (row adRowData) first(rows [][]string, column string) string {
	index, ok := row.headerIndexes[strings.ToLower(strings.TrimSpace(column))]
	if !ok {
		return ""
	}
	for _, values := range rows {
		if index < 0 || index >= len(values) {
			continue
		}
		if value := strings.TrimSpace(values[index]); value != "" {
			return value
		}
	}
	return ""
}

func (row adRowData) textOrFallback(columns ...string) *string {
	if value := row.text(columns...); value != nil {
		return value
	}
	if row.fallbackStart != "" {
		value := row.fallbackStart
		return &value
	}
	return nil
}

func (row adRowData) integer(columns ...string) int {
	value := row.text(columns...)
	if value == nil {
		return 0
	}
	number, _ := parseAdNumber(*value, false)
	return int(number)
}

func (row adRowData) decimal(percent bool, columns ...string) float64 {
	value := row.text(columns...)
	if value == nil {
		return 0
	}
	number, _ := parseAdNumber(*value, percent)
	return number
}

func (row adRowData) countryValue(columns ...string) *string {
	if value := row.text(columns...); value != nil {
		normalized := adNormalizeCountry(*value)
		return &normalized
	}
	if row.country == "" {
		return nil
	}
	country := row.country
	return &country
}

func (row adRowData) rawJSON() string {
	raw := make(map[string]string, len(row.headers))
	for i, header := range row.headers {
		if i < len(row.values) {
			raw[header] = row.values[i]
		}
	}
	body, _ := json.Marshal(raw)
	return string(body)
}

func (row adRowData) dateRange() (string, string) {
	start := row.text("开始日期")
	end := row.text("结束日期")
	if start != nil && end != nil {
		startDate, errStart := parseAdDate(*start)
		endDate, errEnd := parseAdDate(*end)
		if errStart == nil && errEnd == nil {
			return startDate.Format("2006-01-02"), endDate.Format("2006-01-02")
		}
	}
	if value := row.text("日期范围"); value != nil {
		if startDate, endDate, ok := parseAdDateRange(*value); ok {
			return startDate.Format("2006-01-02"), endDate.Format("2006-01-02")
		}
	}
	if value := row.text("日期"); start == nil && end == nil && value != nil {
		if rowDate, err := parseAdDate(*value); err == nil {
			date := rowDate.Format("2006-01-02")
			return date, date
		}
	}
	return row.fallbackStart, row.fallbackEnd
}

func detectAdDateRange(row adRowData, rows [][]string) (*string, *string) {
	if start := row.first(rows, "开始日期"); start != "" {
		if end := row.first(rows, "结束日期"); end != "" {
			if parsedStart, errStart := parseAdDate(start); errStart == nil {
				if parsedEnd, errEnd := parseAdDate(end); errEnd == nil {
					startText := parsedStart.Format("2006-01-02")
					endText := parsedEnd.Format("2006-01-02")
					return &startText, &endText
				}
			}
		}
	}
	if value := row.first(rows, "日期范围"); value != "" {
		if start, end, ok := parseAdDateRange(value); ok {
			startText := start.Format("2006-01-02")
			endText := end.Format("2006-01-02")
			return &startText, &endText
		}
	}
	if value := row.first(rows, "日期"); value != "" {
		index, ok := row.headerIndexes[strings.ToLower("日期")]
		if ok {
			var earliest, latest *time.Time
			for _, values := range rows {
				if index >= len(values) {
					continue
				}
				parsed, err := parseAdDate(values[index])
				if err != nil {
					continue
				}
				if earliest == nil || parsed.Before(*earliest) {
					copy := parsed
					earliest = &copy
				}
				if latest == nil || parsed.After(*latest) {
					copy := parsed
					latest = &copy
				}
			}
			if earliest != nil && latest != nil {
				startText := earliest.Format("2006-01-02")
				endText := latest.Format("2006-01-02")
				return &startText, &endText
			}
		}
	}
	return nil, nil
}

func parseAdDate(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, errors.New("date is empty")
	}
	if serial, err := strconv.ParseFloat(strings.ReplaceAll(value, ",", ""), 64); err == nil {
		if serial > 20000 && serial < 80000 {
			base := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
			return base.AddDate(0, 0, int(math.Round(serial))), nil
		}
	}
	value = strings.ReplaceAll(value, "年", "-")
	value = strings.ReplaceAll(value, "月", "-")
	value = strings.ReplaceAll(value, "日", "")
	value = strings.ReplaceAll(value, "/", "-")
	value = strings.ReplaceAll(value, ".", "-")
	layouts := []string{
		"2006-1-2",
		"2006-01-02",
		"2006-1-2 15:04:05",
		"2006-01-02 15:04:05",
		time.RFC3339,
		"1-2-2006",
		"01-02-2006",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, nil
		}
	}
	monitoredTime := strings.Split(value, "T")
	if len(monitoredTime) > 0 {
		for _, layout := range layouts[:4] {
			if parsed, err := time.Parse(layout, monitoredTime[0]); err == nil {
				return parsed, nil
			}
		}
	}
	return time.Time{}, fmt.Errorf("invalid date %q", value)
}

func parseAdDateRange(value string) (time.Time, time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, time.Time{}, false
	}
	replacer := strings.NewReplacer("年", "-", "月", "-", "日", "")
	value = replacer.Replace(value)
	fields := strings.FieldsFunc(value, func(r rune) bool {
		return r == '-' || r == '/' || r == '.' || r == '~' || r == '至' || r == ' '
	})
	tokens := make([]string, 0, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		tokens = append(tokens, field)
	}
	var parsed []time.Time
	for i := 0; i < len(tokens); i++ {
		if i+2 < len(tokens) {
			candidate := strings.Join(tokens[i:i+3], "-")
			if parsedDate, err := parseAdDate(candidate); err == nil {
				parsed = append(parsed, parsedDate)
				i += 2
				continue
			}
		}
		if parsedDate, err := parseAdDate(tokens[i]); err == nil {
			parsed = append(parsed, parsedDate)
		}
	}
	if len(parsed) == 0 {
		if parsedDate, err := parseAdDate(value); err == nil {
			return parsedDate, parsedDate, true
		}
		return time.Time{}, time.Time{}, false
	}
	sort.Slice(parsed, func(i, j int) bool { return parsed[i].Before(parsed[j]) })
	return parsed[0], parsed[len(parsed)-1], true
}

func parseAdNumber(raw string, percent bool) (float64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, errors.New("number is empty")
	}
	negative := false
	if strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")") {
		negative = true
		raw = strings.TrimSuffix(strings.TrimPrefix(raw, "("), ")")
	}
	raw = strings.TrimSpace(raw)
	raw = strings.ReplaceAll(raw, "\u00a0", "")
	raw = strings.ReplaceAll(raw, " ", "")
	raw = strings.ReplaceAll(raw, ",", "")
	raw = strings.NewReplacer("US$", "", "$", "", "USD", "", "EUR", "", "€", "", "GBP", "", "£", "", "¥", "", "￥", "").Replace(raw)
	if strings.HasSuffix(raw, "%") {
		percent = true
		raw = strings.TrimSuffix(raw, "%")
	}
	if negative {
		raw = "-" + raw
	}
	number, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, err
	}
	if percent {
		number /= 100
	}
	return number, nil
}

func adNormalizeCountry(value string) string {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	switch normalized {
	case "", "US", "USA", "美国", "美国站":
		return "US"
	case "DE", "GERMANY", "德国", "德国站":
		return "DE"
	case "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK"
	}
	return normalized
}

type adInsertValue struct {
	column string
	value  any
	cast   string
}

func adText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func insertAdDetailRows(
	ctx context.Context,
	db FullDB,
	sourceID int64,
	parsed *adParsedFile,
	rows [][]string,
	scopeStart string,
	scopeEnd string,
) error {
	for rowIndex, values := range rows {
		row := newAdRowData(parsed.headers, values, scopeStart, scopeEnd, &parsed.country)
		columns, vals, err := adDetailInsertValues(parsed.match.spec.reportType, sourceID, rowIndex+1, row)
		if err != nil {
			return err
		}
		columnNames := make([]string, 0, len(columns))
		placeholders := make([]string, 0, len(columns))
		args := make([]any, 0, len(columns))
		for i, item := range columns {
			columnNames = append(columnNames, item.column)
			placeholder := fmt.Sprintf("$%d", i+1)
			if item.cast != "" {
				placeholder += item.cast
			}
			placeholders = append(placeholders, placeholder)
			args = append(args, item.value)
		}
		if len(args) != len(vals) {
			return errors.New("ad upload detail argument mismatch")
		}
		query := fmt.Sprintf(
			"insert into public.%s (%s) values (%s)",
			adDetailTable(parsed.match.spec.reportType),
			strings.Join(columnNames, ", "),
			strings.Join(placeholders, ", "),
		)
		if _, err := db.Exec(ctx, query, args...); err != nil {
			return fmt.Errorf("insert %s row %d: %w", adDetailTable(parsed.match.spec.reportType), rowIndex+1, err)
		}
	}
	return nil
}

func adDetailTable(reportType string) string {
	switch reportType {
	case "ad_budget_report":
		return "ad_upload_budget_rows"
	case "ad_campaign_report":
		return "ad_upload_campaign_rows"
	case "ad_placement_report":
		return "ad_upload_placement_rows"
	case "ad_invalid_traffic_report":
		return "ad_upload_invalid_traffic_rows"
	case "ad_target_report":
		return "ad_upload_target_rows"
	case "ad_search_term_report":
		return "ad_upload_search_term_rows"
	case "ad_search_term_share_report":
		return "ad_upload_search_term_share_rows"
	case "ad_time_trend_report":
		return "ad_upload_time_trend_rows"
	case "ad_promoted_product_report":
		return "ad_upload_promoted_product_rows"
	case "ad_purchased_product_report":
		return "ad_upload_purchased_product_rows"
	default:
		return ""
	}
}

func adDetailInsertValues(reportType string, sourceID int64, rowNumber int, row adRowData) ([]adInsertValue, []any, error) {
	table := adDetailTable(reportType)
	if table == "" {
		return nil, nil, fmt.Errorf("unsupported ad report type %s", reportType)
	}
	startDate, endDate := row.dateRange()
	if startDate == "" || endDate == "" {
		return nil, nil, errors.New("ad upload row date is missing")
	}

	items := []adInsertValue{
		{column: "source_file_id", value: sourceID},
		{column: "source_row_no", value: rowNumber},
		{column: "report_start_date", value: startDate},
		{column: "report_end_date", value: endDate},
	}
	add := func(column string, value any) {
		items = append(items, adInsertValue{column: column, value: value})
	}
	addText := func(column string, value *string) {
		add(column, adText(value))
	}

	switch reportType {
	case "ad_budget_report":
		addText("campaign_name", row.text("广告活动名称"))
		addText("status", row.text("状态"))
		add("budget", row.decimal(false, "预算"))
		add("suggested_budget", row.decimal(false, "建议预算"))
		add("budget_utilization_rate", row.decimal(false, "预算范围内的平均时间"))
		add("missed_impressions_min", row.integer("预计错失的展示量范围（最小值）"))
		add("missed_impressions_max", row.integer("预计错失的展示量范围（最大值）"))
		add("missed_clicks_min", row.integer("预计错失的点击量范围（最小值）"))
		add("missed_clicks_max", row.integer("预计错失的点击量范围（最大）"))
		add("missed_sales_min", row.decimal(false, "预计错失的销售额范围（最小值）"))
		add("missed_sales_max", row.decimal(false, "预计错失的销售额范围（最大值）"))
		add("spend", row.decimal(false, "花费"))
		add("sales_7d", row.decimal(false, "7天总销售额"))
		add("orders_7d", row.integer("7天总订单数(#)"))
		add("acos", row.decimal(false, "广告投入产出比 (ACOS) 总计"))
		addText("country", row.countryValue("国家/地区"))
		addText("currency", row.text("货币"))
		addText("retailer", row.text("零售商"))
		addText("portfolio_name", row.text("广告组合名称"))
		addText("campaign_type", row.text("广告活动类型"))
		addText("targeting_type", row.text("定位类型"))
		addText("bidding_strategy", row.text("竞价策略"))
		add("impressions", row.integer("展示量"))
		add("clicks", row.integer("点击量"))
	case "ad_campaign_report":
		addText("campaign_name", row.text("广告活动名称"))
		addText("portfolio_name", row.text("广告组合名称"))
		addText("campaign_type", row.text("广告活动类型"))
		addText("targeting_type", row.text("定位类型"))
		addText("bidding_strategy", row.text("竞价策略"))
		addText("status", row.text("状态"))
		add("budget", row.decimal(false, "预算"))
		add("impressions", row.integer("展示量"))
		add("clicks", row.integer("点击量"))
		add("ctr", row.decimal(true, "点击率 (CTR)"))
		add("spend", row.decimal(false, "花费"))
		add("cpc", row.decimal(false, "单次点击成本 (CPC)"))
		add("orders_7d", row.integer("7天总订单数(#)"))
		add("sales_7d", row.decimal(false, "7天总销售额"))
		add("acos", row.decimal(false, "广告投入产出比 (ACOS) 总计"))
		add("roas", row.decimal(false, "总广告投资回报率 (ROAS)"))
		addText("country", row.countryValue("国家/地区"))
		addText("currency", row.text("货币"))
		addText("retailer", row.text("零售商"))
	case "ad_placement_report":
		addText("campaign_name", row.text("广告活动名称"))
		addText("placement", row.text("放置"))
		addText("bidding_strategy", row.text("竞价策略"))
		add("impressions", row.integer("展示量"))
		add("clicks", row.integer("点击量"))
		add("spend", row.decimal(false, "花费"))
		add("cpc", row.decimal(false, "单次点击成本 (CPC)"))
		add("sales_7d", row.decimal(false, "7天总销售额"))
		add("orders_7d", row.integer("7天总订单数(#)"))
		add("units_7d", row.integer("7天总销售量(#)"))
		add("acos", row.decimal(false, "广告投入产出比 (ACOS) 总计"))
		add("roas", row.decimal(false, "总广告投资回报率 (ROAS)"))
		addText("country", row.countryValue("国家/地区"))
		addText("currency", row.text("货币"))
		addText("retailer", row.text("零售商"))
		addText("portfolio_name", row.text("广告组合名称"))
	case "ad_invalid_traffic_report":
		addText("campaign_name", row.text("广告活动名称"))
		addText("status", row.text("状态"))
		add("total_impressions", row.integer("总展示量"))
		add("valid_impressions", row.integer("展示量"))
		add("invalid_impressions", row.integer("无效展示量"))
		add("invalid_impression_rate", row.decimal(false, "无效展示率"))
		add("total_clicks", row.integer("总点击量"))
		add("valid_clicks", row.integer("点击量"))
		add("invalid_clicks", row.integer("无效点击"))
		add("invalid_click_rate", row.decimal(false, "无效的点击率"))
		addText("country", row.countryValue("国家/地区"))
		addText("retailer", row.text("零售商"))
	case "ad_target_report":
		addText("campaign_name", row.text("广告活动名称"))
		addText("ad_group_name", row.text("广告组名称"))
		addText("target_text", row.text("投放"))
		addText("match_type", row.text("匹配类型"))
		add("impressions", row.integer("展示量"))
		add("top_of_search_impression_share", row.decimal(false, "搜索结果首页首位展示量份额"))
		add("clicks", row.integer("点击量"))
		add("ctr", row.decimal(false, "点击率 (CTR)"))
		add("cpc", row.decimal(false, "单次点击成本 (CPC)"))
		add("spend", row.decimal(false, "花费"))
		add("sales_7d", row.decimal(false, "7天总销售额"))
		add("orders_7d", row.integer("7天总订单数(#)"))
		add("units_7d", row.integer("7天总销售量(#)"))
		add("acos", row.decimal(false, "广告投入产出比 (ACOS) 总计"))
		add("roas", row.decimal(false, "总广告投资回报率 (ROAS)"))
		add("cvr_7d", row.decimal(false, "7天的转化率"))
		addText("country", row.countryValue("国家/地区"))
		addText("currency", row.text("货币"))
		addText("retailer", row.text("零售商"))
		addText("portfolio_name", row.text("广告组合名称"))
	case "ad_search_term_report":
		addText("campaign_name", row.text("广告活动名称"))
		addText("ad_group_name", row.text("广告组名称"))
		addText("target_text", row.text("投放"))
		addText("match_type", row.text("匹配类型"))
		addText("search_term", row.text("客户搜索词"))
		add("impressions", row.integer("展示量"))
		add("clicks", row.integer("点击量"))
		add("ctr", row.decimal(false, "点击率 (CTR)"))
		add("spend", row.decimal(false, "花费"))
		add("cpc", row.decimal(false, "单次点击成本 (CPC)"))
		add("orders_7d", row.integer("7天总订单数(#)"))
		add("sales_7d", row.decimal(false, "7天总销售额"))
		add("acos", row.decimal(false, "广告投入产出比 (ACOS) 总计"))
		add("roas", row.decimal(false, "总广告投资回报率 (ROAS)"))
		add("cvr_7d", row.decimal(false, "7天的转化率"))
		addText("country", row.countryValue("国家/地区"))
		addText("currency", row.text("货币"))
		addText("retailer", row.text("零售商"))
		addText("portfolio_name", row.text("广告组合名称"))
	case "ad_search_term_share_report":
		addText("search_term", row.text("客户搜索词"))
		add("impression_rank", row.integer("搜索词展示量排名"))
		add("impression_share", row.decimal(true, "搜索词展示量份额"))
		addText("target_text", row.text("投放"))
		addText("match_type", row.text("匹配类型"))
		addText("campaign_name", row.text("广告活动名称"))
		addText("ad_group_name", row.text("广告组名称"))
		add("clicks", row.integer("点击量"))
		add("impressions", row.integer("展示量"))
		add("ctr", row.decimal(true, "点击率 (CTR)"))
		add("spend", row.decimal(false, "花费"))
		add("cpc", row.decimal(false, "单次点击成本 (CPC)"))
		add("orders_7d", row.integer("7 天内的总订单量 (#)"))
		add("sales_7d", row.decimal(false, "7 天内的总销售额 "))
		add("acos", row.decimal(false, "广告投入产出比 (ACOS) 总计"))
		add("roas", row.decimal(false, "总广告投资回报率 (ROAS)"))
		add("cvr_7d", row.decimal(true, "7 天转化率"))
		addText("country", row.countryValue("国家/地区"))
		addText("currency", row.text("货币"))
		addText("portfolio_name", row.text("广告组合名称"))
	case "ad_time_trend_report":
		addText("country", row.countryValue("国家/地区"))
		addText("currency", row.text("货币"))
		add("clicks", row.integer("点击量"))
		add("cpc", row.decimal(false, "单次点击成本 (CPC)"))
		add("spend", row.decimal(false, "花费"))
	case "ad_promoted_product_report":
		isNewFormat := row.text("日期范围") != nil
		addText("campaign_name", row.text("广告活动名称"))
		addText("ad_group_name", row.text("广告组名称"))
		addText("ad_sku", row.text("推广的商品 SKU-Advertised product SKU", "广告SKU"))
		addText("ad_asin", row.text("推广的商品编号", "广告ASIN"))
		add("impressions", row.integer("展示量"))
		add("clicks", row.integer("点击量"))
		add("ctr", row.decimal(isNewFormat, "点击率", "点击率 (CTR)"))
		add("spend", row.decimal(false, "总成本", "花费"))
		add("cpc", row.decimal(false, "CPC", "单次点击成本 (CPC)"))
		add("orders_7d", row.integer("购买量", "7天总订单数(#)"))
		add("units_7d", row.integer("由点击产生的已售商品数量", "7天总销售量(#)"))
		add("sales_7d", row.decimal(false, "销售额", "7天总销售额"))
		spend := row.decimal(false, "总成本", "花费")
		sales := row.decimal(false, "销售额", "7天总销售额")
		acos := row.decimal(false, "广告投入产出比 (ACOS) 总计")
		if row.text("广告投入产出比 (ACOS) 总计") == nil && sales > 0 {
			acos = spend / sales
		}
		add("acos", acos)
		add("roas", row.decimal(false, "归因于点击的 ROAS", "总广告投资回报率 (ROAS)"))
		add("cvr_7d", row.decimal(isNewFormat, "点击购买率", "7天的转化率"))
		add("ad_sku_units_7d", row.integer("已售商品数量（推广）", "7天内广告SKU销售量(#)"))
		add("other_sku_units_7d", row.integer("已售商品数量（光环）", "7天内其他SKU销售量(#)"))
		add("ad_sku_sales_7d", row.decimal(false, "推广商品的销量", "7天内广告SKU销售额"))
		add("other_sku_sales_7d", row.decimal(false, "销售额（光环）", "7天内其他SKU销售额"))
		add("scope_status", "included_product")
		addText("country", row.countryValue("投放广告活动的国家/地区", "国家/地区"))
		addText("currency", row.text("预算货币", "货币"))
		addText("retailer", row.text("零售商"))
		addText("portfolio_name", row.text("广告组合名称"))
	case "ad_purchased_product_report":
		addText("campaign_name", row.text("广告活动名称"))
		addText("ad_group_name", row.text("广告组名称"))
		addText("ad_sku", row.text("广告SKU"))
		addText("ad_asin", row.text("广告ASIN"))
		addText("target_text", row.text("投放"))
		addText("match_type", row.text("匹配类型"))
		addText("purchased_asin", row.text("已购买的ASIN"))
		add("other_sku_units_7d", row.integer("7天内其他SKU销售量(#)"))
		add("other_sku_orders_7d", row.integer("7天内其他SKU订单数(#)"))
		add("other_sku_sales_7d", row.decimal(false, "7天内其他SKU销售额"))
		addText("country", row.countryValue("国家/地区"))
		addText("currency", row.text("货币"))
		addText("retailer", row.text("零售商"))
		addText("portfolio_name", row.text("广告组合名称"))
	}

	items = append(items, adInsertValue{
		column: "raw_row",
		value:  row.rawJSON(),
		cast:   "::json",
	})
	vals := make([]any, len(items))
	for i := range items {
		vals[i] = items[i].value
	}
	return items, vals, nil
}
