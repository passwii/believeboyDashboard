package scheduler

import (
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSchedulerUsesShanghaiTimezoneAndComputesNextRun(t *testing.T) {
	s := New()
	now := mustShanghaiTime(t, "2026-11-08T08:30:00+08:00")
	s.now = func() time.Time { return now }

	if got := s.Location().String(); got != DefaultTimezone {
		t.Fatalf("Location() = %q, want %q", got, DefaultTimezone)
	}
	if err := s.AddJob("crm-follow-up-reminder", "0 9 * * *", func() {}); err != nil {
		t.Fatalf("AddJob() error = %v", err)
	}

	jobs := s.ListJobs()
	if len(jobs) != 1 {
		t.Fatalf("ListJobs() length = %d, want 1", len(jobs))
	}
	wantNext := mustShanghaiTime(t, "2026-11-08T09:00:00+08:00")
	if !jobs[0].NextRun.Equal(wantNext) {
		t.Fatalf("NextRun = %s, want %s", jobs[0].NextRun, wantNext)
	}
	if got := jobs[0].NextRun.Location().String(); got != DefaultTimezone {
		t.Fatalf("NextRun location = %q, want %q", got, DefaultTimezone)
	}
}

func TestSchedulerRejectsInvalidJobs(t *testing.T) {
	s := New()

	tests := []struct {
		name string
		add  func() error
	}{
		{name: "empty name", add: func() error {
			return s.AddJob("", "* * * * *", func() {})
		}},
		{name: "invalid cron", add: func() error {
			return s.AddJob("invalid-cron", "not-a-cron", func() {})
		}},
		{name: "nil command", add: func() error {
			return s.AddJob("nil-command", "* * * * *", nil)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.add(); err == nil {
				t.Fatal("AddJob() error = nil, want error")
			}
		})
	}

	if err := s.AddJob("duplicate", "* * * * *", func() {}); err != nil {
		t.Fatalf("first AddJob() error = %v", err)
	}
	if err := s.AddJob("duplicate", "*/5 * * * *", func() {}); err == nil {
		t.Fatal("duplicate AddJob() error = nil, want error")
	}
}

func TestSchedulerStartStopIsIdempotent(t *testing.T) {
	s := New()
	s.SetLogger(discardLogger())
	if err := s.AddJob("minute-job", "* * * * *", func() {}); err != nil {
		t.Fatalf("AddJob() error = %v", err)
	}

	s.Start()
	s.Start()
	s.Stop()
	s.Stop()
}

func TestMemoryLockerContentionExpiryAndRelease(t *testing.T) {
	now := mustShanghaiTime(t, "2026-11-08T08:30:00+08:00")
	locker := NewMemoryLocker()
	locker.now = func() time.Time { return now }

	acquired, release, err := locker.TryLock(t.Context(), "job:test", time.Minute)
	if err != nil {
		t.Fatalf("TryLock() error = %v", err)
	}
	if !acquired {
		t.Fatal("first TryLock() = false, want true")
	}

	acquired, _, err = locker.TryLock(t.Context(), "job:test", time.Minute)
	if err != nil {
		t.Fatalf("contended TryLock() error = %v", err)
	}
	if acquired {
		t.Fatal("contended TryLock() = true, want false")
	}

	now = now.Add(2 * time.Minute)
	acquired, secondRelease, err := locker.TryLock(t.Context(), "job:test", time.Minute)
	if err != nil {
		t.Fatalf("TryLock() after expiry error = %v", err)
	}
	if !acquired {
		t.Fatal("TryLock() after expiry = false, want true")
	}

	release()
	acquired, _, err = locker.TryLock(t.Context(), "job:test", time.Minute)
	if err != nil {
		t.Fatalf("TryLock() after stale release error = %v", err)
	}
	if acquired {
		t.Fatal("stale release removed the new owner's lock")
	}

	secondRelease()
	acquired, _, err = locker.TryLock(t.Context(), "job:test", time.Minute)
	if err != nil {
		t.Fatalf("TryLock() after owner release error = %v", err)
	}
	if !acquired {
		t.Fatal("owner release did not release the lock")
	}
}

func TestSchedulerRunsJobOnlyOnceAcrossInstances(t *testing.T) {
	locker := NewMemoryLocker()
	first := New(locker)
	second := New(locker)
	first.SetLogger(discardLogger())
	second.SetLogger(discardLogger())
	var calls atomic.Int32
	command := func() error {
		time.Sleep(10 * time.Millisecond)
		calls.Add(1)
		return nil
	}
	if err := first.addJob("shared-job", "* * * * *", "", command); err != nil {
		t.Fatalf("first addJob() error = %v", err)
	}
	if err := second.addJob("shared-job", "* * * * *", "", command); err != nil {
		t.Fatalf("second addJob() error = %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		first.runJobByName("shared-job")
	}()
	go func() {
		defer wg.Done()
		second.runJobByName("shared-job")
	}()
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("command calls = %d, want 1", got)
	}
}

func TestSchedulerReleasesLockAfterCommandFailure(t *testing.T) {
	locker := NewMemoryLocker()
	first := New(locker)
	second := New(locker)
	first.SetLogger(discardLogger())
	second.SetLogger(discardLogger())
	var calls atomic.Int32
	failing := func() error {
		calls.Add(1)
		return errors.New("enqueue failed")
	}
	successful := func() error {
		calls.Add(1)
		return nil
	}
	if err := first.addJob("retry-job", "* * * * *", "", failing); err != nil {
		t.Fatalf("first addJob() error = %v", err)
	}
	if err := second.addJob("retry-job", "* * * * *", "", successful); err != nil {
		t.Fatalf("second addJob() error = %v", err)
	}

	first.runJobByName("retry-job")
	second.runJobByName("retry-job")

	if got := calls.Load(); got != 2 {
		t.Fatalf("command calls = %d, want 2", got)
	}
}

func TestSchedulerReleasesLockAfterCommandPanic(t *testing.T) {
	locker := NewMemoryLocker()
	first := New(locker)
	second := New(locker)
	first.SetLogger(discardLogger())
	second.SetLogger(discardLogger())
	var calls atomic.Int32
	panicking := func() error {
		calls.Add(1)
		panic("enqueue panic")
	}
	successful := func() error {
		calls.Add(1)
		return nil
	}
	if err := first.addJob("panic-job", "* * * * *", "", panicking); err != nil {
		t.Fatalf("first addJob() error = %v", err)
	}
	if err := second.addJob("panic-job", "* * * * *", "", successful); err != nil {
		t.Fatalf("second addJob() error = %v", err)
	}

	first.runJobByName("panic-job")
	second.runJobByName("panic-job")

	if got := calls.Load(); got != 2 {
		t.Fatalf("command calls = %d, want 2", got)
	}
}

func TestLockTTLExpiresBeforeNextOccurrence(t *testing.T) {
	s := New()
	schedule, err := s.parser.Parse("5 * * * *")
	if err != nil {
		t.Fatalf("parse cron: %v", err)
	}
	now := mustShanghaiTime(t, "2026-11-08T09:05:00.100+08:00")

	ttl := lockTTL(schedule, now)
	nextRun := schedule.Next(now)
	if expiresAt := now.Add(ttl); !expiresAt.Before(nextRun) {
		t.Fatalf("lock expires at %s, want before next run %s", expiresAt, nextRun)
	}
}

func TestSetLockerNilKeepsExistingLocker(t *testing.T) {
	locker := NewMemoryLocker()
	s := New(locker)
	if err := s.AddJob("existing-locker", "* * * * *", func() {}); err != nil {
		t.Fatalf("AddJob() error = %v", err)
	}
	s.SetLocker(nil)
	s.runJobByName("existing-locker")

	acquired, _, err := locker.TryLock(
		t.Context(),
		schedulerLockPrefix+"existing-locker",
		time.Minute,
	)
	if err != nil {
		t.Fatalf("TryLock() error = %v", err)
	}
	if acquired {
		t.Fatal("TryLock() = true, want false because scheduler still owns the lock")
	}
}

func mustShanghaiTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
