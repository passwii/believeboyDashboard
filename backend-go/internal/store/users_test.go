package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/users"
)

func TestUserStoreFindForLoginVerifiesBcryptAndNormalizesEmail(t *testing.T) {
	passwordChangedAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{
		"user-123",
		"operator",
		"person@example.com",
		pgtype.Text{String: "Person Name", Valid: true},
		true,
		true,
		pgtype.Text{String: "admin", Valid: true},
		passwordChangedAt,
		true,
	}}}

	account, valid, err := NewUserStore(db).FindForLogin(
		context.Background(),
		" Person@Example.com ",
		"correct horse",
	)
	if err != nil {
		t.Fatalf("FindForLogin() error = %v", err)
	}
	if !valid || account == nil || account.ID != "user-123" ||
		account.FullName == nil || *account.FullName != "Person Name" ||
		account.PasswordChangedAt == nil ||
		!account.PasswordChangedAt.Equal(passwordChangedAt) {
		t.Fatalf("FindForLogin() = (%#v, %t), want verified account", account, valid)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "crypt($2, password_hash)") {
		t.Errorf("login SQL = %s, want bcrypt-compatible crypt comparison", query)
	}
	if !strings.Contains(query, "replace(password_hash, '$2b$', '$2a$')") {
		t.Errorf("login SQL = %s, want FastAPI $2b$ bcrypt prefix compatibility", query)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{"person@example.com", "correct horse"})
}

func TestUserStoreFindForLoginTreatsMissingAndWrongPasswordAsInvalid(t *testing.T) {
	tests := []struct {
		name string
		row  pgx.Row
	}{
		{name: "missing user", row: fakeRow{err: pgx.ErrNoRows}},
		{name: "wrong password", row: fakeRow{values: []any{
			"user-123",
			"operator",
			"person@example.com",
			pgtype.Text{},
			false,
			true,
			pgtype.Text{String: "operator", Valid: true},
			nil,
			false,
		}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := &fakeDB{row: tt.row}
			account, valid, err := NewUserStore(db).FindForLogin(
				context.Background(),
				"person@example.com",
				"wrong",
			)
			if err != nil {
				t.Fatalf("FindForLogin() error = %v", err)
			}
			if account != nil || valid {
				t.Fatalf("FindForLogin() = (%#v, %t), want invalid credentials", account, valid)
			}
		})
	}
}

func TestUserStoreListUsesPaginationAndReturnsUsers(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	updatedAt := createdAt.Add(time.Hour)
	db := &fakeDB{
		row: fakeRow{values: []any{21}},
		rows: &fakeRows{batches: [][]any{{
			"user-123",
			"operator",
			"person@example.com",
			pgtype.Text{String: "Person Name", Valid: true},
			false,
			true,
			pgtype.Text{String: "operator", Valid: true},
			createdAt,
			updatedAt,
		}}},
	}

	items, total, err := NewUserStore(db).List(context.Background(), 2, 10)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if total != 21 || len(items) != 1 || items[0].ID != "user-123" ||
		items[0].FullName == nil || *items[0].FullName != "Person Name" ||
		!items[0].CreatedAt.Equal(createdAt) || !items[0].UpdatedAt.Equal(updatedAt) {
		t.Fatalf("List() = (%#v, %d), want one scanned user and total 21", items, total)
	}
	if len(db.queryRowCalls) != 1 || !strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "count(*)") {
		t.Fatalf("count query calls = %#v, want one count query", db.queryRowCalls)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("Query() calls = %d, want 1", len(db.queryCalls))
	}
	query := strings.ToLower(db.queryCalls[0].sql)
	if !strings.Contains(query, "order by created_at desc") ||
		!strings.Contains(query, "offset $1") ||
		!strings.Contains(query, "limit $2") {
		t.Errorf("list SQL = %s, want descending order with pagination", query)
	}
	assertArgs(t, db.queryCalls[0].args, []any{10, 10})
}

func TestUserStoreCreateHashesPasswordAndNormalizesInput(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{
		"user-123",
		"operator",
		"person@example.com",
		pgtype.Text{String: "Person Name", Valid: true},
		false,
		true,
		pgtype.Text{String: "operator", Valid: true},
		createdAt,
		createdAt,
	}}}

	created, err := NewUserStore(db).Create(context.Background(), createUserInputForTest())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID != "user-123" || created.Email != "person@example.com" ||
		created.FullName == nil || *created.FullName != "Person Name" {
		t.Fatalf("Create() = %#v, want normalized created user", created)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "crypt($4, gen_salt('bf', 10))") ||
		!strings.Contains(query, "returning") {
		t.Errorf("create SQL = %s, want bcrypt hash generation and returned user", query)
	}
	if got, ok := db.queryRowCalls[0].args[2].(*string); !ok || got == nil || *got != "Person Name" {
		t.Errorf("full_name arg = %#v, want trimmed Person Name", db.queryRowCalls[0].args[2])
	}
	assertArgs(t, []any{
		db.queryRowCalls[0].args[0],
		db.queryRowCalls[0].args[1],
		db.queryRowCalls[0].args[3],
		db.queryRowCalls[0].args[4],
		db.queryRowCalls[0].args[5],
	}, []any{
		"operator",
		"person@example.com",
		"correct horse",
		false,
		"operator",
	})
}

func TestUserStoreCreatePropagatesDatabaseErrors(t *testing.T) {
	wantErr := errors.New("database down")
	db := &fakeDB{row: fakeRow{err: wantErr}}

	created, err := NewUserStore(db).Create(context.Background(), createUserInputForTest())
	if !errors.Is(err, wantErr) {
		t.Fatalf("Create() error = %v, want %v", err, wantErr)
	}
	if created != nil {
		t.Fatalf("Create() = %#v, want nil on error", created)
	}
}

func TestUserStoreUpdateHashesPasswordAndRevokesExistingKeys(t *testing.T) {
	updatedAt := time.Date(2026, 10, 1, 3, 3, 4, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{
		"user-123",
		"admin",
		"person@example.com",
		pgtype.Text{},
		true,
		true,
		pgtype.Text{String: "admin", Valid: true},
		updatedAt,
		updatedAt,
	}}}
	name := "admin"
	role := "admin"
	password := "new password"

	updated, err := NewUserStore(db).Update(context.Background(), "user-123", users.UpdateInput{
		Name:     &name,
		RoleType: &role,
		Password: &password,
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated == nil || updated.Name != "admin" || !updated.IsAdmin || updated.RoleType != "admin" {
		t.Fatalf("Update() = %#v, want updated admin account", updated)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "crypt($7, gen_salt('bf', 10))") ||
		!strings.Contains(query, "update public.user_api_keys") ||
		!strings.Contains(query, "password_changed_at") {
		t.Errorf("update SQL = %s, want bcrypt hashing, password timestamp, and key revocation", query)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{
		"user-123",
		&name,
		(*bool)(nil),
		(*bool)(nil),
		(*string)(nil),
		&role,
		&password,
	})
}

func TestUserStoreDeactivateDisablesAndRevokesKeys(t *testing.T) {
	updatedAt := time.Date(2026, 10, 1, 3, 3, 4, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{
		"user-123",
		"operator",
		"person@example.com",
		pgtype.Text{},
		false,
		false,
		pgtype.Text{String: "operator", Valid: true},
		updatedAt,
		updatedAt,
	}}}

	deactivated, err := NewUserStore(db).Deactivate(context.Background(), "user-123")
	if err != nil {
		t.Fatalf("Deactivate() error = %v", err)
	}
	if deactivated == nil || deactivated.IsActive {
		t.Fatalf("Deactivate() = %#v, want inactive account", deactivated)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "set is_active = false") ||
		!strings.Contains(query, "update public.user_api_keys") ||
		!strings.Contains(query, "with deactivated as") {
		t.Errorf("deactivate SQL = %s, want atomic account disable and key revocation", query)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{"user-123"})
}

func createUserInputForTest() users.CreateInput {
	return users.CreateInput{
		Name:     " operator ",
		Email:    " Person@Example.com ",
		FullName: userTestStringPointer(" Person Name "),
		Password: "correct horse",
		IsAdmin:  false,
		RoleType: "operator",
	}
}

func userTestStringPointer(value string) *string {
	return &value
}
