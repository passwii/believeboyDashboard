package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"

	"github.com/robfig/cron/v3"
)

const (
	// DefaultTimezone mirrors CELERY_TASK_TIMEZONE.
	DefaultTimezone = "Asia/Shanghai"

	schedulerLockPrefix = "job:"
	lockTTLGuard        = 5 * time.Second
	minLockTTL          = time.Second
)

var (
	// ErrInvalidJobName is returned when a scheduler job has no name.
	ErrInvalidJobName = errors.New("scheduler job name is required")
	// ErrDuplicateJobName is returned when a job name is registered twice.
	ErrDuplicateJobName = errors.New("scheduler job name is already registered")
	// ErrInvalidJobCommand is returned when a scheduler job has no command.
	ErrInvalidJobCommand = errors.New("scheduler job command is required")
)

// JobInfo is an immutable scheduler registration snapshot.
type JobInfo struct {
	Name     string
	CronExpr string
	TaskName string
	NextRun  time.Time
}

type scheduledJob struct {
	name     string
	cronExpr string
	taskName string
	schedule cron.Schedule
	entryID  cron.EntryID
	command  func() error
}

// Scheduler runs jobs with Celery Beat-compatible Shanghai time semantics.
type Scheduler struct {
	mu       sync.Mutex
	location *time.Location
	parser   cron.Parser
	cron     *cron.Cron
	locker   Locker
	logger   *slog.Logger
	now      func() time.Time

	jobs  map[string]*scheduledJob
	order []string

	started bool
	ctx     context.Context
	cancel  context.CancelFunc
}

// New creates a scheduler. Without an explicit locker, the scheduler uses an
// in-process memory locker; production multi-instance deployments should pass
// a RedisLocker.
func New(lockers ...Locker) *Scheduler {
	location, err := time.LoadLocation(DefaultTimezone)
	if err != nil {
		panic(fmt.Errorf("load scheduler timezone %s: %w", DefaultTimezone, err))
	}

	s := &Scheduler{
		location: location,
		locker:   NewMemoryLocker(),
		logger:   slog.Default(),
		now:      time.Now,
		jobs:     make(map[string]*scheduledJob),
	}
	if len(lockers) > 0 && lockers[0] != nil {
		s.locker = lockers[0]
	}
	s.initLocked()
	return s
}

// NewScheduler is a convenience alias for New.
func NewScheduler(locker Locker) *Scheduler {
	return New(locker)
}

// Location returns the scheduler's fixed timezone.
func (s *Scheduler) Location() *time.Location {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()
	return s.location
}

// SetLocker replaces the distributed lock implementation. A nil locker keeps
// the current implementation.
func (s *Scheduler) SetLocker(locker Locker) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()
	if locker != nil {
		s.locker = locker
	}
}

// SetLogger replaces the scheduler's structured logger.
func (s *Scheduler) SetLogger(logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()
	s.logger = logger
}

// AddJob registers a named five-field cron job.
func (s *Scheduler) AddJob(name, cronExpr string, cmd func()) error {
	if cmd == nil {
		return ErrInvalidJobCommand
	}
	return s.addJob(name, cronExpr, "", func() error {
		cmd()
		return nil
	})
}

func (s *Scheduler) addJob(name, cronExpr, taskName string, command func() error) error {
	name = strings.TrimSpace(name)
	cronExpr = strings.TrimSpace(cronExpr)
	if name == "" {
		return ErrInvalidJobName
	}
	if command == nil {
		return ErrInvalidJobCommand
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()
	if _, exists := s.jobs[name]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateJobName, name)
	}
	schedule, err := s.parser.Parse(cronExpr)
	if err != nil {
		return fmt.Errorf("parse cron expression for %s: %w", name, err)
	}

	job := &scheduledJob{
		name:     name,
		cronExpr: cronExpr,
		taskName: taskName,
		schedule: schedule,
		command:  command,
	}
	job.entryID = s.cron.Schedule(schedule, cron.FuncJob(func() {
		s.runJob(job)
	}))
	s.jobs[name] = job
	s.order = append(s.order, name)
	return nil
}

// RemoveJob unregisters a job by name and stops it from firing again. It
// reports whether a job with that name existed. In-flight executions are not
// interrupted; the next occurrence simply never happens.
func (s *Scheduler) RemoveJob(name string) bool {
	name = strings.TrimSpace(name)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()

	job, exists := s.jobs[name]
	if !exists {
		return false
	}
	s.cron.Remove(job.entryID)
	delete(s.jobs, name)
	for index, registered := range s.order {
		if registered == name {
			s.order = append(s.order[:index], s.order[index+1:]...)
			break
		}
	}
	return true
}

// CronExprOf returns the cron expression registered for a job.
func (s *Scheduler) CronExprOf(name string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()

	job, exists := s.jobs[name]
	if !exists {
		return "", false
	}
	return job.cronExpr, true
}

// Start starts the scheduler. Repeated calls are no-ops.
func (s *Scheduler) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()
	if s.started {
		return
	}
	if s.ctx == nil || s.ctx.Err() != nil {
		s.ctx, s.cancel = context.WithCancel(context.Background())
	}
	s.started = true
	s.cron.Start()
	s.logger.Info("scheduler started", "timezone", s.location.String(), "jobs", len(s.jobs))
}

// Stop stops scheduling new jobs and waits for in-flight commands to finish.
// Repeated calls are no-ops.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	s.initLocked()
	if !s.started {
		s.mu.Unlock()
		return
	}
	s.started = false
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.ctx = nil
	done := s.cron.Stop()
	s.mu.Unlock()

	<-done.Done()
}

// ListJobs returns jobs in registration order.
func (s *Scheduler) ListJobs() []JobInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked()

	now := s.now().In(s.location)
	jobs := make([]JobInfo, 0, len(s.order))
	for _, name := range s.order {
		job := s.jobs[name]
		nextRun := job.schedule.Next(now)
		if s.started {
			entry := s.cron.Entry(job.entryID)
			if entry.Valid() && !entry.Next.IsZero() {
				nextRun = entry.Next
			}
		}
		jobs = append(jobs, JobInfo{
			Name:     job.name,
			CronExpr: job.cronExpr,
			TaskName: job.taskName,
			NextRun:  nextRun.In(s.location),
		})
	}
	return jobs
}

func (s *Scheduler) runJobByName(name string) {
	s.mu.Lock()
	job := s.jobs[name]
	s.mu.Unlock()
	if job != nil {
		s.runJob(job)
	}
}

func (s *Scheduler) runJob(job *scheduledJob) {
	s.mu.Lock()
	s.initLocked()
	locker := s.locker
	logger := s.logger
	jobContext := s.ctx
	now := s.now().In(s.location)
	ttl := lockTTL(job.schedule, now)
	s.mu.Unlock()

	if jobContext == nil {
		jobContext = context.Background()
	}
	key := schedulerLockPrefix + job.name
	acquired, release, err := locker.TryLock(jobContext, key, ttl)
	if err != nil {
		logger.Error("scheduler lock acquisition failed",
			"job", job.name,
			"task", job.taskName,
			"error", err,
		)
		return
	}
	if !acquired {
		logger.Debug("scheduler job skipped because another instance owns the lock",
			"job", job.name,
			"task", job.taskName,
		)
		return
	}

	succeeded := false
	defer func() {
		if recovered := recover(); recovered != nil {
			logger.Error("scheduler job panicked",
				"job", job.name,
				"task", job.taskName,
				"panic", recovered,
				"stack", string(debug.Stack()),
			)
		}
		if !succeeded {
			release()
		}
	}()
	if err := job.command(); err != nil {
		logger.Error("scheduler job failed",
			"job", job.name,
			"task", job.taskName,
			"error", err,
		)
		return
	}
	succeeded = true

	// A successful dispatch keeps the lock until the next cron occurrence. This
	// blocks duplicate dispatches even when another instance fires slightly later.
}

func (s *Scheduler) initLocked() {
	if s.location == nil {
		location, err := time.LoadLocation(DefaultTimezone)
		if err != nil {
			panic(fmt.Errorf("load scheduler timezone %s: %w", DefaultTimezone, err))
		}
		s.location = location
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.logger == nil {
		s.logger = slog.Default()
	}
	if s.locker == nil {
		s.locker = NewMemoryLocker()
	}
	if s.jobs == nil {
		s.jobs = make(map[string]*scheduledJob)
	}
	if s.cron == nil {
		s.parser = cron.NewParser(
			cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow,
		)
		s.cron = cron.New(cron.WithLocation(s.location))
	}
	if s.ctx == nil && !s.started {
		s.ctx, s.cancel = context.WithCancel(context.Background())
	}
}

func lockTTL(schedule cron.Schedule, now time.Time) time.Duration {
	nextRun := schedule.Next(now)
	if nextRun.IsZero() {
		return 24 * time.Hour
	}

	interval := nextRun.Sub(now)
	guard := lockTTLGuard
	if interval <= 2*lockTTLGuard {
		guard = interval / 10
	}
	ttl := interval - guard
	if ttl < minLockTTL {
		return minLockTTL
	}
	return ttl
}
