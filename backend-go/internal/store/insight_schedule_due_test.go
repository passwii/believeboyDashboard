package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

func TestListDueInsightSchedulesQueriesActiveDueRows(t *testing.T) {
	now := time.Date(2026, 11, 9, 8, 30, 0, 0, time.UTC)
	db := &scheduledTestDB{rowsQueueQuery: []Rows{&scheduledTestRows{batches: [][]any{
		{int64(7), "ad_analysis", "0 9 * * *"},
		{int64(8), "custom", "*/5 * * * *"},
	}}}}
	insightStore := NewAIInsightStore(db, nil)

	due, err := insightStore.ListDueInsightSchedules(context.Background(), now)
	if err != nil {
		t.Fatalf("ListDueInsightSchedules() error = %v", err)
	}
	if len(due) != 2 {
		t.Fatalf("due schedules = %d, want 2", len(due))
	}
	if due[0].ID != 7 || due[0].InsightType != "ad_analysis" || due[0].CronExpression != "0 9 * * *" {
		t.Fatalf("due[0] = %+v", due[0])
	}
	if due[1].ID != 8 || due[1].InsightType != "custom" {
		t.Fatalf("due[1] = %+v", due[1])
	}

	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.queryCalls))
	}
	call := db.queryCalls[0]
	if !strings.Contains(call.sql, "public.insight_schedules") {
		t.Fatalf("query sql = %q, want insight_schedules table", call.sql)
	}
	for _, fragment := range []string{"is_active = true", "next_run_at <= $1"} {
		if !strings.Contains(call.sql, fragment) {
			t.Fatalf("query sql = %q, want %q", call.sql, fragment)
		}
	}
	if len(call.args) != 1 {
		t.Fatalf("query args = %v, want 1", call.args)
	}
	seenNow, ok := call.args[0].(time.Time)
	if !ok || !seenNow.Equal(now) {
		t.Fatalf("query arg = %v, want %s", call.args[0], now)
	}
}

func TestListDueInsightSchedulesRequiresDatabase(t *testing.T) {
	insightStore := NewAIInsightStore(nil, nil)
	if _, err := insightStore.ListDueInsightSchedules(context.Background(), time.Now()); err == nil {
		t.Fatal("ListDueInsightSchedules() error = nil, want missing database error")
	}
}

func TestAdvanceInsightScheduleNextRunUpdatesDueTime(t *testing.T) {
	next := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	db := &scheduledTestDB{execTag: pgconn.NewCommandTag("UPDATE 1")}
	insightStore := NewAIInsightStore(db, nil)

	if err := insightStore.AdvanceInsightScheduleNextRun(context.Background(), 7, next); err != nil {
		t.Fatalf("AdvanceInsightScheduleNextRun() error = %v", err)
	}
	if len(db.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(db.execCalls))
	}
	call := db.execCalls[0]
	if !strings.Contains(call.sql, "next_run_at = $1") {
		t.Fatalf("exec sql = %q, want next_run_at assignment", call.sql)
	}
	if len(call.args) != 2 {
		t.Fatalf("exec args = %v, want 2", call.args)
	}
	seenNext, ok := call.args[0].(time.Time)
	if !ok || !seenNext.Equal(next) {
		t.Fatalf("exec arg[0] = %v, want %s", call.args[0], next)
	}
	if call.args[1] != int64(7) {
		t.Fatalf("exec arg[1] = %v, want 7", call.args[1])
	}
}

func TestAdvanceInsightScheduleNextRunMissingSchedule(t *testing.T) {
	db := &scheduledTestDB{execTag: pgconn.NewCommandTag("UPDATE 0")}
	insightStore := NewAIInsightStore(db, nil)

	err := insightStore.AdvanceInsightScheduleNextRun(context.Background(), 99, time.Now())
	if !errors.Is(err, ai_insight.ErrScheduleNotFound) {
		t.Fatalf("AdvanceInsightScheduleNextRun() error = %v, want %v", err, ai_insight.ErrScheduleNotFound)
	}
}
