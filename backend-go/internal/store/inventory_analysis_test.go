package store

import "testing"

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
