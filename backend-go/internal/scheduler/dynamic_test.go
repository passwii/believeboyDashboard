package scheduler

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
)

type fakeInsightScheduleSource struct {
	due        []store.DueInsightSchedule
	listErr    error
	advanceErr error
	seenNow    time.Time
	advanced   []int64
	nextRuns   []time.Time
	listCalls  atomic.Int32
}

func (source *fakeInsightScheduleSource) ListDueInsightSchedules(
	_ context.Context,
	now time.Time,
) ([]store.DueInsightSchedule, error) {
	source.listCalls.Add(1)
	source.seenNow = now
	return source.due, source.listErr
}

func (source *fakeInsightScheduleSource) AdvanceInsightScheduleNextRun(
	_ context.Context,
	scheduleID int64,
	nextRunAt time.Time,
) error {
	if source.advanceErr != nil {
		return source.advanceErr
	}
	source.advanced = append(source.advanced, scheduleID)
	source.nextRuns = append(source.nextRuns, nextRunAt)
	return nil
}

type fakePayloadEnqueuer struct {
	taskNames []string
	payloads  []any
	err       error
}

func (enqueuer *fakePayloadEnqueuer) EnqueueTask(
	_ context.Context,
	taskName string,
	payload any,
) error {
	if enqueuer.err != nil {
		return enqueuer.err
	}
	enqueuer.taskNames = append(enqueuer.taskNames, taskName)
	enqueuer.payloads = append(enqueuer.payloads, payload)
	return nil
}

func TestInsightReconcilerEnqueuesDueSchedulesAndAdvancesNextRun(t *testing.T) {
	now := mustShanghaiTime(t, "2026-11-08T08:30:00+08:00")
	source := &fakeInsightScheduleSource{due: []store.DueInsightSchedule{
		{ID: 11, InsightType: "custom", CronExpression: "0 9 * * *"},
		{ID: 12, InsightType: "daily", CronExpression: "*/5 * * * *"},
	}}
	enqueuer := &fakePayloadEnqueuer{}
	reconciler, err := NewInsightReconciler(InsightReconcilerConfig{
		Source:   source,
		Enqueuer: enqueuer,
		Now:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewInsightReconciler() error = %v", err)
	}

	result, err := reconciler.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result.Due != 2 || result.Enqueued != 2 || result.Failed != 0 || result.SkippedMigrated != 0 {
		t.Fatalf("RunOnce() result = %+v", result)
	}
	if source.seenNow.Location().String() != DefaultTimezone {
		t.Fatalf("reconciler now location = %q, want %q", source.seenNow.Location(), DefaultTimezone)
	}
	if len(enqueuer.payloads) != 2 {
		t.Fatalf("enqueued payloads = %d, want 2", len(enqueuer.payloads))
	}
	for index, taskName := range enqueuer.taskNames {
		if taskName != queue.TypeGenerateInsight {
			t.Fatalf("taskNames[%d] = %q, want %q", index, taskName, queue.TypeGenerateInsight)
		}
	}
	first := enqueuer.payloads[0].(tasks.GenerateInsightPayload)
	second := enqueuer.payloads[1].(tasks.GenerateInsightPayload)
	if first.ScheduleID == nil || *first.ScheduleID != 11 {
		t.Fatalf("first payload schedule_id = %v, want 11", first.ScheduleID)
	}
	if second.ScheduleID == nil || *second.ScheduleID != 12 {
		t.Fatalf("second payload schedule_id = %v, want 12", second.ScheduleID)
	}

	if len(source.advanced) != 2 || source.advanced[0] != 11 || source.advanced[1] != 12 {
		t.Fatalf("advanced schedule ids = %v, want [11 12]", source.advanced)
	}
	wantFirst := mustShanghaiTime(t, "2026-11-08T09:00:00+08:00")
	if !source.nextRuns[0].Equal(wantFirst) {
		t.Fatalf("first next_run_at = %s, want %s", source.nextRuns[0], wantFirst)
	}
	wantSecond := mustShanghaiTime(t, "2026-11-08T08:35:00+08:00")
	if !source.nextRuns[1].Equal(wantSecond) {
		t.Fatalf("second next_run_at = %s, want %s", source.nextRuns[1], wantSecond)
	}
}

func TestInsightReconcilerSkipsCanonicalMigratedDomain(t *testing.T) {
	now := mustShanghaiTime(t, "2026-11-08T08:30:00+08:00")
	source := &fakeInsightScheduleSource{due: []store.DueInsightSchedule{
		{ID: 21, InsightType: "ad_analysis", CronExpression: "0 9 * * *"},
	}}
	enqueuer := &fakePayloadEnqueuer{}
	reconciler, err := NewInsightReconciler(InsightReconcilerConfig{
		Source:           source,
		Enqueuer:         enqueuer,
		CanonicalDomains: "ad_analysis,inventory_health",
		Now:              func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewInsightReconciler() error = %v", err)
	}

	result, err := reconciler.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result.SkippedMigrated != 1 || result.Enqueued != 0 {
		t.Fatalf("RunOnce() result = %+v, want 1 skipped / 0 enqueued", result)
	}
	if len(enqueuer.payloads) != 0 {
		t.Fatalf("migrated domain enqueued %d payload(s), want 0", len(enqueuer.payloads))
	}
	if len(source.advanced) != 1 || source.advanced[0] != 21 {
		t.Fatalf("migrated domain advanced = %v, want [21]", source.advanced)
	}
}

func TestInsightReconcilerKeepsLegacyDomainWithoutCanonicalSwitch(t *testing.T) {
	now := mustShanghaiTime(t, "2026-11-08T08:30:00+08:00")
	source := &fakeInsightScheduleSource{due: []store.DueInsightSchedule{
		{ID: 22, InsightType: "ad_analysis", CronExpression: "0 9 * * *"},
	}}
	enqueuer := &fakePayloadEnqueuer{}
	reconciler, err := NewInsightReconciler(InsightReconcilerConfig{
		Source:   source,
		Enqueuer: enqueuer,
		Now:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewInsightReconciler() error = %v", err)
	}

	result, err := reconciler.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result.Enqueued != 1 || result.SkippedMigrated != 0 {
		t.Fatalf("RunOnce() result = %+v, want 1 enqueued", result)
	}
}

func TestInsightReconcilerKeepsScheduleDueWhenEnqueueFails(t *testing.T) {
	now := mustShanghaiTime(t, "2026-11-08T08:30:00+08:00")
	source := &fakeInsightScheduleSource{due: []store.DueInsightSchedule{
		{ID: 31, InsightType: "custom", CronExpression: "0 9 * * *"},
	}}
	enqueuer := &fakePayloadEnqueuer{err: errors.New("redis unavailable")}
	reconciler, err := NewInsightReconciler(InsightReconcilerConfig{
		Source:   source,
		Enqueuer: enqueuer,
		Now:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewInsightReconciler() error = %v", err)
	}

	result, err := reconciler.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result.Failed != 1 || result.Enqueued != 0 {
		t.Fatalf("RunOnce() result = %+v, want 1 failed", result)
	}
	if len(source.advanced) != 0 {
		t.Fatalf("advanced = %v, want none after enqueue failure", source.advanced)
	}
}

func TestInsightReconcilerReturnsListError(t *testing.T) {
	reconciler, err := NewInsightReconciler(InsightReconcilerConfig{
		Source:   &fakeInsightScheduleSource{listErr: errors.New("db down")},
		Enqueuer: &fakePayloadEnqueuer{},
	})
	if err != nil {
		t.Fatalf("NewInsightReconciler() error = %v", err)
	}
	if _, err := reconciler.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce() error = nil, want list error")
	}
}

func TestNewInsightReconcilerRequiresDependencies(t *testing.T) {
	if _, err := NewInsightReconciler(InsightReconcilerConfig{}); !errors.Is(err, ErrInsightScheduleSourceMissing) {
		t.Fatalf("missing source error = %v, want %v", err, ErrInsightScheduleSourceMissing)
	}
	if _, err := NewInsightReconciler(InsightReconcilerConfig{
		Source: &fakeInsightScheduleSource{},
	}); !errors.Is(err, ErrPayloadEnqueuerMissing) {
		t.Fatalf("missing enqueuer error = %v, want %v", err, ErrPayloadEnqueuerMissing)
	}
}

type fakeScheduledReportSource struct {
	due    []store.DueScheduledReportSubscription
	err    error
	hour   int
	minute int
}

func (source *fakeScheduledReportSource) ListScheduledReportSubscriptionsDueAt(
	_ context.Context,
	hour, minute int,
) ([]store.DueScheduledReportSubscription, error) {
	source.hour = hour
	source.minute = minute
	return source.due, source.err
}

func intPointer(value int) *int { return &value }

func stringPointer(value string) *string { return &value }

func TestScheduledReportScannerMatchesFrequencyConstraints(t *testing.T) {
	now := mustShanghaiTime(t, "2026-11-09T08:30:00+08:00") // Monday
	source := &fakeScheduledReportSource{due: []store.DueScheduledReportSubscription{
		{ID: 1, Email: stringPointer("daily@example.com"), ProjectIDs: "1,2", Country: "US", Frequency: "daily"},
		{ID: 2, Email: stringPointer("monday@example.com"), Country: "US", Frequency: "weekly", DispatchWeekday: intPointer(0)},
		{ID: 3, Email: stringPointer("tuesday@example.com"), Country: "US", Frequency: "weekly", DispatchWeekday: intPointer(1)},
		{ID: 4, Email: stringPointer("monthly-9@example.com"), Country: "US", Frequency: "monthly", DispatchDay: intPointer(9)},
		{ID: 5, Email: stringPointer("monthly-2@example.com"), Country: "US", Frequency: "monthly", DispatchDay: intPointer(2)},
		{ID: 6, Email: stringPointer("default-weekday@example.com"), Country: "US", Frequency: "weekly"},
		{ID: 7, Email: stringPointer("hourly@example.com"), Country: "US", Frequency: "hourly"},
	}}
	enqueuer := &fakePayloadEnqueuer{}
	scanner, err := NewScheduledReportScanner(ScheduledReportScannerConfig{
		Source:   source,
		Enqueuer: enqueuer,
		Now:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewScheduledReportScanner() error = %v", err)
	}

	result, err := scanner.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if source.hour != 8 || source.minute != 30 {
		t.Fatalf("scan window = %02d:%02d, want 08:30", source.hour, source.minute)
	}
	if result.Matched != 4 || result.Enqueued != 4 || result.Failed != 0 {
		t.Fatalf("RunOnce() result = %+v, want 4 matched/enqueued", result)
	}
	wantIDs := []int64{1, 2, 4, 6}
	if len(enqueuer.payloads) != len(wantIDs) {
		t.Fatalf("enqueued payloads = %d, want %d", len(enqueuer.payloads), len(wantIDs))
	}
	for index, taskName := range enqueuer.taskNames {
		if taskName != queue.TypeDispatchOne {
			t.Fatalf("taskNames[%d] = %q, want %q", index, taskName, queue.TypeDispatchOne)
		}
		payload := enqueuer.payloads[index].(tasks.DispatchOnePayload)
		if payload.SubscriptionID != wantIDs[index] {
			t.Fatalf("payloads[%d].subscription_id = %d, want %d", index, payload.SubscriptionID, wantIDs[index])
		}
		if payload.TriggeredBy != "auto" {
			t.Fatalf("payloads[%d].triggered_by = %q, want auto", index, payload.TriggeredBy)
		}
		if payload.ReportDate != "2026-11-09" {
			t.Fatalf("payloads[%d].report_date = %q, want 2026-11-09", index, payload.ReportDate)
		}
	}
	first := enqueuer.payloads[0].(tasks.DispatchOnePayload)
	if first.Email != "daily@example.com" || first.Country != "US" || first.Frequency != "daily" {
		t.Fatalf("first payload = %+v", first)
	}
	if len(first.ProjectIDs) != 2 || first.ProjectIDs[0] != 1 || first.ProjectIDs[1] != 2 {
		t.Fatalf("first payload project_ids = %v, want [1 2]", first.ProjectIDs)
	}
}

func TestScheduledReportScannerNoDueSubscriptions(t *testing.T) {
	scanner, err := NewScheduledReportScanner(ScheduledReportScannerConfig{
		Source:   &fakeScheduledReportSource{},
		Enqueuer: &fakePayloadEnqueuer{},
	})
	if err != nil {
		t.Fatalf("NewScheduledReportScanner() error = %v", err)
	}
	result, err := scanner.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result.Matched != 0 || result.Enqueued != 0 {
		t.Fatalf("RunOnce() result = %+v, want empty", result)
	}
}

func TestNewScheduledReportScannerRequiresDependencies(t *testing.T) {
	if _, err := NewScheduledReportScanner(ScheduledReportScannerConfig{}); !errors.Is(err, ErrScheduledReportSourceMissing) {
		t.Fatalf("missing source error = %v, want %v", err, ErrScheduledReportSourceMissing)
	}
	if _, err := NewScheduledReportScanner(ScheduledReportScannerConfig{
		Source: &fakeScheduledReportSource{},
	}); !errors.Is(err, ErrPayloadEnqueuerMissing) {
		t.Fatalf("missing enqueuer error = %v, want %v", err, ErrPayloadEnqueuerMissing)
	}
}
