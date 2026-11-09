package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/presence"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type PresenceStore struct {
	db FullDB
}

func NewPresenceStore(db FullDB) *PresenceStore {
	return &PresenceStore{db: db}
}

const upsertPresenceSQL = `
INSERT INTO public.user_presence (
	user_id, display_name, email, avatar_url, current_path,
	current_page_title, last_seen_at, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
ON CONFLICT (user_id) DO UPDATE SET
	display_name = EXCLUDED.display_name,
	email = EXCLUDED.email,
	avatar_url = EXCLUDED.avatar_url,
	current_path = EXCLUDED.current_path,
	current_page_title = EXCLUDED.current_page_title,
	last_seen_at = EXCLUDED.last_seen_at,
	updated_at = EXCLUDED.updated_at`

const listPresenceSQL = `
SELECT user_id, display_name, email, avatar_url, current_path,
       current_page_title, last_seen_at
FROM public.user_presence
WHERE last_seen_at >= $1
ORDER BY last_seen_at DESC, user_id ASC`

func (store *PresenceStore) UpsertPresence(
	ctx context.Context,
	input presence.UpsertInput,
	now time.Time,
) error {
	_, err := store.db.Exec(
		ctx,
		upsertPresenceSQL,
		input.UserID,
		input.DisplayName,
		input.Email,
		input.AvatarURL,
		input.CurrentPath,
		input.CurrentPageTitle,
		now,
	)
	return err
}

func (store *PresenceStore) ListActivePresence(
	ctx context.Context,
	currentUserID string,
	cutoff time.Time,
) ([]presence.UserItem, error) {
	rows, err := store.db.Query(ctx, listPresenceSQL, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]presence.UserItem, 0)
	for rows.Next() {
		var item presence.UserItem
		var email, avatarURL *string
		var lastSeen pgtype.Timestamptz
		if err := rows.Scan(
			&item.UserID,
			&item.DisplayName,
			&email,
			&avatarURL,
			&item.CurrentPath,
			&item.CurrentPageTitle,
			&lastSeen,
		); err != nil {
			return nil, err
		}
		item.Email = email
		if avatarURL == nil || *avatarURL == "" {
			fallback := "/avatars/default.svg"
			item.AvatarURL = &fallback
		} else {
			item.AvatarURL = avatarURL
		}
		if lastSeen.Valid {
			item.LastSeenAt = httpapi.Timestamp(lastSeen.Time)
		}
		item.IsCurrentUser = currentUserID != "" && item.UserID == currentUserID
		items = append(items, item)
	}
	return items, rows.Err()
}

func (store *PresenceStore) ServerTime(ctx context.Context) (time.Time, error) {
	var value time.Time
	err := store.db.QueryRow(ctx, `SELECT now()`).Scan(&value)
	if err == pgx.ErrNoRows {
		return time.Time{}, nil
	}
	return value, err
}
