package tasks

import (
	"context"
	"fmt"
	"time"

	"github.com/hibiken/asynq"
)

const crmSeaReclaimSQL = `
WITH reclaimed_customers AS (
    UPDATE crm_customers
    SET owner_id = NULL,
        next_follow_at = NULL,
        updated_at = NOW()
    WHERE is_deleted = FALSE
      AND owner_id IS NOT NULL
      AND status <> 'signed'
      AND coalesce(rating, '') <> 'A'
      AND COALESCE(last_follow_at, created_at) < $1
    RETURNING id
),
customer_follows AS (
    INSERT INTO crm_follows (
        entity_type,
        entity_id,
        type,
        content,
        next_follow_at,
        created_by
    )
    SELECT 'customer', id, 'note', $2, NULL, NULL
    FROM reclaimed_customers
    RETURNING id
),
reclaimed_leads AS (
    UPDATE crm_leads
    SET owner_id = NULL,
        next_follow_at = NULL,
        updated_at = NOW()
    WHERE is_deleted = FALSE
      AND owner_id IS NOT NULL
      AND status NOT IN ('converted', 'discarded')
      AND COALESCE(last_follow_at, next_follow_at, created_at) < $1
    RETURNING id
),
lead_follows AS (
    INSERT INTO crm_follows (
        entity_type,
        entity_id,
        type,
        content,
        next_follow_at,
        created_by
    )
    SELECT 'lead', id, 'note', $2, NULL, NULL
    FROM reclaimed_leads
    RETURNING id
)
SELECT
    (SELECT COUNT(*) FROM reclaimed_customers),
    (SELECT COUNT(*) FROM reclaimed_leads)
`

const crmTaskReminderSQL = `
UPDATE crm_tasks
SET reminded_at = $1,
    updated_at = $1
WHERE status IN ('pending', 'in_progress')
  AND due_date IS NOT NULL
  AND due_date > $1
  AND due_date <= $2
  AND reminded_at IS NULL
`

const crmFollowUpReminderSQL = `
WITH stale_customers AS (
    SELECT c.id, c.owner_id
    FROM crm_customers c
    WHERE c.is_deleted = FALSE
      AND c.owner_id IS NOT NULL
      AND c.status <> 'signed'
      AND COALESCE(c.last_follow_at, c.created_at) < $1
),
stale_leads AS (
    SELECT l.id, l.owner_id
    FROM crm_leads l
    WHERE l.is_deleted = FALSE
      AND l.owner_id IS NOT NULL
      AND l.status NOT IN ('converted', 'discarded')
      AND COALESCE(l.last_follow_at, l.next_follow_at, l.created_at) < $1
),
resolved_customers AS (
    UPDATE crm_reminder_logs r
    SET status = 'resolved'
    WHERE r.entity_type = 'customer'
      AND r.reminder_type = 'stale_follow_up'
      AND r.status = 'active'
      AND NOT EXISTS (
          SELECT 1 FROM stale_customers s WHERE s.id = r.entity_id
      )
    RETURNING r.id
),
resolved_leads AS (
    UPDATE crm_reminder_logs r
    SET status = 'resolved'
    WHERE r.entity_type = 'lead'
      AND r.reminder_type = 'stale_follow_up'
      AND r.status = 'active'
      AND NOT EXISTS (
          SELECT 1 FROM stale_leads s WHERE s.id = r.entity_id
      )
    RETURNING r.id
),
inserted_customers AS (
    INSERT INTO crm_reminder_logs (
        entity_type,
        entity_id,
        reminder_type,
        owner_id,
        status,
        reminded_at
    )
    SELECT
        'customer',
        s.id,
        'stale_follow_up',
        s.owner_id,
        'active',
        $2
    FROM stale_customers s
    WHERE NOT EXISTS (
        SELECT 1
        FROM crm_reminder_logs r
        WHERE r.entity_type = 'customer'
          AND r.entity_id = s.id
          AND r.reminder_type = 'stale_follow_up'
          AND r.status = 'active'
    )
    RETURNING id
),
inserted_leads AS (
    INSERT INTO crm_reminder_logs (
        entity_type,
        entity_id,
        reminder_type,
        owner_id,
        status,
        reminded_at
    )
    SELECT
        'lead',
        s.id,
        'stale_follow_up',
        s.owner_id,
        'active',
        $2
    FROM stale_leads s
    WHERE NOT EXISTS (
        SELECT 1
        FROM crm_reminder_logs r
        WHERE r.entity_type = 'lead'
          AND r.entity_id = s.id
          AND r.reminder_type = 'stale_follow_up'
          AND r.status = 'active'
    )
    RETURNING id
)
SELECT
    (SELECT COUNT(*) FROM inserted_customers),
    (SELECT COUNT(*) FROM inserted_leads),
    (SELECT COUNT(*) FROM resolved_customers) + (SELECT COUNT(*) FROM resolved_leads)
`

func (handler *TaskHandler) HandleCRMSeaReclaim(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("crm_sea_reclaim", func() error {
		var payload CRMSeaReclaimPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		days := intValue(payload.Days, handler.config.CRMSeaReclaimDays)
		if days < 0 {
			return errNonNegative("days")
		}
		if days == 0 {
			return handler.writeResult(task, taskResult{
				TaskType: "crm_sea_reclaim",
				Status:   "completed",
				Data: map[string]any{
					"enabled": false,
				},
			})
		}

		now := handler.currentTime(payload.Now)
		cutoff := now.AddDate(0, 0, -days)
		content := fmt.Sprintf("超过 %d 天未跟进，系统自动回收至公海", days)
		db, err := handler.requireDB()
		if err != nil {
			return err
		}

		var customers, leads int64
		if err := db.QueryRow(ctx, crmSeaReclaimSQL, cutoff, content).Scan(&customers, &leads); err != nil {
			return fmt.Errorf("reclaim stale CRM entities: %w", err)
		}
		return handler.writeResult(task, taskResult{
			TaskType: "crm_sea_reclaim",
			Status:   "completed",
			Data: map[string]any{
				"customers": customers,
				"leads":     leads,
				"days":      days,
			},
		})
	})
}

func (handler *TaskHandler) HandleCRMTaskReminder(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("crm_task_reminder", func() error {
		var payload CRMTaskReminderPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		leadHours := intValue(payload.LeadHours, handler.config.CRMTaskReminderLeadHours)
		if leadHours <= 0 {
			return errPositive("lead_hours")
		}

		now := handler.currentTime(payload.Now)
		windowEnd := now.Add(time.Duration(leadHours) * time.Hour)
		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		tag, err := db.Exec(ctx, crmTaskReminderSQL, now, windowEnd)
		if err != nil {
			return fmt.Errorf("mark due CRM tasks reminded: %w", err)
		}
		return handler.writeResult(task, taskResult{
			TaskType: "crm_task_reminder",
			Status:   "completed",
			Data: map[string]any{
				"marked":     tag.RowsAffected(),
				"lead_hours": leadHours,
			},
		})
	})
}

func (handler *TaskHandler) HandleCRMFollowUpReminder(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("crm_follow_up_reminder", func() error {
		var payload CRMFollowUpReminderPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		days := intValue(payload.Days, handler.config.CRMFollowUpReminderDays)
		if days < 0 {
			return errNonNegative("days")
		}
		if days == 0 {
			return handler.writeResult(task, taskResult{
				TaskType: "crm_follow_up_reminder",
				Status:   "completed",
				Data: map[string]any{
					"enabled": false,
				},
			})
		}

		now := handler.currentTime(payload.Now)
		cutoff := now.AddDate(0, 0, -days)
		db, err := handler.requireDB()
		if err != nil {
			return err
		}

		var customers, leads, resolved int64
		if err := db.QueryRow(ctx, crmFollowUpReminderSQL, cutoff, now).Scan(&customers, &leads, &resolved); err != nil {
			return fmt.Errorf("scan stale CRM follow-ups: %w", err)
		}
		return handler.writeResult(task, taskResult{
			TaskType: "crm_follow_up_reminder",
			Status:   "completed",
			Data: map[string]any{
				"customers": customers,
				"leads":     leads,
				"resolved":  resolved,
				"days":      days,
			},
		})
	})
}
