package tasks

import (
	"encoding/csv"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis"
)

var productAnalysisOverviewColumns = []string{
	"日期",
	"SKU",
	"ASIN",
	"总销量",
	"总销售额",
	"页面浏览量",
	"总访客",
	"总转化",
	"广告展示量",
	"广告点击量",
	"广告点击率",
	"广告订单量",
	"广告单占比",
	"广告转化率",
	"广告花费",
	"广告销售额",
	"CPC",
	"ACOS",
	"SP占比",
	"自然流量",
	"自然流量占比",
	"自然单",
	"自然单转化",
	"产品FOB",
	"成本占比",
	"销售头程",
	"头程占比",
	"FBA配送费",
	"配送费占比",
	"平台佣金",
	"佣金占比",
	"总成本",
	"总成本占比",
	"利润",
	"利润率",
	"实际销售额",
	"实际销售量",
	"实际退款额",
	"实际退款量",
	"平均售价",
	"退款率",
}

var productAnalysisIntegerColumns = map[string]bool{
	"总销量":   true,
	"页面浏览量": true,
	"总访客":   true,
	"广告展示量": true,
	"广告点击量": true,
	"广告订单量": true,
	"自然流量":  true,
	"自然单":   true,
	"实际销售量": true,
	"实际退款量": true,
}

var productAnalysisPercentColumns = map[string]bool{
	"总转化":    true,
	"广告点击率":  true,
	"广告单占比":  true,
	"广告转化率":  true,
	"ACOS":   true,
	"SP占比":   true,
	"自然流量占比": true,
	"自然单转化":  true,
	"成本占比":   true,
	"头程占比":   true,
	"配送费占比":  true,
	"佣金占比":   true,
	"总成本占比":  true,
	"利润率":    true,
	"退款率":    true,
}

func buildProductAnalysisReportWorkbook(
	response *product_analysis.RunResponse,
	inventoryPath string,
) ([]byte, error) {
	if response == nil {
		return nil, errors.New("product analysis response is nil")
	}
	overviewRows := [][]monthlyXLSXCell{
		monthlyStringRow(productAnalysisOverviewColumns),
	}
	for _, period := range response.Periods {
		for _, detail := range period.Details {
			overviewRows = append(
				overviewRows,
				productAnalysisOverviewRow(detail),
			)
		}
		if period.Summary != nil {
			overviewRows = append(
				overviewRows,
				productAnalysisOverviewRow(period.Summary),
			)
		}
	}
	sheets := []monthlyXLSXSheet{
		{name: "产品分析", rows: overviewRows},
	}
	if inventorySheet := buildProductAnalysisInventorySheet(
		inventoryPath,
		response,
	); inventorySheet != nil {
		sheets = append(sheets, *inventorySheet)
	}
	return renderMonthlyXLSX(response.ProjectName, sheets)
}

func productAnalysisOverviewRow(row map[string]any) []monthlyXLSXCell {
	cells := make([]monthlyXLSXCell, len(productAnalysisOverviewColumns))
	for index, column := range productAnalysisOverviewColumns {
		cells[index] = productAnalysisValueCell(
			row[column],
			productAnalysisIntegerColumns[column],
			productAnalysisPercentColumns[column],
		)
	}
	return cells
}

func productAnalysisValueCell(
	value any,
	integer bool,
	percent bool,
) monthlyXLSXCell {
	if value == nil {
		return monthlyStringCell("")
	}
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	case int:
		number = float64(typed)
	case int32:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case uint:
		number = float64(typed)
	case uint64:
		number = float64(typed)
	default:
		return monthlyStringCell(fmt.Sprint(value))
	}
	if percent {
		return monthlyStringCell(fmt.Sprintf("%.2f%%", number*100))
	}
	if integer {
		return monthlyNumberCell(strconv.FormatInt(int64(number), 10))
	}
	return monthlyNumberCell(strconv.FormatFloat(number, 'f', -1, 64))
}

func buildProductAnalysisInventorySheet(
	inventoryPath string,
	response *product_analysis.RunResponse,
) *monthlyXLSXSheet {
	inventoryPath = strings.TrimSpace(inventoryPath)
	if inventoryPath == "" ||
		strings.EqualFold(filepath.Ext(inventoryPath), ".xlsx") {
		return nil
	}
	inventory, err := readProductAnalysisInventory(inventoryPath)
	if err != nil || len(inventory.headers) == 0 {
		// The Python reference treats the optional inventory sheet as best effort.
		return nil
	}
	salesBySKU := productAnalysisSalesBySKU(response)

	rows := [][]monthlyXLSXCell{monthlyStringRow(inventory.headers)}
	numericColumns := map[string]bool{
		"本周销量":     true,
		"可售库存":     true,
		"0-90天":    true,
		"91-180天":  true,
		"181-270天": true,
		"271-365天": true,
		"365+天":    true,
	}
	sums := map[string]float64{}
	for _, record := range inventory.records {
		values := make(map[string]string, len(inventory.headers))
		for _, header := range inventory.headers {
			values[header] = record[header]
		}
		values["本周销量"] = strconv.FormatFloat(
			salesBySKU[strings.TrimSpace(values["SKU"])],
			'f',
			-1,
			64,
		)
		cells := make([]monthlyXLSXCell, len(inventory.headers))
		for index, header := range inventory.headers {
			if numericColumns[header] {
				numberValue := productAnalysisInventoryNumber(values[header])
				cells[index] = monthlyNumberCell(strconv.FormatFloat(numberValue, 'f', -1, 64))
				sums[header] += numberValue
				continue
			}
			cells[index] = monthlyStringCell(values[header])
		}
		rows = append(rows, cells)
	}

	summary := make([]monthlyXLSXCell, len(inventory.headers))
	for index, header := range inventory.headers {
		switch {
		case header == "SKU":
			summary[index] = monthlyStringCell("汇总行")
		case numericColumns[header]:
			summary[index] = monthlyNumberCell(
				strconv.FormatFloat(sums[header], 'f', -1, 64),
			)
		default:
			summary[index] = monthlyStringCell("")
		}
	}
	rows = append(rows, summary)
	return &monthlyXLSXSheet{name: "库存详情", rows: rows}
}

type productAnalysisInventoryData struct {
	headers []string
	records []map[string]string
}

func readProductAnalysisInventory(path string) (*productAnalysisInventoryData, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.Comma = '\t'
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true
	allRows, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(allRows) < 2 {
		return &productAnalysisInventoryData{}, nil
	}
	sourceHeaders := allRows[0]
	if len(sourceHeaders) > 0 {
		sourceHeaders[0] = strings.TrimPrefix(sourceHeaders[0], "\ufeff")
	}
	inventoryHeaders := []string{
		"sku",
		"asin",
		"available",
		"inv-age-0-to-90-days",
		"inv-age-91-to-180-days",
		"inv-age-181-to-270-days",
		"inv-age-271-to-365-days",
		"inv-age-365-plus-days",
		"recommended-action",
	}
	displayNames := map[string]string{
		"sku":                     "SKU",
		"asin":                    "ASIN",
		"available":               "可售库存",
		"inv-age-0-to-90-days":    "0-90天",
		"inv-age-91-to-180-days":  "91-180天",
		"inv-age-181-to-270-days": "181-270天",
		"inv-age-271-to-365-days": "271-365天",
		"inv-age-365-plus-days":   "365+天",
		"recommended-action":      "库存建议",
	}
	indices := map[string]int{}
	for _, wanted := range inventoryHeaders {
		for index, header := range sourceHeaders {
			if strings.TrimSpace(header) == wanted {
				indices[wanted] = index
				break
			}
		}
	}
	if len(indices) == 0 {
		return &productAnalysisInventoryData{}, nil
	}
	headers := []string{"SKU", "ASIN", "本周销量"}
	for _, sourceHeader := range inventoryHeaders {
		if _, ok := indices[sourceHeader]; ok &&
			displayNames[sourceHeader] != "SKU" &&
			displayNames[sourceHeader] != "ASIN" {
			headers = append(headers, displayNames[sourceHeader])
		}
	}
	records := make([]map[string]string, 0, len(allRows)-1)
	for _, row := range allRows[1:] {
		record := make(map[string]string, len(headers))
		for sourceHeader, index := range indices {
			if index >= len(row) {
				continue
			}
			record[displayNames[sourceHeader]] = strings.TrimSpace(row[index])
		}
		records = append(records, record)
	}
	return &productAnalysisInventoryData{headers: headers, records: records}, nil
}

func productAnalysisSalesBySKU(
	response *product_analysis.RunResponse,
) map[string]float64 {
	result := map[string]float64{}
	for _, period := range response.Periods {
		for _, detail := range period.Details {
			sku := strings.TrimSpace(fmt.Sprint(detail["SKU"]))
			if sku == "" || sku == "汇总" {
				continue
			}
			result[sku] += productAnalysisFloatValue(detail["总销量"])
		}
	}
	return result
}

func productAnalysisInventoryNumber(value string) float64 {
	value = strings.TrimSpace(strings.ReplaceAll(value, ",", ""))
	if value == "" {
		return 0
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0
	}
	return number
}

func productAnalysisFloatValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int32:
		return float64(typed)
	case int64:
		return float64(typed)
	case uint:
		return float64(typed)
	case uint64:
		return float64(typed)
	default:
		return 0
	}
}
