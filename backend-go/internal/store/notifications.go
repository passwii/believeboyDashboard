package store

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notifications"
)

type NotificationStore struct {
	db DB
}

func NewNotificationStore(db DB) *NotificationStore {
	return &NotificationStore{db: db}
}

func (s *NotificationStore) List(
	ctx context.Context,
	userID string,
	params notifications.ListParams,
) ([]notifications.Notification, int, error) {
	var total int
	if err := s.db.QueryRow(
		ctx,
		`select count(*)
		 from public.notifications
		 where user_id = $1::integer
		   and ($2::text is null or type = $2)
		   and ($3::boolean is null or "read" = $3)`,
		userID,
		params.Type,
		params.Read,
	).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := s.db.Query(
		ctx,
		`select
		   id, user_id, type, title, message, data, "read", read_at, created_at
		 from public.notifications
		 where user_id = $1::integer
		   and ($2::text is null or type = $2)
		   and ($3::boolean is null or "read" = $3)
		 order by created_at desc
		 offset $4
		 limit $5`,
		userID,
		params.Type,
		params.Read,
		safeOffset(params.Page, params.PageSize),
		params.PageSize,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]notifications.Notification, 0)
	for rows.Next() {
		item, err := scanNotification(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

func (s *NotificationStore) UnreadCount(ctx context.Context, userID string) (int, error) {
	var count int
	err := s.db.QueryRow(
		ctx,
		`select count(*)
		 from public.notifications
		 where user_id = $1::integer
		   and "read" = false`,
		userID,
	).Scan(&count)
	return count, err
}

type notificationScanner interface {
	Scan(dest ...any) error
}

func scanNotification(scanner notificationScanner) (notifications.Notification, error) {
	var (
		item      notifications.Notification
		message   pgtype.Text
		data      []byte
		readAt    pgtype.Timestamptz
		createdAt pgtype.Timestamptz
	)
	if err := scanner.Scan(
		&item.ID,
		&item.UserID,
		&item.Type,
		&item.Title,
		&message,
		&data,
		&item.Read,
		&readAt,
		&createdAt,
	); err != nil {
		return notifications.Notification{}, err
	}
	item.Message = Text(message)
	if len(data) > 0 {
		item.Data = append(item.Data[:0], data...)
	}
	item.ReadAt = timestampPointer(readAt)
	item.CreatedAt = createdAt.Time
	return item, nil
}
