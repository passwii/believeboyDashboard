package tasks

import (
	"context"
	"errors"
	"fmt"
	"html"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	selectCRMWorkflowSettingsSQL = `
SELECT stale_days, stale_email_enabled
FROM crm_workflow_settings
WHERE id = 1
`
	selectStaleCRMEntitiesSQL = `
WITH stale_entities AS (
    SELECT
        'customer'::text AS entity_type,
        c.id,
        c.name,
        c.owner_id,
        coalesce(c.last_follow_at, c.created_at) AS stale_ref,
        c.stale_email_sent_at
    FROM crm_customers c
    WHERE c.is_deleted = FALSE
      AND c.owner_id IS NOT NULL
      AND c.status <> 'signed'
    UNION ALL
    SELECT
        'lead'::text AS entity_type,
        l.id,
        coalesce(l.name, l.company, '-'),
        l.owner_id,
        coalesce(l.last_follow_at, l.next_follow_at, l.created_at) AS stale_ref,
        l.stale_email_sent_at
    FROM crm_leads l
    WHERE l.is_deleted = FALSE
      AND l.owner_id IS NOT NULL
      AND l.status NOT IN ('converted', 'discarded')
)
SELECT
    s.entity_type,
    s.id,
    s.name,
    s.owner_id,
    coalesce(trim(u.full_name), ''),
    coalesce(u.email, ''),
    s.stale_ref,
    s.stale_email_sent_at
FROM stale_entities s
LEFT JOIN public.user_accounts u ON u.id::text = s.owner_id
WHERE s.stale_ref < $1
  AND (s.stale_email_sent_at IS NULL OR s.stale_email_sent_at < s.stale_ref)
ORDER BY s.owner_id, s.entity_type, s.id
`
	markCustomerStaleEmailSentSQL = `
UPDATE crm_customers
SET stale_email_sent_at = $2,
    updated_at = $2
WHERE id = $1
`
	markLeadStaleEmailSentSQL = `
UPDATE crm_leads
SET stale_email_sent_at = $2,
    updated_at = $2
WHERE id = $1
`
)

type crmWorkflowSettings struct {
	StaleDays         int
	StaleEmailEnabled bool
}

type staleCRMEntity struct {
	EntityType string
	ID         int64
	Name       string
	OwnerID    string
	OwnerName  string
	Email      string
	StaleRef   time.Time
}

type staleCRMOwnerBatch struct {
	OwnerID   string
	OwnerName string
	Email     string
	Entities  []staleCRMEntity
}

func (handler *TaskHandler) HandleCRMStaleEmail(ctx context.Context, task *asynq.Task) error {
	const taskType = queue.TypeCRMStaleEmail
	return handler.runSafely(taskType, func() error {
		var payload CRMStaleEmailPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		db, err := handler.requireDB()
		if err != nil {
			return err
		}

		var settings crmWorkflowSettings
		if err := db.QueryRow(ctx, selectCRMWorkflowSettingsSQL).Scan(
			&settings.StaleDays,
			&settings.StaleEmailEnabled,
		); err != nil {
			return fmt.Errorf("load CRM stale email settings: %w", err)
		}
		if settings.StaleDays < 1 || settings.StaleDays > 365 {
			return errInvalid("crm_workflow_settings.stale_days", "must be between 1 and 365")
		}
		if !handler.config.CRMStaleEmailEnabled || !settings.StaleEmailEnabled {
			return handler.writeResult(task, taskResult{
				TaskType: taskType,
				Status:   "completed",
				Data: map[string]any{
					"enabled": false,
				},
			})
		}
		if handler.config.Mailer == nil {
			return fmt.Errorf("%w: crm stale email mailer", ErrDependencyNotConfigured)
		}

		now := handler.currentTime(nil)
		cutoff := now.AddDate(0, 0, -settings.StaleDays)
		entities, err := loadStaleCRMEntities(ctx, db, cutoff)
		if err != nil {
			return err
		}
		owners := groupStaleCRMEntities(entities)

		var sendErrors []error
		emailsSent := 0
		ownersEmailed := 0
		ownersWithoutEmail := 0
		for _, owner := range owners {
			if strings.TrimSpace(owner.Email) == "" {
				ownersWithoutEmail++
				continue
			}
			subject, body := renderStaleCRMEmail(owner, settings.StaleDays, now)
			if err := handler.config.Mailer.Send(
				ctx,
				owner.Email,
				subject,
				body,
			); err != nil {
				sendErrors = append(sendErrors, fmt.Errorf(
					"send stale CRM email to owner %s: %w",
					owner.OwnerID,
					err,
				))
				continue
			}
			emailsSent++
			ownersEmailed++
			for _, entity := range owner.Entities {
				query := markCustomerStaleEmailSentSQL
				if entity.EntityType == "lead" {
					query = markLeadStaleEmailSentSQL
				}
				if _, err := db.Exec(ctx, query, entity.ID, now); err != nil {
					sendErrors = append(sendErrors, fmt.Errorf(
						"mark %s %d stale email sent: %w",
						entity.EntityType,
						entity.ID,
						err,
					))
				}
			}
		}

		result := taskResult{
			TaskType: taskType,
			Status:   "completed",
			Data: map[string]any{
				"enabled":              true,
				"emails_sent":          emailsSent,
				"customers":            countCRMEntityType(entities, "customer"),
				"leads":                countCRMEntityType(entities, "lead"),
				"owners_emailed":       ownersEmailed,
				"owners_without_email": ownersWithoutEmail,
			},
		}
		if err := handler.writeResult(task, result); err != nil {
			return err
		}
		return errors.Join(sendErrors...)
	})
}

func loadStaleCRMEntities(
	ctx context.Context,
	db store.FullDB,
	cutoff time.Time,
) ([]staleCRMEntity, error) {
	rows, err := db.Query(ctx, selectStaleCRMEntitiesSQL, cutoff)
	if err != nil {
		return nil, fmt.Errorf("scan stale CRM entities: %w", err)
	}
	defer rows.Close()

	var entities []staleCRMEntity
	for rows.Next() {
		var (
			entity staleCRMEntity
			sentAt *time.Time
		)
		if err := rows.Scan(
			&entity.EntityType,
			&entity.ID,
			&entity.Name,
			&entity.OwnerID,
			&entity.OwnerName,
			&entity.Email,
			&entity.StaleRef,
			&sentAt,
		); err != nil {
			return nil, fmt.Errorf("scan stale CRM entity: %w", err)
		}
		entities = append(entities, entity)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate stale CRM entities: %w", err)
	}
	return entities, nil
}

func groupStaleCRMEntities(entities []staleCRMEntity) []staleCRMOwnerBatch {
	byOwner := make(map[string]*staleCRMOwnerBatch)
	order := make([]string, 0, len(entities))
	for _, entity := range entities {
		batch, ok := byOwner[entity.OwnerID]
		if !ok {
			batch = &staleCRMOwnerBatch{
				OwnerID:   entity.OwnerID,
				OwnerName: entity.OwnerName,
				Email:     entity.Email,
			}
			byOwner[entity.OwnerID] = batch
			order = append(order, entity.OwnerID)
		}
		if batch.Email == "" && entity.Email != "" {
			batch.Email = entity.Email
		}
		if batch.OwnerName == "" && entity.OwnerName != "" {
			batch.OwnerName = entity.OwnerName
		}
		batch.Entities = append(batch.Entities, entity)
	}

	batches := make([]staleCRMOwnerBatch, 0, len(order))
	for _, ownerID := range order {
		batches = append(batches, *byOwner[ownerID])
	}
	return batches
}

func renderStaleCRMEmail(
	owner staleCRMOwnerBatch,
	staleDays int,
	now time.Time,
) (string, string) {
	greeting := ""
	if owner.OwnerName != "" {
		greeting = html.EscapeString(owner.OwnerName) + "，"
	}
	subject := fmt.Sprintf("[CRM] 有 %d 个客户/线索超过 %d 天未跟进", len(owner.Entities), staleDays)

	var rows strings.Builder
	for _, entity := range owner.Entities {
		typeLabel := "客户"
		if entity.EntityType == "lead" {
			typeLabel = "线索"
		}
		rows.WriteString("<tr>")
		rows.WriteString("<td>" + typeLabel + "</td>")
		rows.WriteString("<td>" + html.EscapeString(entity.Name) + "</td>")
		rows.WriteString("<td>" + entity.StaleRef.Format("2006-01-02") + "</td>")
		rows.WriteString(fmt.Sprintf("<td>%d 天</td>", max(1, int(now.Sub(entity.StaleRef).Hours()/24))))
		rows.WriteString("</tr>")
	}
	body := fmt.Sprintf(
		"<!doctype html><html><body><h1>%s有 %d 个客户/线索超过 %d 天未跟进</h1><table>%s</table></body></html>",
		greeting,
		len(owner.Entities),
		staleDays,
		rows.String(),
	)
	return subject, body
}

func countCRMEntityType(entities []staleCRMEntity, entityType string) int {
	count := 0
	for _, entity := range entities {
		if entity.EntityType == entityType {
			count++
		}
	}
	return count
}
