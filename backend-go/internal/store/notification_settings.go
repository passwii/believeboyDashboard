package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notification_settings"
)

type NotificationSettingsStore struct {
	db DB
}

func NewNotificationSettingsStore(db DB) *NotificationSettingsStore {
	return &NotificationSettingsStore{db: db}
}

func (s *NotificationSettingsStore) GetProject(
	ctx context.Context,
	projectID string,
) (*notification_settings.Project, error) {
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
	return &notification_settings.Project{
		ProjectOperator:   Text(projectOperator),
		AssistantOperator: Text(assistantOperator),
	}, nil
}

func (s *NotificationSettingsStore) ListSettings(
	ctx context.Context,
	projectID string,
) ([]notification_settings.Setting, error) {
	rows, err := s.db.Query(
		ctx,
		`select
		   id, project_id, rule_name, frequency, report_types, recipients,
		   enabled, created_by, created_at, updated_at
		 from public.notification_subscriptions
		 where project_id = $1::integer
		 order by created_at desc`,
		projectID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]notification_settings.Setting, 0)
	for rows.Next() {
		item, err := scanNotificationSetting(rows)
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

func (s *NotificationSettingsStore) GetSetting(
	ctx context.Context,
	id int64,
) (*notification_settings.Setting, error) {
	row := s.db.QueryRow(
		ctx,
		`select
		   id, project_id, rule_name, frequency, report_types, recipients,
		   enabled, created_by, created_at, updated_at
		 from public.notification_subscriptions
		 where id = $1
		 limit 1`,
		id,
	)
	item, err := scanNotificationSetting(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *NotificationSettingsStore) CreateSetting(
	ctx context.Context,
	value notification_settings.Setting,
) (*notification_settings.Setting, error) {
	reportTypes, err := encodeStringArray(value.ReportTypes)
	if err != nil {
		return nil, err
	}
	recipients, err := encodeStringArray(value.Recipients)
	if err != nil {
		return nil, err
	}
	row := s.db.QueryRow(
		ctx,
		`insert into public.notification_subscriptions (
		   project_id, rule_name, frequency, report_types, recipients, enabled, created_by
		 )
		 values ($1, $2, $3, $4::json, $5::json, $6, $7)
		 returning
		   id, project_id, rule_name, frequency, report_types, recipients,
		   enabled, created_by, created_at, updated_at`,
		value.ProjectID,
		value.RuleName,
		value.Frequency,
		reportTypes,
		recipients,
		value.Enabled,
		value.CreatedBy,
	)
	item, err := scanNotificationSetting(row)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *NotificationSettingsStore) UpdateSetting(
	ctx context.Context,
	id int64,
	value notification_settings.Setting,
) (*notification_settings.Setting, error) {
	reportTypes, err := encodeStringArray(value.ReportTypes)
	if err != nil {
		return nil, err
	}
	recipients, err := encodeStringArray(value.Recipients)
	if err != nil {
		return nil, err
	}
	row := s.db.QueryRow(
		ctx,
		`update public.notification_subscriptions
		 set rule_name = $2,
		     frequency = $3,
		     report_types = $4::json,
		     recipients = $5::json,
		     enabled = $6,
		     updated_at = now()
		 where id = $1
		 returning
		   id, project_id, rule_name, frequency, report_types, recipients,
		   enabled, created_by, created_at, updated_at`,
		id,
		value.RuleName,
		value.Frequency,
		reportTypes,
		recipients,
		value.Enabled,
	)
	item, err := scanNotificationSetting(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *NotificationSettingsStore) DeleteSetting(ctx context.Context, id int64) (bool, error) {
	execer, ok := s.db.(Execer)
	if !ok {
		return false, errors.New("database does not support writes")
	}
	tag, err := execer.Exec(
		ctx,
		`delete from public.notification_subscriptions
		 where id = $1`,
		id,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *NotificationSettingsStore) FindTestEmailAttempt(
	ctx context.Context,
	idempotencyKey string,
) (*notification_settings.TestEmailAttempt, error) {
	var (
		result  string
		after   []byte
		attempt notification_settings.TestEmailAttempt
	)
	err := s.db.QueryRow(
		ctx,
		`select result, after_json
		 from public.operation_audit_logs
		 where action = 'notification_settings.test_email'
		   and idempotency_key = $1
		 order by id desc
		 limit 1`,
		idempotencyKey,
	).Scan(&result, &after)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	attempt.Result = result
	if len(after) > 0 {
		var payload struct {
			Fingerprint string  `json:"fingerprint"`
			ResendID    *string `json:"resend_id"`
		}
		if err := json.Unmarshal(after, &payload); err != nil {
			return nil, fmt.Errorf("scan notification test email audit: %w", err)
		}
		attempt.Fingerprint = payload.Fingerprint
		attempt.ResendID = payload.ResendID
	}
	return &attempt, nil
}

func (s *NotificationSettingsStore) RecordTestEmailAudit(
	ctx context.Context,
	event notification_settings.TestEmailAudit,
) error {
	execer, ok := s.db.(Execer)
	if !ok {
		return errors.New("database does not support writes")
	}
	after := map[string]any{
		"subscription_id": event.SubscriptionID,
		"project_id":      event.ProjectID,
		"recipient":       event.Recipient,
		"frequency":       event.Frequency,
		"fingerprint":     event.Fingerprint,
	}
	if event.ResendID != nil {
		after["resend_id"] = *event.ResendID
	}
	afterJSON, err := json.Marshal(after)
	if err != nil {
		return fmt.Errorf("encode notification test email audit: %w", err)
	}
	operator := clipNotificationAuditText(event.Operator, 255)
	traceID := clipNotificationAuditText(event.TraceID, 64)
	requestMethod := clipNotificationAuditText(event.RequestMethod, 16)
	requestPath := clipNotificationAuditText(event.RequestPath, 255)
	ipAddress := clipNotificationAuditText(event.IPAddress, 64)
	userAgent := clipNotificationAuditText(event.UserAgent, 512)
	idempotencyKey := clipNotificationAuditText(event.IdempotencyKey, 64)
	errorMessage := clipNotificationAuditText(event.ErrorMessage, 2048)
	result := "failure"
	if event.Result == "success" {
		result = "success"
	}
	targetID := fmt.Sprintf("%d", event.SubscriptionID)
	_, err = execer.Exec(
		ctx,
		`insert into public.operation_audit_logs (
		   operator, action, target_type, target_id, result, trace_id,
		   request_method, request_path, ip_address, user_agent,
		   after_json, idempotency_key, error_message, created_at
		 )
		 values (
		   $1, 'notification_settings.test_email', 'notification_subscription', $2, $3, $4,
		   $5, $6, $7, $8, $9::json, $10, $11, now()
		 )`,
		operator,
		targetID,
		result,
		traceID,
		requestMethod,
		requestPath,
		ipAddress,
		userAgent,
		afterJSON,
		idempotencyKey,
		errorMessage,
	)
	if err != nil {
		return fmt.Errorf("write notification test email audit: %w", err)
	}
	return nil
}

func clipNotificationAuditText(value *string, maxLength int) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	if utf8.RuneCountInString(trimmed) > maxLength {
		trimmed = string([]rune(trimmed)[:maxLength])
	}
	return &trimmed
}

type notificationSettingScanner interface {
	Scan(dest ...any) error
}

func scanNotificationSetting(scanner notificationSettingScanner) (notification_settings.Setting, error) {
	var (
		item       notification_settings.Setting
		reportRaw  []byte
		recipients []byte
		createdBy  pgtype.Int4
		createdAt  pgtype.Timestamptz
		updatedAt  pgtype.Timestamptz
	)
	if err := scanner.Scan(
		&item.ID,
		&item.ProjectID,
		&item.RuleName,
		&item.Frequency,
		&reportRaw,
		&recipients,
		&item.Enabled,
		&createdBy,
		&createdAt,
		&updatedAt,
	); err != nil {
		return notification_settings.Setting{}, err
	}
	if err := json.Unmarshal(reportRaw, &item.ReportTypes); err != nil {
		return notification_settings.Setting{}, fmt.Errorf("scan notification settings report_types: %w", err)
	}
	if err := json.Unmarshal(recipients, &item.Recipients); err != nil {
		return notification_settings.Setting{}, fmt.Errorf("scan notification settings recipients: %w", err)
	}
	if item.ReportTypes == nil {
		item.ReportTypes = []string{}
	}
	if item.Recipients == nil {
		item.Recipients = []string{}
	}
	if createdBy.Valid {
		value := int64(createdBy.Int32)
		item.CreatedBy = &value
	}
	item.CreatedAt = createdAt.Time
	item.UpdatedAt = updatedAt.Time
	return item, nil
}

func encodeStringArray(values []string) ([]byte, error) {
	if values == nil {
		values = []string{}
	}
	return json.Marshal(values)
}
