package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestUserKeyStoreResolvesKeyHashAndNullableRevocation(t *testing.T) {
	db := &fakeDB{
		row: fakeRow{
			values: []any{
				"user-123",
				nil,
				"person@example.com",
				"Person Name",
				"operator",
				false,
			},
		},
	}
	store := NewUserKeyStore(db)

	got, err := store.ResolveUserKey(context.Background(), "hash-123")
	if err != nil {
		t.Fatalf("ResolveUserKey() error = %v", err)
	}
	if got == nil || got.UserID != "user-123" || got.RevokedAt != nil ||
		got.Email != "person@example.com" || got.FullName != "Person Name" ||
		got.RoleType != "operator" || got.IsAdmin {
		t.Fatalf("ResolveUserKey() = %#v, want user identity with nil revoked_at", got)
	}
	if len(db.queryRowCalls) != 1 || db.queryRowCalls[0].sql == "" {
		t.Fatal("QueryRow() sql is empty")
	}
	if !strings.Contains(db.queryRowCalls[0].sql, "user_accounts") ||
		!strings.Contains(db.queryRowCalls[0].sql, "full_name") {
		t.Fatal("QueryRow() must resolve user identity from user_accounts")
	}
	if len(db.queryRowCalls[0].args) != 1 || db.queryRowCalls[0].args[0] != "hash-123" {
		t.Errorf("QueryRow() args = %#v, want [hash-123]", db.queryRowCalls[0].args)
	}
}

func TestUserKeyStoreReturnsRevokedAt(t *testing.T) {
	revokedAt := time.Date(2026, 10, 27, 8, 0, 0, 0, time.UTC)
	db := &fakeDB{
		row: fakeRow{
			values: []any{
				"user-456",
				revokedAt,
				"revoked@example.com",
				"Revoked User",
				"admin",
				true,
			},
		},
	}

	got, err := NewUserKeyStore(db).ResolveUserKey(context.Background(), "hash-456")
	if err != nil {
		t.Fatalf("ResolveUserKey() error = %v", err)
	}
	if got == nil || got.RevokedAt == nil || !got.RevokedAt.Equal(revokedAt) {
		t.Fatalf("ResolveUserKey() = %#v, want revoked_at %s", got, revokedAt)
	}
}

func TestUserKeyStoreReturnsNilForUnknownHash(t *testing.T) {
	db := &fakeDB{
		row: fakeRow{err: pgx.ErrNoRows},
	}

	got, err := NewUserKeyStore(db).ResolveUserKey(context.Background(), "unknown")
	if err != nil {
		t.Fatalf("ResolveUserKey() error = %v", err)
	}
	if got != nil {
		t.Fatalf("ResolveUserKey() = %#v, want nil", got)
	}
}

func TestUserKeyStorePropagatesDatabaseError(t *testing.T) {
	wantErr := errors.New("database down")
	db := &fakeDB{
		row: fakeRow{err: wantErr},
	}

	got, err := NewUserKeyStore(db).ResolveUserKey(context.Background(), "hash")
	if !errors.Is(err, wantErr) {
		t.Fatalf("ResolveUserKey() error = %v, want %v", err, wantErr)
	}
	if got != nil {
		t.Fatalf("ResolveUserKey() = %#v, want nil", got)
	}
}

func TestFakeRowsNextReturnsFalseAfterOneBatch(t *testing.T) {
	rows := &fakeRows{batches: [][]any{{0}}}
	if !rows.Next() {
		t.Fatal("first Next() = false, want true")
	}
	if rows.Next() {
		t.Fatal("second Next() = true, want false")
	}
}
