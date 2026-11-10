package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
	"github.com/robfig/cron/v3"
)

const (
	// InsightReconcilerJobName is the interval job that scans due insight schedules.
	InsightReconcilerJobName = "insight-schedule-reconciler"
	// ScheduledReportScanJobName is the cron job that scans due report subscriptions.
	ScheduledReportScanJobName = "scheduled-report-minutely-scan"
	// DefaultInsightReconcileInterval matches the Python APScheduler cadence
	// closely enough while keeping overdue catch-up latency bounded.
	DefaultInsightReconcileInterval = 30 * time.Second
	// invalidInsightCronRetryDelay prevents an unparseable cron row from
	// spinning the reconciler on every tick.
	invalidInsightCronRetryDelay = 24 * time.Hour
)

var (
	// ErrInvalidJobInterval is returned when an interval job has no positive interval.
	ErrInvalidJobInterval = errors.New("scheduler job interval must be positive")
	// ErrInsightScheduleSourceMissing is returned when the reconciler has no source.
	ErrInsightScheduleSourceMissing = errors.New("insight schedule source is not configured")
	// ErrPayloadEnqueuerMissing is returned when a dynamic job has no enqueuer.
	ErrPayloadEnqueuerMissing = errors.New("scheduler payload enqueuer is not configured")
	// ErrScheduledReportSourceMissing is returned when the scanner has no source.
	ErrScheduledReportSourceMissing = errors.New("scheduled report source is not configured")
)

// PayloadEnqueuer enqueues one typed task payload onto the task queue.
type PayloadEnqueuer interface {
	EnqueueTask(ctx context.Context, taskName string, payload any) error
}

// PayloadEnqueuerFunc adapts a function to PayloadEnqueuer.
type PayloadEnqueuerFunc func(ctx context.Context, taskName string, payload any) error

// EnqueueTask implements PayloadEnqueuer.
func (f PayloadEnqueuerFunc) EnqueueTask(ctx context.Context, taskName string, payload any) error {
	if f == nil {
		return ErrPayloadEnqueuerMissing
	}
	return f(ctx, taskName, payload)
}

// InsightScheduleSource is the persistence seam of the insight reconciler.
type InsightScheduleSource interface {
	ListDueInsightSchedules(ctx context.Context, now time.Time) ([]store.DueInsightSchedule, error)
	AdvanceInsightScheduleNextRun(ctx context.Context, scheduleID int64, nextRunAt time.Time) error
}

// InsightReconcilerConfig wires the DB-backed insight schedule reconciler.
type InsightReconcilerConfig struct {
	Source           InsightScheduleSource
	Enqueuer         PayloadEnqueuer
	CanonicalDomains string
	Logger           *slog.Logger
	Now              func() time.Time
}

// InsightReconcileResult summarizes one reconciler pass.
type InsightReconcileResult struct {
	Due             int
	Enqueued        int
	SkippedMigrated int
	Failed          int
}

// InsightReconciler replaces the Python APScheduler registry: every tick it
// reads insight schedules whose next_run_at is due, enqueues generate_insight
// and advances next_run_at to the next cron occurrence.
type InsightReconciler struct {
	source           InsightScheduleSource
	enqueuer         PayloadEnqueuer
	canonicalDomains string
	logger           *slog.Logger
	now              func() time.Time
	location         *time.Location
}

// NewInsightReconciler validates and constructs the reconciler.
func NewInsightReconciler(cfg InsightReconcilerConfig) (*InsightReconciler, error) {
	if cfg.Source == nil {
		return nil, ErrInsightScheduleSourceMissing
	}
	if cfg.Enqueuer == nil {
		return nil, ErrPayloadEnqueuerMissing
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &InsightReconciler{
		source:           cfg.Source,
		enqueuer:         cfg.Enqueuer,
		canonicalDomains: cfg.CanonicalDomains,
		logger:           logger,
		now:              now,
		location:         schedulerLocation(),
	}, nil
}

// RunOnce performs one reconciliation pass.
func (r *InsightReconciler) RunOnce(ctx context.Context) (InsightReconcileResult, error) {
	var result InsightReconcileResult
	if r == nil || r.source == nil {
		return result, ErrInsightScheduleSourceMissing
	}
	if r.enqueuer == nil {
		return result, ErrPayloadEnqueuerMissing
	}
	now := r.now().In(r.location)
	due, err := r.source.ListDueInsightSchedules(ctx, now)
	if err != nil {
		return result, fmt.Errorf("list due insight schedules: %w", err)
	}
	result.Due = len(due)

	for _, schedule := range due {
		if role := ai_insight.LegacyDomainRole(schedule.InsightType); role != "" &&
			ai_insight.IsDomainCanonical(r.canonicalDomains, role) {
			// Canonical-migrated domains are frozen for the legacy generator;
			// mirror the worker's ErrDomainMigrated skip without enqueueing.
			next, ok := nextInsightCron(schedule.CronExpression, now)
			if !ok {
				result.Failed++
				r.logger.Error("insight schedule has invalid cron expression",
					"schedule_id", schedule.ID,
					"cron_expression", schedule.CronExpression,
				)
				continue
			}
			if err := r.source.AdvanceInsightScheduleNextRun(ctx, schedule.ID, next); err != nil {
				result.Failed++
				r.logger.Error("advance migrated insight schedule failed",
					"schedule_id", schedule.ID,
					"error", err,
				)
				continue
			}
			result.SkippedMigrated++
			continue
		}

		next, ok := nextInsightCron(schedule.CronExpression, now)
		if !ok {
			result.Failed++
			r.logger.Error("insight schedule has invalid cron expression",
				"schedule_id", schedule.ID,
				"cron_expression", schedule.CronExpression,
			)
			if err := r.source.AdvanceInsightScheduleNextRun(
				ctx,
				schedule.ID,
				now.Add(invalidInsightCronRetryDelay),
			); err != nil {
				r.logger.Error("park invalid insight schedule failed",
					"schedule_id", schedule.ID,
					"error", err,
				)
			}
			continue
		}

		scheduleID := schedule.ID
		if err := r.enqueuer.EnqueueTask(
			ctx,
			queue.TypeGenerateInsight,
			tasks.GenerateInsightPayload{ScheduleID: &scheduleID},
		); err != nil {
			result.Failed++
			r.logger.Error("enqueue insight schedule failed",
				"schedule_id", schedule.ID,
				"error", err,
			)
			continue
		}
		if err := r.source.AdvanceInsightScheduleNextRun(ctx, schedule.ID, next); err != nil {
			result.Failed++
			r.logger.Error("advance insight schedule next run failed",
				"schedule_id", schedule.ID,
				"error", err,
			)
			continue
		}
		result.Enqueued++
	}

	if result.Enqueued > 0 || result.Failed > 0 {
		r.logger.Info("insight schedule reconcile pass",
			"due", result.Due,
			"enqueued", result.Enqueued,
			"skipped_migrated", result.SkippedMigrated,
			"failed", result.Failed,
		)
	}
	return result, nil
}

// ScheduledReportSource is the persistence seam of the minutely report scanner.
type ScheduledReportSource interface {
	ListScheduledReportSubscriptionsDueAt(
		ctx context.Context,
		hour, minute int,
	) ([]store.DueScheduledReportSubscription, error)
}

// ScheduledReportScannerConfig wires the minutely scheduled-report scanner.
type ScheduledReportScannerConfig struct {
	Source   ScheduledReportSource
	Enqueuer PayloadEnqueuer
	Logger   *slog.Logger
	Now      func() time.Time
}

// ScheduledReportScanResult summarizes one scan pass.
type ScheduledReportScanResult struct {
	Matched  int
	Enqueued int
	Failed   int
}

// ScheduledReportScanner mirrors the Python minutely scan: subscriptions whose
// Asia/Shanghai hour/minute matches are filtered by frequency constraints and
// dispatched via queue.TypeDispatchOne with triggered_by=auto.
type ScheduledReportScanner struct {
	source   ScheduledReportSource
	enqueuer PayloadEnqueuer
	logger   *slog.Logger
	now      func() time.Time
	location *time.Location
}

// NewScheduledReportScanner validates and constructs the scanner.
func NewScheduledReportScanner(cfg ScheduledReportScannerConfig) (*ScheduledReportScanner, error) {
	if cfg.Source == nil {
		return nil, ErrScheduledReportSourceMissing
	}
	if cfg.Enqueuer == nil {
		return nil, ErrPayloadEnqueuerMissing
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &ScheduledReportScanner{
		source:   cfg.Source,
		enqueuer: cfg.Enqueuer,
		logger:   logger,
		now:      now,
		location: schedulerLocation(),
	}, nil
}

// RunOnce performs one minutely scan pass.
func (scanner *ScheduledReportScanner) RunOnce(
	ctx context.Context,
) (ScheduledReportScanResult, error) {
	var result ScheduledReportScanResult
	if scanner == nil || scanner.source == nil {
		return result, ErrScheduledReportSourceMissing
	}
	if scanner.enqueuer == nil {
		return result, ErrPayloadEnqueuerMissing
	}
	now := scanner.now().In(scanner.location)
	due, err := scanner.source.ListScheduledReportSubscriptionsDueAt(
		ctx,
		now.Hour(),
		now.Minute(),
	)
	if err != nil {
		return result, fmt.Errorf("list due scheduled report subscriptions: %w", err)
	}

	reportDate := now.Format("2006-01-02")
	for _, subscription := range due {
		if !scheduledReportDueAt(subscription, now) {
			continue
		}
		result.Matched++

		email := ""
		if subscription.Email != nil {
			email = *subscription.Email
		}
		payload := tasks.DispatchOnePayload{
			SubscriptionID: subscription.ID,
			Email:          email,
			ProjectIDs:     parseProjectIDs(subscription.ProjectIDs),
			Country:        subscription.Country,
			Frequency:      strings.ToLower(strings.TrimSpace(subscription.Frequency)),
			AIModel:        subscription.AIModel,
			TriggeredBy:    "auto",
			ReportDate:     reportDate,
		}
		if err := scanner.enqueuer.EnqueueTask(ctx, queue.TypeDispatchOne, payload); err != nil {
			result.Failed++
			scanner.logger.Error("enqueue scheduled report subscription failed",
				"subscription_id", subscription.ID,
				"error", err,
			)
			continue
		}
		result.Enqueued++
	}

	if result.Enqueued > 0 || result.Failed > 0 {
		scanner.logger.Info(
			"scheduled report minutely scan",
			"hour", now.Hour(),
			"minute", now.Minute(),
			"matched", result.Matched,
			"enqueued", result.Enqueued,
			"failed", result.Failed,
		)
	}
	return result, nil
}

// DynamicJobsConfig registers the DB-backed dynamic scheduling jobs.
type DynamicJobsConfig struct {
	InsightReconciler      *InsightReconciler
	InsightInterval        time.Duration
	ScheduledReportScanner *ScheduledReportScanner
}

// RegisterDynamicJobs attaches the insight reconciler ticker and the minutely
// scheduled-report cron scan to the scheduler lifecycle.
func RegisterDynamicJobs(s *Scheduler, cfg DynamicJobsConfig) error {
	if s == nil {
		return errors.New("scheduler is nil")
	}
	if cfg.InsightReconciler != nil {
		interval := cfg.InsightInterval
		if interval <= 0 {
			interval = DefaultInsightReconcileInterval
		}
		reconciler := cfg.InsightReconciler
		if err := s.AddInterval(
			InsightReconcilerJobName,
			interval,
			func(ctx context.Context) error {
				_, err := reconciler.RunOnce(ctx)
				return err
			},
		); err != nil {
			return fmt.Errorf("register insight schedule reconciler: %w", err)
		}
	}
	if cfg.ScheduledReportScanner != nil {
		scanner := cfg.ScheduledReportScanner
		if err := s.addJob(
			ScheduledReportScanJobName,
			"* * * * *",
			"",
			func() error {
				_, err := scanner.RunOnce(context.Background())
				return err
			},
		); err != nil {
			return fmt.Errorf("register scheduled report minutely scan: %w", err)
		}
	}
	if cfg.InsightReconciler == nil && cfg.ScheduledReportScanner == nil {
		return errors.New("no dynamic scheduler jobs configured")
	}
	return nil
}

func nextInsightCron(expression string, now time.Time) (time.Time, bool) {
	schedule, err := cron.ParseStandard(strings.TrimSpace(expression))
	if err != nil {
		return time.Time{}, false
	}
	next := schedule.Next(now)
	if next.IsZero() {
		return time.Time{}, false
	}
	return next, true
}

// scheduledReportDueAt applies the frequency calendar constraints from the
// Python minutely scan: daily always fires; weekly matches Python weekday
// (Monday=0, default Monday); monthly matches day-of-month (default 2).
func scheduledReportDueAt(
	subscription store.DueScheduledReportSubscription,
	now time.Time,
) bool {
	switch strings.ToLower(strings.TrimSpace(subscription.Frequency)) {
	case "daily":
		return true
	case "weekly":
		weekday := 0
		if subscription.DispatchWeekday != nil {
			weekday = *subscription.DispatchWeekday
		}
		return pythonWeekday(now) == weekday
	case "monthly":
		day := 2
		if subscription.DispatchDay != nil {
			day = *subscription.DispatchDay
		}
		return now.Day() == day
	default:
		return false
	}
}

func pythonWeekday(now time.Time) int {
	return (int(now.Weekday()) + 6) % 7
}

func parseProjectIDs(value string) []int64 {
	value = strings.TrimSpace(value)
	if value == "" || value == "*" {
		return nil
	}
	ids := make([]int64, 0)
	for _, part := range strings.Split(value, ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err == nil && id > 0 {
			ids = append(ids, id)
		}
	}
	return ids
}

func schedulerLocation() *time.Location {
	location, err := time.LoadLocation(DefaultTimezone)
	if err != nil {
		return time.FixedZone(DefaultTimezone, 8*60*60)
	}
	return location
}
