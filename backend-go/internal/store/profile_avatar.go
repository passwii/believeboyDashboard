package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

var _ profile.AvatarStore = (*ProfileStore)(nil)

type ProfileAvatarAuditor struct {
	service audit.Service
}

func NewProfileAvatarAuditor(service audit.Service) profile.Auditor {
	if service == nil {
		return nil
	}
	return &ProfileAvatarAuditor{service: service}
}

func (auditor *ProfileAvatarAuditor) LogActionTx(
	ctx context.Context,
	tx pgx.Tx,
	entry profile.AvatarAudit,
) error {
	if auditor == nil || auditor.service == nil {
		return fmt.Errorf("profile avatar audit service is nil")
	}
	auditEntry := audit.Entry{
		Action:     entry.Action,
		TargetType: entry.TargetType,
		TargetID:   entry.TargetID,
		Operator:   entry.Operator,
		BeforeJSON: entry.BeforeJSON,
		AfterJSON:  entry.AfterJSON,
	}
	auditEntry.PopulateFromRequest(entry.Request)
	return auditor.service.LogActionTx(ctx, tx, auditEntry)
}

func (s *ProfileStore) UpdateAvatar(
	ctx context.Context,
	userID string,
	input profile.AvatarUpdateInput,
) (*profile.Profile, error) {
	if input.Auditor == nil {
		return nil, fmt.Errorf("profile avatar auditor is nil")
	}

	var result *profile.Profile
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		updated, err := scanProfileRow(tx.QueryRow(
			ctx,
			`update public.user_accounts
			 set avatar_url = $1
			 where id::text = $2
			 returning
			   id::text as id,
			   email,
			   name,
			   full_name,
			   is_admin,
			   is_active,
			   role_type,
			   avatar_url,
			   password_changed_at,
			   created_at,
			   updated_at`,
			input.AvatarURL,
			userID,
		))
		if err != nil {
			return err
		}
		if updated == nil {
			result = nil
			return nil
		}
		if err := input.Auditor.LogActionTx(ctx, tx, input.Audit); err != nil {
			return fmt.Errorf("write profile avatar audit: %w", err)
		}
		result = updated
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
