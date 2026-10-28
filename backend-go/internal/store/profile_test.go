package store

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestProfileStoreReadsByIdTextAndScansNullableFields(t *testing.T) {
	passwordChangedAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{
		row: fakeRow{values: []any{
			"user-123",
			"person@example.com",
			"operator",
			pgtype.Text{String: "运营 A", Valid: true},
			true,
			true,
			pgtype.Text{String: "admin", Valid: true},
			pgtype.Text{String: "https://example.com/avatar.webp", Valid: true},
			passwordChangedAt,
			time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
			time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
		}},
	}

	got, err := NewProfileStore(db).GetByUserID(context.Background(), "user-123")
	if err != nil {
		t.Fatalf("GetByUserID() error = %v", err)
	}
	if got == nil || got.ID != "user-123" || got.Email != "person@example.com" ||
		got.FullName == nil || *got.FullName != "运营 A" ||
		got.RoleType != "admin" || got.AvatarURL == nil {
		t.Fatalf("GetByUserID() = %#v, want full profile", got)
	}
	if got.PasswordChangedAt == nil || !got.PasswordChangedAt.Equal(passwordChangedAt) {
		t.Errorf("password_changed_at = %#v, want %s", got.PasswordChangedAt, passwordChangedAt)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	if !contains(db.queryRowCalls[0].sql, "where id::text = $1") {
		t.Errorf("SQL = %s, want id::text filter", db.queryRowCalls[0].sql)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{"user-123"})
}

func TestProfileStoreReturnsNilForUnknownUser(t *testing.T) {
	db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}

	got, err := NewProfileStore(db).GetByUserID(context.Background(), "missing")
	if err != nil {
		t.Fatalf("GetByUserID() error = %v", err)
	}
	if got != nil {
		t.Fatalf("GetByUserID() = %#v, want nil", got)
	}
}

func TestProfileStoreKeepsNullRoleForHandlerFallback(t *testing.T) {
	db := &fakeDB{
		row: fakeRow{values: []any{
			"user-456",
			"operator@example.com",
			"operator",
			pgtype.Text{},
			false,
			true,
			pgtype.Text{},
			pgtype.Text{},
			nil,
			nil,
			nil,
		}},
	}

	got, err := NewProfileStore(db).GetByUserID(context.Background(), "user-456")
	if err != nil {
		t.Fatalf("GetByUserID() error = %v", err)
	}
	if got.RoleType != "" || got.FullName != nil || got.AvatarURL != nil ||
		got.PasswordChangedAt != nil || got.CreatedAt != nil || got.UpdatedAt != nil {
		t.Errorf("GetByUserID() = %#v, want nil/empty optional fields", got)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
