package store

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

type parsedCategoryResearch struct {
	Products        []parsedCategoryProduct
	Trends          []parsedCategoryTrend
	QualityWarnings map[string]any
}

type parsedCategoryProduct struct {
	SourceRowNo             int
	ASIN                    *string
	ParentASIN              *string
	ProductName             *string
	Brand                   *string
	Seller                  *string
	PriceUSD                *float64
	MonthlySales            int
	MonthlyRevenueUSD       *float64
	Rating                  *float64
	ReviewCount             int
	LaunchDate              *string
	ListingAgeDays          *int
	FBAPriceUSD             *float64
	FulfillmentMethod       *string
	BBXSellerAttribute      *string
	VariantCount            *int
	HasMainImageVideo       *bool
	IsClimatePledgeFriendly *bool
	HasBrandStore           *bool
	SellerCountryRegion     *string
	IsAmazon                bool
	IsNew90d                bool
	ExtractedDimensions     map[string]string
	RawRow                  map[string]any
}

type parsedCategoryTrend struct {
	SourceRowNo int
	ASIN        string
	ParentASIN  *string
	YearMonth   string
	MonthlySale int
	RawRow      map[string]any
}

type xlsxRowData struct {
	Number int
	Values []string
}

type xlsxSheetData struct {
	Name string
	Rows []xlsxRowData
}

const maxCategoryXLSXPartBytes = 64 * 1024 * 1024

var categoryProductAliases = map[string][]string{
	"asin":                       {"ASIN", "Asin"},
	"parent_asin":                {"Parent ASIN", "ParentAsin", "父ASIN"},
	"product_name":               {"Product Name", "产品名称", "名称", "Name"},
	"brand":                      {"Brand", "品牌"},
	"seller":                     {"Seller", "卖家", "Seller Name"},
	"price":                      {"实际价格($)", "目前销售价($)", "价格($)", "Price"},
	"monthly_sales":              {"月销量", "Monthly Sales", "MonthlySales", "销量"},
	"monthly_revenue":            {"月销售额", "Monthly Revenue", "MonthlyRevenue", "销售额"},
	"rating":                     {"评分星级", "星级", "Rating"},
	"review_count":               {"评价数量", "Review Count", "Reviews"},
	"launch_date":                {"上架时间", "Launch Date"},
	"listing_age_days":           {"上架天数", "Listing Age Days"},
	"fulfillment_method":         {"物流方式", "Fulfillment", "配送方式"},
	"fba_fee":                    {"FBA费用($)", "FBA费用"},
	"bbx_seller_attribute":       {"BBX卖家属性", "卖家属性"},
	"variant_count":              {"变体数量", "Variations", "Variation Count", "Variation Count Total"},
	"has_main_image_video":       {"主图视频", "Main Image Video", "Has Main Image Video"},
	"is_climate_pledge_friendly": {"是否气候承诺友好标", "气候承诺友好标", "Climate Pledge Friendly"},
	"has_brand_store":            {"是否做品牌旗舰店", "品牌旗舰店", "Brand Store", "Has Brand Store"},
	"seller_country_region":      {"国籍/地区", "国家/地区", "Country/Region", "Seller Country/Region"},
	"blade_material":             {"Blade Material", "刀片材质", "刀片材料"},
	"product_material":           {"Material", "材质", "产品材质"},
	"color":                      {"Color", "颜色"},
	"size":                       {"Size", "尺寸", "规格"},
}

var categoryTrendAliases = map[string][]string{
	"asin":          {"ASIN", "Asin"},
	"parent_asin":   {"Parent ASIN", "ParentAsin"},
	"year_month":    {"Year-Month", "年月", "Month", "YearMonth"},
	"monthly_sales": {"月销量", "Monthly Sales", "MonthlySales", "销量"},
}

type categoryResearchParseState struct {
	result parsedCategoryResearch

	invalidPriceCount int
	invalidFBACount   int
	duplicateASINs    int
	duplicateTrends   int
	seenASINs         map[string]struct{}
	seenTrends        map[string]struct{}
	productASINs      map[string]struct{}
	trendASINs        map[string]struct{}
}

func newCategoryResearchParseState() *categoryResearchParseState {
	return &categoryResearchParseState{
		result: parsedCategoryResearch{
			Products:        []parsedCategoryProduct{},
			Trends:          []parsedCategoryTrend{},
			QualityWarnings: map[string]any{},
		},
		seenASINs:    make(map[string]struct{}),
		seenTrends:   make(map[string]struct{}),
		productASINs: make(map[string]struct{}),
		trendASINs:   make(map[string]struct{}),
	}
}

func (s *categoryResearchParseState) finalize() (*parsedCategoryResearch, error) {
	missingTrends := 0
	for asin := range s.productASINs {
		if _, ok := s.trendASINs[asin]; !ok {
			missingTrends++
		}
	}
	s.result.QualityWarnings = map[string]any{
		"invalid_price_count":          s.invalidPriceCount,
		"invalid_fba_fee_count":        s.invalidFBACount,
		"duplicate_asin_count":         s.duplicateASINs,
		"duplicate_trend_count":        s.duplicateTrends,
		"missing_trend_for_asin_count": missingTrends,
	}
	if len(s.result.Products) == 0 && len(s.result.Trends) == 0 {
		return nil, errors.New("文件中没有可识别的产品明细或趋势明细")
	}
	return &s.result, nil
}

func (s *categoryResearchParseState) parseProduct(headers map[string]int, row xlsxRowData) {
	asin := normalizeASIN(cellValue(headers, row.Values, "asin"))
	if asin == "" {
		return
	}
	if _, exists := s.seenASINs[asin]; exists {
		s.duplicateASINs++
	} else {
		s.seenASINs[asin] = struct{}{}
	}
	s.productASINs[asin] = struct{}{}

	price, priceValid := parseOptionalFloat(cellValue(headers, row.Values, "price"))
	if !priceValid {
		s.invalidPriceCount++
	}
	fbaFee, fbaValid := parseOptionalFloat(cellValue(headers, row.Values, "fba_fee"))
	if !fbaValid {
		s.invalidFBACount++
	}

	monthlyRevenue, _ := parseOptionalFloat(cellValue(headers, row.Values, "monthly_revenue"))
	rating, _ := parseOptionalFloat(cellValue(headers, row.Values, "rating"))
	launchDate := normalizeDateValue(cellValue(headers, row.Values, "launch_date"))
	listingAge := parseOptionalInt(cellValue(headers, row.Values, "listing_age_days"))
	variantCount := parseOptionalInt(cellValue(headers, row.Values, "variant_count"))
	mainImageVideo := parseOptionalBool(cellValue(headers, row.Values, "has_main_image_video"))
	climateFriendly := parseOptionalBool(cellValue(headers, row.Values, "is_climate_pledge_friendly"))
	brandStore := parseOptionalBool(cellValue(headers, row.Values, "has_brand_store"))
	seller := normalizeOptionalText(cellValue(headers, row.Values, "seller"))
	bbxAttribute := normalizeOptionalText(cellValue(headers, row.Values, "bbx_seller_attribute"))
	dimensions := make(map[string]string)
	for _, key := range []string{"blade_material", "product_material", "color", "size"} {
		if value := normalizeOptionalText(cellValue(headers, row.Values, key)); value != nil {
			dimensions[key] = *value
		}
	}

	rawRow := make(map[string]any)
	for idx, header := range headerNames(headers) {
		if header == "" || idx >= len(row.Values) || strings.TrimSpace(row.Values[idx]) == "" {
			continue
		}
		rawRow[header] = row.Values[idx]
	}

	s.result.Products = append(s.result.Products, parsedCategoryProduct{
		SourceRowNo:             row.Number,
		ASIN:                    categoryStringPtr(asin),
		ParentASIN:              normalizeOptionalASIN(cellValue(headers, row.Values, "parent_asin")),
		ProductName:             normalizeOptionalText(cellValue(headers, row.Values, "product_name")),
		Brand:                   normalizeOptionalText(cellValue(headers, row.Values, "brand")),
		Seller:                  seller,
		PriceUSD:                price,
		MonthlySales:            parseInt(cellValue(headers, row.Values, "monthly_sales")),
		MonthlyRevenueUSD:       monthlyRevenue,
		Rating:                  rating,
		ReviewCount:             parseInt(cellValue(headers, row.Values, "review_count")),
		LaunchDate:              launchDate,
		ListingAgeDays:          listingAge,
		FBAPriceUSD:             fbaFee,
		FulfillmentMethod:       normalizeOptionalText(cellValue(headers, row.Values, "fulfillment_method")),
		BBXSellerAttribute:      bbxAttribute,
		VariantCount:            variantCount,
		HasMainImageVideo:       mainImageVideo,
		IsClimatePledgeFriendly: climateFriendly,
		HasBrandStore:           brandStore,
		SellerCountryRegion:     normalizeOptionalText(cellValue(headers, row.Values, "seller_country_region")),
		IsAmazon:                isAmazonSeller(seller, bbxAttribute),
		IsNew90d:                listingAge != nil && *listingAge <= 90,
		ExtractedDimensions:     dimensions,
		RawRow:                  rawRow,
	})
}

func (s *categoryResearchParseState) parseTrend(headers map[string]int, row xlsxRowData) {
	asin := normalizeASIN(cellValue(headers, row.Values, "asin"))
	yearMonth := normalizeYearMonth(cellValue(headers, row.Values, "year_month"))
	if asin == "" || yearMonth == "" {
		return
	}
	key := asin + "|" + yearMonth
	if _, exists := s.seenTrends[key]; exists {
		s.duplicateTrends++
		return
	}
	s.seenTrends[key] = struct{}{}
	s.trendASINs[asin] = struct{}{}

	rawRow := make(map[string]any)
	for idx, header := range headerNames(headers) {
		if header == "" || idx >= len(row.Values) || strings.TrimSpace(row.Values[idx]) == "" {
			continue
		}
		rawRow[header] = row.Values[idx]
	}
	s.result.Trends = append(s.result.Trends, parsedCategoryTrend{
		SourceRowNo: row.Number,
		ASIN:        asin,
		ParentASIN:  normalizeOptionalASIN(cellValue(headers, row.Values, "parent_asin")),
		YearMonth:   yearMonth,
		MonthlySale: parseInt(cellValue(headers, row.Values, "monthly_sales")),
		RawRow:      rawRow,
	})
}

func parseCategoryResearchFile(filename string, data []byte) (*parsedCategoryResearch, error) {
	if len(data) == 0 {
		return nil, errors.New("上传文件为空")
	}
	switch normalizedFileExtension(filename) {
	case ".xlsx":
		return parseCategoryResearchXLSX(data)
	case ".csv":
		return parseCategoryResearchCSV(data)
	default:
		return nil, fmt.Errorf("不支持的文件扩展名 %q，仅支持 .xlsx 和 .csv", normalizedFileExtension(filename))
	}
}

func parseCategoryResearchCSV(data []byte) (*parsedCategoryResearch, error) {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	reader.TrimLeadingSpace = true
	records, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("解析 CSV 失败: %w", err)
	}
	state := newCategoryResearchParseState()
	headerRow := -1
	var headerIndex map[string]int
	for i := 0; i < len(records) && i < 12; i++ {
		index := buildHeaderIndex(records[i])
		if _, ok := index["asin"]; ok {
			headerRow = i
			headerIndex = index
			break
		}
	}
	if headerRow < 0 {
		return nil, errors.New("CSV 缺少 ASIN 表头")
	}

	recordTypeIdx, hasRecordType := headerIndex["record_type"]
	for idx := headerRow + 1; idx < len(records); idx++ {
		record := records[idx]
		if rowIsEmpty(record) {
			continue
		}
		row := xlsxRowData{Number: idx + 1, Values: padRow(record, maxHeaderIndex(headerIndex)+1)}
		recordType := ""
		if hasRecordType && recordTypeIdx < len(row.Values) {
			recordType = strings.ToLower(strings.TrimSpace(row.Values[recordTypeIdx]))
		}
		switch recordType {
		case "trend", "趋势", "sales_trend":
			state.parseTrend(headerIndex, row)
		case "product", "产品", "product_detail":
			state.parseProduct(headerIndex, row)
		default:
			hasTrendColumns := hasAnyHeader(headerIndex, "year_month")
			hasProductColumns := hasAnyHeader(headerIndex, "product_name", "brand", "price", "monthly_revenue", "seller")
			if hasTrendColumns && !hasProductColumns {
				state.parseTrend(headerIndex, row)
			} else if hasTrendColumns && hasProductColumns {
				state.parseProduct(headerIndex, row)
				state.parseTrend(headerIndex, row)
			} else {
				state.parseProduct(headerIndex, row)
			}
		}
	}
	return state.finalize()
}

func parseCategoryResearchXLSX(data []byte) (*parsedCategoryResearch, error) {
	sheets, err := readXLSXSheets(data)
	if err != nil {
		return nil, err
	}
	state := newCategoryResearchParseState()
	for _, sheet := range sheets {
		productHeaderRow, productHeaders := findSheetHeader(sheet.Rows, false)
		trendHeaderRow, trendHeaders := findSheetHeader(sheet.Rows, true)
		sheetName := strings.ToLower(strings.TrimSpace(sheet.Name))
		preferProduct := strings.Contains(sheetName, "产品") ||
			strings.Contains(sheetName, "product") ||
			strings.Contains(sheetName, "竞品")
		preferTrend := strings.Contains(sheetName, "趋势") ||
			strings.Contains(sheetName, "trend")

		switch {
		case preferProduct && productHeaderRow >= 0:
			parseSheetRows(state, sheet.Rows, productHeaderRow, productHeaders, false)
		case preferTrend && trendHeaderRow >= 0:
			parseSheetRows(state, sheet.Rows, trendHeaderRow, trendHeaders, true)
		case productHeaderRow >= 0:
			parseSheetRows(state, sheet.Rows, productHeaderRow, productHeaders, false)
		case trendHeaderRow >= 0:
			parseSheetRows(state, sheet.Rows, trendHeaderRow, trendHeaders, true)
		}
	}
	return state.finalize()
}

func parseSheetRows(state *categoryResearchParseState, rows []xlsxRowData, headerRow int, headers map[string]int, trend bool) {
	for idx := headerRow + 1; idx < len(rows); idx++ {
		if rowIsEmpty(rows[idx].Values) {
			continue
		}
		if trend {
			state.parseTrend(headers, rows[idx])
		} else {
			state.parseProduct(headers, rows[idx])
		}
	}
}

func findSheetHeader(rows []xlsxRowData, trend bool) (int, map[string]int) {
	aliases := categoryProductAliases
	if trend {
		aliases = categoryTrendAliases
	}
	for idx := 0; idx < len(rows) && idx < 12; idx++ {
		headers := headerIndexForAliases(rows[idx].Values, aliases)
		if _, ok := headers["asin"]; !ok {
			continue
		}
		if trend {
			if _, ok := headers["year_month"]; ok {
				return idx, headers
			}
			continue
		}
		if hasAnyHeader(headers, "product_name", "brand", "price", "monthly_sales", "monthly_revenue", "seller", "fulfillment_method") {
			return idx, headers
		}
	}
	return -1, nil
}

func headerIndexForAliases(values []string, aliases map[string][]string) map[string]int {
	index := make(map[string]int)
	normalized := make(map[string]int)
	for idx, value := range values {
		normalized[normalizeHeader(value)] = idx
	}
	for key, candidates := range aliases {
		for _, candidate := range candidates {
			if idx, ok := normalized[normalizeHeader(candidate)]; ok {
				index[key] = idx
				break
			}
		}
	}
	if _, ok := index["record_type"]; !ok {
		for _, candidate := range []string{"record_type", "type", "数据类型", "记录类型"} {
			if idx, ok := normalized[normalizeHeader(candidate)]; ok {
				index["record_type"] = idx
				break
			}
		}
	}
	return index
}

func buildHeaderIndex(values []string) map[string]int {
	index := headerIndexForAliases(values, categoryProductAliases)
	trendIndex := headerIndexForAliases(values, categoryTrendAliases)
	for key, idx := range trendIndex {
		if _, exists := index[key]; !exists {
			index[key] = idx
		}
	}
	return index
}

func headerNames(headers map[string]int) []string {
	maxIdx := -1
	for _, idx := range headers {
		if idx > maxIdx {
			maxIdx = idx
		}
	}
	names := make([]string, maxIdx+1)
	keys := make([]string, 0, len(headers))
	for key := range headers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		idx := headers[key]
		if idx >= 0 && idx < len(names) {
			names[idx] = key
		}
	}
	return names
}

func normalizeHeader(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\uFEFF", ""))
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

func cellValue(headers map[string]int, values []string, key string) string {
	idx, ok := headers[key]
	if !ok || idx < 0 || idx >= len(values) {
		return ""
	}
	return strings.TrimSpace(values[idx])
}

func hasAnyHeader(headers map[string]int, keys ...string) bool {
	for _, key := range keys {
		if _, ok := headers[key]; ok {
			return true
		}
	}
	return false
}

func maxHeaderIndex(headers map[string]int) int {
	maxIdx := -1
	for _, idx := range headers {
		if idx > maxIdx {
			maxIdx = idx
		}
	}
	return maxIdx
}

func normalizeASIN(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, " ", "")
	return value
}

func normalizeOptionalASIN(value string) *string {
	normalized := normalizeASIN(value)
	if normalized == "" {
		return nil
	}
	return &normalized
}

func normalizeOptionalText(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func parseOptionalFloat(value string) (*float64, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, true
	}
	cleaned := strings.NewReplacer(",", "", "$", "", "¥", "", "€", "", "£", "", "%", "").Replace(value)
	number, err := strconv.ParseFloat(cleaned, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return nil, false
	}
	return &number, true
}

func parseInt(value string) int {
	number := parseOptionalInt(value)
	if number == nil {
		return 0
	}
	return *number
}

func parseOptionalInt(value string) *int {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	number, err := strconv.ParseFloat(strings.ReplaceAll(value, ",", ""), 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return nil
	}
	result := int(number)
	if result == 0 {
		return nil
	}
	return &result
}

func parseOptionalBool(value string) *bool {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return nil
	}
	var result bool
	switch value {
	case "true", "yes", "y", "1", "是", "有":
		result = true
	case "false", "no", "n", "0", "否", "无":
		result = false
	default:
		return nil
	}
	return &result
}

func normalizeDateValue(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if serial, err := strconv.ParseFloat(value, 64); err == nil && serial > 0 && serial < 100000 {
		date := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC).AddDate(0, 0, int(serial))
		formatted := date.Format("2006-01-02")
		return &formatted
	}
	for _, layout := range []string{"2006-01-02", "1/2/2006", "2/1/2006", "2006/1/2", "20060102"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			formatted := parsed.Format("2006-01-02")
			return &formatted
		}
	}
	return nil
}

func normalizeYearMonth(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if serial, err := strconv.ParseFloat(value, 64); err == nil && serial > 20000 && serial < 100000 {
		date := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC).AddDate(0, 0, int(serial))
		return date.Format("2006-01")
	}
	for _, layout := range []string{"2006-01", "2006/1", "2006/01", "200601", "Jan-06", "January 2006"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.Format("2006-01")
		}
	}
	normalized := strings.ReplaceAll(value, "/", "-")
	parts := strings.Split(normalized, "-")
	if len(parts) == 2 {
		if len(parts[0]) == 4 {
			if month, err := strconv.Atoi(parts[1]); err == nil && month >= 1 && month <= 12 {
				return fmt.Sprintf("%s-%02d", parts[0], month)
			}
		}
		if len(parts[1]) == 4 {
			if month, err := strconv.Atoi(parts[0]); err == nil && month >= 1 && month <= 12 {
				return fmt.Sprintf("%s-%02d", parts[1], month)
			}
		}
	}
	return value
}

func isAmazonSeller(seller *string, bbx *string) bool {
	sellerText := ""
	if seller != nil {
		sellerText = strings.ToLower(*seller)
	}
	bbxText := ""
	if bbx != nil {
		bbxText = strings.ToLower(*bbx)
	}
	return strings.Contains(sellerText, "amazon") ||
		strings.Contains(bbxText, "amazon") ||
		strings.Contains(sellerText, "亚马逊") ||
		strings.Contains(bbxText, "亚马逊")
}

func rowIsEmpty(values []string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return false
		}
	}
	return true
}

func padRow(values []string, width int) []string {
	if width < len(values) {
		width = len(values)
	}
	if len(values) >= width {
		return values
	}
	out := make([]string, width)
	copy(out, values)
	return out
}

func readXLSXSheets(data []byte) ([]xlsxSheetData, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("读取 XLSX ZIP 失败: %w", err)
	}
	files := make(map[string]*zip.File, len(reader.File))
	for _, file := range reader.File {
		files[file.Name] = file
	}

	sharedStrings, err := readSharedStrings(files)
	if err != nil {
		return nil, fmt.Errorf("解析 XLSX sharedStrings 失败: %w", err)
	}
	type sheetRef struct {
		Name string
		Path string
	}
	var refs []sheetRef
	if workbookFile := files["xl/workbook.xml"]; workbookFile != nil {
		sheetNames, relationships, err := readWorkbookMetadata(workbookFile, files["xl/_rels/workbook.xml.rels"])
		if err == nil {
			for idx, name := range sheetNames {
				if idx >= len(relationships) || relationships[idx] == "" {
					continue
				}
				refs = append(refs, sheetRef{Name: name, Path: relationships[idx]})
			}
		}
	}
	if len(refs) == 0 {
		var paths []string
		for name := range files {
			if strings.HasPrefix(name, "xl/worksheets/sheet") && strings.HasSuffix(name, ".xml") {
				paths = append(paths, name)
			}
		}
		sort.Strings(paths)
		for _, name := range paths {
			refs = append(refs, sheetRef{Name: path.Base(name), Path: name})
		}
	}
	if len(refs) == 0 {
		return nil, errors.New("XLSX 缺少工作表")
	}

	sheets := make([]xlsxSheetData, 0, len(refs))
	for _, ref := range refs {
		file := files[ref.Path]
		if file == nil {
			continue
		}
		partBytes, err := readXLSXZipEntry(file)
		if err != nil {
			return nil, fmt.Errorf("读取工作表 %s 失败: %w", ref.Name, err)
		}
		rows, err := parseWorksheetXML(bytes.NewReader(partBytes), sharedStrings)
		if err != nil {
			return nil, fmt.Errorf("解析工作表 %s 失败: %w", ref.Name, err)
		}
		sheets = append(sheets, xlsxSheetData{Name: ref.Name, Rows: rows})
	}
	return sheets, nil
}

func readSharedStrings(files map[string]*zip.File) ([]string, error) {
	file := files["xl/sharedStrings.xml"]
	if file == nil {
		return nil, nil
	}
	content, err := readXLSXZipEntry(file)
	if err != nil {
		return nil, err
	}
	decoder := xml.NewDecoder(bytes.NewReader(content))
	var stringsList []string
	var current strings.Builder
	inItem := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			if item.Name.Local == "si" {
				inItem = true
				current.Reset()
			}
		case xml.CharData:
			if inItem {
				current.Write([]byte(item))
			}
		case xml.EndElement:
			if item.Name.Local == "si" && inItem {
				inItem = false
				stringsList = append(stringsList, current.String())
			}
		}
	}
	return stringsList, nil
}

type workbookRelationship struct {
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
}

type workbookRelationships struct {
	Items []workbookRelationship `xml:"Relationship"`
}

func readWorkbookMetadata(workbookFile *zip.File, relFile *zip.File) ([]string, []string, error) {
	workbookBytes, err := readXLSXZipEntry(workbookFile)
	if err != nil {
		return nil, nil, err
	}
	decoder := xml.NewDecoder(bytes.NewReader(workbookBytes))
	var names []string
	var relationshipIDs []string
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			if item.Name.Local == "sheet" {
				for _, attr := range item.Attr {
					if attr.Name.Local == "name" {
						names = append(names, attr.Value)
					}
					if attr.Name.Local == "id" && attr.Name.Space != "" {
						relationshipIDs = append(relationshipIDs, attr.Value)
					}
				}
			}
		}
	}
	if relFile == nil {
		return names, nil, nil
	}
	relBytes, err := readXLSXZipEntry(relFile)
	if err != nil {
		return nil, nil, err
	}
	var rels workbookRelationships
	if err := xml.NewDecoder(bytes.NewReader(relBytes)).Decode(&rels); err != nil {
		return nil, nil, err
	}
	byID := make(map[string]string)
	for _, rel := range rels.Items {
		target := strings.TrimPrefix(rel.Target, "/")
		if !strings.HasPrefix(target, "xl/") {
			target = path.Join("xl", target)
		}
		byID[rel.ID] = target
	}
	paths := make([]string, len(relationshipIDs))
	for idx, id := range relationshipIDs {
		paths[idx] = byID[id]
	}
	return names, paths, nil
}

func readXLSXZipEntry(file *zip.File) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	content, err := io.ReadAll(io.LimitReader(reader, maxCategoryXLSXPartBytes+1))
	if err != nil {
		return nil, err
	}
	if len(content) > maxCategoryXLSXPartBytes {
		return nil, fmt.Errorf("XLSX part %q exceeds 64MB uncompressed limit", file.Name)
	}
	return content, nil
}

type worksheetCellValue struct {
	Column int
	Value  string
}

func parseWorksheetXML(reader io.Reader, sharedStrings []string) ([]xlsxRowData, error) {
	decoder := xml.NewDecoder(reader)
	var rows []xlsxRowData
	var currentRow int
	var cells []worksheetCellValue
	var cellColumn int
	var cellType string
	var cellValueBuilder strings.Builder
	inCell, inValue, inInlineText := false, false, false

	flushRow := func() {
		if currentRow <= 0 || len(cells) == 0 {
			cells = nil
			return
		}
		maxColumn := 0
		for _, cell := range cells {
			if cell.Column > maxColumn {
				maxColumn = cell.Column
			}
		}
		values := make([]string, maxColumn)
		for _, cell := range cells {
			if cell.Column > 0 && cell.Column <= len(values) {
				values[cell.Column-1] = cell.Value
			}
		}
		rows = append(rows, xlsxRowData{Number: currentRow, Values: values})
		cells = nil
	}

	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			switch item.Name.Local {
			case "row":
				currentRow++
				for _, attr := range item.Attr {
					if attr.Name.Local == "r" {
						if parsed, err := strconv.Atoi(attr.Value); err == nil {
							currentRow = parsed
						}
					}
				}
			case "c":
				inCell = true
				cellType = ""
				cellValueBuilder.Reset()
				cellColumn = 0
				for _, attr := range item.Attr {
					switch attr.Name.Local {
					case "r":
						cellColumn = columnIndex(attr.Value)
					case "t":
						cellType = attr.Value
					}
				}
			case "v":
				if inCell {
					inValue = true
				}
			case "t":
				if inCell && cellType == "inlineStr" {
					inInlineText = true
				}
			}
		case xml.CharData:
			if inCell && (inValue || inInlineText) {
				cellValueBuilder.Write([]byte(item))
			}
		case xml.EndElement:
			switch item.Name.Local {
			case "v":
				inValue = false
			case "t":
				inInlineText = false
			case "c":
				if inCell {
					value := strings.TrimSpace(cellValueBuilder.String())
					if cellType == "s" {
						if index, err := strconv.Atoi(value); err == nil && index >= 0 && index < len(sharedStrings) {
							value = sharedStrings[index]
						}
					} else if cellType == "b" {
						if value == "1" {
							value = "true"
						} else if value == "0" {
							value = "false"
						}
					}
					cells = append(cells, worksheetCellValue{Column: cellColumn, Value: value})
				}
				inCell = false
				inValue = false
				inInlineText = false
			case "row":
				flushRow()
			}
		}
	}
	flushRow()
	return rows, nil
}

func columnIndex(reference string) int {
	column := 0
	for _, r := range reference {
		if r >= 'A' && r <= 'Z' {
			column = column*26 + int(r-'A'+1)
			continue
		}
		if r >= 'a' && r <= 'z' {
			column = column*26 + int(r-'a'+1)
			continue
		}
		break
	}
	return column
}

func categoryStringPtr(value string) *string {
	return &value
}
