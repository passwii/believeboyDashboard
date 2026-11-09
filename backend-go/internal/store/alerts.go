package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
)

type AlertStore struct {
	db DB
}

func NewAlertStore(db DB) *AlertStore {
	return &AlertStore{db: db}
}

func (s *AlertStore) CreateRule(ctx context.Context, value alerts.Rule) (*alerts.Rule, error) {
	row := s.db.QueryRow(
		ctx,
		`insert into public.alert_rules (
		   name, project_id, country, metric, trigger_type, condition, threshold,
		   window_days, severity, notification_channels, is_active, created_by
		 )
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 returning
		   id, name, project_id, country, metric, trigger_type, condition,
		   threshold, window_days, severity, notification_channels, is_active,
		   created_by, created_at, updated_at`,
		value.Name,
		value.ProjectID,
		value.Country,
		value.Metric,
		value.TriggerType,
		value.Condition,
		value.Threshold,
		value.WindowDays,
		value.Severity,
		value.NotificationChannels,
		value.IsActive,
		value.CreatedBy,
	)
	item, err := scanAlertRule(row)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *AlertStore) GetRule(ctx context.Context, id int64) (*alerts.Rule, error) {
	row := s.db.QueryRow(
		ctx,
		`select
		   id, name, project_id, country, metric, trigger_type, condition,
		   threshold, window_days, severity, notification_channels, is_active,
		   created_by, created_at, updated_at
		 from public.alert_rules
		 where id = $1
		 limit 1`,
		id,
	)
	item, err := scanAlertRule(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *AlertStore) UpdateRule(
	ctx context.Context,
	id int64,
	value alerts.RuleUpdate,
) (*alerts.Rule, error) {
	row := s.db.QueryRow(
		ctx,
		`update public.alert_rules
		 set name = coalesce($2::text, name),
		     metric = coalesce($3::text, metric),
		     trigger_type = coalesce($4::text, trigger_type),
		     condition = coalesce($5::text, condition),
		     threshold = coalesce($6::double precision, threshold),
		     window_days = coalesce($7::integer, window_days),
		     severity = coalesce($8::text, severity),
		     notification_channels = coalesce($9::text, notification_channels),
		     is_active = coalesce($10::boolean, is_active),
		     updated_at = now()
		 where id = $1
		 returning
		   id, name, project_id, country, metric, trigger_type, condition,
		   threshold, window_days, severity, notification_channels, is_active,
		   created_by, created_at, updated_at`,
		id,
		value.Name,
		value.Metric,
		value.TriggerType,
		value.Condition,
		value.Threshold,
		value.WindowDays,
		value.Severity,
		value.NotificationChannels,
		value.IsActive,
	)
	item, err := scanAlertRule(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *AlertStore) DeleteRule(ctx context.Context, id int64) (bool, error) {
	execer, ok := s.db.(Execer)
	if !ok {
		return false, errors.New("database does not support writes")
	}
	tag, err := execer.Exec(
		ctx,
		`delete from public.alert_rules
		 where id = $1`,
		id,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *AlertStore) GetEvent(ctx context.Context, id int64) (*alerts.Event, error) {
	row := s.db.QueryRow(
		ctx,
		`select
		   id, rule_id, project_id, metric, current_value, baseline_value,
		   deviation_pct, severity, message, status, triggered_at,
		   acknowledged_at, acknowledged_by, match_rate, mismatched_items,
		   total_diff, report_month, report_id
		 from public.alert_events
		 where id = $1
		 limit 1`,
		id,
	)
	item, err := scanAlertEvent(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *AlertStore) AcknowledgeEvent(
	ctx context.Context,
	id int64,
	operator *string,
) (*alerts.Event, error) {
	row := s.db.QueryRow(
		ctx,
		`update public.alert_events
		 set status = 'acknowledged',
		     acknowledged_at = now(),
		     acknowledged_by = $2
		 where id = $1
		 returning
		   id, rule_id, project_id, metric, current_value, baseline_value,
		   deviation_pct, severity, message, status, triggered_at,
		   acknowledged_at, acknowledged_by, match_rate, mismatched_items,
		   total_diff, report_month, report_id`,
		id,
		operator,
	)
	item, err := scanAlertEvent(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *AlertStore) ResolveEvent(ctx context.Context, id int64) (*alerts.Event, error) {
	row := s.db.QueryRow(
		ctx,
		`update public.alert_events
		 set status = 'resolved'
		 where id = $1
		 returning
		   id, rule_id, project_id, metric, current_value, baseline_value,
		   deviation_pct, severity, message, status, triggered_at,
		   acknowledged_at, acknowledged_by, match_rate, mismatched_items,
		   total_diff, report_month, report_id`,
		id,
	)
	item, err := scanAlertEvent(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *AlertStore) GetProject(ctx context.Context, projectID string) (*alerts.Project, error) {
	var (
		projectOperator   pgtype.Text
		assistantOperator pgtype.Text
	)
	err := s.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator
		 from public.projects
		 where id = $1::bigint
		 limit 1`,
		projectID,
	).Scan(&projectOperator, &assistantOperator)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &alerts.Project{
		ProjectOperator:   Text(projectOperator),
		AssistantOperator: Text(assistantOperator),
	}, nil
}

func (s *AlertStore) ListRules(
	ctx context.Context,
	filters alerts.RuleFilters,
) ([]alerts.Rule, error) {
	rows, err := s.db.Query(
		ctx,
		`select
		   id, name, project_id, country, metric, trigger_type, condition,
		   threshold, window_days, severity, notification_channels, is_active,
		   created_by, created_at, updated_at
		 from public.alert_rules
		 where ($1::bigint is null or project_id = $1::bigint)
		   and ($2::text is null or metric = $2)
		   and ($3::boolean is null or is_active = $3)
		 order by created_at desc`,
		filters.ProjectID,
		filters.Metric,
		filters.IsActive,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]alerts.Rule, 0)
	for rows.Next() {
		item, err := scanAlertRule(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AlertStore) ListEvents(
	ctx context.Context,
	filters alerts.EventFilters,
) ([]alerts.Event, int, error) {
	var total int
	if err := s.db.QueryRow(
		ctx,
		`select count(*)
		 from public.alert_events
		 where ($1::bigint is null or project_id = $1::bigint)
		   and ($2::text is null or severity = $2)
		   and ($3::text is null or status = $3)`,
		filters.ProjectID,
		filters.Severity,
		filters.Status,
	).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := s.db.Query(
		ctx,
		`select
		   id, rule_id, project_id, metric, current_value, baseline_value,
		   deviation_pct, severity, message, status, triggered_at,
		   acknowledged_at, acknowledged_by, match_rate, mismatched_items,
		   total_diff, report_month, report_id
		 from public.alert_events
		 where ($1::bigint is null or project_id = $1::bigint)
		   and ($2::text is null or severity = $2)
		   and ($3::text is null or status = $3)
		 order by triggered_at desc
		 offset $4
		 limit $5`,
		filters.ProjectID,
		filters.Severity,
		filters.Status,
		safeOffset(filters.Page, filters.PageSize),
		filters.PageSize,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]alerts.Event, 0)
	for rows.Next() {
		item, err := scanAlertEvent(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

func (s *AlertStore) Stats(
	ctx context.Context,
	projectID *string,
	today string,
) (alerts.Stats, error) {
	var stats alerts.Stats
	err := s.db.QueryRow(
		ctx,
		`select
		   count(*) filter (where status = 'active'),
		   count(*) filter (where status = 'active' and severity = 'critical'),
		   count(*) filter (where status = 'active' and severity = 'warning'),
		   count(*) filter (where status = 'active' and severity = 'info'),
		   count(*) filter (where acknowledged_at >= $2::date),
		   count(*) filter (where status = 'resolved' and triggered_at::date = $2::date)
		 from public.alert_events
		 where ($1::bigint is null or project_id = $1::bigint)`,
		projectID,
		today,
	).Scan(
		&stats.TotalActive,
		&stats.CriticalCount,
		&stats.WarningCount,
		&stats.InfoCount,
		&stats.AcknowledgedToday,
		&stats.ResolvedToday,
	)
	return stats, err
}

type alertScanner interface {
	Scan(dest ...any) error
}

func scanAlertRule(scanner alertScanner) (alerts.Rule, error) {
	var (
		item      alerts.Rule
		createdAt pgtype.Timestamptz
		updatedAt pgtype.Timestamptz
	)
	if err := scanner.Scan(
		&item.ID,
		&item.Name,
		&item.ProjectID,
		&item.Country,
		&item.Metric,
		&item.TriggerType,
		&item.Condition,
		&item.Threshold,
		&item.WindowDays,
		&item.Severity,
		&item.NotificationChannels,
		&item.IsActive,
		&item.CreatedBy,
		&createdAt,
		&updatedAt,
	); err != nil {
		return alerts.Rule{}, err
	}
	item.CreatedAt = createdAt.Time
	item.UpdatedAt = updatedAt.Time
	return item, nil
}

func scanAlertEvent(scanner alertScanner) (alerts.Event, error) {
	var (
		item            alerts.Event
		triggeredAt     pgtype.Timestamptz
		acknowledgedAt  pgtype.Timestamptz
		acknowledgedBy  pgtype.Text
		matchRate       pgtype.Float8
		mismatchedItems pgtype.Int4
		totalDiff       pgtype.Float8
		reportMonth     pgtype.Text
		reportID        pgtype.Int4
	)
	if err := scanner.Scan(
		&item.ID,
		&item.RuleID,
		&item.ProjectID,
		&item.Metric,
		&item.CurrentValue,
		&item.BaselineValue,
		&item.DeviationPct,
		&item.Severity,
		&item.Message,
		&item.Status,
		&triggeredAt,
		&acknowledgedAt,
		&acknowledgedBy,
		&matchRate,
		&mismatchedItems,
		&totalDiff,
		&reportMonth,
		&reportID,
	); err != nil {
		return alerts.Event{}, err
	}
	item.TriggeredAt = triggeredAt.Time
	item.AcknowledgedAt = timestampPointer(acknowledgedAt)
	item.AcknowledgedBy = Text(acknowledgedBy)
	item.MatchRate = float8Pointer(matchRate)
	item.MismatchedItems = int4Pointer(mismatchedItems)
	item.TotalDiff = float8Pointer(totalDiff)
	item.ReportMonth = Text(reportMonth)
	item.ReportID = int4Pointer(reportID)
	return item, nil
}

func float8Pointer(value pgtype.Float8) *float64 {
	if !value.Valid {
		return nil
	}
	result := value.Float64
	return &result
}

func int4Pointer(value pgtype.Int4) *int {
	if !value.Valid {
		return nil
	}
	result := int(value.Int32)
	return &result
}
