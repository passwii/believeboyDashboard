package scheduledreport

import (
	"testing"
	"time"
)

func TestSafePctChange(t *testing.T) {
	cases := []struct {
		current, previous float64
		wantValue         float64
		wantType          string
	}{
		{10, 0, 0, "neutral"},
		{10, 10, 0, "neutral"},
		{11, 10, 10, "up"},
		{9, 10, -10, "down"},
		{10.04, 10, 0.4, "neutral"},
	}
	for _, testCase := range cases {
		value, changeType := safePctChange(testCase.current, testCase.previous)
		if value != testCase.wantValue || changeType != testCase.wantType {
			t.Errorf("safePctChange(%v,%v) = (%v,%s), want (%v,%s)",
				testCase.current, testCase.previous, value, changeType, testCase.wantValue, testCase.wantType)
		}
	}
}

func TestReportAnchorDate(t *testing.T) {
	// 2026-11-11 09:00 Shanghai = 2026-11-10 18:00 PT.
	now := time.Date(2026, 11, 11, 9, 0, 0, 0, time.FixedZone("CST", 8*3600))
	anchor := reportAnchorDate("US", now)
	if anchor.Format("2006-01-02") != "2026-11-10" {
		t.Fatalf("US anchor = %s, want 2026-11-10", anchor.Format("2006-01-02"))
	}
}

func TestSalesAmountExpr(t *testing.T) {
	if got := salesAmountExpr("US"); got != "coalesce(item_price, 0) + coalesce(shipping_price, 0)" {
		t.Fatalf("US expr = %s", got)
	}
	if got := salesAmountExpr("DE"); got != "coalesce(item_price, 0) + coalesce(shipping_price, 0) + coalesce(item_tax, 0) + coalesce(shipping_tax, 0)" {
		t.Fatalf("DE expr = %s", got)
	}
}

func TestTranslateReturnReason(t *testing.T) {
	if got := translateReturnReason("NOT_AS_DESCRIBED"); got != "与描述不符" {
		t.Fatalf("translation = %s", got)
	}
	if got := translateReturnReason("UNKNOWN_CODE"); got != "UNKNOWN_CODE" {
		t.Fatalf("fallback = %s", got)
	}
}
