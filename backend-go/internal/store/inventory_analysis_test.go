package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
)

func TestToSnakeCase(t *testing.T) {
	cases := map[string]string{
		"KeepSelling":        "keep_selling",
		"CreateRemovalOrder": "create_removal_order",
		"no_action_needed":   "no_action_needed",
		"outlet-deal":        "outlet_deal",
		"Already_SnakeCase":  "already_snake_case",
		"Normal":             "normal",
	}
	for input, want := range cases {
		if got := toSnakeCase(input); got != want {
			t.Errorf("toSnakeCase(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestTranslateRecommendedAction(t *testing.T) {
	cases := []struct {
		raw  *string
		want string
	}{
		{nil, ""},
		{strPtr(""), ""},
		{strPtr("KeepSelling"), "继续销售"},
		{strPtr("CreateRemovalOrder"), "创建移除订单"},
		{strPtr("Liquidate"), "建议清货"},
		{strPtr("unknown_action"), ""},
	}
	for _, testCase := range cases {
		if got := translateRecommendedAction(testCase.raw); got != testCase.want {
			t.Errorf("translateRecommendedAction(%v) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}

func TestInventoryAgingStatus(t *testing.T) {
	cases := []struct {
		row  inventoryAnalysisRow
		want string
	}{
		{inventoryAnalysisRow{Age0To90Qty: 5}, "fresh"},
		{inventoryAnalysisRow{Age91To180Qty: 5}, "aging"},
		{inventoryAnalysisRow{Age271To365Qty: 5}, "aging"},
		{inventoryAnalysisRow{Age365PlusQty: 1}, "over_aged"},
		{inventoryAnalysisRow{Age91To180Qty: 5, Age365PlusQty: 1}, "over_aged"},
	}
	for _, testCase := range cases {
		if got := inventoryAgingStatus(testCase.row); got != testCase.want {
			t.Errorf("inventoryAgingStatus(%#v) = %q, want %q", testCase.row, got, testCase.want)
		}
	}
}

func TestMergeInventoryAnalysisRows(t *testing.T) {
	baseRows := []inventoryAnalysisRow{
		{SKU: "SKU-A"},
		{SKU: "SKU-B", ASIN: strPtr("B002")},
	}
	aggregated := []inventoryAnalysisRow{
		{SKU: "SKU-A", ASIN: strPtr("B001"), AvailableQty: 10, Age0To90Qty: 5, RecommendedAction: strPtr("KeepSelling")},
		{SKU: "SKU-C", AvailableQty: 3},
	}
	merged := mergeInventoryAnalysisRows(baseRows, aggregated)
	if len(merged) != 3 {
		t.Fatalf("merged length = %d, want 3", len(merged))
	}
	if merged[0].SKU != "SKU-A" || merged[0].AvailableQty != 10 || merged[0].Age0To90Qty != 5 {
		t.Errorf("merged[0] = %#v", merged[0])
	}
	if merged[0].ASIN == nil || *merged[0].ASIN != "B001" {
		t.Errorf("merged[0].ASIN = %v, want B001", merged[0].ASIN)
	}
	if merged[1].SKU != "SKU-B" || merged[1].AvailableQty != 0 {
		t.Errorf("merged[1] = %#v", merged[1])
	}
	if merged[2].SKU != "SKU-C" {
		t.Errorf("merged[2] = %#v", merged[2])
	}
}

func TestInventoryAnalysisSalesWindow(t *testing.T) {
	eveningUTC := time.Date(2026, 11, 20, 0, 30, 0, 0, time.UTC)
	cases := []struct {
		name       string
		reportDate *string
		country    string
		now        time.Time
		wantStart  string
		wantEnd    string
	}{
		{"业务日期为 T：区间取 T-1 至 T-8", strPtr("2026-11-11"), "US", eveningUTC, "2026-11-03", "2026-11-10"},
		{"兼容带时间的 ISO 业务日期", strPtr("2026-11-11T00:00:00Z"), "US", eveningUTC, "2026-11-03", "2026-11-10"},
		{"业务日期非法时回落站点今天", strPtr("bad-date"), "US", eveningUTC, "2026-11-11", "2026-11-18"},
		{"无快照时按洛杉矶时区取今天", nil, "US", eveningUTC, "2026-11-11", "2026-11-18"},
		{"无快照时按柏林时区取今天", nil, "DE", eveningUTC, "2026-11-12", "2026-11-19"},
	}
	for _, testCase := range cases {
		got := inventoryAnalysisSalesWindow(testCase.reportDate, testCase.country, testCase.now)
		if got.StartDate != testCase.wantStart || got.EndDate != testCase.wantEnd {
			t.Errorf("%s: window = %s~%s, want %s~%s", testCase.name, got.StartDate, got.EndDate, testCase.wantStart, testCase.wantEnd)
		}
	}
}

func TestLoadSKUSalesQtyWindow(t *testing.T) {
	db := &fakeDB{rowsQueueQuery: []Rows{&fakeRows{batches: [][]any{
		{"SKU-A", int64(7)},
		{" sku-a ", int64(2)},
		{"", int64(5)},
		{"SKU-B", int64(0)},
	}}}}
	quantities, err := loadSKUSalesQtyWindow(context.Background(), db, 1, "US", SKUSalesWindow{
		StartDate: "2026-11-03",
		EndDate:   "2026-11-10",
	})
	if err != nil {
		t.Fatalf("loadSKUSalesQtyWindow() error = %v", err)
	}
	if quantities["sku-a"] != 9 {
		t.Errorf("quantities[sku-a] = %d, want 9（大小写归一化后合并）", quantities["sku-a"])
	}
	if quantities["sku-b"] != 0 {
		t.Errorf("quantities[sku-b] = %d, want 0", quantities["sku-b"])
	}
	if _, exists := quantities[""]; exists {
		t.Errorf("空 SKU 不应进入结果集: %#v", quantities)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.queryCalls))
	}
	args := db.queryCalls[0].args
	if len(args) != 4 || args[0] != int64(1) || args[1] != "US" || args[2] != "2026-11-03" || args[3] != "2026-11-10" {
		t.Errorf("query args = %#v, want [1 US 2026-11-03 2026-11-10]", args)
	}
	if !strings.Contains(db.queryCalls[0].sql, "is_counted_sales = true") ||
		!strings.Contains(db.queryCalls[0].sql, "order_status != 'Cancelled'") {
		t.Errorf("销量查询缺少每日分析口径过滤条件: %s", db.queryCalls[0].sql)
	}
}

func TestGetInventoryAnalysisIncludesSalesQty7d(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: []any{"项目A"}},
		rowsQueue: []pgx.Row{
			// 1) projects.project_name 2) analysis_source_files(id, report_date)
			fakeRow{values: []any{"项目A"}},
			fakeRow{values: []any{int64(1), "2026-11-11"}},
		},
		rowsQueueQuery: []Rows{
			// product_costs 基础 SKU
			&fakeRows{batches: [][]any{
				{"SKU-A", "B0A"},
				{"SKU-B", nil},
			}},
			// 库存快照聚合
			&fakeRows{batches: [][]any{
				{"SKU-A", "B0A", int64(10), int64(5), int64(0), int64(0), int64(0), int64(0), "KeepSelling"},
			}},
			// 7 天销量
			&fakeRows{batches: [][]any{
				{"SKU-A", int64(12)},
				{"SKU-C", int64(4)},
			}},
			// 品名
			&fakeRows{batches: [][]any{
				{"SKU-A", "B0A", "商品A"},
			}},
			// 在途货件表头 / 明细（本次没有在途货件）
			&fakeRows{},
			&fakeRows{},
		},
	}}
	projectID := int64(1)
	store := NewInventoryReplenishmentStore(db)
	response, err := store.GetInventoryAnalysis(context.Background(), inventory_replenishment.ReplenishmentFilter{
		ProjectID: &projectID,
		Country:   strPtr("US"),
	})
	if err != nil {
		t.Fatalf("GetInventoryAnalysis() error = %v", err)
	}
	if response.SalesWindowStart == nil || *response.SalesWindowStart != "2026-11-03" {
		t.Errorf("SalesWindowStart = %v, want 2026-11-03", response.SalesWindowStart)
	}
	if response.SalesWindowEnd == nil || *response.SalesWindowEnd != "2026-11-10" {
		t.Errorf("SalesWindowEnd = %v, want 2026-11-10", response.SalesWindowEnd)
	}
	if len(response.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(response.Items))
	}
	if response.Items[0].SalesQty7d != 12 {
		t.Errorf("items[0].SalesQty7d = %d, want 12", response.Items[0].SalesQty7d)
	}
	if response.Items[1].SalesQty7d != 0 {
		t.Errorf("items[1].SalesQty7d = %d, want 0（无销量 SKU 记 0）", response.Items[1].SalesQty7d)
	}
	if response.Summary.TotalSalesQty7d != 12 {
		t.Errorf("summary.TotalSalesQty7d = %d, want 12（只汇总展示中的 SKU，未展示的 SKU-C 不计入）", response.Summary.TotalSalesQty7d)
	}

	// 前端按这些 JSON key 取数，契约字段名改动必须让这里先红。
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	payload := map[string]any{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if _, ok := payload["sales_window_start"]; !ok {
		t.Errorf("响应 JSON 缺少 sales_window_start: %s", encoded)
	}
	if _, ok := payload["sales_window_end"]; !ok {
		t.Errorf("响应 JSON 缺少 sales_window_end: %s", encoded)
	}
	firstItem, _ := payload["items"].([]any)[0].(map[string]any)
	if _, ok := firstItem["sales_qty_7d"]; !ok {
		t.Errorf("item JSON 缺少 sales_qty_7d: %v", firstItem)
	}
	summaryPayload, _ := payload["summary"].(map[string]any)
	if _, ok := summaryPayload["total_sales_qty_7d"]; !ok {
		t.Errorf("summary JSON 缺少 total_sales_qty_7d: %v", summaryPayload)
	}
}
