-- name: GetAlertProjectAccess :one
select project_operator, assistant_operator
from public.projects
where id = $1::bigint
limit 1;

-- name: ListAlertRules :many
select
  id, name, project_id, country, metric, trigger_type, condition,
  threshold, window_days, severity, notification_channels, is_active,
  created_by, created_at, updated_at
from public.alert_rules
where ($1::bigint is null or project_id = $1::bigint)
  and ($2::text is null or metric = $2)
  and ($3::boolean is null or is_active = $3)
order by created_at desc;

-- name: CountAlertEvents :one
select count(*)
from public.alert_events
where ($1::bigint is null or project_id = $1::bigint)
  and ($2::text is null or severity = $2)
  and ($3::text is null or status = $3);

-- name: ListAlertEvents :many
select
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
limit $5;

-- name: GetAlertStats :one
select
  count(*) filter (where status = 'active'),
  count(*) filter (where status = 'active' and severity = 'critical'),
  count(*) filter (where status = 'active' and severity = 'warning'),
  count(*) filter (where status = 'active' and severity = 'info'),
  count(*) filter (where acknowledged_at >= $2::date),
  count(*) filter (where status = 'resolved' and triggered_at::date = $2::date)
from public.alert_events
where ($1::bigint is null or project_id = $1::bigint);
