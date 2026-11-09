package tasks

import (
	"context"
	"fmt"
	"time"

	"github.com/hibiken/asynq"
)

const operationAuditCleanupSQL = `
DELETE FROM operation_audit_logs
WHERE agent_id IS NOT NULL
  AND created_at < $1
`

const agentAPIAuditCleanupSQL = `
DELETE FROM agent_api_audit_log
WHERE created_at < $1
`

func (handler *TaskHandler) HandleOperationAuditCleanup(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("operation_audit_cleanup", func() error {
		var payload OperationAuditCleanupPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}

		retentionDays := intValue(payload.RetentionDays, handler.config.OperationAuditRetentionDays)
		if retentionDays <= 0 {
			return errPositive("retention_days")
		}
		now := handler.currentTime(payload.Now)
		cutoff := now.AddDate(0, 0, -retentionDays)

		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		tag, err := db.Exec(ctx, operationAuditCleanupSQL, cutoff)
		if err != nil {
			return fmt.Errorf("delete operation audit rows: %w", err)
		}
		return handler.writeResult(task, taskResult{
			TaskType: "operation_audit_cleanup",
			Status:   "completed",
			Data: map[string]any{
				"deleted":        tag.RowsAffected(),
				"retention_days": retentionDays,
				"cutoff":         cutoff,
			},
		})
	})
}

func (handler *TaskHandler) HandleAgentAPIAuditCleanup(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("agent_api_audit_cleanup", func() error {
		var payload AgentAPIAuditCleanupPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}

		retentionDays := intValue(payload.RetentionDays, handler.config.AgentAPIAuditRetentionDays)
		if retentionDays <= 0 {
			return errPositive("retention_days")
		}
		now := handler.currentTime(payload.Now)
		cutoff := now.AddDate(0, 0, -retentionDays)

		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		tag, err := db.Exec(ctx, agentAPIAuditCleanupSQL, cutoff)
		if err != nil {
			return fmt.Errorf("delete agent API audit rows: %w", err)
		}
		return handler.writeResult(task, taskResult{
			TaskType: "agent_api_audit_cleanup",
			Status:   "completed",
			Data: map[string]any{
				"deleted":        tag.RowsAffected(),
				"retention_days": retentionDays,
				"cutoff":         cutoff,
			},
		})
	})
}

func (handler *TaskHandler) HandleAIChatTokenUsageRefreshDaily(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("ai_chat_token_usage.refresh_daily", func() error {
		var payload AIChatTokenUsageRefreshPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}

		location := handler.location()
		now := handler.currentTime(nil).In(location)
		targetDate := timeDate(now.AddDate(0, 0, -1), location)
		if payload.TargetDate != nil {
			parsed, err := time.ParseInLocation("2006-01-02", *payload.TargetDate, location)
			if err != nil {
				return errInvalid("target_date", "must be YYYY-MM-DD")
			}
			targetDate = parsed
		}

		startLocal := time.Date(
			targetDate.Year(),
			targetDate.Month(),
			targetDate.Day(),
			0,
			0,
			0,
			0,
			location,
		)
		startUTC := startLocal.UTC()
		endUTC := startLocal.AddDate(0, 0, 1).UTC()

		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		tag, err := db.Exec(ctx, aiChatTokenUsageSQL, startUTC, endUTC, targetDate.Format("2006-01-02"))
		if err != nil {
			return fmt.Errorf("refresh AI chat token usage: %w", err)
		}
		return handler.writeResult(task, taskResult{
			TaskType: "ai_chat_token_usage.refresh_daily",
			Status:   "completed",
			Data: map[string]any{
				"rows_written": tag.RowsAffected(),
				"target_date":  targetDate.Format("2006-01-02"),
			},
		})
	})
}

const aiChatTokenUsageSQL = `
WITH aggregates AS (
    SELECT
        c.user_id,
        m.model,
        COALESCE(SUM(m.prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(m.completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(m.total_tokens), 0) AS total_tokens,
        COUNT(m.id) AS message_count,
        COUNT(DISTINCT m.conversation_id) AS conversation_count
    FROM ai_messages m
    JOIN ai_conversations c ON c.id = m.conversation_id
    WHERE c.user_id IS NOT NULL
      AND m.created_at >= $1
      AND m.created_at < $2
      AND m.role = 'assistant'
    GROUP BY c.user_id, m.model
)
INSERT INTO ai_chat_token_usage_snapshots (
    user_id,
    data_date,
    model,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    message_count,
    conversation_count,
    data_version,
    computed_at
)
SELECT
    user_id,
    $3::date,
    model,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    message_count,
    conversation_count,
    1,
    NOW()
FROM aggregates
ON CONFLICT (user_id, data_date, model)
DO UPDATE SET
    prompt_tokens = EXCLUDED.prompt_tokens,
    completion_tokens = EXCLUDED.completion_tokens,
    total_tokens = EXCLUDED.total_tokens,
    message_count = EXCLUDED.message_count,
    conversation_count = EXCLUDED.conversation_count,
    data_version = ai_chat_token_usage_snapshots.data_version + 1,
    computed_at = EXCLUDED.computed_at
`
