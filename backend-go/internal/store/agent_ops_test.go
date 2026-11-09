package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestAgentOpsStoreScansDomainAggregate(t *testing.T) {
	last := time.Date(2026, 11, 8, 7, 6, 5, 0, time.UTC)
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		"orders", int64(3), int64(9), int64(1), int64(2), int64(1),
		last,
	}}}}
	items, err := NewAgentOpsStore(db).DomainSummary(
		context.Background(),
		last.AddDate(0, 0, -7),
		last.Add(-24*time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Domain != "orders" || items[0].Calls7d != 9 ||
		items[0].LastActiveAt == nil || !items[0].LastActiveAt.Equal(last) {
		t.Fatalf("items = %#v", items)
	}
	if !strings.Contains(db.queryCalls[0].sql, "operation_type IS NOT NULL") ||
		!strings.Contains(db.queryCalls[0].sql, "status_code >= 400") {
		t.Errorf("SQL = %s", db.queryCalls[0].sql)
	}
}

func TestAgentOpsStoreScansEmployeeAggregate(t *testing.T) {
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		int64(42), int64(4), int64(8), int64(1), int64(3), int64(0),
		nil,
	}}}}
	items, err := NewAgentOpsStore(db).EmployeeSummary(
		context.Background(), time.Now().AddDate(0, 0, -7), time.Now().Add(-24*time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].APIKeyID != 42 || items[0].LastActiveAt != nil {
		t.Fatalf("items = %#v", items)
	}
}
