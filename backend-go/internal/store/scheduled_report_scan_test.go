package store

import (
	"context"
	"strings"
	"testing"
)

func TestListScheduledReportSubscriptionsDueAtQueriesHourMinute(t *testing.T) {
	db := &scheduledTestDB{rowsQueueQuery: []Rows{&scheduledTestRows{batches: [][]any{
		{int64(5), "a@example.com", "1,2", "US", "daily", nil, nil, nil},
		{int64(6), "b@example.com", "", "UK", "weekly", 0, nil, "gpt"},
	}}}}
	reportStore := NewScheduledReportStore(db)

	due, err := reportStore.ListScheduledReportSubscriptionsDueAt(context.Background(), 8, 30)
	if err != nil {
		t.Fatalf("ListScheduledReportSubscriptionsDueAt() error = %v", err)
	}
	if len(due) != 2 {
		t.Fatalf("due subscriptions = %d, want 2", len(due))
	}
	if due[0].ID != 5 || due[0].Email == nil || *due[0].Email != "a@example.com" || due[0].ProjectIDs != "1,2" {
		t.Fatalf("due[0] = %+v", due[0])
	}
	if due[1].ID != 6 || due[1].Frequency != "weekly" || due[1].DispatchWeekday == nil || *due[1].DispatchWeekday != 0 {
		t.Fatalf("due[1] = %+v", due[1])
	}
	if due[1].AIModel == nil || *due[1].AIModel != "gpt" {
		t.Fatalf("due[1].AIModel = %v, want gpt", due[1].AIModel)
	}

	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.queryCalls))
	}
	call := db.queryCalls[0]
	if !strings.Contains(call.sql, "public.scheduled_report_subscriptions") {
		t.Fatalf("query sql = %q, want subscriptions table", call.sql)
	}
	for _, fragment := range []string{"enabled = true", "dispatch_hour = $1", "dispatch_minute = $2"} {
		if !strings.Contains(call.sql, fragment) {
			t.Fatalf("query sql = %q, want %q", call.sql, fragment)
		}
	}
	if len(call.args) != 2 || call.args[0] != 8 || call.args[1] != 30 {
		t.Fatalf("query args = %v, want [8 30]", call.args)
	}
}

func TestListScheduledReportSubscriptionsDueAtRequiresDatabase(t *testing.T) {
	reportStore := NewScheduledReportStore(nil)
	if _, err := reportStore.ListScheduledReportSubscriptionsDueAt(context.Background(), 8, 30); err == nil {
		t.Fatal("ListScheduledReportSubscriptionsDueAt() error = nil, want missing database error")
	}
}
