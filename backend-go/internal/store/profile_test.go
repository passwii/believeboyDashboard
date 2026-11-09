package store

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
)

func TestProfileStoreReadsByIdTextAndScansNullableFields(t *testing.T) {
	passwordChangedAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{
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
	}}

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
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}}

	got, err := NewProfileStore(db).GetByUserID(context.Background(), "missing")
	if err != nil {
		t.Fatalf("GetByUserID() error = %v", err)
	}
	if got != nil {
		t.Fatalf("GetByUserID() = %#v, want nil", got)
	}
}

func TestProfileStoreKeepsNullRoleForHandlerFallback(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
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
	}}

	got, err := NewProfileStore(db).GetByUserID(context.Background(), "user-456")
	if err != nil {
		t.Fatalf("GetByUserID() error = %v", err)
	}
	if got.RoleType != "" || got.FullName != nil || got.AvatarURL != nil ||
		got.PasswordChangedAt != nil || got.CreatedAt != nil || got.UpdatedAt != nil {
		t.Errorf("GetByUserID() = %#v, want nil/empty optional fields", got)
	}
}

func TestProfileStoreUpdateByUserIDUsesTransactionAndAuditsChangedFields(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: []any{
			"user-123",
			"person@example.com",
			"new-login",
			pgtype.Text{},
			false,
			true,
			pgtype.Text{String: "operator", Valid: true},
			pgtype.Text{},
			nil,
			time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
			time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC),
		}},
	}}
	name := " new-login "
	operator := "operator-a"
	req := httptest.NewRequest("PATCH", "/api/v1/system-management/profile", nil)

	got, err := NewProfileStore(db).UpdateByUserID(
		context.Background(),
		"user-123",
		profile.UpdateInput{
			Name:        &name,
			SetFullName: true,
			FullName:    nil,
			Operator:    &operator,
			Request:     req,
		},
	)
	if err != nil {
		t.Fatalf("UpdateByUserID() error = %v", err)
	}
	if got == nil || got.Name != "new-login" || got.FullName != nil {
		t.Fatalf("UpdateByUserID() = %#v, want updated profile", got)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	if !contains(db.queryRowCalls[0].sql, "name = $1, full_name = $2") ||
		!contains(db.queryRowCalls[0].sql, "where id::text = $3") {
		t.Errorf("update SQL = %s, want parameterized name/full_name/user filter", db.queryRowCalls[0].sql)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{" new-login ", (*string)(nil), "user-123"})
	if len(db.execCalls) != 1 || !contains(db.execCalls[0].sql, "operation_audit_logs") {
		t.Fatalf("audit calls = %#v, want one operation_audit_logs insert", db.execCalls)
	}
	if db.execCalls[0].args[1] != "profile.update" ||
		db.execCalls[0].args[2] != "user_account" {
		t.Errorf("audit action/target = %#v, want profile.update/user_account", db.execCalls[0].args[:3])
	}
}

func TestProfileStoreUpdateByUserIDNoChangesDoesNotAudit(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: []any{
			"user-123",
			"person@example.com",
			"operator",
			pgtype.Text{String: "Operator", Valid: true},
			false,
			true,
			pgtype.Text{String: "operator", Valid: true},
			pgtype.Text{},
			nil,
			nil,
			nil,
		}},
	}}

	got, err := NewProfileStore(db).UpdateByUserID(
		context.Background(),
		"user-123",
		profile.UpdateInput{},
	)
	if err != nil {
		t.Fatalf("UpdateByUserID() error = %v", err)
	}
	if got == nil || got.ID != "user-123" {
		t.Fatalf("UpdateByUserID() = %#v, want current profile", got)
	}
	if len(db.execCalls) != 0 {
		t.Fatalf("audit calls = %#v, want none without changes", db.execCalls)
	}
}

func TestProfileStoreUpdateByUserIDRollsBackWhenAuditFails(t *testing.T) {
	db := &fakeWriteDB{
		fakeDB: &fakeDB{
			row: fakeRow{values: []any{
				"user-123",
				"person@example.com",
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
		},
		execErr: context.DeadlineExceeded,
	}
	name := "operator"

	_, err := NewProfileStore(db).UpdateByUserID(
		context.Background(),
		"user-123",
		profile.UpdateInput{Name: &name},
	)
	if err == nil {
		t.Fatal("UpdateByUserID() error = nil, want audit failure")
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
