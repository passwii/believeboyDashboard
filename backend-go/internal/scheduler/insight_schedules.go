package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

// InsightJobPrefix namespaces DB-driven insight schedules inside the scheduler so
// a reconciliation pass can tell them apart from the fixed Beat-compatible jobs.
const InsightJobPrefix = "insight-schedule:"

// InsightScheduleSource lists the active insight schedules that must be mirrored
// into the scheduler. It is satisfied by the AI insight store.
type InsightScheduleSource interface {
	ListSchedules(
		ctx context.Context,
		filter ai_insight.ScheduleFilter,
	) ([]ai_insight.Schedule, error)
}

// InsightEnqueuer dispatches generate_insight for one schedule. It is called from
// the scheduler goroutine, so implementations must build their own context.
type InsightEnqueuer func(scheduleID int64) error

// InsightSyncResult summarises one reconciliation pass.
type InsightSyncResult struct {
	Registered int
	Unchanged  int
	Removed    int
	Skipped    int
}

// SyncInsightSchedules mirrors the active insight schedules stored in PostgreSQL
// into cron jobs.
//
// This is the Go replacement for FastAPI's APScheduler integration
// (reload_insight_schedules in app/core/scheduler.py + insight_schedule_service):
// without it, insight schedules created through the API are stored but never
// fire, because the 11 static Beat-compatible jobs are all it knows about.
//
// The pass is idempotent: jobs whose cron expression did not change are left
// untouched, jobs for deactivated or deleted schedules are removed, and a single
// schedule with an unparseable cron expression is skipped (counted, logged)
// instead of aborting the whole sync.
func SyncInsightSchedules(
	ctx context.Context,
	s *Scheduler,
	source InsightScheduleSource,
	enqueue InsightEnqueuer,
) (InsightSyncResult, error) {
	var result InsightSyncResult
	if s == nil {
		return result, errors.New("scheduler is nil")
	}
	if source == nil {
		return result, errors.New("insight schedule source is nil")
	}
	if enqueue == nil {
		return result, errors.New("insight enqueuer is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	active := true
	schedules, err := source.ListSchedules(ctx, ai_insight.ScheduleFilter{IsActive: &active})
	if err != nil {
		return result, fmt.Errorf("list active insight schedules: %w", err)
	}

	desired := make(map[string]string, len(schedules))
	for _, schedule := range schedules {
		if schedule.ID <= 0 {
			result.Skipped++
			continue
		}
		cronExpr := strings.TrimSpace(schedule.CronExpression)
		if cronExpr == "" {
			result.Skipped++
			continue
		}
		desired[InsightJobPrefix+fmt.Sprintf("%d", schedule.ID)] = cronExpr
	}

	// Remove jobs whose schedule disappeared or was deactivated. Only names inside
	// the insight namespace are touched.
	for _, job := range s.ListJobs() {
		if !strings.HasPrefix(job.Name, InsightJobPrefix) {
			continue
		}
		if _, keep := desired[job.Name]; keep {
			continue
		}
		if s.RemoveJob(job.Name) {
			result.Removed++
		}
	}

	for name, cronExpr := range desired {
		if existing, ok := s.CronExprOf(name); ok && existing == cronExpr {
			result.Unchanged++
			continue
		}
		// A changed cron expression must replace the old registration.
		s.RemoveJob(name)

		scheduleID, parseErr := parseInsightJobID(name)
		if parseErr != nil {
			result.Skipped++
			continue
		}
		id := scheduleID
		command := func() error { return enqueue(id) }
		if err := s.addJob(name, cronExpr, "generate_insight", command); err != nil {
			// An unparseable expression is a data problem for that row only.
			slog.Default().Error(
				"insight schedule not registered",
				slog.String("job", name),
				slog.String("cron_expression", cronExpr),
				slog.Int64("schedule_id", id),
				slog.Any("error", err),
			)
			result.Skipped++
			continue
		}
		result.Registered++
	}

	return result, nil
}

func parseInsightJobID(name string) (int64, error) {
	raw := strings.TrimPrefix(name, InsightJobPrefix)
	var id int64
	if _, err := fmt.Sscanf(raw, "%d", &id); err != nil {
		return 0, fmt.Errorf("parse insight schedule id from %q: %w", name, err)
	}
	if id <= 0 {
		return 0, fmt.Errorf("insight schedule id in %q is not positive", name)
	}
	return id, nil
}
