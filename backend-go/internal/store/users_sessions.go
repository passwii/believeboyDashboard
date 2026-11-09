package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/users"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func revokeUserSessions(
	ctx context.Context,
	db FullDB,
	input users.SessionRevocationInput,
) (int, error) {
	if input.Revoker == nil || input.Auditor == nil {
		return 0, users.ErrSessionRevocationUnavailable
	}
	if db == nil {
		return 0, users.ErrSessionRevocationUnavailable
	}

	revoked := 0
	err := RunInTx(ctx, db, func(tx pgx.Tx) error {
		var userID string
		err := tx.QueryRow(
			ctx,
			`select id::text
			 from public.user_accounts
			 where id::text = $1
			 limit 1`,
			input.UserID,
		).Scan(&userID)
		if err == pgx.ErrNoRows {
			return users.ErrUserNotFound
		}
		if err != nil {
			return err
		}

		count, err := input.Revoker.DeleteUserSessions(ctx, input.UserID)
		if err != nil {
			return fmt.Errorf("%w: %v", users.ErrSessionRevocationUnavailable, err)
		}

		// FastAPI's revoke-sessions route removes Redis sessions only. User API
		// keys retain their separate password-change/deactivation lifecycle.
		entry := audit.Entry{
			Action:     "users.revoke_sessions",
			TargetType: "user_account",
			TargetID:   &input.UserID,
			Operator:   input.Operator,
			AfterJSON:  map[string]any{"revoked": count},
		}
		entry.PopulateFromRequest(input.Request)
		if err := input.Auditor.LogActionTx(ctx, tx, entry); err != nil {
			return fmt.Errorf("write revoke sessions audit: %w", err)
		}
		revoked = count
		return nil
	})
	if err != nil {
		return 0, err
	}
	return revoked, nil
}
