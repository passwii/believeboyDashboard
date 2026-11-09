package store

import (
	"context"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

const alertPreferenceReturningColumns = `
	email_enabled,
	in_app_enabled,
	min_severity,
	case when quiet_hours_start is null then null
	     else to_char(quiet_hours_start, 'HH24:MI')
	end as quiet_hours_start,
	case when quiet_hours_end is null then null
	     else to_char(quiet_hours_end, 'HH24:MI')
	end as quiet_hours_end`

func (s *AlertStore) GetPreference(
	ctx context.Context,
	userID int64,
) (*alerts.Preference, error) {
	row := s.db.QueryRow(
		ctx,
		`insert into public.alert_preferences (user_id)
		 values ($1)
		 on conflict (user_id) do update
		 set user_id = excluded.user_id
		 returning `+alertPreferenceReturningColumns,
		userID,
	)
	item, err := scanAlertPreference(row)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *AlertStore) UpdatePreference(
	ctx context.Context,
	userID int64,
	input alerts.UpdatePreferenceInput,
) (*alerts.Preference, error) {
	transactor, ok := s.db.(Transactor)
	if !ok {
		return nil, alerts.ErrPreferencesUnavailable
	}

	var result *alerts.Preference
	err := RunInTx(ctx, transactor, func(tx pgx.Tx) error {
		current, err := scanAlertPreference(tx.QueryRow(
			ctx,
			`select `+alertPreferenceReturningColumns+`
			 from public.alert_preferences
			 where user_id = $1
			 for update`,
			userID,
		))
		exists := true
		if err == pgx.ErrNoRows {
			exists = false
			current = alerts.Preference{
				EmailEnabled: true,
				InAppEnabled: true,
				MinSeverity:  "warning",
			}
			if _, insertErr := tx.Exec(
				ctx,
				`insert into public.alert_preferences (user_id)
				 values ($1)
				 on conflict (user_id) do nothing`,
				userID,
			); insertErr != nil {
				return insertErr
			}
		} else if err != nil {
			return err
		}

		var before any
		if exists {
			before = alertPreferenceJSON(&current)
		}

		updated, err := scanAlertPreference(tx.QueryRow(
			ctx,
			`update public.alert_preferences
			 set email_enabled = coalesce($2::boolean, email_enabled),
			     in_app_enabled = coalesce($3::boolean, in_app_enabled),
			     min_severity = coalesce($4::text, min_severity),
			     quiet_hours_start = case
			       when $5::boolean then $6::time
			       else quiet_hours_start
			     end,
			     quiet_hours_end = case
			       when $7::boolean then $8::time
			       else quiet_hours_end
			     end,
			     updated_at = now()
			 where user_id = $1
			 returning `+alertPreferenceReturningColumns,
			userID,
			input.Patch.EmailEnabled,
			input.Patch.InAppEnabled,
			input.Patch.MinSeverity,
			input.Patch.QuietHoursStartSet,
			input.Patch.QuietHoursStart,
			input.Patch.QuietHoursEndSet,
			input.Patch.QuietHoursEnd,
		))
		if err != nil {
			return err
		}

		entry := alertAuditEntry(input.Audit)
		entry.BeforeJSON = before
		entry.AfterJSON = alertPreferenceJSON(&updated)
		entry.TargetID = stringPointerValue(strconv.FormatInt(userID, 10))
		if err := audit.NewService(tx).LogActionTx(ctx, tx, entry); err != nil {
			return err
		}

		result = &updated
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

type alertPreferenceScanner interface {
	Scan(dest ...any) error
}

func scanAlertPreference(scanner alertPreferenceScanner) (alerts.Preference, error) {
	var (
		item      alerts.Preference
		startText pgtype.Text
		endText   pgtype.Text
	)
	if err := scanner.Scan(
		&item.EmailEnabled,
		&item.InAppEnabled,
		&item.MinSeverity,
		&startText,
		&endText,
	); err != nil {
		return alerts.Preference{}, err
	}
	item.QuietHoursStart = Text(startText)
	item.QuietHoursEnd = Text(endText)
	return item, nil
}

func stringPointerValue(value string) *string {
	return &value
}
