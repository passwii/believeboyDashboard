package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_ops"
)

type AgentOpsStore struct {
	db DB
}

func NewAgentOpsStore(db DB) *AgentOpsStore {
	return &AgentOpsStore{db: db}
}

const agentDomainSummarySQL = `
SELECT
	operation_type,
	count(*) FILTER (WHERE created_at >= $2) AS calls_24h,
	count(*) AS calls_7d,
	count(*) FILTER (
		WHERE method IN ('POST', 'PUT', 'PATCH', 'DELETE')
		  AND created_at >= $2
	) AS writes_24h,
	count(*) FILTER (
		WHERE method IN ('POST', 'PUT', 'PATCH', 'DELETE')
	) AS writes_7d,
	count(*) FILTER (WHERE status_code >= 400) AS errors_7d,
	max(created_at) AS last_active_at
FROM public.agent_api_audit_log
WHERE created_at >= $1
  AND operation_type IS NOT NULL
GROUP BY operation_type
ORDER BY count(*) DESC`

const agentEmployeeSummarySQL = `
SELECT
	api_key_id,
	count(*) FILTER (WHERE created_at >= $2) AS calls_24h,
	count(*) AS calls_7d,
	count(*) FILTER (
		WHERE method IN ('POST', 'PUT', 'PATCH', 'DELETE')
		  AND created_at >= $2
	) AS writes_24h,
	count(*) FILTER (
		WHERE method IN ('POST', 'PUT', 'PATCH', 'DELETE')
	) AS writes_7d,
	count(*) FILTER (WHERE status_code >= 400) AS errors_7d,
	max(created_at) AS last_active_at
FROM public.agent_api_audit_log
WHERE created_at >= $1
  AND api_key_id IS NOT NULL
GROUP BY api_key_id
ORDER BY count(*) DESC`

func (store *AgentOpsStore) DomainSummary(
	ctx context.Context,
	sinceWindow time.Time,
	since24h time.Time,
) ([]agent_ops.DomainSummaryItem, error) {
	rows, err := store.db.Query(ctx, agentDomainSummarySQL, sinceWindow, since24h)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]agent_ops.DomainSummaryItem, 0)
	for rows.Next() {
		var item agent_ops.DomainSummaryItem
		var lastActive pgtype.Timestamptz
		if err := rows.Scan(
			&item.Domain,
			&item.Calls24h,
			&item.Calls7d,
			&item.Writes24h,
			&item.Writes7d,
			&item.Errors7d,
			&lastActive,
		); err != nil {
			return nil, err
		}
		item.LastActiveAt = optionalPGTime(lastActive)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (store *AgentOpsStore) EmployeeSummary(
	ctx context.Context,
	sinceWindow time.Time,
	since24h time.Time,
) ([]agent_ops.EmployeeSummaryItem, error) {
	rows, err := store.db.Query(ctx, agentEmployeeSummarySQL, sinceWindow, since24h)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]agent_ops.EmployeeSummaryItem, 0)
	for rows.Next() {
		var item agent_ops.EmployeeSummaryItem
		var lastActive pgtype.Timestamptz
		if err := rows.Scan(
			&item.APIKeyID,
			&item.Calls24h,
			&item.Calls7d,
			&item.Writes24h,
			&item.Writes7d,
			&item.Errors7d,
			&lastActive,
		); err != nil {
			return nil, err
		}
		item.LastActiveAt = optionalPGTime(lastActive)
		items = append(items, item)
	}
	return items, rows.Err()
}

func optionalPGTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}
