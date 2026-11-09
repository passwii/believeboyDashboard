package tasks

import (
	"archive/zip"
	"bytes"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"
)

type monthlyXLSXCell struct {
	value  string
	number bool
}

type monthlyXLSXSheet struct {
	name string
	rows [][]monthlyXLSXCell
}

func buildMonthlyReportWorkbook(
	input MonthlyReportGenerationInput,
	rows []*monthlyPaymentRow,
	classified monthlyClassifiedRows,
	pt3 monthlyAmountMap,
	pt4 monthlyAmountMap,
) ([]byte, error) {
	sheets := []monthlyXLSXSheet{
		buildMonthlyOverviewSheet(pt3, pt4),
		buildMonthlyAccountingSheet(input.Country, pt3),
		buildMonthlyPaymentRowsSheet("交易一览", rows, monthlyPaymentColumns),
		buildMonthlySKUSheet("销售SKU明细", classified["order"]),
		buildMonthlySKUSheet("退款SKU明细", classified["refund"]),
		buildMonthlyPaymentRowsSheet("所有订单", classified["order"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("所有退款", classified["refund"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("FBM 订单", classified["fbm_order"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("FBM 退款", classified["fbm_refund"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("FBA 订单", classified["fba_order"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("FBA 退款", classified["fba_refund"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("FBA库存赔偿", classified["adjustment_income"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("其他赔偿", classified["adjustment_expense"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("清算费用", classified["liquidation"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("拒付退款", classified["chargeback_refund"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("FBA仓储及入库服务费", classified["fba_inventory_fee"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("服务费（不含广告）", classified["amazon_fees_and_service_fee_without_ad"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("广告费", classified["advertising"], monthlyPaymentColumns),
		buildMonthlyPaymentRowsSheet("广告退款", classified["service_refund_for_advertiser"], monthlyPaymentColumns),
	}
	return renderMonthlyXLSX(input.ProjectName, sheets)
}

func buildMonthlyOverviewSheet(pt3, pt4 monthlyAmountMap) monthlyXLSXSheet {
	headers := []string{
		"1-销售额",
		"2-销售额退款",
		"3-赔偿",
		"4-其他收入",
		"5-平台费",
		"6-派送费",
		"7-仓储费",
		"8-服务费",
		"9-广告费",
		"10-其他费用",
		"收入合计",
		"支出合计",
		"亚马逊回款金额",
		"信用卡扣款-支出",
		"推广费占比",
		"说明",
	}
	values := []monthlyXLSXCell{
		monthlyNumberCell(monthlyAmountText(pt4["income_sales"])),
		monthlyNumberCell(monthlyAmountText(pt4["income_refund"])),
		monthlyNumberCell(monthlyAmountText(pt4["income_adjustment"])),
		monthlyNumberCell(monthlyAmountText(pt4["income_other"])),
		monthlyNumberCell(monthlyAmountText(pt4["expense_selling_fee"])),
		monthlyNumberCell(monthlyAmountText(pt4["expense_fba_fee"])),
		monthlyNumberCell(monthlyAmountText(pt4["expense_inventory_fee"])),
		monthlyNumberCell(monthlyAmountText(pt4["expense_service_fee"])),
		monthlyNumberCell(monthlyAmountText(pt4["expense_advertising"])),
		monthlyNumberCell(monthlyAmountText(pt4["expense_other_fees"])),
		monthlyNumberCell(monthlyAmountText(pt4["income_total"])),
		monthlyNumberCell(monthlyAmountText(pt4["expense_total"])),
		monthlyNumberCell(monthlyAmountText(pt4["amazon_pay_back"])),
		monthlyNumberCell(monthlyAmountText(pt4["credit_card_deduction_usd"])),
		monthlyStringCell(monthlyPercentText(
			pt3["expense_cost_of_advertising"],
			pt4["income_total"],
		)),
		monthlyStringCell("PDF已暂不处理，仅按交易CSV核算"),
	}
	return monthlyXLSXSheet{
		name: "总览草稿",
		rows: [][]monthlyXLSXCell{
			monthlyStringRow(headers),
			values,
		},
	}
}

func buildMonthlyAccountingSheet(country string, pt3 monthlyAmountMap) monthlyXLSXSheet {
	currency := monthlyCurrencyCode(country)
	rows := [][]monthlyXLSXCell{
		monthlyStringRow([]string{
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
	incomeLines := []monthlyAccountingLine{
		{en: "Product sales (non-FBA)", zh: "销售额（非FBA）", source: "FBM 订单-订单金额", amount: monthlyAmountText(pt3["income_product_sales_non_fba"])},
		{en: "Product sale refunds (non-FBA) ", zh: "销售额退款（非FBA）", source: "FBM 退款-订单金额", amount: monthlyAmountText(pt3["income_product_sale_refunds_non_fba"])},
		{en: "FBA product sales", zh: "销售额（FBA）", source: "FBA 订单-订单金额", amount: monthlyAmountText(pt3["income_fba_product_sales"])},
		{en: "FBA product sale refunds", zh: "销售额退款（FBA）", source: "FBA 退款-订单金额 + 其他金额", amount: monthlyAmountText(pt3["income_fba_product_sale_refunds"])},
		{en: "FBA inventory credit", zh: "FBA库存赔偿（FBA）", source: "FBA库存赔偿-总计", amount: monthlyAmountText(pt3["income_fba_inventory_credit"])},
		{en: "FBA liquidation proceeds", zh: "FBA清算收入", source: "清算费用-订单金额", amount: monthlyAmountText(pt3["income_fba_liquidation_proceeds"])},
		{en: "Shipping credits", zh: "运费收入", source: "所有订单-运费金额", amount: monthlyAmountText(pt3["income_shipping_credits"])},
		{en: "Shipping credit refunds", zh: "运费退款", source: "所有退款-运费金额", amount: monthlyAmountText(pt3["income_shipping_credit_refunds"])},
		{en: "Gift wrap credits", zh: "礼品包装收入", source: "所有订单-礼品包装金额", amount: monthlyAmountText(pt3["income_gift_wrap_credits"])},
		{en: "Gift wrap credit refunds", zh: "礼品包装退款", source: "所有退款-礼品包装金额", amount: monthlyAmountText(pt3["income_gift_wrap_credits_refunds"])},
		{en: "Promotional rebates", zh: "促销折扣", source: "所有订单-促销折扣金额", amount: monthlyAmountText(pt3["income_promotional_rebates"])},
		{en: "Promotional rebate refunds", zh: "促销折扣退款", source: "所有退款-促销折扣金额", amount: monthlyAmountText(pt3["income_promotional_rebate_refunds"])},
		{en: "A-to-z Guarantee claims", zh: "A-to-z保障索赔", amount: monthlyAmountText(pt3["income_a_to_z_guarantee_claims"])},
		{en: "Chargebacks", zh: "拒付退款", source: "拒付退款-总计", amount: monthlyAmountText(pt3["income_chargebacks"])},
		{en: "SAFE-T reimbursement", zh: "SAFE-T赔偿", amount: monthlyAmountText(pt3["income_safe_t_reimbursement"])},
		{en: "Product sales tax (gross)", zh: "销售税（gross）", source: "所有订单/退款-产品销售税", amount: monthlyAmountText(pt3["income_vat_total"])},
	}
	expenseLines := []monthlyAccountingLine{
		{en: "Seller fulfilled selling fees", zh: "卖家自配送销售佣金", source: "FBM 订单-销售佣金", amount: monthlyAmountText(pt3["expense_seller_fulfilled_selling_fees"])},
		{en: "FBA selling fees", zh: "FBA销售佣金", source: "FBA 订单-销售佣金", amount: monthlyAmountText(pt3["expense_fba_selling_fees"])},
		{en: "Selling fee refunds", zh: "销售佣金退款", source: "所有退款-销售佣金 + 退款管理费", amount: monthlyAmountText(pt3["expense_selling_fee_refunds"])},
		{en: "FBA transaction fees", zh: "FBA派送费", source: "FBA 订单 - 派送费", amount: monthlyAmountText(pt3["expense_fba_transaction_fees"])},
		{en: "FBA transaction fee refunds", zh: "FBA派送费退款", source: "FBA 退款 - 派送费 + 测量费", amount: monthlyAmountText(pt3["expense_fba_transaction_fee_refunds"])},
		{en: "Other transaction fees", zh: "其他交易费用", amount: monthlyAmountText(pt3["expense_other_transaction_fees"])},
		{en: "Other transaction fee refunds", zh: "其他交易费用退款", amount: monthlyAmountText(pt3["expense_other_transaction_fee_refunds"])},
		{en: "FBA inventory and inbound services fees", zh: "FBA库存和入库服务费", source: "FBA仓储及入库服务费 - 总计", amount: monthlyAmountText(pt3["expense_fba_inventory_and_inbound_services_fees"])},
		{en: "Shipping label purchases", zh: "购买配送标签", amount: monthlyAmountText(pt3["expense_shipping_label_purchases"])},
		{en: "Shipping label refunds", zh: "配送标签退款", amount: monthlyAmountText(pt3["expense_shipping_label_refunds"])},
		{en: "Carrier shipping label adjustments", zh: "承运商配送标签调整", amount: monthlyAmountText(pt3["expense_carrier_shipping_label_adjustments"])},
		{en: "Service fees", zh: "服务费", source: "服务费（不含广告）-总计", amount: monthlyAmountText(pt3["expense_service_fees"])},
		{en: "Refund administration fees", zh: "退款管理费", source: "合并在销售佣金退款中扣除", amount: monthlyAmountText(pt3["expense_refund_administration_fees"])},
		{en: "Adjustments", zh: "调整项", source: "其他赔偿调整-总计", amount: monthlyAmountText(pt3["expense_adjustments"])},
		{en: "Cost of Advertising", zh: "广告成本", source: "广告费-总计", amount: monthlyAmountText(pt3["expense_cost_of_advertising"])},
		{en: "Refund for Advertiser", zh: "广告商退款", source: "广告退款-总计", amount: monthlyAmountText(pt3["expense_refund_for_advertiser"])},
		{en: "Liquidations fees", zh: "清算处理费", source: "清算费用-其他交易费用", amount: monthlyAmountText(pt3["expense_liquidations_fees"])},
		{en: "Receivables", zh: "应收账款", amount: monthlyAmountText(pt3["expense_receivables"])},
		{en: "Deductions", zh: "扣款", amount: monthlyAmountText(pt3["expense_deductions"])},
		{en: "Amazon Shipping Charge Adjustments", zh: "亚马逊配送运费调整", amount: monthlyAmountText(pt3["expense_amazon_shipping_charge_adjustments"])},
	}
	count := len(incomeLines)
	if len(expenseLines) > count {
		count = len(expenseLines)
	}
	for index := 0; index < count; index++ {
		var incomeLine, expenseLine monthlyAccountingLine
		if index < len(incomeLines) {
			incomeLine = incomeLines[index]
		}
		if index < len(expenseLines) {
			expenseLine = expenseLines[index]
		}
		rows = append(rows, []monthlyXLSXCell{
			monthlyStringCell(incomeLine.en),
			monthlyStringCell(incomeLine.zh),
			monthlyStringOrEmptyAmountCell(incomeLine.amount),
			monthlyStringCell(incomeLine.source),
			monthlyStringCell(""),
			monthlyStringCell(expenseLine.en),
			monthlyStringCell(expenseLine.zh),
			monthlyStringOrEmptyAmountCell(expenseLine.amount),
			monthlyStringCell(expenseLine.source),
		})
	}
	rows = append(rows, []monthlyXLSXCell{
		monthlyStringCell("Total_Income"),
		monthlyStringCell("合计销售额"),
		monthlyNumberCell(monthlyAmountText(pt3["income_total"])),
		monthlyStringCell(""),
		monthlyStringCell(""),
		monthlyStringCell("Total_Expense"),
		monthlyStringCell("合计费用"),
		monthlyNumberCell(monthlyAmountText(pt3["expense_total"])),
		monthlyStringCell(""),
	})
	return monthlyXLSXSheet{name: "报表核算", rows: rows}
}

type monthlyAccountingLine struct {
	en     string
	zh     string
	amount string
	source string
}

func buildMonthlyPaymentRowsSheet(
	name string,
	rows []*monthlyPaymentRow,
	columns []monthlyPaymentColumn,
) monthlyXLSXSheet {
	if len(rows) == 0 {
		return monthlyXLSXSheet{
			name: name,
			rows: [][]monthlyXLSXCell{monthlyStringRow([]string{"No Data"})},
		}
	}
	header := make([]string, len(columns))
	for index, column := range columns {
		header[index] = column.name
	}
	sheetRows := [][]monthlyXLSXCell{monthlyStringRow(header)}
	for _, row := range rows {
		cells := make([]monthlyXLSXCell, len(columns))
		for index, column := range columns {
			field := column.name
			if monthlyPaymentNumericColumns[field] {
				if field == "quantity" {
					cells[index] = monthlyNumberCell(fmt.Sprintf("%d", row.quantity))
				} else {
					cells[index] = monthlyNumberCell(row.displayAmount(field))
				}
				continue
			}
			cells[index] = monthlyStringCell(row.fields[field])
		}
		sheetRows = append(sheetRows, cells)
	}
	return monthlyXLSXSheet{name: name, rows: sheetRows}
}

func buildMonthlySKUSheet(name string, rows []*monthlyPaymentRow) monthlyXLSXSheet {
	type skuQuantity struct {
		sku      string
		quantity int
	}
	grouped := make(map[string]int)
	for _, row := range rows {
		sku := strings.TrimSpace(row.fields["sku"])
		if sku == "" {
			continue
		}
		grouped[sku] += row.quantity
	}
	items := make([]skuQuantity, 0, len(grouped))
	for sku, quantity := range grouped {
		items = append(items, skuQuantity{sku: sku, quantity: quantity})
	}
	sort.Slice(items, func(left, right int) bool {
		if items[left].quantity == items[right].quantity {
			return items[left].sku < items[right].sku
		}
		return items[left].quantity > items[right].quantity
	})
	sheetRows := [][]monthlyXLSXCell{monthlyStringRow([]string{"sku", "quantity"})}
	if len(items) == 0 {
		sheetRows = [][]monthlyXLSXCell{monthlyStringRow([]string{"No Data"})}
	} else {
		for _, item := range items {
			sheetRows = append(sheetRows, []monthlyXLSXCell{
				monthlyStringCell(item.sku),
				monthlyNumberCell(fmt.Sprintf("%d", item.quantity)),
			})
		}
	}
	return monthlyXLSXSheet{name: name, rows: sheetRows}
}

func renderMonthlyXLSX(projectName string, sheets []monthlyXLSXSheet) ([]byte, error) {
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	entries := map[string][]byte{
		"[Content_Types].xml":        monthlyContentTypesXML(len(sheets)),
		"_rels/.rels":                monthlyRootRelationshipsXML(),
		"docProps/core.xml":          monthlyCorePropertiesXML(projectName),
		"docProps/app.xml":           monthlyAppPropertiesXML(len(sheets)),
		"xl/workbook.xml":            monthlyWorkbookXML(sheets),
		"xl/_rels/workbook.xml.rels": monthlyWorkbookRelationshipsXML(len(sheets)),
		"xl/styles.xml":              monthlyStylesXML(),
	}
	for index, sheet := range sheets {
		entries[fmt.Sprintf("xl/worksheets/sheet%d.xml", index+1)] = monthlyWorksheetXML(sheet)
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
			return nil, fmt.Errorf("create xlsx entry %s: %w", name, err)
		}
		if _, err := writer.Write(entries[name]); err != nil {
			_ = archive.Close()
			return nil, fmt.Errorf("write xlsx entry %s: %w", name, err)
		}
	}
	if err := archive.Close(); err != nil {
		return nil, fmt.Errorf("close monthly report xlsx: %w", err)
	}
	return buffer.Bytes(), nil
}

func monthlyWorksheetXML(sheet monthlyXLSXSheet) []byte {
	var buffer strings.Builder
	buffer.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	buffer.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
	buffer.WriteString(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`)
	buffer.WriteString(`<sheetData>`)
	for rowIndex, row := range sheet.rows {
		buffer.WriteString(`<row r="`)
		buffer.WriteString(fmt.Sprintf("%d", rowIndex+1))
		buffer.WriteString(`">`)
		for columnIndex, cell := range row {
			buffer.WriteString(`<c r="`)
			buffer.WriteString(monthlyExcelColumn(columnIndex + 1))
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
				buffer.WriteString(monthlyXMLEscape(cell.value))
				buffer.WriteString(`</t></is></c>`)
			}
		}
		buffer.WriteString(`</row>`)
	}
	buffer.WriteString(`</sheetData></worksheet>`)
	return []byte(buffer.String())
}

func monthlyWorkbookXML(sheets []monthlyXLSXSheet) []byte {
	var buffer strings.Builder
	buffer.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	buffer.WriteString(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`)
	buffer.WriteString(`<sheets>`)
	for index, sheet := range sheets {
		buffer.WriteString(`<sheet name="`)
		buffer.WriteString(monthlyXMLEscape(sheet.name))
		buffer.WriteString(`" sheetId="`)
		buffer.WriteString(fmt.Sprintf("%d", index+1))
		buffer.WriteString(`" r:id="rId`)
		buffer.WriteString(fmt.Sprintf("%d", index+1))
		buffer.WriteString(`"/>`)
	}
	buffer.WriteString(`</sheets></workbook>`)
	return []byte(buffer.String())
}

func monthlyWorkbookRelationshipsXML(sheetCount int) []byte {
	var buffer strings.Builder
	buffer.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	buffer.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for index := 1; index <= sheetCount; index++ {
		buffer.WriteString(`<Relationship Id="rId`)
		buffer.WriteString(fmt.Sprintf("%d", index))
		buffer.WriteString(`" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet`)
		buffer.WriteString(fmt.Sprintf("%d", index))
		buffer.WriteString(`.xml"/>`)
	}
	buffer.WriteString(`<Relationship Id="rId`)
	buffer.WriteString(fmt.Sprintf("%d", sheetCount+1))
	buffer.WriteString(`" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`)
	buffer.WriteString(`</Relationships>`)
	return []byte(buffer.String())
}

func monthlyContentTypesXML(sheetCount int) []byte {
	var buffer strings.Builder
	buffer.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	buffer.WriteString(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`)
	buffer.WriteString(`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`)
	buffer.WriteString(`<Default Extension="xml" ContentType="application/xml"/>`)
	buffer.WriteString(`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`)
	for index := 1; index <= sheetCount; index++ {
		buffer.WriteString(`<Override PartName="/xl/worksheets/sheet`)
		buffer.WriteString(fmt.Sprintf("%d", index))
		buffer.WriteString(`.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
	}
	buffer.WriteString(`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`)
	buffer.WriteString(`<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`)
	buffer.WriteString(`<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`)
	buffer.WriteString(`</Types>`)
	return []byte(buffer.String())
}

func monthlyRootRelationshipsXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
		`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
		`<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
		`</Relationships>`)
}

func monthlyCorePropertiesXML(projectName string) []byte {
	now := time.Now().UTC().Format(time.RFC3339)
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
		`xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
		`xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
		`<dc:title>` + monthlyXMLEscape(projectName+" monthly report") + `</dc:title>` +
		`<dc:creator>believeboyDashboard</dc:creator>` +
		`<cp:lastModifiedBy>believeboyDashboard</cp:lastModifiedBy>` +
		`<dcterms:created xsi:type="dcterms:W3CDTF">` + now + `</dcterms:created>` +
		`<dcterms:modified xsi:type="dcterms:W3CDTF">` + now + `</dcterms:modified>` +
		`</cp:coreProperties>`)
}

func monthlyAppPropertiesXML(sheetCount int) []byte {
	_ = sheetCount
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
		`xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
		`<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
		`</Properties>`)
}

func monthlyStylesXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
		`<fonts count="2"><font><sz val="11"/><name val="Arial"/><family val="2"/></font>` +
		`<font><b/><sz val="11"/><name val="Arial"/><family val="2"/></font></fonts>` +
		`<fills count="3"><fill><patternFill patternType="none"/></fill>` +
		`<fill><patternFill patternType="gray125"/></fill>` +
		`<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>` +
		`<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
		`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
		`<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
		`<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>` +
		`<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
		`</styleSheet>`)
}

func monthlyExcelColumn(column int) string {
	result := ""
	for column > 0 {
		column--
		result = string(rune('A'+column%26)) + result
		column /= 26
	}
	return result
}

func monthlyXMLEscape(value string) string {
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

func monthlyStringRow(values []string) []monthlyXLSXCell {
	cells := make([]monthlyXLSXCell, len(values))
	for index, value := range values {
		cells[index] = monthlyStringCell(value)
	}
	return cells
}

func monthlyStringCell(value string) monthlyXLSXCell {
	return monthlyXLSXCell{value: value}
}

func monthlyNumberCell(value string) monthlyXLSXCell {
	if value == "" {
		value = "0"
	}
	return monthlyXLSXCell{value: value, number: true}
}

func monthlyStringOrEmptyAmountCell(value string) monthlyXLSXCell {
	if value == "" {
		return monthlyStringCell("")
	}
	return monthlyNumberCell(value)
}

func monthlyAmountText(value *big.Rat) string {
	if value == nil {
		return "0.00"
	}
	return value.FloatString(2)
}

func monthlyPercentText(numerator, denominator *big.Rat) string {
	if denominator == nil || denominator.Sign() == 0 {
		return "0%"
	}
	value := new(big.Rat).Quo(numerator, denominator)
	value.Mul(value, big.NewRat(100, 1))
	return value.FloatString(2) + "%"
}

func monthlyCurrencyCode(country string) string {
	switch strings.ToUpper(strings.TrimSpace(country)) {
	case "DE":
		return "EUR"
	case "UK", "GB":
		return "GBP"
	default:
		return "USD"
	}
}
