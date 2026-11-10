package scheduler

import (
	"context"
	"fmt"
	"runtime/debug"
	"strings"
	"time"
)

// intervalJob is a ticker-driven job managed by the scheduler lifecycle.
type intervalJob struct {
	name     string
	interval time.Duration
	command  func(context.Context) error
}

// AddInterval registers an interval job. Interval jobs start with the
// scheduler and are cancelled/waited for by Stop. They use the same
// "job:<name>" distributed lock namespace as cron jobs so multi-instance
// deployments do not run the same tick twice.
func (s *Scheduler) AddInterval(
	name string,
	interval time.Duration,
	command func(context.Context) error,
) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return ErrInvalidJobName
	}
	if command == nil {
		return ErrInvalidJobCommand
	}
	if interval <= 0 {
		return fmt.Errorf("%w: %s", ErrInvalidJobInterval, interval)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()
	if s.intervalJobs == nil {
		s.intervalJobs = make(map[string]*intervalJob)
	}
	if _, exists := s.jobs[name]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateJobName, name)
	}
	if _, exists := s.intervalJobs[name]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateJobName, name)
	}
	job := &intervalJob{name: name, interval: interval, command: command}
	s.intervalJobs[name] = job
	s.intervalOrder = append(s.intervalOrder, name)
	if s.started && s.intervalCtx != nil {
		s.startIntervalLocked(job, s.intervalCtx)
	}
	return nil
}

func (s *Scheduler) startIntervalLocked(job *intervalJob, ctx context.Context) {
	s.intervalWG.Add(1)
	go s.runIntervalLoop(ctx, job)
}

func (s *Scheduler) runIntervalLoop(ctx context.Context, job *intervalJob) {
	defer s.intervalWG.Done()
	ticker := time.NewTicker(job.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runIntervalJob(ctx, job)
		}
	}
}

func (s *Scheduler) runIntervalJob(parent context.Context, job *intervalJob) {
	s.mu.Lock()
	s.initLocked()
	locker := s.locker
	logger := s.logger
	jobContext := s.intervalCtx
	s.mu.Unlock()

	if jobContext == nil {
		jobContext = parent
	}
	if jobContext == nil || jobContext.Err() != nil {
		return
	}

	key := schedulerLockPrefix + job.name
	acquired, release, err := locker.TryLock(jobContext, key, intervalLockTTL(job.interval))
	if err != nil {
		logger.Error("scheduler interval lock acquisition failed",
			"job", job.name,
			"error", err,
		)
		return
	}
	if !acquired {
		logger.Debug("scheduler interval job skipped because another instance owns the lock",
			"job", job.name,
		)
		return
	}

	commandContext, cancel := context.WithTimeout(jobContext, job.interval)
	defer cancel()

	succeeded := false
	defer func() {
		if recovered := recover(); recovered != nil {
			logger.Error("scheduler interval job panicked",
				"job", job.name,
				"panic", recovered,
				"stack", string(debug.Stack()),
			)
		}
		if !succeeded {
			release()
		}
	}()
	if err := job.command(commandContext); err != nil {
		logger.Error("scheduler interval job failed", "job", job.name, "error", err)
		return
	}
	succeeded = true
}

// intervalLockTTL keeps the distributed lock until just before the next tick
// while never waiting for a full interval on shutdown.
func intervalLockTTL(interval time.Duration) time.Duration {
	if interval <= 0 {
		return minLockTTL
	}
	guard := lockTTLGuard
	if interval <= 2*lockTTLGuard {
		guard = interval / 10
	}
	ttl := interval - guard
	if ttl <= 0 {
		return interval
	}
	return ttl
}
