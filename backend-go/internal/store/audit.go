package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent"
)

type AuditLogStore struct {
	db FullDB
}

func NewAuditLogStore(db FullDB) *AuditLogStore {
	return &AuditLogStore{db: db}
}

func (s *AuditLogStore) QueryAuditLogs(
	ctx context.Context,
	targetType string,
	targetIDs []string,
	limit int,
) ([]agent.AuditItem, error) {
	if len(targetIDs) == 0 {
		return []agent.AuditItem{}, nil
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	query := `
		SELECT id, created_at, action, agent_id, operator, idempotency_key, result, before_json, after_json, error_message
		FROM public.operation_audit_logs
		WHERE target_type = $1 AND target_id = ANY($2)
		ORDER BY id DESC
		LIMIT $3
	`

	rows, err := s.db.Query(ctx, query, targetType, targetIDs, limit)
	if err != nil {
		return nil, fmt.Errorf("query operation_audit_logs: %w", err)
	}
	defer rows.Close()

	items := make([]agent.AuditItem, 0, limit)
	for rows.Next() {
		var (
			id             int64
			createdAt      *time.Time
			action         string
			agentID        *string
			operator       *string
			idempotencyKey *string
			result         string
			beforeRaw      []byte
			afterRaw       []byte
			errorMessage   *string
		)
		if err := rows.Scan(
			&id,
			&createdAt,
			&action,
			&agentID,
			&operator,
			&idempotencyKey,
			&result,
			&beforeRaw,
			&afterRaw,
			&errorMessage,
		); err != nil {
			return nil, fmt.Errorf("scan operation_audit_log row: %w", err)
		}

		var before map[string]any
		if len(beforeRaw) > 0 {
			_ = json.Unmarshal(beforeRaw, &before)
		}
		var after map[string]any
		if len(afterRaw) > 0 {
			_ = json.Unmarshal(afterRaw, &after)
		}

		var createdStr *string
		if createdAt != nil {
			str := createdAt.UTC().Format(time.RFC3339)
			createdStr = &str
		}

		items = append(items, agent.AuditItem{
			ID:             id,
			CreatedAt:      createdStr,
			Action:         action,
			AgentID:        agentID,
			Operator:       operator,
			IdempotencyKey: idempotencyKey,
			Result:         result,
			Before:         before,
			After:          after,
			ErrorMessage:   errorMessage,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}
