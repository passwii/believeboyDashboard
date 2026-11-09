package agent_commerce

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

const (
	xlsxContentType       = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	maxShipmentNos        = 100
	maxFBAImageBytes      = 5 * 1024 * 1024
	maxFBATotalImageBytes = 20 * 1024 * 1024
	maxFBAEmbeddedImages  = 200
	fbaImageWorkerCount   = 6
	fbaImageFetchTimeout  = 3 * time.Second
)

func (h *Handler) ExportNewProductCalculations(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	project, projectID, ok := h.verifyProject(w, r)
	if !ok {
		return
	}
	snapshotIDs, apiErr := parseSnapshotIDs(r.URL.Query()["snapshot_ids"])
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	rows, err := h.store.ListNewProductExports(r.Context(), projectID, snapshotIDs)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	if len(rows) != len(snapshotIDs) {
		found := make(map[int64]bool, len(rows))
		for _, row := range rows {
			found[row.ID] = true
		}
		missing := make([]int64, 0)
		for _, snapshotID := range snapshotIDs {
			if !found[snapshotID] {
				missing = append(missing, snapshotID)
			}
		}
		writeValidationError(w, "部分快照不存在或不属于该项目", map[string]any{
			"missing_snapshot_ids": missing,
		})
		return
	}
	ordered := orderNewProductRows(rows, snapshotIDs)
	workbook, err := buildNewProductWorkbook(ordered)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	entry := h.auditEntry(r, "new_product_calculation.export")
	entry.TargetType = "new_product_calculation"
	targetID := strconv.FormatInt(projectID, 10)
	entry.TargetID = &targetID
	entry.AfterJSON = map[string]any{
		"snapshot_ids": snapshotIDs,
		"row_count":    len(ordered),
		"column_count": len(ordered),
	}
	if err := h.store.RecordAudit(r.Context(), entry); err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	filename := fmt.Sprintf(
		"%s_新品测算对比矩阵-%s.xlsx",
		safeFilenamePart(project.Name),
		h.options.now().UTC().Format("20060102-150405Z"),
	)
	writeXLSX(w, filename, workbook)
}

func (h *Handler) ExportShopCalculations(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	project, projectID, ok := h.verifyProject(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	mode := strings.TrimSpace(query.Get("mode"))
	if mode == "" {
		mode = "current"
	}
	if mode != "current" && mode != "history" {
		writeValidationError(w, "mode 必须是 current 或 history", nil)
		return
	}
	includeUncomputed := true
	if raw, exists := query["include_uncomputed"]; exists {
		if len(raw) == 0 {
			writeValidationError(w, "include_uncomputed 必须是布尔值", nil)
			return
		}
		value, err := strconv.ParseBool(strings.TrimSpace(raw[0]))
		if err != nil {
			writeValidationError(w, "include_uncomputed 必须是布尔值", nil)
			return
		}
		includeUncomputed = value
	}
	var asOf *time.Time
	if raw := strings.TrimSpace(query.Get("as_of")); raw != "" {
		parsed, err := parseAsOf(raw)
		if err != nil {
			writeValidationError(w, "as_of 必须是 ISO 日期时间", nil)
			return
		}
		asOf = &parsed
	}
	filter := ShopExportFilter{
		Mode:              mode,
		AsOf:              asOf,
		IncludeUncomputed: includeUncomputed,
	}
	if country := strings.TrimSpace(query.Get("country")); country != "" {
		country = normalizeCountryCode(country)
		filter.Country = &country
	}
	if sku := strings.TrimSpace(query.Get("sku")); sku != "" {
		filter.SKU = &sku
	}
	data, err := h.store.ListShopExport(r.Context(), projectID, filter)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	workbook, rowCount, err := buildShopWorkbook(project.Name, data, includeUncomputed)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	entry := h.auditEntry(r, "shop_calculation.export")
	entry.TargetType = "shop_calculation"
	targetID := strconv.FormatInt(projectID, 10)
	entry.TargetID = &targetID
	entry.AfterJSON = map[string]any{
		"project_id":         projectID,
		"country":            filter.Country,
		"sku":                filter.SKU,
		"mode":               filter.Mode,
		"as_of":              query.Get("as_of"),
		"include_uncomputed": includeUncomputed,
		"row_count":          rowCount,
		"countries":          data.Countries,
	}
	if err := h.store.RecordAudit(r.Context(), entry); err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	countryPart := "全部站点"
	if filter.Country != nil {
		countryPart = *filter.Country
	}
	filename := fmt.Sprintf(
		"%s_%s-店铺SKU测算-%s.xlsx",
		safeFilenamePart(project.Name),
		safeFilenamePart(countryPart),
		h.options.now().UTC().Format("20060102-150405Z"),
	)
	writeXLSX(w, filename, workbook)
}

func (h *Handler) ExportFBABoxDetails(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	project, projectID, ok := h.verifyProject(w, r)
	if !ok {
		return
	}
	shipmentNos, apiErr := normalizeShipmentNos(r.URL.Query()["shipment_no"])
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	for _, shipmentNo := range shipmentNos {
		if _, err := h.store.ResolveShipment(r.Context(), projectID, shipmentNo); err != nil {
			writeAPIError(w, mapStoreError(err))
			return
		}
	}
	data, err := h.store.ListFBABoxDetails(r.Context(), projectID, shipmentNos)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	if len(data.Items) == 0 {
		writeAPIError(w, APIErrorWithMessage(CodeResourceNotFound, "指定货件没有可导出的 FBA 箱单明细"))
		return
	}
	images := h.loadFBABoxImages(r.Context(), data.Items)
	workbook, err := buildFBABoxWorkbook(data.Items, images)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	shipmentSegment := safeFilenamePart(shipmentNos[0])
	if len(shipmentNos) > 1 {
		firstThree := shipmentNos[:min(3, len(shipmentNos))]
		parts := make([]string, 0, len(firstThree))
		for _, shipmentNo := range firstThree {
			parts = append(parts, safeFilenamePart(shipmentNo))
		}
		shipmentSegment = strings.Join(parts, "_")
		if len(shipmentNos) > 3 {
			shipmentSegment += fmt.Sprintf("_等%d个货件", len(shipmentNos))
		}
	}
	if runeCount(shipmentSegment) > 100 {
		shipmentSegment = strings.TrimRight(truncateRunes(shipmentSegment, 100), " .-")
	}
	projectSegment := truncateRunes(safeFilenamePart(project.Name), 80)
	filename := fmt.Sprintf(
		"%s-FBA箱单明细-%s.xlsx",
		projectSegment,
		shipmentSegment,
	)
	writeXLSX(w, filename, workbook)
}

func (h *Handler) ExportFBADeliveryTemplate(w http.ResponseWriter, r *http.Request) {
	if !h.requireStore(w) {
		return
	}
	project, projectID, ok := h.verifyProject(w, r)
	if !ok {
		return
	}
	shipmentNo := strings.TrimSpace(chi.URLParam(r, "shipment_no"))
	if shipmentNo == "" || len([]rune(shipmentNo)) > 100 {
		writeValidationError(w, "shipment_no 必须是 1 到 100 个字符", nil)
		return
	}
	data, err := h.store.PrepareShipmentTemplate(r.Context(), projectID, shipmentNo)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	if data == nil || data.Detail == nil {
		writeAPIError(w, APIErrorWithMessage(CodeResourceNotFound, "排期不存在"))
		return
	}
	workbook, err := buildFBATemplateWorkbook(data)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return
	}
	filename := fmt.Sprintf(
		"%s_%s-FBA发货模板-%s.xlsx",
		safeFilenamePart(project.Name),
		safeFilenamePart(agentCommerceCountryLabelCN(data.Detail.Country)),
		safeFilenamePart(data.Detail.ShipmentNo),
	)
	writeXLSX(w, filename, workbook)
}

func buildNewProductWorkbook(rows []NewProductExportRow) ([]byte, error) {
	type metric struct {
		section string
		label   string
		style   int
		get     func(NewProductExportRow) any
	}
	number := func(value float64) any { return value }
	text := func(value string) any {
		if strings.TrimSpace(value) == "" {
			return "-"
		}
		return value
	}
	calculationLabel := func(value string) string {
		switch value {
		case "profit_calc":
			return "利润核算"
		case "profit_reverse":
			return "利润倒算"
		case "cost_reverse":
			return "成本倒推"
		case "fbm_calc":
			return "FBM测算"
		default:
			return value
		}
	}
	packaging := func(row NewProductExportRow) string {
		return fmt.Sprintf("%s × %s × %s", numberText(row.PackageLengthCM), numberText(row.PackageWidthCM), numberText(row.PackageHeightCM))
	}
	dimensions := func(row NewProductExportRow) string {
		return fmt.Sprintf(
			"%s × %s × %s",
			numberText(row.LongestSideIn),
			numberText(row.MiddleSideIn),
			numberText(row.ShortestSideIn),
		)
	}
	commissionRate := func(row NewProductExportRow) any {
		if row.SalePriceUSD == 0 {
			return "-"
		}
		return row.ReferralFeeUSD / row.SalePriceUSD
	}
	metrics := []metric{
		{"货品数据", "产品名称", xlsxStyleNormal, func(row NewProductExportRow) any { return row.ProjectName + " / " + row.SKU }},
		{"货品数据", "SKU", xlsxStyleNormal, func(row NewProductExportRow) any { return row.SKU }},
		{"货品数据", "国家站点", xlsxStyleNormal, func(row NewProductExportRow) any { return text(row.Country) }},
		{"货品数据", "测算时间", xlsxStyleNormal, func(row NewProductExportRow) any { return row.CreatedAt.UTC().Format(time.RFC3339) }},
		{"货品数据", "竞品链接", xlsxStyleNormal, func(_ NewProductExportRow) any { return "-" }},
		{"货品数据", "测算类型", xlsxStyleNormal, func(row NewProductExportRow) any { return text(calculationLabel(row.CalculationType)) }},
		{"货品数据", "包装尺寸(cm)", xlsxStyleNormal, func(row NewProductExportRow) any { return packaging(row) }},
		{"货品数据", "重量(kg)", xlsxStyleNumber, func(row NewProductExportRow) any { return number(row.WeightKG) }},
		{"货品数据", "体积(in³)", xlsxStyleNumber, func(row NewProductExportRow) any { return number(row.VolumeCubicIn) }},
		{"货品数据", "体积(ft³)", xlsxStyleNumber, func(row NewProductExportRow) any { return number(row.VolumeCubicFt) }},
		{"DDP 成本", "FOB成本", xlsxStyleRMB, func(row NewProductExportRow) any { return row.FOBProductCostRMB }},
		{"DDP 成本", "头程", xlsxStyleRMB, func(row NewProductExportRow) any { return row.FirstLegCostRMB }},
		{"DDP 成本", "DDP(RMB)", xlsxStyleRMB, func(row NewProductExportRow) any { return row.DDPCostRMB }},
		{"DDP 成本", "DDP(USD)", xlsxStyleUSD, func(row NewProductExportRow) any { return row.DDPCostUSD }},
		{"DDP 成本", "头程单价(RMB/kg)", xlsxStyleRMB, func(_ NewProductExportRow) any { return "-" }},
		{"DDP 成本", "头程数量", xlsxStyleNumber, func(_ NewProductExportRow) any { return "-" }},
		{"费用支出", "平台佣金", xlsxStyleUSD, func(row NewProductExportRow) any { return row.ReferralFeeUSD }},
		{"费用支出", "平台佣金率", xlsxStylePercent, func(row NewProductExportRow) any { return commissionRate(row) }},
		{"费用支出", "广告费", xlsxStyleUSD, func(row NewProductExportRow) any { return row.AdvertisingFeeUSD }},
		{"费用支出", "广告费率", xlsxStylePercent, func(row NewProductExportRow) any { return row.AdvertisingRate }},
		{"费用支出", "派送", xlsxStyleUSD, func(row NewProductExportRow) any { return row.FBAFulfillmentFeeUSD }},
		{"费用支出", "配置费", xlsxStyleUSD, func(row NewProductExportRow) any { return row.InboundConfigFeeUSD }},
		{"费用支出", "仓储费", xlsxStyleUSD, func(row NewProductExportRow) any { return row.StorageFeeUSD }},
		{"费用支出", "仓储月数", xlsxStyleNumber, func(row NewProductExportRow) any { return row.StorageMonths }},
		{"费用支出", "退货损耗", xlsxStyleUSD, func(row NewProductExportRow) any { return row.ReturnLossUSD }},
		{"费用支出", "退货折损率", xlsxStylePercent, func(row NewProductExportRow) any { return row.ReturnLossRate }},
		{"费用支出", "费用合计", xlsxStyleUSD, func(row NewProductExportRow) any { return row.TotalFeeUSD }},
		{"售价与利润", "售价", xlsxStyleUSD, func(row NewProductExportRow) any { return row.SalePriceUSD }},
		{"售价与利润", "回款", xlsxStyleUSD, func(row NewProductExportRow) any { return row.PayoutUSD }},
		{"售价与利润", "利润", xlsxStyleUSD, func(row NewProductExportRow) any { return row.ProfitUSD }},
		{"售价与利润", "利润率", xlsxStylePercent, func(row NewProductExportRow) any { return row.ProfitRate }},
		{"核算规则", "尺寸等级", xlsxStyleNormal, func(row NewProductExportRow) any { return text(row.SizeTierLabel) }},
		{"核算规则", "售价带", xlsxStyleNormal, func(row NewProductExportRow) any { return text(row.PriceBandLabel) }},
		{"核算规则", "计费重(lb)", xlsxStyleNumber, func(row NewProductExportRow) any { return row.ChargeableWeightLB }},
		{"核算规则", "体积(ft³)", xlsxStyleNumber, func(row NewProductExportRow) any { return row.VolumeCubicFt }},
		{"核算规则", "派送规则", xlsxStyleNormal, func(row NewProductExportRow) any { return text(row.FulfillmentFeeRuleLabel) }},
		{"核算规则", "入库配置", xlsxStyleNormal, func(row NewProductExportRow) any { return text(row.InboundConfigFeeRuleLabel) }},
		{"核算规则", "仓储规则", xlsxStyleNormal, func(row NewProductExportRow) any { return text(row.StorageFeeRuleLabel) }},
		{"核算规则", "汇率", xlsxStyleNumber, func(row NewProductExportRow) any { return row.USDToRMBRate }},
		{"核算规则", "计费重规则", xlsxStyleNormal, func(row NewProductExportRow) any { return text(row.ChargeableWeightRule) }},
		{"核算规则", "产品重(lb)", xlsxStyleNumber, func(row NewProductExportRow) any { return row.ProductWeightLB }},
		{"核算规则", "体积重(lb)", xlsxStyleNumber, func(row NewProductExportRow) any { return row.DimensionalWeightLB }},
		{"核算规则", "尺寸(in)", xlsxStyleNormal, func(row NewProductExportRow) any { return dimensions(row) }},
	}
	header := []xlsxCell{
		{Value: "指标", Style: xlsxStyleHeader},
		{Value: "子项", Style: xlsxStyleHeader},
	}
	for _, row := range rows {
		header = append(header, xlsxCell{Value: row.ProjectName + " / " + row.SKU, Style: xlsxStyleHeader})
	}
	outputRows := [][]xlsxCell{header}
	for _, item := range metrics {
		out := []xlsxCell{
			{Value: item.section, Style: xlsxStyleWrap},
			{Value: item.label, Style: xlsxStyleWrap},
		}
		for _, row := range rows {
			out = append(out, xlsxCell{Value: item.get(row), Style: item.style})
		}
		outputRows = append(outputRows, out)
	}
	return newXLSXSheets([]xlsxSheet{{Name: "测算对比矩阵", Rows: outputRows}})
}

func buildShopWorkbook(projectName string, data ShopExportData, includeUncomputed bool) ([]byte, int, error) {
	type sheetRows struct {
		country string
		rows    [][]xlsxCell
	}
	byCountry := make(map[string][][]any)
	calculatedKeys := make(map[string]bool)
	masters := make(map[string]ShopExportMaster, len(data.Masters))
	for _, master := range data.Masters {
		key := master.SKU + "\x00" + strings.ToUpper(master.Country)
		masters[key] = master
	}
	for _, row := range data.Calculations {
		country := strings.ToUpper(strings.TrimSpace(row.Country))
		key := row.SKU + "\x00" + country
		calculatedKeys[key] = true
		master, hasMaster := masters[key]
		byCountry[country] = append(byCountry[country], shopValues(row, master, hasMaster, country))
	}
	if includeUncomputed {
		for _, master := range data.Masters {
			country := strings.ToUpper(strings.TrimSpace(master.Country))
			key := master.SKU + "\x00" + country
			if calculatedKeys[key] {
				continue
			}
			byCountry[country] = append(byCountry[country], shopValues(ShopExportRow{}, master, true, country))
		}
	}
	if len(byCountry) == 0 {
		byCountry["US"] = [][]any{}
	}
	sheets := make([]xlsxSheet, 0, len(byCountry))
	countries := make([]string, 0, len(byCountry))
	for country := range byCountry {
		countries = append(countries, country)
	}
	sortStrings(countries)
	rowCount := 0
	for _, country := range countries {
		entries := byCountry[country]
		rowCount += len(entries)
		if rowCount > maxExportRows {
			return nil, 0, ErrExportTooLarge
		}
		headers := shopHeaders(country)
		headerRow := make([]xlsxCell, len(headers))
		for index, header := range headers {
			headerRow[index] = xlsxCell{Value: header, Style: xlsxStyleHeader}
		}
		rows := [][]xlsxCell{
			{{Value: fmt.Sprintf("%s店铺SKU测算表 - %s", country, projectName), Style: xlsxStyleTitle}},
			headerRow,
		}
		for _, values := range entries {
			row := make([]xlsxCell, len(values))
			for index, value := range values {
				style := xlsxStyleNormal
				switch value.(type) {
				case float64:
					style = xlsxStyleNumber
				case int:
					style = xlsxStyleInteger
				}
				if index == percentageColumn(headers) {
					style = xlsxStylePercent
				}
				row[index] = xlsxCell{Value: value, Style: style}
			}
			rows = append(rows, row)
		}
		sheets = append(sheets, xlsxSheet{Name: country + "店铺SKU测算", Rows: rows})
	}
	content, err := newXLSXSheets(sheets)
	return content, rowCount, err
}

func shopValues(row ShopExportRow, master ShopExportMaster, hasMaster bool, country string) []any {
	sku := row.SKU
	if sku == "" {
		sku = master.SKU
	}
	fob := row.FOBProductCostRMB
	length := row.PackageLengthCM
	width := row.PackageWidthCM
	height := row.PackageHeightCM
	weight := row.WeightKG
	firstLeg := row.FirstLegCostRMB
	if hasMaster {
		fob = master.FOBUnitCost
		length = master.PackageLengthCM
		width = master.PackageWidthCM
		height = master.PackageHeightCM
		weight = master.WeightKG
		firstLeg = master.FirstLegCostRMB
	}
	chargeable := math.Max(weight, length*width*height/6000)
	basic := []any{
		sku,
		fob,
		length,
		width,
		height,
		weight,
		chargeable,
		firstLeg,
	}
	hasCalculation := row.SKU != ""
	if !hasCalculation {
		trace := []any{
			firstNonEmpty(nil, master.ASIN),
			nil,
			nil,
			"未核算/缺数据",
		}
		if country == "US" {
			return append(append(basic, make([]any, 20)...), trace...)
		}
		return append(append(basic, make([]any, 17)...), trace...)
	}
	trace := []any{
		firstNonEmpty(row.ASIN, master.ASIN),
		row.Source,
		formatOptionalTime(row.ObservedAt),
		strings.Join(row.Warnings, "; "),
	}
	if country == "US" {
		return append(basic,
			row.DDPCostRMB,
			row.DDPCostUSD,
			row.USDToRMBRate,
			row.SalePriceUSD,
			row.AdvertisingRate*100,
			row.AdvertisingFeeUSD,
			row.ReturnLossRate*100,
			row.ReturnLossUSD,
			row.ReferralFeeUSD,
			row.FBAFulfillmentFeeUSD,
			row.InboundConfigFeeUSD,
			row.StorageMonths,
			row.StorageFeeUSD,
			row.TotalFeeUSD,
			row.PayoutUSD,
			row.ProfitUSD,
			row.ProfitRate,
			row.SizeTierLabel,
			row.PriceBandLabel,
			fmt.Sprintf("%s / %s / %s", row.FulfillmentFeeRuleLabel, row.InboundConfigFeeRuleLabel, row.StorageFeeRuleLabel),
			trace[0], trace[1], trace[2], trace[3],
		)
	}
	profitAfterVAT := row.ProfitUSD
	if row.ProfitAfterVATUSD != nil {
		profitAfterVAT = *row.ProfitAfterVATUSD
	}
	profitRateAfterVAT := row.ProfitRate
	if row.ProfitAfterVATRate != nil {
		profitRateAfterVAT = *row.ProfitAfterVATRate
	}
	return append(basic,
		row.DDPCostRMB,
		row.DDPCostUSD,
		row.USDToRMBRate,
		row.SalePriceUSD,
		row.PlatformFeeUSD,
		row.AdvertisingRate*100,
		row.AdvertisingFeeUSD,
		row.ReturnLossRate*100,
		row.ReturnLossUSD,
		row.DeliveryFeeUSD,
		row.InboundConfigFeeManualUSD,
		row.StorageFeeManualUSD,
		row.TotalFeeUSD,
		row.PayoutUSD,
		row.VATUSD,
		profitAfterVAT,
		profitRateAfterVAT,
		trace[0], trace[1], trace[2], trace[3],
	)
}

func shopHeaders(country string) []string {
	base := []string{
		"SKU", "FOB(RMB)", "长", "宽", "高", "重量(kg)", "计费重", "头程(RMB)",
	}
	var headers []string
	if country == "US" {
		headers = []string{
			"DDP(RMB)", "DDP(USD)", "汇率", "售价(USD)", "广告费率%", "广告费",
			"退货折损率%", "退货损耗", "佣金", "派送费", "配置费", "仓储月数",
			"仓储费", "费用合计", "回款", "利润", "利润率", "尺寸等级", "售价带", "规则",
		}
	} else {
		currency := "USD"
		switch country {
		case "DE":
			currency = "EUR"
		case "UK":
			currency = "GBP"
		}
		headers = []string{
			"DDP(RMB)", fmt.Sprintf("DDP(%s)", currency), "汇率", fmt.Sprintf("售价(%s)", currency),
			"平台佣金", "广告费率%", "广告费", "退货率%", "退货损失", "派送费", "配置费",
			"仓储费", "费用合计", "回款", "增值税", "利润(扣税后)", "利润率(扣税)",
		}
	}
	return append(append(base, headers...), "ASIN", "source", "observed_at", "warnings")
}

func percentageColumn(headers []string) int {
	for index, header := range headers {
		if header == "利润率" || header == "利润率(扣税)" {
			return index
		}
	}
	return -1
}

type fbaImageTask struct {
	index int
	key   string
}

type fbaImageResult struct {
	index int
	data  []byte
}

func (h *Handler) loadFBABoxImages(
	ctx context.Context,
	items []FBABoxItem,
) map[int][]byte {
	reader, ok := h.options.Blobs.(BlobReader)
	if !ok || reader == nil {
		return nil
	}
	itemKeys := make([]string, len(items))
	tasks := make([]fbaImageTask, 0, maxFBAEmbeddedImages)
	seen := make(map[string]bool)
	for itemIndex, item := range items {
		key := fbaProductImageKey(item)
		itemKeys[itemIndex] = key
		if key == "" || seen[key] || len(tasks) >= maxFBAEmbeddedImages {
			continue
		}
		seen[key] = true
		tasks = append(tasks, fbaImageTask{index: len(tasks), key: key})
	}
	if len(tasks) == 0 {
		return nil
	}

	results := make([]fbaImageResult, len(tasks))
	jobs := make(chan fbaImageTask)
	output := make(chan fbaImageResult, len(tasks))
	var workers sync.WaitGroup
	workerCount := min(fbaImageWorkerCount, len(tasks))
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for task := range jobs {
				output <- fbaImageResult{
					index: task.index,
					data:  fetchFBAImage(ctx, reader, task.key),
				}
			}
		}()
	}
	go func() {
		for _, task := range tasks {
			jobs <- task
		}
		close(jobs)
		workers.Wait()
		close(output)
	}()
	for result := range output {
		results[result.index] = result
	}

	byKey := make(map[string][]byte, len(tasks))
	var totalBytes int64
	for _, task := range tasks {
		result := results[task.index]
		if len(result.data) == 0 {
			continue
		}
		if totalBytes+int64(len(result.data)) > maxFBATotalImageBytes {
			break
		}
		totalBytes += int64(len(result.data))
		byKey[task.key] = result.data
	}
	if len(byKey) == 0 {
		return nil
	}
	images := make(map[int][]byte, len(items))
	for itemIndex, key := range itemKeys {
		if data := byKey[key]; len(data) > 0 {
			images[itemIndex] = data
		}
	}
	return images
}

func fbaProductImageKey(item FBABoxItem) string {
	if item.ProductImageThumbnailR2Key != nil &&
		strings.TrimSpace(*item.ProductImageThumbnailR2Key) != "" {
		return strings.TrimSpace(*item.ProductImageThumbnailR2Key)
	}
	if item.ProductImageR2Key != nil &&
		strings.TrimSpace(*item.ProductImageR2Key) != "" {
		return strings.TrimSpace(*item.ProductImageR2Key)
	}
	return ""
}

func fetchFBAImage(
	ctx context.Context,
	reader BlobReader,
	key string,
) []byte {
	fetchContext, cancel := context.WithTimeout(ctx, fbaImageFetchTimeout)
	defer cancel()
	body, err := reader.Get(fetchContext, key)
	if err != nil || body == nil {
		if body != nil {
			_ = body.Close()
		}
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(body, maxFBAImageBytes+1))
	_ = body.Close()
	if err != nil || len(data) == 0 || len(data) > maxFBAImageBytes {
		return nil
	}
	normalized, ok := normalizeXLSXImage(data)
	if !ok {
		return nil
	}
	return normalized
}

func buildFBABoxWorkbook(
	items []FBABoxItem,
	images map[int][]byte,
) ([]byte, error) {
	headers := []string{
		"货件编号", "追踪 ID", "仓库 ID", "SKU", "品名", "产品图片", "ASIN", "FNSKU",
		"外箱长(cm)", "外箱宽(cm)", "外箱高(cm)", "外箱重量(kg)", "装箱率", "总箱数",
		"标签号段", "总数量", "总体积(m³)", "总重量(kg)",
	}
	row := make([]xlsxCell, len(headers))
	for index, header := range headers {
		row[index] = xlsxCell{Value: header, Style: xlsxStyleHeader}
	}
	rows := [][]xlsxCell{row}
	sheetImages := make([]xlsxImage, 0, len(items))
	rowHeights := make(map[int]int, len(items)+1)
	counters := make(map[string]int)
	var totalCartons, totalQuantity int
	var totalVolume, totalWeight float64
	for itemIndex, item := range items {
		cartonCount := item.CartonCount
		start := counters[item.ShipmentNo]
		if start == 0 {
			start = 1
		}
		prefix := item.FBALabelPrefix
		if prefix == "" {
			prefix = item.ShipmentNo
		}
		labelRange := "-"
		if cartonCount > 0 {
			end := start + cartonCount - 1
			labelRange = fmt.Sprintf("%sU000%03d-%03d", prefix, start, end)
			counters[item.ShipmentNo] = end + 1
		}
		totalCartons += cartonCount
		totalQuantity += item.Quantity
		totalVolume += item.TotalVolumeM3
		totalWeight += item.TotalWeightKG
		unitsText := "-"
		if item.UnitsPerCarton > 0 {
			unitsText = fmt.Sprintf("%d / 箱", item.UnitsPerCarton)
		}
		imageCell := firstNonEmpty(item.ProductImageThumbnailR2URL, item.ProductImageR2URL)
		if data := images[itemIndex]; len(data) > 0 {
			imageCell = nil
			sheetImages = append(sheetImages, xlsxImage{
				Row:    len(rows) + 1,
				Column: 6,
				Data:   data,
			})
		}
		row = []xlsxCell{
			{Value: item.ShipmentNo, Style: xlsxStyleNormal},
			{Value: firstNonEmpty(item.TrackingNo, nil), Style: xlsxStyleNormal},
			{Value: firstNonEmpty(item.WarehouseCode, nil), Style: xlsxStyleNormal},
			{Value: item.SKU, Style: xlsxStyleNormal},
			{Value: firstNonEmpty(item.ProductName, nil), Style: xlsxStyleNormal},
			{Value: imageCell, Style: xlsxStyleNormal},
			{Value: firstNonEmpty(item.ASIN, nil), Style: xlsxStyleNormal},
			{Value: firstNonEmpty(item.FNSKU, nil), Style: xlsxStyleNormal},
			{Value: positiveNumberOrDash(item.LengthCM), Style: xlsxStyleNumber},
			{Value: positiveNumberOrDash(item.WidthCM), Style: xlsxStyleNumber},
			{Value: positiveNumberOrDash(item.HeightCM), Style: xlsxStyleNumber},
			{Value: positiveNumberOrDash(derefFloat(item.CartonWeightKG)), Style: xlsxStyleNumber},
			{Value: unitsText, Style: xlsxStyleNormal},
			{Value: item.CartonCount, Style: xlsxStyleInteger},
			{Value: labelRange, Style: xlsxStyleNormal},
			{Value: item.Quantity, Style: xlsxStyleInteger},
			{Value: item.TotalVolumeM3, Style: xlsxStyleNumber},
			{Value: item.TotalWeightKG, Style: xlsxStyleNumber},
		}
		rows = append(rows, row)
		rowHeights[len(rows)] = 75
	}
	totalRow := make([]xlsxCell, len(headers))
	totalRow[0] = xlsxCell{Value: "合计", Style: xlsxStyleHeader}
	totalRow[13] = xlsxCell{Value: totalCartons, Style: xlsxStyleInteger}
	totalRow[15] = xlsxCell{Value: totalQuantity, Style: xlsxStyleInteger}
	totalRow[16] = xlsxCell{Value: round(totalVolume, 4), Style: xlsxStyleNumber}
	totalRow[17] = xlsxCell{Value: round(totalWeight, 2), Style: xlsxStyleNumber}
	rows = append(rows, totalRow)
	rowHeights[len(rows)] = 22
	return newXLSXSheets([]xlsxSheet{{
		Name:         "FBA箱单明细",
		Rows:         rows,
		Images:       sheetImages,
		ColumnWidths: map[int]int{4: 12, 6: 16},
		RowHeights:   rowHeights,
	}})
}

func buildFBATemplateWorkbook(data *ShipmentTemplateData) ([]byte, error) {
	country := strings.ToUpper(strings.TrimSpace(data.Detail.Country))
	useMetric := country == "DE" || country == "UK"
	lengthUnit := "in"
	weightUnit := "lb"
	if useMetric {
		lengthUnit = "cm"
		weightUnit = "kg"
	}
	headers := []string{
		"Merchant SKU", "Quantity", "Units per box", "Number of boxes",
		"Box length (" + lengthUnit + ")", "Box width (" + lengthUnit + ")",
		"Box height (" + lengthUnit + ")", "Box weight (" + weightUnit + ")",
	}
	rows := [][]xlsxCell{
		{{Value: "Default prep owner", Style: xlsxStyleNormal}, {Value: "Seller", Style: xlsxStyleNormal}},
		{{Value: "Default labeling owner", Style: xlsxStyleNormal}, {Value: "Seller", Style: xlsxStyleNormal}},
	}
	headerRow := make([]xlsxCell, len(headers))
	for index, header := range headers {
		headerRow[index] = xlsxCell{Value: header, Style: xlsxStyleHeader}
	}
	rows = append(rows, headerRow)
	for _, item := range data.Detail.Items {
		carton := data.Cartons[item.SKU]
		length, width, height, weight := carton.CartonLengthCM, carton.CartonWidthCM, carton.CartonHeightCM, carton.CartonWeightKG
		if !useMetric {
			length /= 2.54
			width /= 2.54
			height /= 2.54
			weight *= 2.20462
		}
		cartonCount := 0
		if item.CartonCount != nil {
			cartonCount = *item.CartonCount
		}
		rows = append(rows, []xlsxCell{
			{Value: item.SKU, Style: xlsxStyleNormal},
			{Value: item.Quantity, Style: xlsxStyleInteger},
			{Value: positiveIntOrNil(carton.UnitsPerCarton), Style: xlsxStyleInteger},
			{Value: positiveIntOrNil(cartonCount), Style: xlsxStyleInteger},
			{Value: positiveNumberOrNil(round(length, 2)), Style: xlsxStyleNumber},
			{Value: positiveNumberOrNil(round(width, 2)), Style: xlsxStyleNumber},
			{Value: positiveNumberOrNil(round(height, 2)), Style: xlsxStyleNumber},
			{Value: positiveNumberOrNil(round(weight, 2)), Style: xlsxStyleNumber},
		})
	}
	return newXLSXSheets([]xlsxSheet{{Name: "Create workflow – template", Rows: rows}})
}

func parseSnapshotIDs(values []string) ([]int64, *APIError) {
	result := make([]int64, 0, len(values))
	seen := make(map[int64]bool, len(values))
	for _, raw := range values {
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			id, err := strconv.ParseInt(part, 10, 64)
			if err != nil || id < 1 {
				return nil, validationError("snapshot_ids 必须为正整数")
			}
			if seen[id] {
				return nil, validationError("snapshot_ids 不允许重复")
			}
			seen[id] = true
			result = append(result, id)
		}
	}
	if len(result) == 0 {
		return nil, validationError("snapshot_ids 必填")
	}
	if len(result) > 12 {
		return nil, validationError("snapshot_ids 最多 12 条")
	}
	return result, nil
}

func normalizeShipmentNos(values []string) ([]string, *APIError) {
	result := make([]string, 0, len(values))
	seen := make(map[string]bool)
	for _, raw := range values {
		for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
			return r == ',' || r == '\n'
		}) {
			value := truncateRunes(strings.TrimSpace(part), 100)
			if value == "" || seen[value] {
				continue
			}
			seen[value] = true
			result = append(result, value)
		}
	}
	if len(values) > maxShipmentNos || len(result) > maxShipmentNos {
		return nil, validationError("shipment_no 最多支持 100 个货件")
	}
	if len(result) == 0 {
		return nil, validationError("shipment_no 至少需要一个有效货件编号")
	}
	return result, nil
}

func parseAsOf(raw string) (time.Time, error) {
	if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return parsed.UTC(), nil
	}
	for _, layout := range []string{
		"2006-01-02",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05.999999999",
		"2006-01-02 15:04:05.999999999",
	} {
		if parsed, err := time.ParseInLocation(layout, raw, time.UTC); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid as_of")
}

func writeXLSX(w http.ResponseWriter, filename string, content []byte) {
	w.Header().Set("Content-Type", xlsxContentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(
		`attachment; filename="%s"; filename*=UTF-8''%s`,
		asciiFilename(filename),
		url.PathEscape(filename),
	))
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func asciiFilename(filename string) string {
	var builder strings.Builder
	for _, character := range filename {
		if character >= 0x20 && character <= 0x7e && character != '"' && character != '\\' {
			builder.WriteRune(character)
		} else {
			builder.WriteByte('_')
		}
	}
	if builder.Len() == 0 {
		return "export.xlsx"
	}
	return builder.String()
}

func safeFilenamePart(value string) string {
	value = strings.TrimSpace(value)
	var builder strings.Builder
	for _, character := range value {
		switch character {
		case '\\', '/', ':', '*', '?', '"', '<', '>', '|', '\r', '\n', '\x00':
			builder.WriteByte('-')
		default:
			if character < 0x20 || character == 0x7f {
				builder.WriteByte('-')
				continue
			}
			builder.WriteRune(character)
		}
	}
	result := strings.Trim(builder.String(), " .-")
	if result == "" {
		result = "未命名"
	}
	if runeCount(result) > 120 {
		result = truncateRunes(result, 120)
	}
	return result
}

func agentCommerceCountryLabelCN(country string) string {
	switch strings.ToUpper(strings.TrimSpace(country)) {
	case "US":
		return "美国站"
	case "DE":
		return "德国站"
	case "UK", "GB":
		return "英国站"
	case "JP":
		return "日本站"
	case "FR":
		return "法国站"
	case "IT":
		return "意大利站"
	case "ES":
		return "西班牙站"
	case "CA":
		return "加拿大站"
	case "MX":
		return "墨西哥站"
	case "AU":
		return "澳大利亚站"
	default:
		return strings.ToUpper(strings.TrimSpace(country))
	}
}

func orderNewProductRows(rows []NewProductExportRow, ids []int64) []NewProductExportRow {
	byID := make(map[int64]NewProductExportRow, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	result := make([]NewProductExportRow, 0, len(ids))
	for _, id := range ids {
		result = append(result, byID[id])
	}
	return result
}

func numberText(value float64) string {
	if value == 0 {
		return "0"
	}
	if value == math.Trunc(value) {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func firstNonEmpty(primary, fallback *string) any {
	if primary != nil && strings.TrimSpace(*primary) != "" {
		return strings.TrimSpace(*primary)
	}
	if fallback != nil && strings.TrimSpace(*fallback) != "" {
		return strings.TrimSpace(*fallback)
	}
	return "-"
}

func formatOptionalTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UTC().Format(time.RFC3339)
}

func positiveNumberOrDash(value float64) any {
	if value <= 0 {
		return "-"
	}
	return round(value, 2)
}

func positiveNumberOrNil(value float64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func positiveIntOrNil(value int) any {
	if value <= 0 {
		return nil
	}
	return value
}

func derefFloat(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

func round(value float64, digits int) float64 {
	scale := math.Pow10(digits)
	return math.Round(value*scale) / scale
}

func sortStrings(values []string) {
	for left := 0; left < len(values); left++ {
		for right := left + 1; right < len(values); right++ {
			if values[right] < values[left] {
				values[left], values[right] = values[right], values[left]
			}
		}
	}
}
