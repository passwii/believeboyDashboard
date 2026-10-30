package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

// UserKeyStore resolves SHA-256 key hashes against user_api_keys.
type UserKeyStore struct {
	db DB
}

func NewUserKeyStore(db DB) *UserKeyStore {
	return &UserKeyStore{db: db}
}

func (s *UserKeyStore) ResolveUserKey(ctx context.Context, keyHash string) (*auth.UserKeyRecord, error) {
	row := s.db.QueryRow(
		ctx,
		`select k.user_id::text,
		        k.revoked_at,
		        u.email,
		        coalesce(nullif(trim(u.full_name), ''), ''),
		        u.role_type,
		        u.is_admin
		 from public.user_api_keys as k
		 join public.user_accounts as u on u.id = k.user_id
		 where k.key_hash = $1
		 limit 1`,
		keyHash,
	)

	var record auth.UserKeyRecord
	if err := row.Scan(
		&record.UserID,
		&record.RevokedAt,
		&record.Email,
		&record.FullName,
		&record.RoleType,
		&record.IsAdmin,
	); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &record, nil
}
