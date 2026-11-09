package store

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
)

type inventoryLedgerKind string

const (
	inventoryLedgerUnknown inventoryLedgerKind = ""
	inventoryLedgerSummary inventoryLedgerKind = "summary"
	inventoryLedgerDetail  inventoryLedgerKind = "detail"
)

var inventoryLedgerSummaryHeaders = []string{
	"date",
	"fnsku",
	"asin",
	"msku",
	"title",
	"disposition",
	"starting_warehouse_balance",
	"in_transit_between_warehouses",
	"receipts",
	"customer_shipments",
	"customer_returns",
	"vendor_returns",
	"warehouse_transfer_in/out",
	"found",
	"lost",
	"damaged",
	"disposed",
	"other_events",
	"ending_warehouse_balance",
	"unknown_events",
	"location",
	"store",
}

var inventoryLedgerDetailHeaders = []string{
	"date",
	"fnsku",
	"asin",
	"msku",
	"title",
	"event_type",
	"reference_id",
	"quantity",
	"fulfillment_center",
	"disposition",
	"reason",
	"country",
	"reconciled_quantity",
	"unreconciled_quantity",
	"date_and_time",
	"store",
}

var inventoryLedgerDispositions = map[string]bool{
	"SELLABLE":          true,
	"CUSTOMER_DAMAGED":  true,
	"CARRIER_DAMAGED":   true,
	"WAREHOUSE_DAMAGED": true,
}

var inventoryLedgerEventTypes = map[string]bool{
	"Receipts":        true,
	"Shipments":       true,
	"WhseTransfers":   true,
	"CustomerReturns": true,
	"VendorReturns":   true,
	"Adjustments":     true,
}

var inventoryLedgerCompactDatePattern = regexp.MustCompile(
	`(?:^|[^0-9])(20[0-9]{2})-?([0-9]{2})([0-9]{2})(?:[^0-9]|$)`,
)
var inventoryLedgerMonthPattern = regexp.MustCompile(
	`(?:^|[^0-9])(20[0-9]{2})-([0-9]{2})(?:[^0-9]|$)`,
)

type inventoryLedgerSpec struct {
	kind            inventoryLedgerKind
	headers         []string
	stageColumns    []string
	stageTable      string
	targetTable     string
	stageDefinition string
}

type inventoryLedgerReader struct {
	file        *os.File
	reader      *csv.Reader
	spec        inventoryLedgerSpec
	headerIndex map[string]int
}

type inventoryLedgerValidationError struct {
	Message string
}

func (err *inventoryLedgerValidationError) Error() string {
	return err.Message
}

func inventoryLedgerValidation(format string, args ...any) error {
	return &inventoryLedgerValidationError{Message: fmt.Sprintf(format, args...)}
}

func inventoryLedgerSpecFor(kind inventoryLedgerKind) inventoryLedgerSpec {
	if kind == inventoryLedgerDetail {
		return inventoryLedgerSpec{
			kind:         inventoryLedgerDetail,
			headers:      inventoryLedgerDetailHeaders,
			stageColumns: inventoryLedgerDetailHeaders,
			stageTable:   "stage_10f_inventory_ledger_detail",
			targetTable:  "inventory_ledger_detail",
			stageDefinition: `CREATE TEMP TABLE stage_10f_inventory_ledger_detail (
				"date" DATE NOT NULL,
				"fnsku" VARCHAR(20),
				"asin" VARCHAR(15),
				"msku" VARCHAR(30) NOT NULL,
				"title" VARCHAR(500),
				"event_type" VARCHAR(40) NOT NULL,
				"reference_id" VARCHAR(64),
				"quantity" INTEGER NOT NULL,
				"fulfillment_center" VARCHAR(10) NOT NULL,
				"disposition" VARCHAR(20) NOT NULL,
				"reason" VARCHAR(20),
				"country" VARCHAR(10),
				"reconciled_quantity" INTEGER,
				"unreconciled_quantity" INTEGER,
				"date_and_time" TIMESTAMPTZ,
				"store" VARCHAR(50)
			) ON COMMIT DROP`,
		}
	}
	return inventoryLedgerSpec{
		kind:    inventoryLedgerSummary,
		headers: inventoryLedgerSummaryHeaders,
		stageColumns: []string{
			"date",
			"fnsku",
			"asin",
			"msku",
			"title",
			"disposition",
			"starting_balance",
			"in_transit_between",
			"receipts",
			"customer_shipments",
			"customer_returns",
			"vendor_returns",
			"warehouse_transfer_io",
			"found",
			"lost",
			"damaged",
			"disposed",
			"other_events",
			"ending_balance",
			"unknown_events",
			"location",
			"store",
		},
		stageTable:  "stage_10f_inventory_ledger_summary",
		targetTable: "inventory_ledger_summary",
		stageDefinition: `CREATE TEMP TABLE stage_10f_inventory_ledger_summary (
			"date" DATE NOT NULL,
			"fnsku" VARCHAR(20),
			"asin" VARCHAR(15),
			"msku" VARCHAR(30) NOT NULL,
			"title" VARCHAR(500),
			"disposition" VARCHAR(20) NOT NULL,
			"starting_balance" INTEGER NOT NULL,
			"in_transit_between" INTEGER NOT NULL,
			"receipts" INTEGER NOT NULL,
			"customer_shipments" INTEGER NOT NULL,
			"customer_returns" INTEGER NOT NULL,
			"vendor_returns" INTEGER NOT NULL,
			"warehouse_transfer_io" INTEGER NOT NULL,
			"found" INTEGER NOT NULL,
			"lost" INTEGER NOT NULL,
			"damaged" INTEGER NOT NULL,
			"disposed" INTEGER NOT NULL,
			"other_events" INTEGER NOT NULL,
			"ending_balance" INTEGER NOT NULL,
			"unknown_events" INTEGER NOT NULL,
			"location" VARCHAR(10) NOT NULL,
			"store" VARCHAR(50)
		) ON COMMIT DROP`,
	}
}

func (store *UploadStore) persistLedgerReport(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	operator string,
) (persistResult, error) {
	if strings.TrimSpace(file.LocalPath) == "" {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "库存分类账文件路径无效")
	}
	expectedKind := inventoryLedgerUnknown
	switch normalizeReportType(payload.ReportType) {
	case "inventory_ledger_summary":
		expectedKind = inventoryLedgerSummary
	case "inventory_ledger_detail":
		expectedKind = inventoryLedgerDetail
	case "inventory_ledger":
	default:
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "不支持的库存分类账报表类型")
	}

	result := persistResult{Status: "persisted"}
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		var projectCountry string
		if err := tx.QueryRow(
			ctx,
			`SELECT country FROM public.projects WHERE id = $1 FOR UPDATE`,
			project.ID,
		).Scan(&projectCountry); err != nil {
			return err
		}
		country := normalizeStoreCountry(payload.Country)
		if country == "" || normalizeStoreCountry(projectCountry) != country {
			return uploads.NewAPIError(
				http.StatusBadRequest,
				"库存分类账站点与项目站点不一致，请确认后重新上传",
			)
		}

		reader, err := openInventoryLedgerReader(file.LocalPath, expectedKind)
		if err != nil {
			return err
		}
		defer reader.file.Close()

		txDB := NewTxDB(tx)
		if _, err := txDB.Exec(
			ctx,
			`DROP TABLE IF EXISTS `+inventoryLedgerTempIdentifier(reader.spec.stageTable),
		); err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, reader.spec.stageDefinition); err != nil {
			return err
		}

		source := &inventoryLedgerCopySource{
			reader:          reader,
			selectedCountry: country,
		}
		copied, err := tx.CopyFrom(
			ctx,
			pgx.Identifier{reader.spec.stageTable},
			reader.spec.stageColumns,
			source,
		)
		if err != nil {
			if sourceErr := source.Err(); sourceErr != nil {
				return sourceErr
			}
			return err
		}
		if copied == 0 {
			return inventoryLedgerValidation("库存分类账 CSV 没有可入库的数据行")
		}

		reportMonth, err := inventoryLedgerReportMonth(
			ctx,
			txDB,
			reader.spec.stageTable,
			file.OriginalFilename,
		)
		if err != nil {
			return err
		}
		periodStart := time.Date(reportMonth.Year(), reportMonth.Month(), 1, 0, 0, 0, 0, time.UTC)
		periodEnd := time.Date(reportMonth.Year(), reportMonth.Month()+1, 0, 0, 0, 0, 0, time.UTC)

		fileHash, err := fileSHA256(file.LocalPath)
		if err != nil {
			return err
		}
		batchID, existingSuccess, existingSourceID, err := inventoryLedgerBatch(
			ctx,
			txDB,
			project.ID,
			country,
			periodStart,
			file.OriginalFilename,
			fileHash,
			file.Size,
			string(reader.spec.kind),
			nullableOperator(operator),
			int(copied),
		)
		if err != nil {
			return err
		}

		if existingSuccess {
			rowCount := 0
			tableName := reader.spec.targetTable
			result.RowsIngested = &rowCount
			result.Table = &tableName
			result.Message = inventoryLedgerMessage(normalizeReportType(payload.ReportType), reader.spec.kind, 0)
			result.ReportStartDate = formatDatePointer(&periodStart)
			result.ReportEndDate = formatDatePointer(&periodEnd)
			if existingSourceID > 0 {
				result.SourceID = &existingSourceID
			}
			return nil
		}

		sourceID, err := insertInventoryLedgerAnalysisSource(
			ctx,
			txDB,
			project.ID,
			country,
			reader.spec.kind,
			periodStart,
			periodEnd,
			file,
			int(copied),
			nullableOperator(operator),
		)
		if err != nil {
			return err
		}
		if err := inventoryLedgerInsertStaged(
			ctx,
			txDB,
			reader.spec,
			project.ID,
			periodStart,
			batchID,
		); err != nil {
			return err
		}
		if _, err := txDB.Exec(
			ctx,
			`UPDATE public.inventory_ledger_ingest_batch
			 SET status = 'success',
			     rows_written_summary = CASE WHEN $2 = 'summary' THEN $3 ELSE 0 END,
			     rows_written_detail = CASE WHEN $2 = 'detail' THEN $3 ELSE 0 END,
			     error_message = NULL,
			     completed_at = now()
			 WHERE id = $1`,
			batchID,
			string(reader.spec.kind),
			copied,
		); err != nil {
			return err
		}

		rowCount := int(copied)
		tableName := reader.spec.targetTable
		result.SourceID = &sourceID
		result.Table = &tableName
		result.RowsIngested = &rowCount
		result.Message = inventoryLedgerMessage(normalizeReportType(payload.ReportType), reader.spec.kind, rowCount)
		result.ReportStartDate = formatDatePointer(&periodStart)
		result.ReportEndDate = formatDatePointer(&periodEnd)
		return nil
	})
	if err != nil {
		return persistResult{}, inventoryLedgerPublicError(err)
	}
	return result, nil
}

func openInventoryLedgerReader(
	path string,
	expectedKind inventoryLedgerKind,
) (*inventoryLedgerReader, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	buffered := bufio.NewReader(file)
	if bom, _ := buffered.Peek(3); bytes.Equal(bom, []byte{0xef, 0xbb, 0xbf}) {
		_, _ = buffered.Discard(3)
	}
	reader := csv.NewReader(buffered)
	reader.FieldsPerRecord = 0
	reader.ReuseRecord = true
	header, err := reader.Read()
	if err != nil {
		_ = file.Close()
		if errors.Is(err, io.EOF) {
			return nil, inventoryLedgerValidation("库存分类账 CSV 为空")
		}
		return nil, inventoryLedgerValidation("库存分类账 CSV 表头无法解析: %v", err)
	}
	normalized := make([]string, len(header))
	seen := make(map[string]bool, len(header))
	for index, value := range header {
		name := normalizeInventoryLedgerHeader(value)
		if name == "" {
			_ = file.Close()
			return nil, inventoryLedgerValidation("库存分类账 CSV 第 %d 列表头为空", index+1)
		}
		if seen[name] {
			_ = file.Close()
			return nil, inventoryLedgerValidation("库存分类账 CSV 表头重复: %s", name)
		}
		seen[name] = true
		normalized[index] = name
	}

	detected, err := detectInventoryLedgerKind(normalized)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	kind := detected
	if expectedKind != inventoryLedgerUnknown {
		if detected != inventoryLedgerUnknown && detected != expectedKind {
			_ = file.Close()
			return nil, inventoryLedgerValidation(
				"报表类型与文件内容不一致：声明为 %s，实际检测为 %s",
				expectedKind,
				detected,
			)
		}
		kind = expectedKind
	}
	if kind == inventoryLedgerUnknown {
		_ = file.Close()
		return nil, inventoryLedgerValidation(
			"无法识别报表类型：列头既不是 Summary 视图（Starting/Ending Warehouse Balance）也不是 Detailed 视图（Event Type / Quantity）",
		)
	}

	spec := inventoryLedgerSpecFor(kind)
	indexes := make(map[string]int, len(normalized))
	for index, name := range normalized {
		indexes[name] = index
	}
	missing := make([]string, 0)
	for _, required := range spec.headers {
		if _, ok := indexes[required]; !ok {
			missing = append(missing, required)
		}
	}
	if len(missing) > 0 {
		_ = file.Close()
		return nil, inventoryLedgerValidation(
			"库存分类账缺少必要列: %s",
			strings.Join(missing, ", "),
		)
	}
	return &inventoryLedgerReader{
		file:        file,
		reader:      reader,
		spec:        spec,
		headerIndex: indexes,
	}, nil
}

func detectInventoryLedgerKind(headers []string) (inventoryLedgerKind, error) {
	set := make(map[string]bool, len(headers))
	for _, header := range headers {
		set[header] = true
	}
	summarySignals := set["starting_warehouse_balance"] || set["ending_warehouse_balance"]
	detailSignals := 0
	for _, marker := range []string{"event_type", "quantity", "fulfillment_center", "reference_id"} {
		if set[marker] {
			detailSignals++
		}
	}
	if summarySignals && detailSignals >= 2 {
		return inventoryLedgerUnknown, inventoryLedgerValidation(
			"库存分类账格式冲突：同时包含 Summary 与 Detail 的关键字段",
		)
	}
	if set["event_type"] && set["quantity"] && set["fulfillment_center"] {
		return inventoryLedgerDetail, nil
	}
	if summarySignals {
		return inventoryLedgerSummary, nil
	}
	if detailSignals >= 2 {
		return inventoryLedgerDetail, nil
	}
	return inventoryLedgerUnknown, nil
}

func normalizeInventoryLedgerHeader(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(value, "\ufeff")))
	return strings.Join(strings.Fields(value), "_")
}

type inventoryLedgerCopySource struct {
	reader          *inventoryLedgerReader
	selectedCountry string
	values          []any
	err             error
}

func (source *inventoryLedgerCopySource) Next() bool {
	if source.err != nil {
		return false
	}
	record, err := source.reader.reader.Read()
	if errors.Is(err, io.EOF) {
		return false
	}
	if err != nil {
		line, _ := source.reader.reader.FieldPos(0)
		source.err = inventoryLedgerValidation(
			"库存分类账 CSV 第 %d 行无法解析: %v",
			line,
			err,
		)
		return true
	}
	values, err := parseInventoryLedgerRecord(source.reader, record, source.selectedCountry)
	if err != nil {
		source.err = err
		return true
	}
	source.values = values
	return true
}

func (source *inventoryLedgerCopySource) Values() ([]any, error) {
	if source.err != nil {
		return nil, source.err
	}
	return source.values, nil
}

func (source *inventoryLedgerCopySource) Err() error {
	return source.err
}

func parseInventoryLedgerRecord(
	reader *inventoryLedgerReader,
	record []string,
	selectedCountry string,
) ([]any, error) {
	line := 1
	if reader.reader != nil {
		line, _ = reader.reader.FieldPos(0)
	}
	value := func(name string) string {
		index := reader.headerIndex[name]
		if index >= len(record) {
			return ""
		}
		return strings.TrimSpace(record[index])
	}
	if reader.spec.kind == inventoryLedgerSummary {
		return parseInventoryLedgerSummaryRecord(reader, value, line)
	}
	return parseInventoryLedgerDetailRecord(reader, value, selectedCountry, line)
}

func parseInventoryLedgerSummaryRecord(
	reader *inventoryLedgerReader,
	value func(string) string,
	line int,
) ([]any, error) {
	date, err := parseInventoryLedgerDate(value("date"), line)
	if err != nil {
		return nil, err
	}
	disposition, err := inventoryLedgerDisposition(value("disposition"), line)
	if err != nil {
		return nil, err
	}
	values := make([]any, 0, len(inventoryLedgerSummaryHeaders))
	values = append(values, date)
	for _, name := range []string{"fnsku", "asin"} {
		item, err := inventoryLedgerOptionalText(value(name), name, 20, line)
		if err != nil {
			return nil, err
		}
		values = append(values, item)
	}
	msku, err := inventoryLedgerRequiredText(value("msku"), "msku", 30, line)
	if err != nil {
		return nil, err
	}
	values = append(values, msku)
	title, err := inventoryLedgerOptionalText(value("title"), "title", 500, line)
	if err != nil {
		return nil, err
	}
	values = append(values, title, disposition)
	for _, name := range []string{
		"starting_warehouse_balance",
		"in_transit_between_warehouses",
		"receipts",
		"customer_shipments",
		"customer_returns",
		"vendor_returns",
		"warehouse_transfer_in/out",
		"found",
		"lost",
		"damaged",
		"disposed",
		"other_events",
		"ending_warehouse_balance",
		"unknown_events",
	} {
		item, err := inventoryLedgerInteger(value(name), name, line, false)
		if err != nil {
			return nil, err
		}
		values = append(values, item)
	}
	location, err := inventoryLedgerRequiredText(value("location"), "location", 10, line)
	if err != nil {
		return nil, err
	}
	values = append(values, location)
	store, err := inventoryLedgerOptionalText(value("store"), "store", 50, line)
	if err != nil {
		return nil, err
	}
	values = append(values, store)
	if len(values) != len(reader.spec.headers) {
		return nil, inventoryLedgerValidation("库存分类账 Summary 列映射数量异常")
	}
	return values, nil
}

func parseInventoryLedgerDetailRecord(
	reader *inventoryLedgerReader,
	value func(string) string,
	selectedCountry string,
	line int,
) ([]any, error) {
	date, err := parseInventoryLedgerDate(value("date"), line)
	if err != nil {
		return nil, err
	}
	values := make([]any, 0, len(inventoryLedgerDetailHeaders))
	values = append(values, date)
	for _, name := range []string{"fnsku", "asin"} {
		item, err := inventoryLedgerOptionalText(value(name), name, 20, line)
		if err != nil {
			return nil, err
		}
		values = append(values, item)
	}
	msku, err := inventoryLedgerRequiredText(value("msku"), "msku", 30, line)
	if err != nil {
		return nil, err
	}
	values = append(values, msku)
	title, err := inventoryLedgerOptionalText(value("title"), "title", 500, line)
	if err != nil {
		return nil, err
	}
	values = append(values, title)
	eventType, err := inventoryLedgerEventType(value("event_type"), line)
	if err != nil {
		return nil, err
	}
	values = append(values, eventType)
	referenceID, err := inventoryLedgerOptionalText(value("reference_id"), "reference_id", 64, line)
	if err != nil {
		return nil, err
	}
	values = append(values, referenceID)
	quantity, err := inventoryLedgerInteger(value("quantity"), "quantity", line, true)
	if err != nil {
		return nil, err
	}
	values = append(values, quantity)
	fulfillmentCenter, err := inventoryLedgerRequiredText(
		value("fulfillment_center"),
		"fulfillment_center",
		10,
		line,
	)
	if err != nil {
		return nil, err
	}
	values = append(values, fulfillmentCenter)
	disposition, err := inventoryLedgerDisposition(value("disposition"), line)
	if err != nil {
		return nil, err
	}
	values = append(values, disposition)
	reason, err := inventoryLedgerOptionalText(value("reason"), "reason", 20, line)
	if err != nil {
		return nil, err
	}
	values = append(values, reason)
	rowCountry, err := inventoryLedgerRowCountry(value("country"), selectedCountry, line)
	if err != nil {
		return nil, err
	}
	values = append(values, rowCountry)
	reconciled, err := inventoryLedgerOptionalInteger(
		value("reconciled_quantity"),
		"reconciled_quantity",
		line,
	)
	if err != nil {
		return nil, err
	}
	values = append(values, reconciled)
	unreconciled, err := inventoryLedgerOptionalInteger(
		value("unreconciled_quantity"),
		"unreconciled_quantity",
		line,
	)
	if err != nil {
		return nil, err
	}
	values = append(values, unreconciled)
	dateTime, err := inventoryLedgerDateTime(value("date_and_time"), line)
	if err != nil {
		return nil, err
	}
	values = append(values, dateTime)
	store, err := inventoryLedgerOptionalText(value("store"), "store", 50, line)
	if err != nil {
		return nil, err
	}
	values = append(values, store)
	if len(values) != len(reader.spec.headers) {
		return nil, inventoryLedgerValidation("库存分类账 Detail 列映射数量异常")
	}
	return values, nil
}

func parseInventoryLedgerDate(value string, line int) (time.Time, error) {
	if value == "" {
		return time.Time{}, inventoryLedgerValidation("第 %d 行 date 为空", line)
	}
	for _, layout := range []string{"1/2/2006", "1/2006"} {
		parsed, err := time.ParseInLocation(layout, value, time.UTC)
		if err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, inventoryLedgerValidation(
		"第 %d 行 date 格式无效，应为 MM/DD/YYYY 或 MM/YYYY: %s",
		line,
		value,
	)
}

func inventoryLedgerDateTime(value string, line int) (any, error) {
	if value == "" {
		return nil, nil
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05-0700",
		"2006-01-02T15:04:05Z0700",
		"2006-01-02 15:04:05-0700",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, nil
		}
	}
	return nil, inventoryLedgerValidation(
		"第 %d 行 date_and_time 格式无效: %s",
		line,
		value,
	)
}

func inventoryLedgerInteger(
	value string,
	name string,
	line int,
	required bool,
) (any, error) {
	if value == "" {
		if required {
			return nil, inventoryLedgerValidation("第 %d 行 %s 为空", line, name)
		}
		return int32(0), nil
	}
	if strings.ContainsAny(value, ".eE,") {
		return nil, inventoryLedgerValidation(
			"第 %d 行 %s 不是有效整数: %s",
			line,
			name,
			value,
		)
	}
	parsed, err := strconv.ParseInt(value, 10, 32)
	if err != nil || parsed < math.MinInt32 || parsed > math.MaxInt32 {
		return nil, inventoryLedgerValidation(
			"第 %d 行 %s 不是有效整数: %s",
			line,
			name,
			value,
		)
	}
	return int32(parsed), nil
}

func inventoryLedgerOptionalInteger(
	value string,
	name string,
	line int,
) (any, error) {
	if value == "" {
		return nil, nil
	}
	return inventoryLedgerInteger(value, name, line, true)
}

func inventoryLedgerRequiredText(
	value string,
	name string,
	limit int,
	line int,
) (any, error) {
	item, err := inventoryLedgerOptionalText(value, name, limit, line)
	if err != nil {
		return nil, err
	}
	if item == nil {
		return nil, inventoryLedgerValidation("第 %d 行 %s 为空", line, name)
	}
	return item, nil
}

func inventoryLedgerOptionalText(
	value string,
	name string,
	limit int,
	line int,
) (any, error) {
	if strings.ContainsRune(value, '\x00') || !utf8.ValidString(value) {
		return nil, inventoryLedgerValidation("第 %d 行 %s 包含非法字符", line, name)
	}
	if value == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(value) > limit {
		return nil, inventoryLedgerValidation(
			"第 %d 行 %s 超过长度限制 %d",
			line,
			name,
			limit,
		)
	}
	return value, nil
}

func inventoryLedgerDisposition(value string, line int) (any, error) {
	if value == "" {
		return nil, inventoryLedgerValidation("第 %d 行 disposition 为空", line)
	}
	if !inventoryLedgerDispositions[value] {
		return nil, inventoryLedgerValidation(
			"第 %d 行 disposition 枚举无效: %s",
			line,
			value,
		)
	}
	return value, nil
}

func inventoryLedgerEventType(value string, line int) (any, error) {
	if value == "" {
		return nil, inventoryLedgerValidation("第 %d 行 event_type 为空", line)
	}
	if !inventoryLedgerEventTypes[value] {
		return nil, inventoryLedgerValidation(
			"第 %d 行 event_type 枚举无效: %s",
			line,
			value,
		)
	}
	return value, nil
}

func inventoryLedgerRowCountry(
	value string,
	selectedCountry string,
	line int,
) (any, error) {
	if value == "" {
		return selectedCountry, nil
	}
	country := normalizeStoreCountry(value)
	if country == "" {
		return nil, inventoryLedgerValidation(
			"第 %d 行 country 枚举无效: %s",
			line,
			value,
		)
	}
	if country != selectedCountry {
		return nil, inventoryLedgerValidation(
			"第 %d 行 country (%s) 与项目站点 (%s) 不一致",
			line,
			country,
			selectedCountry,
		)
	}
	if len(country) > 10 {
		return nil, inventoryLedgerValidation("第 %d 行 country 超过长度限制", line)
	}
	return country, nil
}

func inventoryLedgerReportMonth(
	ctx context.Context,
	db DB,
	stageTable string,
	filename string,
) (time.Time, error) {
	if month, ok := inventoryLedgerFilenameMonth(filename); ok {
		return month, nil
	}
	var earliest time.Time
	err := db.QueryRow(
		ctx,
		`SELECT min("date") FROM `+inventoryLedgerTempIdentifier(stageTable),
	).Scan(&earliest)
	if err != nil {
		return time.Time{}, err
	}
	if earliest.IsZero() {
		return time.Time{}, inventoryLedgerValidation(
			"无法从文件名或数据日期确定库存分类账报告月份",
		)
	}
	return time.Date(earliest.Year(), earliest.Month(), 1, 0, 0, 0, 0, time.UTC), nil
}

func inventoryLedgerFilenameMonth(filename string) (time.Time, bool) {
	for _, pattern := range []*regexp.Regexp{
		inventoryLedgerCompactDatePattern,
		inventoryLedgerMonthPattern,
	} {
		match := pattern.FindStringSubmatch(filename)
		if len(match) < 3 {
			continue
		}
		year, yearErr := strconv.Atoi(match[1])
		month, monthErr := strconv.Atoi(match[2])
		if yearErr != nil || monthErr != nil || month < 1 || month > 12 {
			continue
		}
		value := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC)
		if value.Year() == year && int(value.Month()) == month {
			return value, true
		}
	}
	return time.Time{}, false
}

func inventoryLedgerBatch(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	reportMonth time.Time,
	filename string,
	fileHash string,
	fileSize int64,
	fileKind string,
	loadedBy *string,
	rowCount int,
) (int64, bool, int64, error) {
	if utf8.RuneCountInString(filename) > 256 {
		return 0, false, 0, inventoryLedgerValidation(
			"库存分类账原始文件名超过长度限制 256",
		)
	}
	var batchID int64
	var status string
	err := db.QueryRow(
		ctx,
		`SELECT id, status
		 FROM public.inventory_ledger_ingest_batch
		 WHERE project_id = $1
		   AND report_month = $2
		   AND source_filename = $3
		   AND file_hash = $4
		 FOR UPDATE`,
		projectID,
		dateOnly(reportMonth),
		filename,
		fileHash,
	).Scan(&batchID, &status)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, 0, err
	}
	if err == nil && status == "success" {
		var sourceID int64
		err := db.QueryRow(
			ctx,
			`SELECT id
			 FROM public.analysis_source_files
			 WHERE project_id = $1
			   AND report_type = 'inventory_report'
			   AND country = $2
			   AND period_start_date = $3
			   AND period_end_date = $4
			   AND file_sha256 = $5
			 ORDER BY version DESC, id DESC
			 LIMIT 1`,
			projectID,
			country,
			dateOnly(reportMonth),
			dateOnly(time.Date(reportMonth.Year(), reportMonth.Month()+1, 0, 0, 0, 0, 0, time.UTC)),
			fileHash,
		).Scan(&sourceID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return 0, false, 0, err
		}
		return batchID, true, sourceID, nil
	}

	if err == nil {
		_, updateErr := db.(Execer).Exec(
			ctx,
			`UPDATE public.inventory_ledger_ingest_batch
			 SET status = 'running',
			     rows_parsed = $2,
			     rows_written_summary = 0,
			     rows_written_detail = 0,
			     rows_failed_validation = 0,
			     error_message = NULL,
			     completed_at = NULL,
			     loaded_by = coalesce($3, loaded_by)
			 WHERE id = $1`,
			batchID,
			rowCount,
			loadedBy,
		)
		return batchID, false, 0, updateErr
	}

	err = db.QueryRow(
		ctx,
		`INSERT INTO public.inventory_ledger_ingest_batch (
		   project_id, report_month, source_filename, file_hash,
		   file_size_bytes, file_kind, loaded_by, status, rows_parsed
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8)
		 RETURNING id`,
		projectID,
		dateOnly(reportMonth),
		filename,
		fileHash,
		fileSize,
		fileKind,
		loadedBy,
		rowCount,
	).Scan(&batchID)
	return batchID, false, 0, err
}

func insertInventoryLedgerAnalysisSource(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	kind inventoryLedgerKind,
	periodStart time.Time,
	periodEnd time.Time,
	file uploads.PreparedReportFile,
	rowCount int,
	createdBy *string,
) (int64, error) {
	hash, err := fileSHA256(file.LocalPath)
	if err != nil {
		return 0, err
	}
	// The existing analysis_source_files check constraint only permits
	// inventory_report snapshot sources. The ledger batch carries the real
	// summary/detail kind and is used to keep source versions separated.
	const ledgerSourceMatch = `
		EXISTS (
			SELECT 1
			FROM public.inventory_ledger_ingest_batch b
			WHERE b.project_id = f.project_id
			  AND b.file_hash = f.file_sha256
			  AND b.source_filename = f.original_filename
			  AND b.report_month = f.period_start_date
			  AND b.file_kind = $5
		)`
	var version int
	err = db.QueryRow(
		ctx,
		`SELECT coalesce(max(f.version), 0) + 1
		 FROM public.analysis_source_files f
		 WHERE f.project_id = $1
		   AND f.report_type = 'inventory_report'
		   AND f.country = $2
		   AND f.period_start_date = $3
		   AND f.period_end_date = $4
		   AND `+ledgerSourceMatch,
		projectID,
		country,
		dateOnly(periodStart),
		dateOnly(periodEnd),
		string(kind),
	).Scan(&version)
	if err != nil {
		return 0, err
	}
	_, err = db.(Execer).Exec(
		ctx,
		`UPDATE public.analysis_source_files f
		 SET is_current = false,
		     superseded_at = now()
		 WHERE f.project_id = $1
		   AND f.report_type = 'inventory_report'
		   AND f.country = $2
		   AND f.period_start_date = $3
		   AND f.period_end_date = $4
		   AND coalesce(f.is_current, true)
		   AND `+ledgerSourceMatch,
		projectID,
		country,
		dateOnly(periodStart),
		dateOnly(periodEnd),
		string(kind),
	)
	if err != nil {
		return 0, err
	}
	logicalName := fmt.Sprintf(
		"inventory_ledger_%s_v%d_%s",
		kind,
		version,
		file.Filename,
	)
	var sourceID int64
	err = db.QueryRow(
		ctx,
		`INSERT INTO public.analysis_source_files (
		   project_id, report_type, country, report_date, period_start_date,
		   period_end_date, snapshot_at, version, is_current, superseded_at,
		   upload_file_id, upload_file_path, original_filename, stored_filename,
		   logical_filename, storage_key, file_size_bytes, file_sha256,
		   ingestion_status, ingestion_error, row_count_total, row_count_included,
		   created_by
		 ) VALUES (
		   $1, 'inventory_report', $2, NULL, $3, $4, $5, $6, true, NULL,
		   $7, $8, $9, $10, $11, $12, $13, $14,
		   'success', NULL, $15, $15, $16
		 )
		 RETURNING id`,
		projectID,
		country,
		dateOnly(periodStart),
		dateOnly(periodEnd),
		timeArgument(timePointer(periodEnd)),
		version,
		file.FileID,
		file.FilePath,
		file.OriginalFilename,
		file.Filename,
		logicalName,
		pathToSlash(file.LocalPath),
		file.Size,
		hash,
		rowCount,
		createdBy,
	).Scan(&sourceID)
	return sourceID, err
}

func inventoryLedgerInsertStaged(
	ctx context.Context,
	db DB,
	spec inventoryLedgerSpec,
	projectID int64,
	reportMonth time.Time,
	batchID int64,
) error {
	if spec.kind == inventoryLedgerDetail {
		_, err := db.(Execer).Exec(
			ctx,
			`INSERT INTO public.inventory_ledger_detail (
			   project_id, report_month, "date", fnsku, asin, msku, title,
			   event_type, reference_id, quantity, fulfillment_center,
			   disposition, reason, country, reconciled_quantity,
			   unreconciled_quantity, date_and_time, store, batch_id
			 )
			 SELECT $1, $2, "date", fnsku, asin, msku, title,
			        event_type, reference_id, quantity, fulfillment_center,
			        disposition, reason, country, reconciled_quantity,
			        unreconciled_quantity, date_and_time, store, $3
			 FROM `+inventoryLedgerTempIdentifier(spec.stageTable),
			projectID,
			dateOnly(reportMonth),
			batchID,
		)
		return err
	}
	_, err := db.(Execer).Exec(
		ctx,
		`INSERT INTO public.inventory_ledger_summary (
		   project_id, report_month, "date", fnsku, asin, msku, title,
		   disposition, starting_balance,
		   in_transit_between, receipts, customer_shipments,
		   customer_returns, vendor_returns, warehouse_transfer_io,
		   found, lost, damaged, disposed, other_events,
		   ending_balance, unknown_events, location, store, batch_id
		 )
		 SELECT $1, $2, "date", fnsku, asin, msku, title,
		        disposition, starting_balance,
		        in_transit_between, receipts, customer_shipments,
		        customer_returns, vendor_returns, warehouse_transfer_io,
		        found, lost, damaged, disposed, other_events,
		        ending_balance, unknown_events, location, store, $3
		 FROM `+inventoryLedgerTempIdentifier(spec.stageTable)+`
		 ON CONFLICT (project_id, report_month, "date", msku, disposition, location)
		 DO UPDATE SET
		   fnsku = EXCLUDED.fnsku,
		   asin = EXCLUDED.asin,
		   title = EXCLUDED.title,
		   starting_balance = EXCLUDED.starting_balance,
		   in_transit_between = EXCLUDED.in_transit_between,
		   receipts = EXCLUDED.receipts,
		   customer_shipments = EXCLUDED.customer_shipments,
		   customer_returns = EXCLUDED.customer_returns,
		   vendor_returns = EXCLUDED.vendor_returns,
		   warehouse_transfer_io = EXCLUDED.warehouse_transfer_io,
		   found = EXCLUDED.found,
		   lost = EXCLUDED.lost,
		   damaged = EXCLUDED.damaged,
		   disposed = EXCLUDED.disposed,
		   other_events = EXCLUDED.other_events,
		   ending_balance = EXCLUDED.ending_balance,
		   unknown_events = EXCLUDED.unknown_events,
		   store = EXCLUDED.store,
		   batch_id = EXCLUDED.batch_id`,
		projectID,
		dateOnly(reportMonth),
		batchID,
	)
	return err
}

func inventoryLedgerMessage(reportType string, kind inventoryLedgerKind, rows int) string {
	if reportType == "inventory_ledger" {
		return fmt.Sprintf("库存盘点数据已入库（%d 行）", rows)
	}
	if kind == inventoryLedgerDetail {
		return fmt.Sprintf("库存分类账明细视图已入库（%d 行）", rows)
	}
	return fmt.Sprintf("库存分类账汇总视图已入库（%d 行）", rows)
}

func inventoryLedgerPublicError(err error) error {
	var validation *inventoryLedgerValidationError
	if errors.As(err, &validation) {
		return uploads.NewAPIError(http.StatusUnprocessableEntity, validation.Error())
	}
	var apiErr *uploads.APIError
	if errors.As(err, &apiErr) {
		return apiErr
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "21000":
			return uploads.NewAPIError(
				http.StatusUnprocessableEntity,
				"库存分类账同一批次包含重复 Summary 自然键",
			)
		case "23505", "23503", "23514", "22001", "22P02", "22007", "22008":
			return uploads.NewAPIError(
				http.StatusUnprocessableEntity,
				"库存分类账数据不符合入库约束",
			)
		}
	}
	return err
}

func inventoryLedgerTempIdentifier(table string) string {
	return `"` + strings.ReplaceAll(table, `"`, `""`) + `"`
}
