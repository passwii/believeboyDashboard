package store

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestParseCategoryResearchXLSX(t *testing.T) {
	xlsxBytes, err := buildCategoryXLSX([]exportSheet{
		{
			Name: "产品明细",
			Rows: [][]any{
				{"ASIN", "Parent ASIN", "Product Name", "Brand", "Seller", "Price", "月销量", "月销售额", "评分", "评价数量", "上架时间", "上架天数", "FBA费用", "物流方式", "BBX卖家属性", "主图视频", "Color", "Size"},
				{"B001", "P001", "Yoga Mat", "Brand A", "Amazon", "25.50", 120, 3060, 4.6, 88, "1/15/2026", 45, "4.20", "FBA", "亚马逊自营", "是", "Blue", "6mm"},
				{"B002", "P002", "Yoga Block", "Brand B", "Seller B", "not-a-price", 30, 240, 4.2, 12, "2026-03-01", 120, "3.00", "FBM", "", "否", "Black", "2-pack"},
			},
		},
		{
			Name: "趋势明细",
			Rows: [][]any{
				{"ASIN", "Parent ASIN", "Year-Month", "Monthly Sales"},
				{"B001", "P001", "2026-01", 100},
				{"B001", "P001", "2026-02", 120},
			},
		},
	})
	if err != nil {
		t.Fatalf("build test xlsx: %v", err)
	}

	parsed, err := parseCategoryResearchFile("report.xlsx", xlsxBytes)
	if err != nil {
		t.Fatalf("parse xlsx: %v", err)
	}
	if len(parsed.Products) != 2 || len(parsed.Trends) != 2 {
		t.Fatalf("rows = products:%d trends:%d", len(parsed.Products), len(parsed.Trends))
	}
	if parsed.Products[0].ASIN == nil || *parsed.Products[0].ASIN != "B001" {
		t.Fatalf("first ASIN = %#v", parsed.Products[0].ASIN)
	}
	if parsed.Products[0].PriceUSD == nil || *parsed.Products[0].PriceUSD != 25.5 {
		t.Fatalf("first price = %#v", parsed.Products[0].PriceUSD)
	}
	if parsed.Products[0].LaunchDate == nil || *parsed.Products[0].LaunchDate != "2026-01-15" {
		t.Fatalf("launch date = %#v", parsed.Products[0].LaunchDate)
	}
	if !parsed.Products[0].IsAmazon || !parsed.Products[0].IsNew90d {
		t.Fatalf("flags mismatch: amazon=%v new90=%v", parsed.Products[0].IsAmazon, parsed.Products[0].IsNew90d)
	}
	if parsed.Products[0].ExtractedDimensions["color"] != "Blue" {
		t.Fatalf("dimensions = %#v", parsed.Products[0].ExtractedDimensions)
	}
	if parsed.Trends[1].YearMonth != "2026-02" || parsed.Trends[1].MonthlySale != 120 {
		t.Fatalf("trend = %#v", parsed.Trends[1])
	}
	if got := anyInt(parsed.QualityWarnings["invalid_price_count"]); got != 1 {
		t.Fatalf("invalid price count = %d", got)
	}
}

func TestParseCategoryResearchCSVRecordTypes(t *testing.T) {
	csvData := []byte("\xef\xbb\xbfrecord_type,ASIN,Product Name,Brand,Price,Monthly Sales,Year-Month\nproduct,B001,Mat,Brand A,19.99,80,\ntrend,B001,, ,, ,2026-01\n")
	parsed, err := parseCategoryResearchFile("report.csv", csvData)
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(parsed.Products) != 1 || len(parsed.Trends) != 1 {
		t.Fatalf("rows = products:%d trends:%d", len(parsed.Products), len(parsed.Trends))
	}
	if parsed.Products[0].MonthlySales != 80 {
		t.Fatalf("monthly sales = %d", parsed.Products[0].MonthlySales)
	}
	if parsed.Trends[0].YearMonth != "2026-01" {
		t.Fatalf("year month = %q", parsed.Trends[0].YearMonth)
	}
}

func TestParseCategoryResearchRejectsInvalidFilesAndExtensions(t *testing.T) {
	if _, err := parseCategoryResearchFile("report.xls", []byte("legacy")); err == nil {
		t.Fatal("expected .xls to be rejected")
	}
	if _, err := parseCategoryResearchFile("report.xlsx", []byte("not-a-zip")); err == nil {
		t.Fatal("expected invalid XLSX ZIP to be rejected")
	}
	if _, err := parseCategoryResearchFile("report.csv", []byte("Product Name,Brand\nMat,Brand A\n")); err == nil {
		t.Fatal("expected CSV without ASIN to be rejected")
	}
}

func TestCategoryResearchImportPersistsParsedRows(t *testing.T) {
	xlsxBytes, err := buildCategoryXLSX([]exportSheet{
		{
			Name: "产品明细",
			Rows: [][]any{
				{"ASIN", "Product Name", "Brand", "Price", "Monthly Sales"},
				{"B001", "Mat", "Brand A", 20, 50},
			},
		},
		{
			Name: "趋势明细",
			Rows: [][]any{
				{"ASIN", "Year-Month", "Monthly Sales"},
				{"B001", "2026-01", 50},
			},
		},
	})
	if err != nil {
		t.Fatalf("build test xlsx: %v", err)
	}

	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{0}},
			fakeRow{values: []any{int64(77)}},
		},
	}}
	store := NewCategoryResearchStore(db)
	resp, err := store.ImportDataset(
		context.Background(), "us", "Yoga Mat", "瑜伽垫", "../../report.xlsx", xlsxBytes, "tester",
	)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if resp.DatasetID != 77 || resp.RowCountProducts != 1 || resp.RowCountTrends != 1 {
		t.Fatalf("response = %#v", resp)
	}
	if len(db.execCalls) != 3 {
		t.Fatalf("exec calls = %d, want supersede + 2 row inserts", len(db.execCalls))
	}
	if !strings.Contains(db.execCalls[1].sql, "insert into public.category_research_product_details") {
		t.Fatalf("product insert SQL = %s", db.execCalls[1].sql)
	}
	if !strings.Contains(db.execCalls[2].sql, "insert into public.category_research_sales_trends") {
		t.Fatalf("trend insert SQL = %s", db.execCalls[2].sql)
	}
	if len(db.execCalls[1].args) != 26 {
		t.Fatalf("product insert args = %d, want 26", len(db.execCalls[1].args))
	}

	if databaseURL := os.Getenv("TEST_DATABASE_URL"); databaseURL != "" {
		conn, err := pgx.Connect(context.Background(), databaseURL)
		if err != nil {
			t.Fatalf("connect test database: %v", err)
		}
		defer conn.Close(context.Background())
		queryIndex := 0
		for _, call := range db.queryRowCalls {
			queryIndex++
			if _, err := conn.Prepare(
				context.Background(),
				fmt.Sprintf("category_import_query_%d", queryIndex),
				call.sql,
			); err != nil {
				t.Fatalf("prepare captured QueryRow SQL: %v\n%s", err, call.sql)
			}
		}
		for idx, call := range db.execCalls {
			if _, err := conn.Prepare(
				context.Background(),
				fmt.Sprintf("category_import_exec_%d", idx),
				call.sql,
			); err != nil {
				t.Fatalf("prepare captured Exec SQL: %v\n%s", err, call.sql)
			}
		}
	}
}

func TestCategoryResearchImportCSVPersistsBothRowTypes(t *testing.T) {
	csvData := []byte("record_type,ASIN,Product Name,Brand,Price,Monthly Sales,Year-Month\nproduct,B001,Mat,Brand A,20,50,\ntrend,B001,,, , ,2026-01\n")
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{0}},
			fakeRow{values: []any{int64(88)}},
		},
	}}
	store := NewCategoryResearchStore(db)
	resp, err := store.ImportDataset(context.Background(), "US", "yoga mat", "瑜伽垫", "report.csv", csvData, "tester")
	if err != nil {
		t.Fatalf("import CSV: %v", err)
	}
	if resp.RowCountProducts != 1 || resp.RowCountTrends != 1 {
		t.Fatalf("CSV import response = %#v", resp)
	}
	if len(db.execCalls) != 3 {
		t.Fatalf("CSV import exec calls = %d", len(db.execCalls))
	}
}

func TestCategoryResearchExportIsReadableXLSX(t *testing.T) {
	xlsxBytes, err := buildCategoryXLSX([]exportSheet{
		{Name: "产品明细", Rows: [][]any{{"ASIN", "月销量"}, {"B001", 100}}},
	})
	if err != nil {
		t.Fatalf("build export: %v", err)
	}
	if !bytes.HasPrefix(xlsxBytes, []byte("PK\x03\x04")) {
		t.Fatalf("export is not a ZIP/XLSX")
	}
	reader, err := zip.NewReader(bytes.NewReader(xlsxBytes), int64(len(xlsxBytes)))
	if err != nil {
		t.Fatalf("open export zip: %v", err)
	}
	foundWorkbook := false
	foundSheet := false
	for _, file := range reader.File {
		switch file.Name {
		case "xl/workbook.xml":
			foundWorkbook = true
		case "xl/worksheets/sheet1.xml":
			foundSheet = true
		}
	}
	if !foundWorkbook || !foundSheet {
		t.Fatalf("missing workbook parts: workbook=%v sheet=%v", foundWorkbook, foundSheet)
	}
	sheets, err := readXLSXSheets(xlsxBytes)
	if err != nil {
		t.Fatalf("read generated xlsx: %v", err)
	}
	if len(sheets) != 1 || len(sheets[0].Rows) != 2 || sheets[0].Rows[1].Values[1] != "100" {
		t.Fatalf("round-trip sheets = %#v", sheets)
	}
}

func TestCategoryResearchStoreGetExportData(t *testing.T) {
	now := "2026-11-08"
	db := &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{
			int64(1), "US", "yoga mat", "瑜伽垫", 1, true,
			nil, "file-1", "path/file.xlsx", categoryTestStringPtr("report.xlsx"), "report.xlsx",
			categoryTestIntPtr(1024), categoryTestStringPtr("sha256"), "success", (*string)(nil), &now,
			1, 1, categoryTestStringPtr("{}"), categoryTestStringPtr("tester"),
			&timePlaceholder, &timePlaceholder,
		}}},
		rowsQueueQuery: []Rows{
			&categoryTestRows{batches: [][]any{{
				int64(10), 2, categoryTestStringPtr("B001"), (*string)(nil), categoryTestStringPtr("Mat"),
				categoryTestStringPtr("Brand A"), categoryTestStringPtr("Seller"), float64PointerLocal(20), 50,
				float64PointerLocal(1000), float64PointerLocal(4.5), 10, "2026-01-01", categoryTestIntPtr(30),
				float64PointerLocal(3), categoryTestStringPtr("FBA"), (*string)(nil), categoryTestIntPtr(1),
				(*bool)(nil), (*bool)(nil), (*bool)(nil), (*string)(nil), false, true,
				categoryTestStringPtr("{}"), categoryTestStringPtr("{}"),
			}}},
			&categoryTestRows{batches: [][]any{{"B001", (*string)(nil), "2026-01", 50}}},
		},
	}
	store := NewCategoryResearchStore(&fakeWriteDB{fakeDB: db})
	filename, content, err := store.GetExportData(context.Background(), 1, "products", "default", "")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if !strings.HasSuffix(filename, ".xlsx") || !bytes.HasPrefix(content, []byte("PK\x03\x04")) {
		t.Fatalf("filename=%q content-prefix=%q", filename, content[:min(4, len(content))])
	}
}

func categoryTestStringPtr(value string) *string {
	return &value
}

func categoryTestIntPtr(value int) *int {
	return &value
}

func float64PointerLocal(value float64) *float64 {
	return &value
}

type categoryTestRows struct {
	batches [][]any
	index   int
	err     error
}

func (r *categoryTestRows) Next() bool {
	if r.index >= len(r.batches) {
		return false
	}
	r.index++
	return true
}

func (r *categoryTestRows) Scan(dest ...any) error {
	if r.index == 0 || r.index > len(r.batches) {
		return errors.New("scan called outside row")
	}
	return assignCategoryScanValues(dest, r.batches[r.index-1])
}

func (r *categoryTestRows) Err() error {
	return r.err
}

func (r *categoryTestRows) Close() {}

func assignCategoryScanValues(dest, values []any) error {
	if len(dest) != len(values) {
		return errors.New("scan destination count mismatch")
	}
	for idx, target := range dest {
		targetValue := reflect.ValueOf(target)
		if targetValue.Kind() != reflect.Pointer || targetValue.IsNil() {
			return errors.New("scan destination is not a pointer")
		}
		element := targetValue.Elem()
		if values[idx] == nil {
			element.SetZero()
			continue
		}
		value := reflect.ValueOf(values[idx])
		if value.Type().AssignableTo(element.Type()) {
			element.Set(value)
			continue
		}
		if element.Kind() == reflect.Pointer && value.Type().AssignableTo(element.Type().Elem()) {
			pointer := reflect.New(element.Type().Elem())
			pointer.Elem().Set(value)
			element.Set(pointer)
			continue
		}
		if value.Type().ConvertibleTo(element.Type()) {
			element.Set(value.Convert(element.Type()))
			continue
		}
		return errors.New("scan value type mismatch")
	}
	return nil
}

var timePlaceholder = mustTime("2026-11-08T00:00:00Z")

func mustTime(value string) (parsedTime time.Time) {
	parsedTime, err := time.Parse(time.RFC3339, value)
	if err != nil {
		panic(err)
	}
	return parsedTime
}
