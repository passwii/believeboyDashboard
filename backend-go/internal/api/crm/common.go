package crm

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func todayShanghai() string {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.Now().Format("20060102")
	}
	return time.Now().In(location).Format("20060102")
}

func ioReadAllLimited(reader io.Reader, maxBytes int64) ([]byte, error) {
	limited := io.LimitReader(reader, maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("file exceeds %d bytes", maxBytes)
	}
	return data, nil
}

func chiURLParam(r *http.Request, name string) string {
	return chi.URLParam(r, name)
}

const (
	maxCustomerPageSize = 200
	maxLeadPageSize     = 100
	maxTaskPageSize     = 100
	maxAuditPageSize    = 100
	maxProposalPageSize = 100
)

func requestIdentity(r *http.Request) Identity {
	user, _ := auth.UserContextFromContext(r.Context())
	return Identity{
		UserID:    strings.TrimSpace(user.UserID),
		Operator:  strings.TrimSpace(user.Operator),
		IsAdmin:   user.IsAdmin,
		Email:     user.Email,
		Name:      user.Name,
		RoleType:  user.RoleType,
		SessionID: user.SessionID,
	}
}

func parsePage(r *http.Request, defaultSize, maxSize int) (int, int, error) {
	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 {
			return 0, 0, NewAPIError(http.StatusUnprocessableEntity, "page must be greater than or equal to 1")
		}
		page = value
	}
	pageSize := defaultSize
	if raw := strings.TrimSpace(r.URL.Query().Get("page_size")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > maxSize {
			return 0, 0, NewAPIError(
				http.StatusUnprocessableEntity,
				fmt.Sprintf("page_size must be between 1 and %d", maxSize),
			)
		}
		pageSize = value
	}
	return page, pageSize, nil
}

func parsePathID(r *http.Request, name string) (int64, error) {
	value, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	if err != nil || value < 1 {
		return 0, NewAPIError(http.StatusUnprocessableEntity, "invalid "+name)
	}
	return value, nil
}

func parseOptionalIntQuery(r *http.Request, name string) (*int64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return nil, NewAPIError(http.StatusUnprocessableEntity, name+" must be an integer")
	}
	return &value, nil
}

func parseOptionalIntList(r *http.Request, name string) ([]int64, error) {
	rawValues := r.URL.Query()[name]
	if len(rawValues) == 0 {
		return nil, nil
	}
	result := make([]int64, 0, len(rawValues))
	for _, raw := range rawValues {
		for _, item := range strings.Split(raw, ",") {
			item = strings.TrimSpace(item)
			if item == "" {
				continue
			}
			value, err := strconv.ParseInt(item, 10, 64)
			if err != nil {
				return nil, NewAPIError(http.StatusUnprocessableEntity, name+" must contain integers")
			}
			result = append(result, value)
		}
	}
	return result, nil
}

func parseOptionalStringList(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			item = strings.TrimSpace(item)
			if item != "" {
				result = append(result, item)
			}
		}
	}
	return result
}

func decodeJSON(r *http.Request, target any, disallowUnknown bool) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 32<<20))
	decoder.UseNumber()
	if disallowUnknown {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(target); err != nil {
		return NewAPIError(http.StatusUnprocessableEntity, "Invalid request body")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return NewAPIError(http.StatusUnprocessableEntity, "Invalid request body")
	}
	return nil
}

func parseFilters(raw string) ([]FilterCondition, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var filters []FilterCondition
	if err := json.Unmarshal([]byte(raw), &filters); err != nil {
		return nil, NewAPIError(http.StatusBadRequest, "filters 非法 JSON")
	}
	var generic any
	if err := json.Unmarshal([]byte(raw), &generic); err != nil {
		return nil, NewAPIError(http.StatusBadRequest, "filters 非法 JSON")
	}
	if _, ok := generic.([]any); !ok {
		return nil, NewAPIError(http.StatusBadRequest, "filters 须为 JSON 数组")
	}
	return filters, nil
}

func parseTimeQuery(r *http.Request, name string) (*time.Time, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	value, err := time.Parse(time.RFC3339Nano, raw)
	if err == nil {
		return &value, nil
	}
	location, locationErr := time.LoadLocation("Asia/Shanghai")
	if locationErr != nil {
		location = time.FixedZone("CST", 8*60*60)
	}
	if naive, naiveErr := time.ParseInLocation("2006-01-02T15:04:05.999999999", raw, location); naiveErr == nil {
		return &naive, nil
	}
	if day, dayErr := time.ParseInLocation("2006-01-02", raw, location); dayErr == nil {
		return &day, nil
	}
	return nil, NewAPIError(http.StatusUnprocessableEntity, name+" must be a valid datetime")
}

func validateScope(scope string, allowed ...string) (string, error) {
	if scope == "" {
		return allowed[0], nil
	}
	for _, candidate := range allowed {
		if scope == candidate {
			return scope, nil
		}
	}
	return "", NewAPIError(http.StatusUnprocessableEntity, "invalid scope")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	if err := httpapi.WriteJSON(w, status, value); err != nil {
		WriteError(w, NewAPIError(http.StatusInternalServerError, "Internal Server Error"))
	}
}

func writeCSV(w http.ResponseWriter, filename, content string) {
	encoded := url.QueryEscape(filename)
	encoded = strings.ReplaceAll(encoded, "+", "%20")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+encoded)
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, content)
}

func writeXLSX(w http.ResponseWriter, filename string, data []byte) {
	encoded := url.QueryEscape(filename)
	encoded = strings.ReplaceAll(encoded, "+", "%20")
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+encoded)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func buildCustomerCSV(items []Customer) string {
	var buffer bytes.Buffer
	buffer.WriteString("\ufeff")
	writer := csv.NewWriter(&buffer)
	_ = writer.Write([]string{
		"名称", "简称", "行业", "对象类型", "意向服务", "评级", "状态", "负责人",
		"主联系人", "主联系人电话", "主联系人微信", "最近跟进", "下次跟进", "创建时间",
	})
	for _, item := range items {
		_ = writer.Write([]string{
			item.Name,
			pointerValue(item.ShortName),
			pointerValue(item.Industry),
			pointerValue(item.CustomerType),
			pointerValue(item.InterestedService),
			item.Rating,
			item.Status,
			pointerValue(item.OwnerName),
			pointerValue(item.ContactName),
			pointerValue(item.ContactPhone),
			pointerValue(item.ContactWechat),
			formatCSVTime(item.LastFollowAt),
			formatCSVTime(item.NextFollowAt),
			formatCSVTime(&item.CreatedAt),
		})
	}
	writer.Flush()
	return buffer.String()
}

func buildLeadCSV(items []Lead) string {
	var buffer bytes.Buffer
	buffer.WriteString("\ufeff")
	writer := csv.NewWriter(&buffer)
	_ = writer.Write([]string{
		"联系人名", "公司", "电话", "微信", "来源", "对象类型", "意向服务",
		"状态", "意向度", "负责人", "下次跟进", "创建时间",
	})
	for _, item := range items {
		_ = writer.Write([]string{
			item.Name,
			pointerValue(item.Company),
			pointerValue(item.Phone),
			pointerValue(item.Wechat),
			pointerValue(item.Source),
			pointerValue(item.CustomerType),
			pointerValue(item.InterestedService),
			item.Status,
			item.Intent,
			pointerValue(item.OwnerName),
			formatCSVTime(item.NextFollowAt),
			formatCSVTime(&item.CreatedAt),
		})
	}
	writer.Flush()
	return buffer.String()
}

func formatCSVTime(value *string) string {
	if value == nil || *value == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339, *value)
	if err != nil {
		return *value
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return parsed.Format("2006-01-02 15:04")
	}
	return parsed.In(location).Format("2006-01-02 15:04")
}

func pointerValue[T any](value *T) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(*value)
}

func buildXLSX(rows [][]string) ([]byte, error) {
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	sheet.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for rowIndex, values := range rows {
		fmt.Fprintf(&sheet, `<row r="%d">`, rowIndex+1)
		for columnIndex, value := range values {
			ref := xlsxColumn(columnIndex+1) + strconv.Itoa(rowIndex+1)
			fmt.Fprintf(&sheet, `<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, ref, escapeXML(value))
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)

	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	write := func(name, body string) error {
		entry, err := writer.Create(name)
		if err != nil {
			return err
		}
		_, err = io.WriteString(entry, body)
		return err
	}
	if err := write("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`); err != nil {
		return nil, err
	}
	if err := write("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats-package.relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`); err != nil {
		return nil, err
	}
	if err := write("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="CRM" sheetId="1" r:id="rId1"/></sheets></workbook>`); err != nil {
		return nil, err
	}
	if err := write("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats-package.relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`); err != nil {
		return nil, err
	}
	if err := write("xl/worksheets/sheet1.xml", sheet.String()); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func xlsxColumn(index int) string {
	result := ""
	for index > 0 {
		index--
		result = string(rune('A'+index%26)) + result
		index /= 26
	}
	return result
}

func escapeXML(value string) string {
	var buffer bytes.Buffer
	_ = xml.EscapeText(&buffer, []byte(value))
	return buffer.String()
}

func parseCustomerImportFile(data []byte, filename string) ([]CustomerSeaImportRow, error) {
	ext := strings.ToLower(filename)
	if strings.HasSuffix(ext, ".csv") {
		return parseCustomerCSV(data)
	}
	if strings.HasSuffix(ext, ".xlsx") {
		return parseCustomerXLSX(data)
	}
	return nil, NewAPIError(http.StatusBadRequest, "仅支持 .csv 或 .xlsx 导入文件")
}

func parseCustomerCSV(data []byte) ([]CustomerSeaImportRow, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil || len(records) < 2 {
		return nil, NewAPIError(http.StatusBadRequest, "CSV 导入文件为空或格式错误")
	}
	headers := map[string]int{}
	for index, header := range records[0] {
		headers[strings.TrimSpace(header)] = index
	}
	required := []string{"name"}
	for _, header := range required {
		if _, ok := headers[header]; !ok {
			return nil, NewAPIError(http.StatusBadRequest, "CSV 缺少必填列: "+header)
		}
	}
	rows := make([]CustomerSeaImportRow, 0, len(records)-1)
	for _, record := range records[1:] {
		value := func(header string) *string {
			index, ok := headers[header]
			if !ok || index >= len(record) || strings.TrimSpace(record[index]) == "" {
				return nil
			}
			item := strings.TrimSpace(record[index])
			return &item
		}
		row := CustomerSeaImportRow{
			Name:              pointerValue(value("name")),
			ShortName:         value("short_name"),
			Industry:          value("industry"),
			CustomerType:      value("customer_type"),
			InterestedService: value("interested_service"),
			Rating:            value("rating"),
			Status:            value("status"),
			Source:            value("source"),
			Address:           value("address"),
			Website:           value("website"),
			Remark:            value("remark"),
			ContactName:       value("contact_name"),
			ContactPhone:      value("contact_phone"),
			ContactEmail:      value("contact_email"),
		}
		if raw := value("annual_revenue"); raw != nil {
			parsed, err := strconv.ParseFloat(*raw, 64)
			if err != nil {
				return nil, NewAPIError(http.StatusBadRequest, "annual_revenue 必须是数字")
			}
			row.AnnualRevenue = &parsed
		}
		if raw := value("employee_count"); raw != nil {
			parsed, err := strconv.Atoi(*raw)
			if err != nil {
				return nil, NewAPIError(http.StatusBadRequest, "employee_count 必须是整数")
			}
			row.EmployeeCount = &parsed
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func parseCustomerXLSX(data []byte) ([]CustomerSeaImportRow, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, NewAPIError(http.StatusBadRequest, "XLSX 文件格式错误")
	}
	var shared []string
	sharedFile, err := reader.Open("xl/sharedStrings.xml")
	if err == nil {
		defer sharedFile.Close()
		var parsed struct {
			Items []struct {
				Text     string `xml:"t"`
				Fallback string `xml:",chardata"`
			} `xml:"si"`
		}
		if err := xml.NewDecoder(io.LimitReader(sharedFile, 64<<20)).Decode(&parsed); err == nil {
			for _, item := range parsed.Items {
				value := item.Text
				if value == "" {
					value = item.Fallback
				}
				shared = append(shared, value)
			}
		}
	}
	sheetFile, err := reader.Open("xl/worksheets/sheet1.xml")
	if err != nil {
		return nil, NewAPIError(http.StatusBadRequest, "XLSX 缺少首个工作表")
	}
	defer sheetFile.Close()
	var parsed struct {
		Rows []struct {
			Cells []struct {
				Ref    string `xml:"r,attr"`
				Type   string `xml:"t,attr"`
				Value  string `xml:"v"`
				Inline struct {
					Text string `xml:"t"`
				} `xml:"is"`
			} `xml:"c"`
		} `xml:"sheetData>row"`
	}
	if err := xml.NewDecoder(io.LimitReader(sheetFile, 64<<20)).Decode(&parsed); err != nil {
		return nil, NewAPIError(http.StatusBadRequest, "XLSX 工作表格式错误")
	}
	rows := make([][]string, 0, len(parsed.Rows))
	for _, row := range parsed.Rows {
		maxColumn := 0
		for _, cell := range row.Cells {
			if column := xlsxColumnIndex(cell.Ref); column > maxColumn {
				maxColumn = column
			}
		}
		values := make([]string, maxColumn)
		for _, cell := range row.Cells {
			value := cell.Value
			if cell.Inline.Text != "" {
				value = cell.Inline.Text
			}
			if cell.Type == "s" {
				index, parseErr := strconv.Atoi(value)
				if parseErr == nil && index >= 0 && index < len(shared) {
					value = shared[index]
				}
			}
			column := xlsxColumnIndex(cell.Ref)
			if column > 0 && column <= len(values) {
				values[column-1] = value
			}
		}
		rows = append(rows, values)
	}
	if len(rows) < 2 {
		return nil, NewAPIError(http.StatusBadRequest, "XLSX 导入文件为空")
	}
	headerIndex := map[string]int{}
	for index, header := range rows[0] {
		headerIndex[strings.TrimSpace(header)] = index
	}
	if _, ok := headerIndex["name"]; !ok {
		return nil, NewAPIError(http.StatusBadRequest, "XLSX 缺少必填列: name")
	}
	result := make([]CustomerSeaImportRow, 0, len(rows)-1)
	for _, values := range rows[1:] {
		value := func(header string) *string {
			index, ok := headerIndex[header]
			if !ok || index >= len(values) || strings.TrimSpace(values[index]) == "" {
				return nil
			}
			item := strings.TrimSpace(values[index])
			return &item
		}
		row := CustomerSeaImportRow{
			Name:              pointerValue(value("name")),
			ShortName:         value("short_name"),
			Industry:          value("industry"),
			CustomerType:      value("customer_type"),
			InterestedService: value("interested_service"),
			Rating:            value("rating"),
			Status:            value("status"),
			Source:            value("source"),
			Address:           value("address"),
			Website:           value("website"),
			Remark:            value("remark"),
			ContactName:       value("contact_name"),
			ContactPhone:      value("contact_phone"),
			ContactEmail:      value("contact_email"),
		}
		if raw := value("annual_revenue"); raw != nil {
			parsed, parseErr := strconv.ParseFloat(*raw, 64)
			if parseErr != nil {
				return nil, NewAPIError(http.StatusBadRequest, "annual_revenue 必须是数字")
			}
			row.AnnualRevenue = &parsed
		}
		if raw := value("employee_count"); raw != nil {
			parsed, parseErr := strconv.Atoi(*raw)
			if parseErr != nil {
				return nil, NewAPIError(http.StatusBadRequest, "employee_count 必须是整数")
			}
			row.EmployeeCount = &parsed
		}
		result = append(result, row)
	}
	return result, nil
}

func xlsxColumnIndex(ref string) int {
	ref = strings.TrimSpace(ref)
	column := 0
	for index := 0; index < len(ref); index++ {
		ch := ref[index]
		if ch >= 'a' && ch <= 'z' {
			ch -= 'a' - 'A'
		}
		if ch < 'A' || ch > 'Z' {
			break
		}
		column = column*26 + int(ch-'A'+1)
	}
	return column
}

func runSSE(
	ctx context.Context,
	w http.ResponseWriter,
	event string,
	tick time.Duration,
	fetch func(context.Context) ([]any, error),
) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		WriteError(w, NewAPIError(http.StatusInternalServerError, "streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	pushed := map[string]bool{}
	send := func() bool {
		items, err := fetch(ctx)
		if err != nil {
			_, _ = io.WriteString(w, ": tick-error\n\n")
			flusher.Flush()
		} else {
			for _, item := range items {
				payload, marshalErr := json.Marshal(item)
				if marshalErr != nil {
					continue
				}
				key := string(payload)
				if pushed[key] {
					continue
				}
				pushed[key] = true
				_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload)
			}
		}
		_, _ = io.WriteString(w, ": keep-alive\n\n")
		flusher.Flush()
		return ctx.Err() == nil
	}
	if !send() {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !send() {
				return
			}
		}
	}
}

func validateLength(value string, min, max int, field string) error {
	length := len([]rune(strings.TrimSpace(value)))
	if length < min || length > max {
		return NewAPIError(
			http.StatusUnprocessableEntity,
			fmt.Sprintf("%s must contain %d to %d characters", field, min, max),
		)
	}
	return nil
}

func validateDateString(value *string, field string) error {
	if value == nil || *value == "" {
		return nil
	}
	if _, err := time.Parse("2006-01-02", *value); err != nil {
		return NewAPIError(http.StatusUnprocessableEntity, field+" must use YYYY-MM-DD")
	}
	return nil
}

func timeMonthRange(month string) (time.Time, time.Time, error) {
	parts := strings.Split(strings.TrimSpace(month), "-")
	if len(parts) != 2 {
		return time.Time{}, time.Time{}, NewAPIError(http.StatusBadRequest, "month 须为 YYYY-MM 格式")
	}
	year, yearErr := strconv.Atoi(parts[0])
	monthNumber, monthErr := strconv.Atoi(parts[1])
	if yearErr != nil || monthErr != nil || year < 1 || monthNumber < 1 || monthNumber > 12 {
		return time.Time{}, time.Time{}, NewAPIError(http.StatusBadRequest, "month 须为 YYYY-MM 格式")
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		location = time.FixedZone("CST", 8*60*60)
	}
	start := time.Date(year, time.Month(monthNumber), 1, 0, 0, 0, 0, location)
	end := start.AddDate(0, 1, 0)
	return start, end, nil
}

func malformedMultipart(err error) error {
	if errors.Is(err, http.ErrNotMultipart) {
		return NewAPIError(http.StatusBadRequest, "Invalid multipart form")
	}
	return NewAPIError(http.StatusBadRequest, "Invalid multipart form")
}
