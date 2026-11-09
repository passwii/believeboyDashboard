package tasks

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type monthlyPaymentRow struct {
	fields          map[string]string
	amounts         map[string]*big.Rat
	transactionDate time.Time
	localMonth      string
	quantity        int
}

type monthlyClassifiedRows map[string][]*monthlyPaymentRow
type monthlyAmountMap map[string]*big.Rat

type monthlyPaymentColumn struct {
	name    string
	aliases []string
}

var monthlyPaymentColumns = []monthlyPaymentColumn{
	{name: "date/time", aliases: []string{"date/time", "datum/uhrzeit"}},
	{name: "settlement id", aliases: []string{"settlement id", "abrechnungsnummer"}},
	{name: "type", aliases: []string{"type", "typ"}},
	{name: "order id", aliases: []string{"order id", "bestellnummer"}},
	{name: "sku", aliases: []string{"sku"}},
	{name: "description", aliases: []string{"description", "beschreibung"}},
	{name: "quantity", aliases: []string{"quantity", "menge"}},
	{name: "marketplace", aliases: []string{"marketplace"}},
	{name: "account type", aliases: []string{"account type"}},
	{name: "fulfillment", aliases: []string{"fulfillment", "fulfilment", "versand"}},
	{name: "order city", aliases: []string{"order city", "ort der bestellung"}},
	{name: "order state", aliases: []string{"order state", "bundesland"}},
	{name: "order postal", aliases: []string{"order postal", "postleitzahl"}},
	{name: "tax collection model", aliases: []string{"tax collection model", "steuererhebungsmodell"}},
	{name: "product sales", aliases: []string{"product sales", "umsaetze"}},
	{name: "product sales tax", aliases: []string{"product sales tax", "produktumsatzsteuer"}},
	{name: "shipping credits", aliases: []string{"shipping credits", "postage credits", "gutschrift fuer versandkosten"}},
	{name: "shipping credits tax", aliases: []string{"shipping credits tax", "steuer auf versandgutschrift"}},
	{name: "gift wrap credits", aliases: []string{"gift wrap credits", "gutschrift fuer geschenkverpackung"}},
	{name: "giftwrap credits tax", aliases: []string{"giftwrap credits tax", "steuer auf geschenkverpackungsgutschriften"}},
	{name: "regulatory fee", aliases: []string{"regulatory fee"}},
	{name: "tax on regulatory fee", aliases: []string{"tax on regulatory fee"}},
	{name: "promotional rebates", aliases: []string{"promotional rebates", "rabatte aus werbeaktionen"}},
	{name: "promotional rebates tax", aliases: []string{"promotional rebates tax", "steuer auf aktionsrabatte"}},
	{name: "marketplace withheld tax", aliases: []string{"marketplace withheld tax", "einbehaltene steuer auf marketplace"}},
	{name: "selling fees", aliases: []string{"selling fees", "verkaufsgebuehren"}},
	{name: "fba fees", aliases: []string{"fba fees", "gebuehren zu versand durch amazon"}},
	{name: "other transaction fees", aliases: []string{"other transaction fees", "andere transaktionsgebuehren"}},
	{name: "other", aliases: []string{"other", "andere"}},
	{name: "total", aliases: []string{"total", "gesamt"}},
	{name: "transaction status", aliases: []string{"transaction status", "transaktionsstatus"}},
	{name: "transaction release date", aliases: []string{"transaction release date", "freigabedatum der transaktion"}},
}

var monthlyPaymentRequiredColumns = map[string]bool{
	"type":                true,
	"sku":                 true,
	"quantity":            true,
	"product sales":       true,
	"shipping credits":    true,
	"promotional rebates": true,
	"other":               true,
	"selling fees":        true,
	"fba fees":            true,
}

var monthlyPaymentNumericColumns = map[string]bool{
	"quantity":                 true,
	"product sales":            true,
	"product sales tax":        true,
	"shipping credits":         true,
	"shipping credits tax":     true,
	"gift wrap credits":        true,
	"giftwrap credits tax":     true,
	"regulatory fee":           true,
	"tax on regulatory fee":    true,
	"promotional rebates":      true,
	"promotional rebates tax":  true,
	"marketplace withheld tax": true,
	"selling fees":             true,
	"fba fees":                 true,
	"other transaction fees":   true,
	"other":                    true,
	"total":                    true,
}

type monthlyPaymentAlias struct {
	canonical string
	aliases   []string
}

var monthlyPaymentTypeAliases = []monthlyPaymentAlias{
	{canonical: "Order", aliases: []string{"order", "bestellung"}},
	{canonical: "Refund", aliases: []string{"refund", "erstattung"}},
	{canonical: "Amazon Fees", aliases: []string{"amazon fees", "gebuehren von amazon"}},
	{canonical: "Service Fee", aliases: []string{"service fee", "servicegebuehr"}},
	{canonical: "FBA Inventory Fee", aliases: []string{"fba inventory fee", "versand durch amazon lagergebuehr"}},
	{canonical: "Transfer", aliases: []string{"transfer", "uebertrag"}},
	{canonical: "FBA Transaction Fees", aliases: []string{
		"fba transaction fees",
		"transaktionsgebuehren fuer versand durch amazon",
		"fulfilment by amazon (fba) transaction fees",
	}},
	{canonical: "Chargeback Refund", aliases: []string{"chargeback refund"}},
	{canonical: "Liquidations", aliases: []string{"liquidations"}},
	{canonical: "Adjustment", aliases: []string{"adjustment", "anpassung"}},
	{canonical: "Deal Fee", aliases: []string{"deal fee"}},
	{canonical: "Debt", aliases: []string{"debt", "verbindlichkeit"}},
	{canonical: "Fee Adjustment", aliases: []string{"fee adjustment"}},
}

var monthlyPaymentDescriptionAliases = []monthlyPaymentAlias{
	{canonical: "Cost of Advertising", aliases: []string{"cost of advertising", "werbekosten"}},
	{canonical: "Refund for Advertiser", aliases: []string{
		"refund for advertiser",
		"werbekosten-erstattung",
		"erstattung werbekosten",
	}},
	{canonical: "FBA Inventory Reimbursement - General Adjustment", aliases: []string{
		"fba inventory reimbursement - general adjustment",
		"fba-bestandsentschaedigung - allgemeine anpassung",
		"versand durch amazon erstattung für lagerbestand - allgemeine anpassung",
	}},
	{canonical: "FBA Inventory Reimbursement - Lost", aliases: []string{
		"fba inventory reimbursement - lost",
		"versand durch amazon erstattung fuer lagerbestand - im lager verloren",
	}},
	{canonical: "Non-subscription Fee Adjustment", aliases: []string{
		"non-subscription fee adjustment",
		"nicht-abonnement-gebu ehrenanpassung",
	}},
	{canonical: "FBA International Freight Shipping Charge", aliases: []string{
		"fba international freight shipping charge",
		"fba internationale frachtversandkosten",
	}},
	{canonical: "FBA International Freight Duties and Taxes Charge", aliases: []string{
		"fba international freight duties and taxes charge",
		"fba internationale frachtzoelle und steuern",
	}},
	{canonical: "Fee Adjustment - Weight and Dimension Change", aliases: []string{
		"fee adjustment - weight and dimension change",
		"gebuehrenanpassung - gewichts- und massaenderung",
	}},
	{canonical: "Deal Participation Fee", aliases: []string{
		"deal participation fee",
		"teilnahmegebuehr fuer das angebot",
	}},
	{canonical: "Deal Performance Based Fee", aliases: []string{
		"deal performance based fee",
		"leistungsbasierte angebotsgebuehr",
	}},
	{canonical: "Coupon Participation Fee", aliases: []string{
		"coupon participation fee",
		"coupon-teilnahmegebuehr",
	}},
	{canonical: "Coupon Performance Based Fee", aliases: []string{
		"coupon performance based fee",
		"leistungsbasierte coupon-gebuehr",
	}},
	{canonical: "Vine Enrollment Fee", aliases: []string{
		"vine enrollment fee",
		"vine-registrierungsgebuehr",
	}},
	{canonical: "FBA storage fee", aliases: []string{
		"fba storage fee",
		"fba-lagergebuehr",
		"fba lagergebuehr",
	}},
	{canonical: "FBA Removal Order: Disposal Fee", aliases: []string{
		"fba removal order: disposal fee",
		"versand durch amazon gebuehr fuer entsorgung",
	}},
	{canonical: "FBA Removal Order: Return Fee", aliases: []string{
		"fba removal order: return fee",
		"versand durch amazon gebuehr fuer ruecksendung",
	}},
	{canonical: "FBA Long-Term Storage Fee", aliases: []string{
		"fba long-term storage fee",
		"fba langzeitlagergebuehr",
	}},
	{canonical: "Subscription", aliases: []string{
		"subscription",
		"abonnement",
		"gebuehr fuer verkaeuferkonto",
	}},
	{canonical: "Failed disbursement", aliases: []string{
		"failed disbursement",
		"fehlgeschlagene auszahlung",
	}},
	{canonical: "Micro Deposit", aliases: []string{
		"micro deposit",
		"micro-einzahlung",
		"kleineinzahlung",
	}},
	{canonical: "Other", aliases: []string{"other", "andere"}},
}

var germanMonthlyHeaderTokens = map[string]bool{
	"datum/uhrzeit":                       true,
	"abrechnungsnummer":                   true,
	"typ":                                 true,
	"bestellnummer":                       true,
	"beschreibung":                        true,
	"menge":                               true,
	"bundesland":                          true,
	"steuererhebungsmodell":               true,
	"umsaetze":                            true,
	"verkaufsgebuehren":                   true,
	"gebuehren zu versand durch amazon":   true,
	"einbehaltene steuer auf marketplace": true,
}

type monthlyPaymentStructure struct {
	headerLine     int
	delimiter      rune
	columnIndex    map[int]string
	detectedLocale string
}

func parseMonthlyPaymentCSV(data []byte, country string) ([]*monthlyPaymentRow, string, error) {
	text, err := decodeMonthlyPaymentCSV(data)
	if err != nil {
		return nil, "", err
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	structure, err := detectMonthlyPaymentStructure(lines)
	if err != nil {
		return nil, "", err
	}
	locale := "en"
	if strings.EqualFold(strings.TrimSpace(country), "DE") {
		locale = "de"
	}
	records, err := readMonthlyPaymentRecords(lines[structure.headerLine+1:], structure.delimiter)
	if err != nil {
		return nil, "", err
	}
	rows := make([]*monthlyPaymentRow, 0, len(records))
	for recordIndex, record := range records {
		fields := make(map[string]string, len(structure.columnIndex))
		allEmpty := true
		for columnIndex, canonical := range structure.columnIndex {
			if columnIndex >= len(record) {
				continue
			}
			value := strings.TrimSpace(record[columnIndex])
			fields[canonical] = value
			if value != "" {
				allEmpty = false
			}
		}
		if allEmpty {
			continue
		}

		amounts := make(map[string]*big.Rat)
		for name := range monthlyPaymentNumericColumns {
			rawValue, ok := fields[name]
			if !ok {
				continue
			}
			amount := parseMonthlyLocalizedNumber(rawValue, locale)
			amounts[name] = amount
			fields[name] = formatMonthlyRat(amount, 2)
		}
		fields["type"] = normalizeMonthlyPaymentType(fields["type"])
		fields["description"] = normalizeMonthlyPaymentDescription(fields["description"], locale)
		fields["sku"] = strings.TrimSpace(fields["sku"])

		rawDate := strings.TrimSpace(fields["date/time"])
		if rawDate == "" {
			return nil, "", fmt.Errorf("monthly report transaction row %d date/time is required", recordIndex+1)
		}
		transactionDate, err := parseMonthlyTransactionDate(rawDate)
		if err != nil {
			return nil, "", fmt.Errorf("monthly report transaction row %d: %w", recordIndex+1, err)
		}
		quantity := 0
		if amount := amounts["quantity"]; amount != nil {
			quantity = monthlyRatInt(amount)
		}
		rows = append(rows, &monthlyPaymentRow{
			fields:          fields,
			amounts:         amounts,
			transactionDate: transactionDate,
			localMonth:      dateLocalMonth(transactionDate, rawDate),
			quantity:        quantity,
		})
	}
	if len(rows) == 0 {
		return nil, "", errors.New("monthly report transaction CSV contains no data rows")
	}
	return rows, structure.detectedLocale, nil
}

func decodeMonthlyPaymentCSV(data []byte) (string, error) {
	switch {
	case bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}):
		data = data[3:]
	case bytes.HasPrefix(data, []byte{0xFF, 0xFE}):
		return decodeMonthlyUTF16(data[2:], true)
	case bytes.HasPrefix(data, []byte{0xFE, 0xFF}):
		return decodeMonthlyUTF16(data[2:], false)
	}
	if utf8.Valid(data) {
		return string(data), nil
	}
	var builder strings.Builder
	for _, value := range data {
		builder.WriteRune(rune(value))
	}
	return builder.String(), nil
}

func decodeMonthlyUTF16(data []byte, littleEndian bool) (string, error) {
	if len(data)%2 != 0 {
		return "", errors.New("monthly report CSV has an odd-length UTF-16 payload")
	}
	runes := make([]rune, 0, len(data)/2)
	for index := 0; index < len(data); index += 2 {
		var value uint16
		if littleEndian {
			value = uint16(data[index]) | uint16(data[index+1])<<8
		} else {
			value = uint16(data[index])<<8 | uint16(data[index+1])
		}
		if value >= 0xD800 && value <= 0xDBFF && index+3 < len(data) {
			var next uint16
			if littleEndian {
				next = uint16(data[index+2]) | uint16(data[index+3])<<8
			} else {
				next = uint16(data[index+2])<<8 | uint16(data[index+3])
			}
			if next >= 0xDC00 && next <= 0xDFFF {
				runes = append(runes, rune(0x10000+(uint32(value-0xD800)<<10)+uint32(next-0xDC00)))
				index += 2
				continue
			}
		}
		runes = append(runes, rune(value))
	}
	return string(runes), nil
}

func detectMonthlyPaymentStructure(lines []string) (monthlyPaymentStructure, error) {
	for lineIndex, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		for _, delimiter := range []rune{',', '\t', ';'} {
			record, err := readMonthlyPaymentRecord(line, delimiter)
			if err != nil || len(record) < 3 {
				continue
			}
			mapping, locale := matchMonthlyPaymentColumns(record)
			if mapping == nil {
				continue
			}
			return monthlyPaymentStructure{
				headerLine:     lineIndex,
				delimiter:      delimiter,
				columnIndex:    mapping,
				detectedLocale: locale,
			}, nil
		}
	}
	return monthlyPaymentStructure{}, errors.New("payment report missing required columns in header row")
}

func readMonthlyPaymentRecord(line string, delimiter rune) ([]string, error) {
	reader := csv.NewReader(strings.NewReader(line))
	reader.Comma = delimiter
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	record, err := reader.Read()
	if err != nil {
		return nil, err
	}
	for index := range record {
		record[index] = strings.TrimSpace(strings.Trim(record[index], `"`))
	}
	return record, nil
}

func matchMonthlyPaymentColumns(header []string) (map[int]string, string) {
	normalized := make(map[string]int, len(header))
	for index, value := range header {
		normalized[normalizeMonthlyPaymentToken(value)] = index
	}
	mapping := make(map[int]string)
	locale := "en"
	for _, column := range monthlyPaymentColumns {
		for _, alias := range column.aliases {
			if index, ok := normalized[normalizeMonthlyPaymentToken(alias)]; ok {
				mapping[index] = column.name
				break
			}
		}
	}
	for required := range monthlyPaymentRequiredColumns {
		found := false
		for _, canonical := range mapping {
			if canonical == required {
				found = true
				break
			}
		}
		if !found {
			return nil, ""
		}
	}
	if _, ok := normalized["date/time"]; !ok {
		if _, german := normalized["datum/uhrzeit"]; german {
			locale = "de"
		}
	}
	for token := range normalized {
		if germanMonthlyHeaderTokens[token] {
			locale = "de"
			break
		}
	}
	return mapping, locale
}

func readMonthlyPaymentRecords(lines []string, delimiter rune) ([][]string, error) {
	reader := csv.NewReader(strings.NewReader(strings.Join(lines, "\n")))
	reader.Comma = delimiter
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	records, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read payment report rows: %w", err)
	}
	return records, nil
}

func validateMonthlyPaymentRows(
	rows []*monthlyPaymentRow,
	country string,
	reportMonth string,
	detectedLocale string,
) error {
	if detectedLocale == "de" && !strings.EqualFold(country, "DE") {
		return errors.New("monthly report country does not match the German payment report header")
	}
	knownMarketplace := false
	matchingMarketplace := false
	for _, row := range rows {
		marketplaceCountry := monthlyMarketplaceCountry(row.fields["marketplace"])
		if marketplaceCountry != "" {
			knownMarketplace = true
			if marketplaceCountry == country {
				matchingMarketplace = true
			}
		}
		if row.localMonth != reportMonth {
			return fmt.Errorf(
				"monthly report transaction month %s does not match report_month %s",
				row.localMonth,
				reportMonth,
			)
		}
	}
	if knownMarketplace && !matchingMarketplace {
		return fmt.Errorf(
			"monthly report country %s does not match the payment report marketplace",
			country,
		)
	}
	return nil
}

func monthlyMarketplaceCountry(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch {
	case normalized == "":
		return ""
	case strings.Contains(normalized, "amazon.de"):
		return "DE"
	case strings.Contains(normalized, "amazon.co.uk"), strings.Contains(normalized, "amazon.uk"):
		return "UK"
	case strings.Contains(normalized, "amazon.com"):
		return "US"
	default:
		return ""
	}
}

func parseMonthlyLocalizedNumber(value string, locale string) *big.Rat {
	text := strings.TrimSpace(value)
	if text == "" || strings.EqualFold(text, "nan") || strings.EqualFold(text, "none") || strings.EqualFold(text, "null") {
		return new(big.Rat)
	}
	negative := strings.HasPrefix(text, "(") && strings.HasSuffix(text, ")")
	var builder strings.Builder
	for _, character := range text {
		if (character >= '0' && character <= '9') || strings.ContainsRune(",.-", character) {
			builder.WriteRune(character)
		}
	}
	cleaned := builder.String()
	if cleaned == "" || cleaned == "-" || cleaned == "," || cleaned == "." || cleaned == "-." || cleaned == "-," {
		return new(big.Rat)
	}
	if locale == "de" {
		cleaned = strings.ReplaceAll(cleaned, ".", "")
		cleaned = strings.ReplaceAll(cleaned, ",", ".")
	} else if strings.Contains(cleaned, ",") {
		cleaned = strings.ReplaceAll(cleaned, ",", "")
	}
	amount, ok := new(big.Rat).SetString(cleaned)
	if !ok {
		return new(big.Rat)
	}
	if negative && amount.Sign() > 0 {
		amount.Neg(amount)
	}
	return amount
}

func parseMonthlyTransactionDate(value string) (time.Time, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return time.Time{}, errors.New("transaction date is empty")
	}
	offset := 0
	if index := strings.LastIndex(text, " "); index >= 0 {
		if zone, ok := monthlyTimezoneOffsets[text[index+1:]]; ok {
			offset = zone
			text = strings.TrimSpace(text[:index])
		}
	}
	location := time.FixedZone("monthly-report", offset*60*60)
	for _, layout := range []string{
		"Jan 2, 2006 03:04:05 PM",
		"2006-01-02 15:04:05",
		"02.01.2006 15:04:05",
		"02 Jan 2006 15:04:05",
	} {
		parsed, err := time.ParseInLocation(layout, text, location)
		if err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid transaction date %q", value)
}

var monthlyTimezoneOffsets = map[string]int{
	"UTC": 0,
	"GMT": 0,
	"PST": -8,
	"PDT": -7,
	"MST": -7,
	"MDT": -6,
	"CST": -6,
	"CDT": -5,
	"EST": -5,
	"EDT": -4,
}

func dateLocalMonth(parsedUTC time.Time, raw string) string {
	offset := 0
	if index := strings.LastIndex(strings.TrimSpace(raw), " "); index >= 0 {
		if zone, ok := monthlyTimezoneOffsets[strings.TrimSpace(raw)[index+1:]]; ok {
			offset = zone
		}
	}
	return parsedUTC.In(time.FixedZone("monthly-report", offset*60*60)).Format("2006-01")
}

func monthlyRatInt(value *big.Rat) int {
	if value == nil {
		return 0
	}
	quotient := new(big.Int).Quo(value.Num(), value.Denom())
	if !quotient.IsInt64() {
		return 0
	}
	result := quotient.Int64()
	if result > int64(^uint(0)>>1) || result < -int64(^uint(0)>>1)-1 {
		return 0
	}
	return int(result)
}

func normalizeMonthlyPaymentToken(value string) string {
	text := strings.ToLower(strings.TrimSpace(strings.Trim(value, `"`)))
	text = strings.ReplaceAll(text, "\uFEFF", "")
	text = strings.NewReplacer(
		"ä", "ae",
		"ö", "oe",
		"ü", "ue",
		"ß", "ss",
	).Replace(text)
	return strings.Join(strings.Fields(text), " ")
}

func normalizeMonthlyPaymentType(value string) string {
	normalized := normalizeMonthlyPaymentToken(value)
	for _, alias := range monthlyPaymentTypeAliases {
		for _, candidate := range alias.aliases {
			if normalized == normalizeMonthlyPaymentToken(candidate) {
				return alias.canonical
			}
		}
	}
	return strings.TrimSpace(value)
}

func normalizeMonthlyPaymentDescription(value string, locale string) string {
	original := strings.TrimSpace(value)
	normalized := strings.Join(strings.Fields(normalizeMonthlyPaymentToken(original)), " ")
	for _, alias := range monthlyPaymentDescriptionAliases {
		if normalized == strings.Join(strings.Fields(normalizeMonthlyPaymentToken(alias.canonical)), " ") {
			return alias.canonical
		}
		for _, candidate := range alias.aliases {
			if normalized == strings.Join(strings.Fields(normalizeMonthlyPaymentToken(candidate)), " ") {
				return alias.canonical
			}
		}
	}
	switch {
	case strings.HasPrefix(normalized, "price discount"):
		return "Price Discount"
	case strings.Contains(normalized, "coupon redemption fee"):
		return "Coupon Redemption Fee"
	case strings.Contains(normalized, "fba customer returns fee"):
		return "FBA Customer Returns Fee"
	case strings.Contains(normalized, "to your account ending in"):
		return "Transfer to Bank Account"
	case strings.Contains(normalized, "retrocharge") && strings.Contains(normalized, "reversal"):
		return "Retrocharge Reversal"
	case strings.Contains(normalized, "retrocharge"):
		return "Retrocharge"
	case strings.Contains(normalized, "fba inventory reimbursement"):
		switch {
		case strings.Contains(normalized, "customer return"):
			return "FBA Inventory Reimbursement - Customer Return"
		case strings.Contains(normalized, "customer service issue"):
			return "FBA Inventory Reimbursement - Customer Service Issue"
		case strings.Contains(normalized, "damaged"):
			return "FBA Inventory Reimbursement - Damaged"
		case strings.Contains(normalized, "lost:inbound"), strings.Contains(normalized, "lost:warehouse"):
			return "FBA Inventory Reimbursement - Lost"
		default:
			return "FBA Inventory Reimbursement"
		}
	case locale == "de" && original == "":
		return ""
	default:
		return original
	}
}

func isMonthlyFBAStorageFee(description string) bool {
	normalized := normalizeMonthlyPaymentToken(description)
	for _, keyword := range []string{"storage fee", "lagergebuehr", "inventory storage"} {
		if strings.Contains(normalized, keyword) {
			return true
		}
	}
	return false
}

func (row *monthlyPaymentRow) displayAmount(field string) string {
	if row == nil {
		return "0.00"
	}
	if amount := row.amounts[field]; amount != nil {
		return formatMonthlyRat(amount, 2)
	}
	value := strings.TrimSpace(row.fields[field])
	if value == "" {
		return "0.00"
	}
	return formatMonthlyRat(parseMonthlyLocalizedNumber(value, "en"), 2)
}

func (row *monthlyPaymentRow) rawJSON() ([]byte, error) {
	if row == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(row.fields)
}

func formatMonthlyRat(value *big.Rat, places int) string {
	if value == nil {
		return formatMonthlyDecimal(0, places)
	}
	return value.FloatString(places)
}

func formatMonthlyDecimal(value float64, places int) string {
	return strconv.FormatFloat(value, 'f', places, 64)
}
