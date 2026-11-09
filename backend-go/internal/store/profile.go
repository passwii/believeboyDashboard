package store

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type ProfileStore struct {
	db FullDB
}

var _ profile.UpdateStore = (*ProfileStore)(nil)

func NewProfileStore(db FullDB) *ProfileStore {
	return &ProfileStore{db: db}
}

func (s *ProfileStore) GetByUserID(ctx context.Context, userID string) (*profile.Profile, error) {
	row := s.db.QueryRow(
		ctx,
		`select
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
		   updated_at
		 from public.user_accounts
		 where id::text = $1
		 limit 1`,
		userID,
	)

	return scanProfileRow(row)
}

func (s *ProfileStore) UpdateByUserID(
	ctx context.Context,
	userID string,
	input profile.UpdateInput,
) (*profile.Profile, error) {
	var result *profile.Profile
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		changed := make([]string, 0, 2)
		query := `update public.user_accounts set `
		args := make([]any, 0, 3)
		clauses := make([]string, 0, 2)

		if input.Name != nil {
			args = append(args, *input.Name)
			clauses = append(clauses, `name = $`+strconv.Itoa(len(args)))
			changed = append(changed, "name")
		}
		if input.SetFullName {
			args = append(args, input.FullName)
			clauses = append(clauses, `full_name = $`+strconv.Itoa(len(args)))
			changed = append(changed, "full_name")
		}

		if len(clauses) == 0 {
			existing, err := scanProfileRow(tx.QueryRow(
				ctx,
				`select
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
				   updated_at
				 from public.user_accounts
				 where id::text = $1
				 limit 1`,
				userID,
			))
			if err != nil {
				return err
			}
			result = existing
			return nil
		}

		args = append(args, userID)
		query += strings.Join(clauses, ", ") +
			` where id::text = $` + strconv.Itoa(len(args)) +
			` returning
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
			   updated_at`
		updated, err := scanProfileRow(tx.QueryRow(ctx, query, args...))
		if err != nil {
			return err
		}
		result = updated
		if result == nil {
			return nil
		}

		entry := audit.Entry{
			Action:     "profile.update",
			TargetType: "user_account",
			TargetID:   &userID,
			Operator:   input.Operator,
			BeforeJSON: map[string]any{"changed": changed},
			AfterJSON:  map[string]any{"changed": changed},
		}
		entry.PopulateFromRequest(input.Request)
		return audit.NewService(tx).LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

type profileRowScanner interface {
	Scan(dest ...any) error
}

func scanProfileRow(row profileRowScanner) (*profile.Profile, error) {
	var (
		result            profile.Profile
		fullName          pgtype.Text
		roleType          pgtype.Text
		avatarURL         pgtype.Text
		passwordChangedAt pgtype.Timestamptz
		createdAt         pgtype.Timestamptz
		updatedAt         pgtype.Timestamptz
	)
	err := row.Scan(
		&result.ID,
		&result.Email,
		&result.Name,
		&fullName,
		&result.IsAdmin,
		&result.IsActive,
		&roleType,
		&avatarURL,
		&passwordChangedAt,
		&createdAt,
		&updatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	result.FullName = Text(fullName)
	if roleType.Valid {
		result.RoleType = roleType.String
	}
	result.AvatarURL = Text(avatarURL)
	result.PasswordChangedAt = timestampPointer(passwordChangedAt)
	result.CreatedAt = timestampPointer(createdAt)
	result.UpdatedAt = timestampPointer(updatedAt)
	return &result, nil
}

func timestampPointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	timestamp := value.Time
	return &timestamp
}
