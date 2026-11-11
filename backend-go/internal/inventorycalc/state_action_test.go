package inventorycalc

import "testing"

func TestComputeTrendLabel(t *testing.T) {
	cases := []struct {
		dms7, dms30 *float64
		want        string
	}{
		{nil, floatPtr(1), "稳定"},
		{floatPtr(2), floatPtr(1), "上升"},
		{floatPtr(1), floatPtr(1), "稳定"},
		{floatPtr(0.8), floatPtr(1), "轻微下降"},
		{floatPtr(0.5), floatPtr(1), "下降明显"},
	}
	for _, testCase := range cases {
		if got := ComputeTrendLabel(testCase.dms7, testCase.dms30); got != testCase.want {
			t.Errorf("ComputeTrendLabel(%v,%v) = %s, want %s", testCase.dms7, testCase.dms30, got, testCase.want)
		}
	}
}

func TestComputeTrendMomentum(t *testing.T) {
	if got := ComputeTrendMomentum(floatPtr(0.5), floatPtr(0.9), floatPtr(1)); got != "accelerating" {
		t.Errorf("momentum = %s, want accelerating", got)
	}
	if got := ComputeTrendMomentum(floatPtr(1.2), floatPtr(0.9), floatPtr(1)); got != "decelerating" {
		t.Errorf("momentum = %s, want decelerating", got)
	}
	if got := ComputeTrendMomentum(nil, nil, nil); got != "stable" {
		t.Errorf("momentum = %s, want stable", got)
	}
}

func TestComputeInventoryState(t *testing.T) {
	base := ItemInput{DMS30: floatPtr(1), AvailableQty: 10}
	cases := []struct {
		name    string
		item    ItemInput
		trend   string
		doh     *float64
		buffer  *int
		state   string
		subtype string
		rule    string
	}{
		{"missing dms", ItemInput{}, "稳定", nil, nil, "unknown", "", "P0"},
		{"critical shortage", base, "稳定", floatPtr(5), nil, "critical", "shortage", "P1"},
		{"shortage 14-30", base, "稳定", floatPtr(20), nil, "critical", "shortage", "P2"},
		{"aging 365", ItemInput{DMS30: floatPtr(1), Age365PlusQty: 1}, "稳定", floatPtr(100), nil, "critical", "aging", "P3"},
		{"aging 271 ratio", ItemInput{DMS30: floatPtr(1), Age271To365Qty: 6, Age0To90Qty: 4}, "稳定", floatPtr(100), nil, "critical", "aging", "P4"},
		{"aging 181 ratio", ItemInput{DMS30: floatPtr(1), Age181To270Qty: 6, Age0To90Qty: 4}, "稳定", floatPtr(100), nil, "critical", "aging", "P5"},
		{"overstock", ItemInput{DMS30: floatPtr(0.1)}, "稳定", floatPtr(200), nil, "critical", "overstock", "P6"},
		{"buffer negative decline", base, "下降明显", floatPtr(100), intPtr(-1), "deteriorating", "", "P0b"},
		{"buffer negative stable", base, "稳定", floatPtr(100), intPtr(-1), "watch", "", "P0a"},
		{"deteriorating 120-180", ItemInput{DMS30: floatPtr(0.1)}, "稳定", floatPtr(150), nil, "deteriorating", "", "P7"},
		{"decline aging", ItemInput{DMS30: floatPtr(1), Age91To180Qty: 5, Age0To90Qty: 5}, "下降明显", floatPtr(60), nil, "deteriorating", "", "P8"},
		{"decline 45-90", base, "下降明显", floatPtr(60), nil, "deteriorating", "", "P9"},
		{"decline 30-45", base, "下降明显", floatPtr(40), nil, "watch", "", "P10"},
		{"watch 90-180", base, "稳定", floatPtr(120), nil, "watch", "", "P11"},
		{"healthy", base, "稳定", floatPtr(80), nil, "healthy", "", "P12"},
	}
	for _, testCase := range cases {
		state, subtype, rule := ComputeInventoryState(testCase.item, testCase.trend, testCase.doh, testCase.buffer)
		if state != testCase.state || rule != testCase.rule {
			t.Errorf("%s: got (%s,%s), want (%s,%s)", testCase.name, state, rule, testCase.state, testCase.rule)
		}
		if testCase.subtype == "" {
			if subtype != nil {
				t.Errorf("%s: subtype = %v, want nil", testCase.name, *subtype)
			}
		} else if subtype == nil || *subtype != testCase.subtype {
			t.Errorf("%s: subtype = %v, want %s", testCase.name, subtype, testCase.subtype)
		}
	}
}

func TestComputeReplenishmentAction(t *testing.T) {
	shortage := "shortage"
	aging := "aging"
	overstock := "overstock"
	cases := []struct {
		name    string
		state   string
		subtype *string
		trend   string
		transit float64
		phase   string
		doh     *float64
		buffer  *int
		action  string
	}{
		{"aging remove", "critical", &aging, "稳定", 0, "neutral", floatPtr(100), nil, ActionRemove},
		{"overstock decline", "critical", &overstock, "下降明显", 0, "neutral", floatPtr(150), nil, ActionReducePrice},
		{"overstock transit", "critical", &overstock, "稳定", 4, "neutral", floatPtr(150), nil, ActionReducePrice},
		{"overstock trough hold", "critical", &overstock, "稳定", 1, "trough", floatPtr(150), nil, ActionHold},
		{"buffer negative urgent", "healthy", nil, "稳定", 0, "neutral", floatPtr(100), intPtr(-1), ActionReplenishNow},
		{"buffer urgent", "healthy", nil, "稳定", 0, "neutral", floatPtr(100), intPtr(10), ActionReplenishNow},
		{"shortage urgent", "critical", &shortage, "稳定", 0, "neutral", floatPtr(5), nil, ActionReplenishNow},
		{"shortage normal up", "critical", &shortage, "上升", 0, "neutral", floatPtr(20), nil, ActionReplenishNormal},
		{"shortage peak override", "critical", &shortage, "下降明显", 0, "peak", floatPtr(20), nil, ActionReplenishNormal},
		{"shortage hold down", "critical", &shortage, "下降明显", 0, "neutral", floatPtr(20), nil, ActionHold},
		{"deteriorating reduce", "deteriorating", nil, "下降明显", 0, "neutral", floatPtr(60), nil, ActionReducePrice},
		{"deteriorating trough hold", "deteriorating", nil, "下降明显", 0, "trough", floatPtr(60), nil, ActionHold},
		{"deteriorating hold", "deteriorating", nil, "上升", 0, "neutral", floatPtr(60), nil, ActionHold},
		{"watch no action", "watch", nil, "稳定", 0, "neutral", floatPtr(60), nil, ActionNoAction},
	}
	for _, testCase := range cases {
		action, _, _ := ComputeReplenishmentAction(testCase.state, testCase.subtype, testCase.trend, testCase.transit, testCase.phase, testCase.doh, testCase.buffer)
		if action != testCase.action {
			t.Errorf("%s: action = %s, want %s", testCase.name, action, testCase.action)
		}
	}
}

func TestComputeSeasonalFactor(t *testing.T) {
	factor, phase, source := ComputeSeasonalFactor(floatPtr(2), floatPtr(2), floatPtr(1), floatPtr(1))
	if factor == nil || *factor != 2 || phase != "peak" || source != "sku_yoy" {
		t.Fatalf("seasonal = (%v,%s,%s)", factor, phase, source)
	}
	factor, phase, source = ComputeSeasonalFactor(nil, nil, nil, nil)
	if factor != nil || phase != "unknown" || source != "neutral" {
		t.Fatalf("seasonal empty = (%v,%s,%s)", factor, phase, source)
	}
}

func TestComputeSignals(t *testing.T) {
	item := ItemInput{
		AvailableQty: 10, InTransitQty: 5,
		DMS30: floatPtr(1), DMS7: floatPtr(2), DMS3: floatPtr(4),
		Age0To90Qty: 5, Age91To180Qty: 5,
	}
	signals := ComputeSignals(item, "上升", "stable", 1, nil, "unknown", "neutral")
	if signals.TrendRatio730 == nil || *signals.TrendRatio730 != 2 {
		t.Errorf("trend ratio 7/30 = %v", signals.TrendRatio730)
	}
	if signals.TransitRatio == nil || *signals.TransitRatio != 0.5 {
		t.Errorf("transit ratio = %v", signals.TransitRatio)
	}
	if signals.AgingShare["0_90"] != 0.5 || signals.AgingShare["91_180"] != 0.5 {
		t.Errorf("aging share = %v", signals.AgingShare)
	}
	if signals.Confidence != "high" {
		t.Errorf("confidence = %s, want high", signals.Confidence)
	}
}
