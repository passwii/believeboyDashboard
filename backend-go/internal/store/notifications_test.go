package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notifications"
)

func TestNotificationStoreListUsesParameterizedReadOnlySQL(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	readAt := createdAt.Add(time.Minute)
	notificationType := "alert"
	read := true
	db := &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{3}}},
		rows: &fakeRows{batches: [][]any{{
			int64(7),
			int64(10),
			"alert",
			"title",
			pgtype.Text{String: "message", Valid: true},
			[]byte(`{"project_id":3}`),
			true,
			readAt,
			createdAt,
		}}},
	}

	rows, total, err := NewNotificationStore(db).List(
		context.Background(),
		"10",
		notifications.ListParams{
			Type:     &notificationType,
			Read:     &read,
			Page:     2,
			PageSize: 5,
		},
	)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if total != 3 || len(rows) != 1 {
		t.Fatalf("List() = total %d rows %d, want total 3 rows 1", total, len(rows))
	}
	got := rows[0]
	if got.ID != 7 || got.UserID != 10 || got.Type != "alert" ||
		got.Title != "title" || got.Message == nil || *got.Message != "message" ||
		!got.Read || got.ReadAt == nil || !got.ReadAt.Equal(readAt) ||
		!got.CreatedAt.Equal(createdAt) {
		t.Errorf("List() row = %#v, want persisted notification", got)
	}
	var data map[string]int
	if err := json.Unmarshal(got.Data, &data); err != nil || data["project_id"] != 3 {
		t.Errorf("data = %s, want decoded object", got.Data)
	}

	if len(db.queryRowCalls) != 1 || len(db.queryCalls) != 1 {
		t.Fatalf("query calls = row %d many %d, want 1 each", len(db.queryRowCalls), len(db.queryCalls))
	}
	countSQL := db.queryRowCalls[0].sql
	listSQL := db.queryCalls[0].sql
	assertReadOnlySQL(t, countSQL)
	assertReadOnlySQL(t, listSQL)
	for _, query := range []string{countSQL, listSQL} {
		for _, fragment := range []string{
			"where user_id = $1::integer",
			"($2::text is null or type = $2)",
			"($3::boolean is null or \"read\" = $3)",
		} {
			if !contains(query, fragment) {
				t.Errorf("SQL = %s, want fragment %q", query, fragment)
			}
		}
	}
	if !contains(listSQL, "order by created_at desc") ||
		!contains(listSQL, "offset $4") ||
		!contains(listSQL, "limit $5") {
		t.Errorf("SQL = %s, want created_at desc and bounded paging", listSQL)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{"10", &notificationType, &read})
	assertArgs(t, db.queryCalls[0].args, []any{"10", &notificationType, &read, 5, 5})
}

func TestNotificationStoreListReturnsEmptySlice(t *testing.T) {
	db := &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{0}}},
		rows:      &fakeRows{},
	}

	rows, total, err := NewNotificationStore(db).List(
		context.Background(),
		"1",
		notifications.ListParams{Page: 1, PageSize: 20},
	)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if total != 0 || rows == nil || len(rows) != 0 {
		t.Errorf("List() = total %d rows %#v, want empty non-nil slice", total, rows)
	}
}

func TestNotificationStoreUnreadCountUsesParameterizedReadOnlySQL(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{4}}}

	count, err := NewNotificationStore(db).UnreadCount(context.Background(), "9")
	if err != nil {
		t.Fatalf("UnreadCount() error = %v", err)
	}
	if count != 4 {
		t.Errorf("UnreadCount() = %d, want 4", count)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := db.queryRowCalls[0].sql
	assertReadOnlySQL(t, query)
	if !contains(query, "user_id = $1::integer") ||
		!contains(query, "\"read\" = false") {
		t.Errorf("SQL = %s, want user id and unread filters", query)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{"9"})
}

func TestNotificationStorePropagatesErrors(t *testing.T) {
	wantErr := errors.New("database down")
	db := &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{err: wantErr}},
		rows:      &fakeRows{err: wantErr},
	}
	if _, _, err := NewNotificationStore(db).List(
		context.Background(),
		"1",
		notifications.ListParams{Page: 1, PageSize: 20},
	); !errors.Is(err, wantErr) {
		t.Errorf("List() error = %v, want %v", err, wantErr)
	}

	db = &fakeDB{row: fakeRow{err: wantErr}}
	if _, err := NewNotificationStore(db).UnreadCount(context.Background(), "1"); !errors.Is(err, wantErr) {
		t.Errorf("UnreadCount() error = %v, want %v", err, wantErr)
	}
}

func assertReadOnlySQL(t *testing.T, query string) {
	t.Helper()
	upper := strings.ToUpper(query)
	for _, keyword := range []string{"INSERT ", "UPDATE ", "DELETE ", "MERGE ", "TRUNCATE "} {
		if strings.Contains(upper, keyword) {
			t.Errorf("SQL is not read-only: %s", query)
		}
	}
}
