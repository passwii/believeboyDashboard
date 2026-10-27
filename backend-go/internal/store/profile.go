package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
)

type ProfileStore struct {
	db DB
}

func NewProfileStore(db DB) *ProfileStore {
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
