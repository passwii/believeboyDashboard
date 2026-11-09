package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestNotificationStoreMarkReadScopesUpdateToOwnerAndReturnsRow(t *testing.T) {
	readAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: []any{
		int64(7), int64(10), "alert", "title", pgtype.Text{}, []byte(`{"x":1}`),
		true, readAt, readAt,
	}}}}

	got, err := NewNotificationStore(db).MarkRead(context.Background(), "10", 7)
	if err != nil {
		t.Fatalf("MarkRead() error = %v", err)
	}
	if got == nil || got.ID != 7 || got.UserID != 10 || !got.Read ||
		got.ReadAt == nil || !got.ReadAt.Equal(readAt) {
		t.Fatalf("MarkRead() = %#v, want updated notification", got)
	}
	if data := json.RawMessage(got.Data); string(data) != `{"x":1}` {
		t.Errorf("data = %s, want JSON payload", data)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "update public.notifications") ||
		!strings.Contains(query, "where id = $1") ||
		!strings.Contains(query, "user_id = $2::integer") ||
		!strings.Contains(query, "returning") {
		t.Errorf("MarkRead SQL = %s, want owner-scoped UPDATE RETURNING", query)
	}
	if !assertWriteArgsEqual(db.queryRowCalls[0].args, []any{int64(7), "10"}) {
		t.Errorf("MarkRead args = %#v, want id and authenticated user", db.queryRowCalls[0].args)
	}
}

func TestNotificationStoreMarkAllReadAndDeleteUseOwnerScope(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{}, execTag: pgconn.NewCommandTag("UPDATE 3")}
	count, err := NewNotificationStore(db).MarkAllRead(context.Background(), "14")
	if err != nil {
		t.Fatalf("MarkAllRead() error = %v", err)
	}
	if count != 3 {
		t.Errorf("MarkAllRead() = %d, want 3", count)
	}
	if len(db.execCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.execCalls[0].sql), "update public.notifications") ||
		!strings.Contains(strings.ToLower(db.execCalls[0].sql), "user_id = $1::integer") {
		t.Fatalf("MarkAllRead Exec() = %#v, want user-scoped update", db.execCalls)
	}
	if !assertWriteArgsEqual(db.execCalls[0].args, []any{"14"}) {
		t.Errorf("MarkAllRead args = %#v, want user id", db.execCalls[0].args)
	}

	db.execCalls = nil
	db.execTag = pgconn.NewCommandTag("DELETE 1")
	deleted, err := NewNotificationStore(db).Delete(context.Background(), "14", 8)
	if err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if !deleted {
		t.Error("Delete() = false, want true")
	}
	if len(db.execCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.execCalls[0].sql), "delete from public.notifications") ||
		!strings.Contains(strings.ToLower(db.execCalls[0].sql), "user_id = $2::integer") {
		t.Fatalf("Delete Exec() = %#v, want user-scoped delete", db.execCalls)
	}
	if !assertWriteArgsEqual(db.execCalls[0].args, []any{int64(8), "14"}) {
		t.Errorf("Delete args = %#v, want notification and user ids", db.execCalls[0].args)
	}
}

func TestNotificationStoreWriteErrorsPropagate(t *testing.T) {
	wantErr := errors.New("database unavailable")
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: wantErr}}, execErr: wantErr}
	store := NewNotificationStore(db)
	if _, err := store.MarkRead(context.Background(), "10", 2); !errors.Is(err, wantErr) {
		t.Errorf("MarkRead() error = %v, want %v", err, wantErr)
	}
	if _, err := store.MarkAllRead(context.Background(), "10"); !errors.Is(err, wantErr) {
		t.Errorf("MarkAllRead() error = %v, want %v", err, wantErr)
	}
	if _, err := store.Delete(context.Background(), "10", 2); !errors.Is(err, wantErr) {
		t.Errorf("Delete() error = %v, want %v", err, wantErr)
	}
}
