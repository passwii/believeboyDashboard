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
		`select user_id::text, revoked_at
		 from public.user_api_keys
		 where key_hash = $1
		 limit 1`,
		keyHash,
	)

	var record auth.UserKeyRecord
	if err := row.Scan(&record.UserID, &record.RevokedAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &record, nil
}
