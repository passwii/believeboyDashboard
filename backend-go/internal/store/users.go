package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/users"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type UserStore struct {
	db DB
}

var (
	_ auth.Store  = (*UserStore)(nil)
	_ users.Store = (*UserStore)(nil)
)

func NewUserStore(db DB) *UserStore {
	return &UserStore{db: db}
}

func (s *UserStore) FindForLogin(
	ctx context.Context,
	email string,
	password string,
) (*auth.Account, bool, error) {
	// pgcrypto accepts bcrypt's $2a$ prefix; FastAPI may store $2b$, so verification normalizes that prefix.
	row := s.db.QueryRow(
		ctx,
		`select
		   id::text,
		   name,
		   email,
		   full_name,
		   is_admin,
		   is_active,
		   role_type,
		   password_changed_at,
		   coalesce(
		     case
		       when left(password_hash, 4) = '$2b$' then
		         crypt($2, replace(password_hash, '$2b$', '$2a$'))
		           = replace(password_hash, '$2b$', '$2a$')
		       else password_hash = crypt($2, password_hash)
		     end,
		     false
		   )
		 from public.user_accounts
		 where lower(email) = lower($1)
		 limit 1`,
		strings.ToLower(strings.TrimSpace(email)),
		password,
	)

	var (
		account           auth.Account
		fullName          pgtype.Text
		roleType          pgtype.Text
		passwordChangedAt pgtype.Timestamptz
		passwordValid     bool
	)
	if err := row.Scan(
		&account.ID,
		&account.Name,
		&account.Email,
		&fullName,
		&account.IsAdmin,
		&account.IsActive,
		&roleType,
		&passwordChangedAt,
		&passwordValid,
	); err != nil {
		if err == pgx.ErrNoRows {
			return nil, false, nil
		}
		return nil, false, err
	}
	if !passwordValid {
		return nil, false, nil
	}
	account.FullName = Text(fullName)
	if roleType.Valid {
		account.RoleType = roleType.String
	}
	account.PasswordChangedAt = timestampPointer(passwordChangedAt)
	return &account, passwordValid, nil
}

func (s *UserStore) GetByIDAndEmail(
	ctx context.Context,
	userID string,
	email string,
) (*auth.Account, error) {
	row := s.db.QueryRow(
		ctx,
		`select
		   id::text,
		   name,
		   email,
		   full_name,
		   is_admin,
		   is_active,
		   role_type,
		   password_changed_at
		 from public.user_accounts
		 where id::text = $1 and lower(email) = lower($2)
		 limit 1`,
		userID,
		strings.ToLower(strings.TrimSpace(email)),
	)
	account, err := scanAuthAccount(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &account, nil
}

func (s *UserStore) IssueUserAPIKey(
	ctx context.Context,
	userID string,
	clientID string,
) (string, error) {
	_, plaintext, err := NewAPIKeyStore(s.db).CreateUserAPIKey(ctx, userID, clientID)
	return plaintext, err
}

func (s *UserStore) List(
	ctx context.Context,
	page int,
	pageSize int,
) ([]users.User, int, error) {
	page = max(page, 1)
	pageSize = min(max(pageSize, 1), 200)
	offset := httpapi.SafeOffset(page, pageSize)

	var total int
	if err := s.db.QueryRow(
		ctx,
		`select count(*) from public.user_accounts`,
	).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := s.db.Query(
		ctx,
		`select
		   id::text,
		   name,
		   email,
		   full_name,
		   is_admin,
		   is_active,
		   role_type,
		   created_at,
		   updated_at
		 from public.user_accounts
		 order by created_at desc
		 offset $1
		 limit $2`,
		offset,
		pageSize,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]users.User, 0)
	for rows.Next() {
		item, err := scanUser(rows)
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

func (s *UserStore) GetByID(ctx context.Context, userID string) (*users.User, error) {
	row := s.db.QueryRow(
		ctx,
		`select
		   id::text,
		   name,
		   email,
		   full_name,
		   is_admin,
		   is_active,
		   role_type,
		   created_at,
		   updated_at
		 from public.user_accounts
		 where id::text = $1
		 limit 1`,
		userID,
	)
	item, err := scanUser(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *UserStore) Create(
	ctx context.Context,
	input users.CreateInput,
) (*users.User, error) {
	fullName := input.FullName
	if fullName != nil {
		normalized := strings.TrimSpace(*fullName)
		fullName = &normalized
	}
	row := s.db.QueryRow(
		ctx,
		`insert into public.user_accounts (
		   name, email, full_name, password_hash, is_admin, role_type, is_active
		 )
		 values (
		   $1, $2, $3, crypt($4, gen_salt('bf', 10)), $5, $6, true
		 )
		 returning
		   id::text,
		   name,
		   email,
		   full_name,
		   is_admin,
		   is_active,
		   role_type,
		   created_at,
		   updated_at`,
		strings.TrimSpace(input.Name),
		strings.ToLower(strings.TrimSpace(input.Email)),
		fullName,
		input.Password,
		input.IsAdmin,
		input.RoleType,
	)
	item, err := scanUser(row)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *UserStore) Update(
	ctx context.Context,
	userID string,
	input users.UpdateInput,
) (*users.User, error) {
	row := s.db.QueryRow(
		ctx,
		`with updated as (
		   update public.user_accounts
		   set
		     name = coalesce($2, name),
		     is_admin = coalesce($3, is_admin),
		     is_active = coalesce($4, is_active),
		     full_name = coalesce($5, full_name),
		     role_type = coalesce($6, role_type),
		     password_hash = case
		       when $7::text is null then password_hash
		       else crypt($7, gen_salt('bf', 10))
		     end,
		     password_changed_at = case
		       when $7::text is null then password_changed_at
		       else now()
		     end,
		     updated_at = now()
		   where id::text = $1
		   returning
		     id,
		     id::text as id_text,
		     name,
		     email,
		     full_name,
		     is_admin,
		     is_active,
		     role_type,
		     created_at,
		     updated_at
		 ), revoked as (
		   update public.user_api_keys
		   set revoked_at = now()
		   where user_id = (select id from updated)
		     and $7::text is not null
		     and revoked_at is null
		   returning id
		 )
		 select id_text, name, email, full_name, is_admin, is_active, role_type, created_at, updated_at
		 from updated`,
		userID,
		input.Name,
		input.IsAdmin,
		input.IsActive,
		input.FullName,
		input.RoleType,
		input.Password,
	)
	item, err := scanUser(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *UserStore) Deactivate(ctx context.Context, userID string) (*users.User, error) {
	row := s.db.QueryRow(
		ctx,
		`with deactivated as (
		   update public.user_accounts
		   set is_active = false, updated_at = now()
		   where id::text = $1
		   returning
		     id,
		     id::text as id_text,
		     name,
		     email,
		     full_name,
		     is_admin,
		     is_active,
		     role_type,
		     created_at,
		     updated_at
		 ), revoked as (
		   update public.user_api_keys
		   set revoked_at = now()
		   where user_id = (select id from deactivated)
		     and revoked_at is null
		   returning id
		 )
		 select
		   id_text,
		   name,
		   email,
		   full_name,
		   is_admin,
		   is_active,
		   role_type,
		   created_at,
		   updated_at
		 from deactivated`,
		userID,
	)
	item, err := scanUser(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAuthAccount(row rowScanner) (auth.Account, error) {
	var (
		account           auth.Account
		fullName          pgtype.Text
		roleType          pgtype.Text
		passwordChangedAt pgtype.Timestamptz
	)
	err := row.Scan(
		&account.ID,
		&account.Name,
		&account.Email,
		&fullName,
		&account.IsAdmin,
		&account.IsActive,
		&roleType,
		&passwordChangedAt,
	)
	if err != nil {
		return auth.Account{}, err
	}
	account.FullName = Text(fullName)
	if roleType.Valid {
		account.RoleType = roleType.String
	}
	account.PasswordChangedAt = timestampPointer(passwordChangedAt)
	return account, nil
}

func scanUser(row rowScanner) (users.User, error) {
	var (
		item     users.User
		fullName pgtype.Text
		roleType pgtype.Text
	)
	err := row.Scan(
		&item.ID,
		&item.Name,
		&item.Email,
		&fullName,
		&item.IsAdmin,
		&item.IsActive,
		&roleType,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	if err != nil {
		return users.User{}, err
	}
	item.FullName = Text(fullName)
	if roleType.Valid {
		item.RoleType = roleType.String
	}
	return item, nil
}
