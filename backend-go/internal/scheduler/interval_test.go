package scheduler

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestSchedulerRejectsInvalidIntervalJobs(t *testing.T) {
	s := New()
	if err := s.AddInterval("", time.Second, func(context.Context) error { return nil }); !errors.Is(err, ErrInvalidJobName) {
		t.Fatalf("empty name error = %v, want %v", err, ErrInvalidJobName)
	}
	if err := s.AddInterval("zero", 0, func(context.Context) error { return nil }); !errors.Is(err, ErrInvalidJobInterval) {
		t.Fatalf("zero interval error = %v, want %v", err, ErrInvalidJobInterval)
	}
	if err := s.AddInterval("nil-command", time.Second, nil); !errors.Is(err, ErrInvalidJobCommand) {
		t.Fatalf("nil command error = %v, want %v", err, ErrInvalidJobCommand)
	}
	if err := s.AddInterval("shared-name", time.Second, func(context.Context) error { return nil }); err != nil {
		t.Fatalf("AddInterval() error = %v", err)
	}
	if err := s.AddInterval("shared-name", time.Second, func(context.Context) error { return nil }); !errors.Is(err, ErrDuplicateJobName) {
		t.Fatalf("duplicate interval error = %v, want %v", err, ErrDuplicateJobName)
	}
	if err := s.AddJob("shared-name", "* * * * *", func() {}); !errors.Is(err, ErrDuplicateJobName) {
		t.Fatalf("interval/cron name collision error = %v, want %v", err, ErrDuplicateJobName)
	}
}

func TestSchedulerRunsIntervalJobUntilStop(t *testing.T) {
	s := New()
	s.SetLogger(discardLogger())
	var calls atomic.Int32
	if err := s.AddInterval("tick", 20*time.Millisecond, func(ctx context.Context) error {
		calls.Add(1)
		return nil
	}); err != nil {
		t.Fatalf("AddInterval() error = %v", err)
	}

	s.Start()
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := calls.Load(); got < 2 {
		t.Fatalf("interval job calls = %d, want at least 2", got)
	}

	s.Stop()
	stopped := calls.Load()
	time.Sleep(60 * time.Millisecond)
	if got := calls.Load(); got != stopped {
		t.Fatalf("interval job calls after Stop = %d, want %d", got, stopped)
	}
}

func TestSchedulerAddIntervalAfterStartRuns(t *testing.T) {
	s := New()
	s.SetLogger(discardLogger())
	s.Start()
	defer s.Stop()

	var calls atomic.Int32
	if err := s.AddInterval("late", 20*time.Millisecond, func(context.Context) error {
		calls.Add(1)
		return nil
	}); err != nil {
		t.Fatalf("AddInterval() after Start error = %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := calls.Load(); got < 1 {
		t.Fatalf("interval job added after Start calls = %d, want at least 1", got)
	}
}

func TestRegisterDynamicJobsRegistersBothJobs(t *testing.T) {
	s := New()
	s.SetLogger(discardLogger())
	reconciler, err := NewInsightReconciler(InsightReconcilerConfig{
		Source:   &fakeInsightScheduleSource{},
		Enqueuer: &fakePayloadEnqueuer{},
	})
	if err != nil {
		t.Fatalf("NewInsightReconciler() error = %v", err)
	}
	scanner, err := NewScheduledReportScanner(ScheduledReportScannerConfig{
		Source:   &fakeScheduledReportSource{},
		Enqueuer: &fakePayloadEnqueuer{},
	})
	if err != nil {
		t.Fatalf("NewScheduledReportScanner() error = %v", err)
	}
	if err := RegisterDynamicJobs(s, DynamicJobsConfig{
		InsightReconciler:      reconciler,
		InsightInterval:        20 * time.Millisecond,
		ScheduledReportScanner: scanner,
	}); err != nil {
		t.Fatalf("RegisterDynamicJobs() error = %v", err)
	}

	var scanJob *JobInfo
	for _, job := range s.ListJobs() {
		if job.Name == ScheduledReportScanJobName {
			job := job
			scanJob = &job
		}
	}
	if scanJob == nil {
		t.Fatalf("ListJobs() = %+v, want %s", s.ListJobs(), ScheduledReportScanJobName)
	}
	if scanJob.CronExpr != "* * * * *" {
		t.Fatalf("scan job cron = %q, want minutely", scanJob.CronExpr)
	}

	source := &fakeInsightScheduleSource{}
	reconciler2, err := NewInsightReconciler(InsightReconcilerConfig{
		Source:   source,
		Enqueuer: &fakePayloadEnqueuer{},
	})
	if err != nil {
		t.Fatalf("NewInsightReconciler() error = %v", err)
	}
	s2 := New()
	s2.SetLogger(discardLogger())
	if err := RegisterDynamicJobs(s2, DynamicJobsConfig{
		InsightReconciler: reconciler2,
		InsightInterval:   20 * time.Millisecond,
	}); err != nil {
		t.Fatalf("RegisterDynamicJobs() error = %v", err)
	}
	s2.Start()
	deadline := time.Now().Add(2 * time.Second)
	for source.listCalls.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	s2.Stop()
	if source.listCalls.Load() < 1 {
		t.Fatal("insight reconciler interval job did not run")
	}
}

func TestRegisterDynamicJobsRejectsEmptyConfig(t *testing.T) {
	if err := RegisterDynamicJobs(nil, DynamicJobsConfig{}); err == nil {
		t.Fatal("RegisterDynamicJobs(nil) error = nil, want error")
	}
	if err := RegisterDynamicJobs(New(), DynamicJobsConfig{}); err == nil {
		t.Fatal("RegisterDynamicJobs(empty) error = nil, want error")
	}
}
