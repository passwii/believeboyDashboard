package store

import (
	"context"
	"errors"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

// DueInsightSchedule is an active insight schedule whose next_run_at is due.
// Migrated domains are still returned so the scheduler can apply the
// canonical-domain switch semantics before enqueueing anything.
type DueInsightSchedule struct {
	ID             int64
	InsightType    string
	CronExpression string
}

// ListDueInsightSchedules returns active schedules whose next_run_at is at or
// before now, ordered by due time. It is the read side of the DB-backed insight
// schedule reconciler that replaces the Python APScheduler job registry.
func (s *AIInsightStore) ListDueInsightSchedules(
	ctx context.Context,
	now time.Time,
) ([]DueInsightSchedule, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("insight database is not configured")
	}
	rows, err := s.db.Query(
		ctx,
		`select id, insight_type, cron_expression
		 from public.insight_schedules
		 where is_active = true
		   and next_run_at is not null
		   and next_run_at <= $1
		 order by next_run_at asc, id asc`,
		now,
	)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []DueInsightSchedule{}, nil
	}
	defer rows.Close()

	due := make([]DueInsightSchedule, 0)
	for rows.Next() {
		var item DueInsightSchedule
		if err := rows.Scan(&item.ID, &item.InsightType, &item.CronExpression); err != nil {
			return nil, err
		}
		due = append(due, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return due, nil
}

// AdvanceInsightScheduleNextRun records the next cron occurrence so the
// reconciler does not re-enqueue the same run on its next tick.
func (s *AIInsightStore) AdvanceInsightScheduleNextRun(
	ctx context.Context,
	scheduleID int64,
	nextRunAt time.Time,
) error {
	if s == nil || s.db == nil {
		return errors.New("insight database is not configured")
	}
	tag, err := s.db.Exec(
		ctx,
		`update public.insight_schedules
		 set next_run_at = $1, updated_at = now()
		 where id = $2`,
		nextRunAt,
		scheduleID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ai_insight.ErrScheduleNotFound
	}
	return nil
}
