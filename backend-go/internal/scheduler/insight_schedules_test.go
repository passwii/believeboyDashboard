package scheduler

import (
	"context"
	"sync"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

type fakeInsightScheduleSource struct {
	mu        sync.Mutex
	schedules []ai_insight.Schedule
	err       error
}

func (source *fakeInsightScheduleSource) ListSchedules(
	_ context.Context,
	filter ai_insight.ScheduleFilter,
) ([]ai_insight.Schedule, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.err != nil {
		return nil, source.err
	}
	if filter.IsActive != nil && *filter.IsActive {
		active := make([]ai_insight.Schedule, 0, len(source.schedules))
		for _, schedule := range source.schedules {
			if schedule.IsActive {
				active = append(active, schedule)
			}
		}
		return active, nil
	}
	return append([]ai_insight.Schedule(nil), source.schedules...), nil
}

func (source *fakeInsightScheduleSource) set(schedules ...ai_insight.Schedule) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.schedules = schedules
}

func TestSyncInsightSchedulesRegistersActiveSchedules(t *testing.T) {
	sched := New()
	source := &fakeInsightScheduleSource{}
	source.set(
		ai_insight.Schedule{ID: 7, CronExpression: "0 9 * * *", IsActive: true},
		ai_insight.Schedule{ID: 8, CronExpression: "30 18 * * *", IsActive: true},
		ai_insight.Schedule{ID: 9, CronExpression: "0 3 * * *", IsActive: false},
	)

	var enqueued []int64
	enqueue := func(scheduleID int64) error {
		enqueued = append(enqueued, scheduleID)
		return nil
	}

	result, err := SyncInsightSchedules(context.Background(), sched, source, enqueue)
	if err != nil {
		t.Fatalf("SyncInsightSchedules() error = %v", err)
	}
	if result.Registered != 2 || result.Removed != 0 || result.Skipped != 0 {
		t.Fatalf("result = %#v, want 2 registered (inactive schedule must be ignored)", result)
	}
	if jobs := len(sched.ListJobs()); jobs != 2 {
		t.Fatalf("scheduler jobs = %d, want 2", jobs)
	}

	sched.runJobByName(InsightJobPrefix + "7")
	if len(enqueued) != 1 || enqueued[0] != 7 {
		t.Fatalf("enqueued = %v, want [7]", enqueued)
	}
}

func TestSyncInsightSchedulesIsIdempotent(t *testing.T) {
	sched := New()
	source := &fakeInsightScheduleSource{}
	source.set(ai_insight.Schedule{ID: 11, CronExpression: "15 8 * * *", IsActive: true})
	enqueue := func(int64) error { return nil }

	first, err := SyncInsightSchedules(context.Background(), sched, source, enqueue)
	if err != nil {
		t.Fatalf("first sync error = %v", err)
	}
	if first.Registered != 1 {
		t.Fatalf("first result = %#v, want 1 registered", first)
	}

	second, err := SyncInsightSchedules(context.Background(), sched, source, enqueue)
	if err != nil {
		t.Fatalf("second sync error = %v", err)
	}
	if second.Registered != 0 || second.Unchanged != 1 {
		t.Fatalf("second result = %#v, want unchanged only", second)
	}
	if jobs := len(sched.ListJobs()); jobs != 1 {
		t.Fatalf("scheduler jobs = %d, want 1 (no duplicate registration)", jobs)
	}
}

func TestSyncInsightSchedulesRemovesStaleJobs(t *testing.T) {
	sched := New()
	source := &fakeInsightScheduleSource{}
	source.set(
		ai_insight.Schedule{ID: 21, CronExpression: "0 9 * * *", IsActive: true},
		ai_insight.Schedule{ID: 22, CronExpression: "0 10 * * *", IsActive: true},
	)
	enqueue := func(int64) error { return nil }

	if _, err := SyncInsightSchedules(context.Background(), sched, source, enqueue); err != nil {
		t.Fatalf("initial sync error = %v", err)
	}

	// Schedule 22 is deactivated in the database.
	source.set(ai_insight.Schedule{ID: 21, CronExpression: "0 9 * * *", IsActive: true})
	result, err := SyncInsightSchedules(context.Background(), sched, source, enqueue)
	if err != nil {
		t.Fatalf("second sync error = %v", err)
	}
	if result.Removed != 1 {
		t.Fatalf("result = %#v, want 1 removed", result)
	}
	if _, ok := sched.CronExprOf(InsightJobPrefix + "22"); ok {
		t.Fatal("deactivated schedule job is still registered")
	}
}

func TestSyncInsightSchedulesReplacesChangedCronExpression(t *testing.T) {
	sched := New()
	source := &fakeInsightScheduleSource{}
	source.set(ai_insight.Schedule{ID: 31, CronExpression: "0 9 * * *", IsActive: true})
	enqueue := func(int64) error { return nil }

	if _, err := SyncInsightSchedules(context.Background(), sched, source, enqueue); err != nil {
		t.Fatalf("initial sync error = %v", err)
	}

	source.set(ai_insight.Schedule{ID: 31, CronExpression: "45 6 * * *", IsActive: true})
	result, err := SyncInsightSchedules(context.Background(), sched, source, enqueue)
	if err != nil {
		t.Fatalf("second sync error = %v", err)
	}
	if result.Registered != 1 {
		t.Fatalf("result = %#v, want 1 re-registered", result)
	}
	if cronExpr, ok := sched.CronExprOf(InsightJobPrefix + "31"); !ok || cronExpr != "45 6 * * *" {
		t.Fatalf("cron expression = %q, want the updated value", cronExpr)
	}
}

func TestSyncInsightSchedulesSkipsInvalidRowsWithoutFailingThePass(t *testing.T) {
	sched := New()
	source := &fakeInsightScheduleSource{}
	source.set(
		ai_insight.Schedule{ID: 41, CronExpression: "not a cron", IsActive: true},
		ai_insight.Schedule{ID: 42, CronExpression: "  ", IsActive: true},
		ai_insight.Schedule{ID: 43, CronExpression: "0 7 * * *", IsActive: true},
	)
	enqueue := func(int64) error { return nil }

	result, err := SyncInsightSchedules(context.Background(), sched, source, enqueue)
	if err != nil {
		t.Fatalf("SyncInsightSchedules() error = %v", err)
	}
	if result.Registered != 1 || result.Skipped != 2 {
		t.Fatalf("result = %#v, want 1 registered and 2 skipped", result)
	}
	if _, ok := sched.CronExprOf(InsightJobPrefix + "43"); !ok {
		t.Fatal("valid schedule was not registered")
	}
}

func TestSyncInsightSchedulesRequiresDependencies(t *testing.T) {
	source := &fakeInsightScheduleSource{}
	enqueue := func(int64) error { return nil }

	if _, err := SyncInsightSchedules(context.Background(), nil, source, enqueue); err == nil {
		t.Fatal("expected an error for a nil scheduler")
	}
	if _, err := SyncInsightSchedules(context.Background(), New(), nil, enqueue); err == nil {
		t.Fatal("expected an error for a nil source")
	}
	if _, err := SyncInsightSchedules(context.Background(), New(), source, nil); err == nil {
		t.Fatal("expected an error for a nil enqueuer")
	}
}
