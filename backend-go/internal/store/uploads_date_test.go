package store

import "testing"

func TestParseDateStringDoesNotShiftDateOnlyValue(t *testing.T) {
	got := parseDateString("2026-11-16", "US")
	if got == nil || *got != "2026-11-16" {
		t.Fatalf("parseDateString(2026-11-16, US) = %v, want 2026-11-16", got)
	}
}

func TestRecognizeInventoryKeepsSnapshotDate(t *testing.T) {
	table := tableData{
		Headers: []string{"snapshot-date", "sku", "asin"},
		Rows:    [][]string{{"2026-11-16", "SKU-1", "B0TEST"}},
	}
	recognition := recognizeInventory(table, "US")
	if recognition.DetectedDate == nil || *recognition.DetectedDate != "2026-11-16" {
		t.Fatalf("inventory detected_date = %v, want 2026-11-16", recognition.DetectedDate)
	}
}
