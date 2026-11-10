package store

import (
	"context"
	"errors"
)

// DueScheduledReportSubscription is an enabled subscription whose configured
// dispatch hour/minute matches the current minutely scan window.
type DueScheduledReportSubscription struct {
	ID              int64
	Email           *string
	ProjectIDs      string
	Country         string
	Frequency       string
	DispatchWeekday *int
	DispatchDay     *int
	AIModel         *string
}

// ListScheduledReportSubscriptionsDueAt returns enabled subscriptions whose
// Asia/Shanghai wall-clock dispatch time matches hour:minute. Frequency and
// weekday/day constraints are applied by the scheduler scanner because they
// depend on calendar semantics (Monday=0 weekday alignment, monthly day).
func (store *ScheduledReportStore) ListScheduledReportSubscriptionsDueAt(
	ctx context.Context,
	hour, minute int,
) ([]DueScheduledReportSubscription, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("scheduled report database is not configured")
	}
	rows, err := store.db.Query(
		ctx,
		`select id, email, project_ids, country, frequency,
		        dispatch_weekday, dispatch_day, ai_model
		 from public.scheduled_report_subscriptions
		 where enabled = true
		   and dispatch_hour = $1
		   and dispatch_minute = $2
		 order by id asc`,
		hour,
		minute,
	)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []DueScheduledReportSubscription{}, nil
	}
	defer rows.Close()

	due := make([]DueScheduledReportSubscription, 0)
	for rows.Next() {
		var item DueScheduledReportSubscription
		if err := rows.Scan(
			&item.ID,
			&item.Email,
			&item.ProjectIDs,
			&item.Country,
			&item.Frequency,
			&item.DispatchWeekday,
			&item.DispatchDay,
			&item.AIModel,
		); err != nil {
			return nil, err
		}
		due = append(due, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return due, nil
}
