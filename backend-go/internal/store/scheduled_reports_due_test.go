package store

import (
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
)

func intPtr(value int) *int { return &value }

func TestFilterDueSubscriptionsMatchesFrequencyRules(t *testing.T) {
	// 2026-11-09 is a Monday (Python weekday 0).
	local := time.Date(2026, 11, 9, 15, 30, 0, 0, time.FixedZone("CST", 8*3600))
	subscriptions := []scheduled_reports.Subscription{
		{ID: 1, Frequency: "daily", DispatchHour: 15, DispatchMinute: 30},
		{ID: 2, Frequency: "weekly", DispatchHour: 15, DispatchMinute: 30, DispatchWeekday: intPtr(0)},
		{ID: 3, Frequency: "weekly", DispatchHour: 15, DispatchMinute: 30, DispatchWeekday: intPtr(6)},
		{ID: 4, Frequency: "monthly", DispatchHour: 15, DispatchMinute: 30, DispatchDay: intPtr(9)},
		{ID: 5, Frequency: "monthly", DispatchHour: 15, DispatchMinute: 30, DispatchDay: intPtr(2)},
		{ID: 6, Frequency: "daily", DispatchHour: 15, DispatchMinute: 31},
		{ID: 7, Frequency: "unknown", DispatchHour: 15, DispatchMinute: 30},
	}
	due := filterDueSubscriptions(subscriptions, local)
	want := []int64{1, 2, 4}
	if len(due) != len(want) {
		t.Fatalf("due = %d subscriptions (%v), want %v", len(due), subscriptionIDs(due), want)
	}
	for index, id := range want {
		if due[index].ID != id {
			t.Errorf("due[%d].ID = %d, want %d", index, due[index].ID, id)
		}
	}
}

func TestSubscriptionMatchesDateWeeklyUsesMondayZero(t *testing.T) {
	location := time.FixedZone("CST", 8*3600)
	monday := time.Date(2026, 11, 9, 0, 0, 0, 0, location)
	sunday := time.Date(2026, 11, 15, 0, 0, 0, 0, location)
	mondaySubscription := scheduled_reports.Subscription{
		Frequency:       "weekly",
		DispatchWeekday: intPtr(0),
	}
	if !subscriptionMatchesDate(mondaySubscription, monday) {
		t.Error("Monday should match dispatch_weekday=0")
	}
	if subscriptionMatchesDate(mondaySubscription, sunday) {
		t.Error("Sunday should not match dispatch_weekday=0")
	}
	sundaySubscription := scheduled_reports.Subscription{
		Frequency:       "weekly",
		DispatchWeekday: intPtr(6),
	}
	if !subscriptionMatchesDate(sundaySubscription, sunday) {
		t.Error("Sunday should match dispatch_weekday=6")
	}
}

func subscriptionIDs(subscriptions []scheduled_reports.Subscription) []int64 {
	ids := make([]int64, 0, len(subscriptions))
	for _, subscription := range subscriptions {
		ids = append(ids, subscription.ID)
	}
	return ids
}
