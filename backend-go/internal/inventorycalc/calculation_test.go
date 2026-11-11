package inventorycalc

import (
	"math"
	"testing"
	"time"
)

func floatPtr(value float64) *float64 { return &value }
func intPtr(value int) *int           { return &value }

func TestNormalizeWeightedDMS(t *testing.T) {
	got := NormalizeWeightedDMS(floatPtr(10), floatPtr(20), nil, nil)
	if got == nil || math.Abs(*got-(0.10*10+0.30*20)/0.40) > 1e-9 {
		t.Fatalf("NormalizeWeightedDMS() = %v", got)
	}
	if got := NormalizeWeightedDMS(nil, nil, nil, nil); got != nil {
		t.Fatalf("NormalizeWeightedDMS(nil) = %v, want nil", *got)
	}
}

func TestAddDays(t *testing.T) {
	base := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	if got := AddDays(base, floatPtr(2.9)); got == nil || *got != "2026-11-13" {
		t.Fatalf("AddDays(2.9) = %v, want 2026-11-13", got)
	}
	if got := AddDays(base, nil); got != nil {
		t.Fatalf("AddDays(nil) = %v, want nil", *got)
	}
}

func TestComputeCoverageTimeline(t *testing.T) {
	today := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	eta := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	end, gapStart, gapDays, nextETA := ComputeCoverageTimeline(
		today, 10, floatPtr(1), []TransitBatch{{Quantity: 5, ETADate: &eta}}, 7,
	)
	if end == nil || *end != time.Date(2026, 11, 26, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("continuousEnd = %v, want 2026-11-26", end)
	}
	if gapStart != nil {
		t.Fatalf("gapStart = %v, want nil", gapStart)
	}
	if gapDays != 0 {
		t.Fatalf("gapDays = %d, want 0", gapDays)
	}
	if nextETA == nil || !nextETA.Equal(eta) {
		t.Fatalf("nextETA = %v", nextETA)
	}
}

func TestClassifyRisk(t *testing.T) {
	today := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		end    string
		buffer int
		want   string
	}{
		{"2026-11-10", 0, RiskLongTermOutOfStock},
		{"2026-12-01", -1, RiskShortTermOutOfStock},
		{"2026-12-01", 5, RiskOutOfStock},
		{"2026-12-01", 30, RiskHealthy},
		{"2027-03-01", 30, RiskSlowMoving},
		{"2027-05-01", 30, RiskSevereSlowMoving},
	}
	for _, testCase := range cases {
		got := ClassifyRisk(today, &testCase.end, &testCase.buffer, floatPtr(1))
		if got != testCase.want {
			t.Errorf("ClassifyRisk(%s, %d) = %s, want %s", testCase.end, testCase.buffer, got, testCase.want)
		}
	}
	if got := ClassifyRisk(today, nil, intPtr(0), floatPtr(1)); got != RiskPending {
		t.Errorf("ClassifyRisk(nil) = %s, want %s", got, RiskPending)
	}
}

func TestEstimateReplenishmentQuantity(t *testing.T) {
	if got := EstimateReplenishmentQuantity(90, intPtr(60), 30, floatPtr(2)); got == nil || *got != 120 {
		t.Fatalf("EstimateReplenishmentQuantity() = %v, want 120", got)
	}
	if got := EstimateReplenishmentQuantity(20, intPtr(100), 30, floatPtr(2)); got != nil {
		t.Fatalf("EstimateReplenishmentQuantity() = %v, want nil", *got)
	}
}
