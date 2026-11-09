package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_keys"
)

const (
	agentAPIKeyPrefix = "bbx_"
	userAPIKeyPrefix  = "blf_"
	defaultClientID   = "default"
	maxActiveUserKeys = 5
)

type APIKeyStore struct {
	db DB
}

var _ internal_keys.Store = (*APIKeyStore)(nil)

func NewAPIKeyStore(db DB) *APIKeyStore {
	return &APIKeyStore{db: db}
}

func (s *APIKeyStore) ListAPIKeys(
	ctx context.Context,
	includeDeleted bool,
) ([]internal_keys.APIKey, error) {
	query := `select
		   id, key_prefix, label, scope, project_scope, business_scope,
		   agent_id, item_key, is_revoked, expires_at, created_at,
		   last_used_at, deleted_at
		 from public.agent_api_keys`
	if !includeDeleted {
		query += ` where deleted_at is null`
	}
	query += ` order by created_at desc, id desc`

	rows, err := s.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]internal_keys.APIKey, 0)
	for rows.Next() {
		item, err := scanAPIKey(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *APIKeyStore) CreateAPIKey(
	ctx context.Context,
	input internal_keys.APIKeyCreateInput,
	operator string,
) (*internal_keys.APIKey, string, error) {
	plaintext, keyHash, keyPrefix, err := generateKey(agentAPIKeyPrefix)
	if err != nil {
		return nil, "", err
	}
	if input.Scope == "" {
		input.Scope = "read"
	}
	if input.ProjectScope == "" {
		input.ProjectScope = "*"
	}
	if input.BusinessScope == "" {
		input.BusinessScope = "*"
	}
	if strings.TrimSpace(operator) == "" {
		operator = "admin"
	}
	row := s.db.QueryRow(
		ctx,
		`insert into public.agent_api_keys (
		   key_hash, key_prefix, label, scope, project_scope, business_scope,
		   expires_at, created_by, agent_id, item_key
		 )
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 returning
		   id, key_prefix, label, scope, project_scope, business_scope,
		   agent_id, item_key, is_revoked, expires_at, created_at,
		   last_used_at, deleted_at`,
		keyHash,
		keyPrefix,
		strings.TrimSpace(input.Label),
		input.Scope,
		input.ProjectScope,
		input.BusinessScope,
		input.ExpiresAt,
		operator,
		input.AgentID,
		input.ItemKey,
	)
	record, err := scanAPIKey(row)
	if err != nil {
		return nil, "", err
	}
	return &record, plaintext, nil
}

func (s *APIKeyStore) UpdateAPIKey(
	ctx context.Context,
	id int64,
	input internal_keys.APIKeyUpdateInput,
) (*internal_keys.APIKey, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("api key store database is nil")
	}
	txer, ok := s.db.(Transactor)
	if !ok {
		return nil, errors.New("api key store database does not support transactions")
	}
	var updated *internal_keys.APIKey
	err := RunInTx(ctx, txer, func(tx pgx.Tx) error {
		current, err := scanAPIKey(tx.QueryRow(
			ctx,
			`select
			   id, key_prefix, label, scope, project_scope, business_scope,
			   agent_id, item_key, is_revoked, expires_at, created_at,
			   last_used_at, deleted_at
			 from public.agent_api_keys
			 where id = $1
			   and deleted_at is null
			 for update`,
			id,
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return internal_keys.ErrAPIKeyNotFound
		}
		if err != nil {
			return err
		}

		if input.Label != nil {
			current.Label = *input.Label
		}
		if input.ProjectScope != nil {
			current.ProjectScope = normalizeAPIKeyScope(*input.ProjectScope)
		}
		if input.BusinessScope != nil {
			current.BusinessScope = normalizeAPIKeyScope(*input.BusinessScope)
		}
		if input.ItemKey != nil {
			if strings.TrimSpace(*input.ItemKey) == "" {
				current.ItemKey = nil
			} else {
				value := *input.ItemKey
				current.ItemKey = &value
			}
		}

		if businessScopeHasProvisioning(current.BusinessScope) {
			exists, err := activeProvisioningKeyExistsTx(ctx, tx, id)
			if err != nil {
				return err
			}
			if exists {
				return internal_keys.ErrAPIKeyUpdateConflict
			}
		}

		record, err := scanAPIKey(tx.QueryRow(
			ctx,
			`update public.agent_api_keys
			    set label = $2,
			        project_scope = $3,
			        business_scope = $4,
			        item_key = $5
			  where id = $1
			    and deleted_at is null
			  returning
			    id, key_prefix, label, scope, project_scope, business_scope,
			    agent_id, item_key, is_revoked, expires_at, created_at,
			    last_used_at, deleted_at`,
			id,
			current.Label,
			current.ProjectScope,
			current.BusinessScope,
			current.ItemKey,
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return internal_keys.ErrAPIKeyNotFound
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return internal_keys.ErrAPIKeyUpdateConflict
		}
		if err != nil {
			return err
		}
		updated = &record
		return nil
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

func (s *APIKeyStore) DeleteAPIKey(
	ctx context.Context,
	id int64,
) (*internal_keys.APIKey, error) {
	row := s.db.QueryRow(
		ctx,
		`update public.agent_api_keys
		 set deleted_at = coalesce(deleted_at, now())
		 where id = $1
		 returning
		   id, key_prefix, label, scope, project_scope, business_scope,
		   agent_id, item_key, is_revoked, expires_at, created_at,
		   last_used_at, deleted_at`,
		id,
	)
	record, err := scanAPIKey(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (s *APIKeyStore) RevokeAPIKey(
	ctx context.Context,
	id int64,
) (*internal_keys.APIKey, error) {
	return s.setAPIKeyRevoked(ctx, id, true)
}

func (s *APIKeyStore) ActivateAPIKey(
	ctx context.Context,
	id int64,
) (*internal_keys.APIKey, error) {
	return s.setAPIKeyRevoked(ctx, id, false)
}

func (s *APIKeyStore) setAPIKeyRevoked(
	ctx context.Context,
	id int64,
	revoked bool,
) (*internal_keys.APIKey, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("api key store database is nil")
	}
	row := s.db.QueryRow(
		ctx,
		`update public.agent_api_keys
		 set is_revoked = $2
		 where id = $1
		   and deleted_at is null
		 returning
		   id, key_prefix, label, scope, project_scope, business_scope,
		   agent_id, item_key, is_revoked, expires_at, created_at,
		   last_used_at, deleted_at`,
		id,
		revoked,
	)
	record, err := scanAPIKey(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (s *APIKeyStore) ListUserAPIKeys(
	ctx context.Context,
) ([]internal_keys.UserAPIKey, error) {
	rows, err := s.db.Query(
		ctx,
		`select id, user_id::text, client_id, key_prefix, revoked_at, created_at
		 from public.user_api_keys
		 order by user_id, client_id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]internal_keys.UserAPIKey, 0)
	for rows.Next() {
		item, err := scanUserAPIKey(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *APIKeyStore) CreateUserAPIKey(
	ctx context.Context,
	userID string,
	clientID string,
) (*internal_keys.UserAPIKey, string, error) {
	if clientID == "" {
		clientID = defaultClientID
	}
	plaintext, keyHash, keyPrefix, err := generateKey(userAPIKeyPrefix)
	if err != nil {
		return nil, "", err
	}
	row := s.db.QueryRow(
		ctx,
		`with upserted as (
		   insert into public.user_api_keys (
		     user_id, client_id, key_hash, key_prefix, revoked_at, created_at
		   )
		   values ($3::uuid, $4, $1, $2, null, now())
		   on conflict (user_id, client_id) do update
		     set key_hash = excluded.key_hash,
		         key_prefix = excluded.key_prefix,
		         revoked_at = null,
		         created_at = now()
		   returning id, user_id, client_id, key_prefix, revoked_at, created_at
		 ), ranked as (
		   select
		     id,
		     row_number() over (order by created_at asc, id asc) as position,
		     count(*) over () as active_count
		   from (
		     select id, created_at
		     from public.user_api_keys
		     where user_id = $3::uuid
		       and revoked_at is null
		       and id <> (select id from upserted)
		     union all
		     select id, created_at from upserted
		   ) active_keys
		 ), evicted as (
		   update public.user_api_keys as keys
		   set revoked_at = now()
		   from ranked
		   where keys.id = ranked.id
		     and ranked.position <= ranked.active_count - $5
		     and keys.id <> (select id from upserted)
		   returning keys.id
		 )
		 select id, user_id::text, client_id, key_prefix, revoked_at, created_at
		 from upserted`,
		keyHash,
		keyPrefix,
		userID,
		clientID,
		maxActiveUserKeys,
	)
	record, err := scanUserAPIKey(row)
	if err != nil {
		return nil, "", err
	}
	return &record, plaintext, nil
}

func (s *APIKeyStore) DeleteUserAPIKey(
	ctx context.Context,
	id int64,
) (*internal_keys.UserAPIKey, error) {
	row := s.db.QueryRow(
		ctx,
		`update public.user_api_keys
		 set revoked_at = coalesce(revoked_at, now())
		 where id = $1
		 returning id, user_id::text, client_id, key_prefix, revoked_at, created_at`,
		id,
	)
	record, err := scanUserAPIKey(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (s *APIKeyStore) RotateUserAPIKey(
	ctx context.Context,
	userID string,
	clientID *string,
) (*internal_keys.UserAPIKey, string, error) {
	if clientID == nil {
		if txer, ok := s.db.(Transactor); ok {
			var item *internal_keys.UserAPIKey
			var plaintext string
			err := RunInTx(ctx, txer, func(tx pgx.Tx) error {
				txStore := NewAPIKeyStore(NewTxDB(tx))
				matched, err := txStore.RevokeUserAPIKeys(ctx, userID, nil)
				if err != nil {
					return err
				}
				if len(matched) == 0 {
					return nil
				}
				created, plain, err := txStore.CreateUserAPIKey(ctx, userID, defaultClientID)
				if err != nil {
					return err
				}
				item = created
				plaintext = plain
				return nil
			})
			if err != nil {
				return nil, "", err
			}
			return item, plaintext, nil
		}

		matched, err := s.RevokeUserAPIKeys(ctx, userID, nil)
		if err != nil {
			return nil, "", err
		}
		if len(matched) == 0 {
			return nil, "", nil
		}
		return s.CreateUserAPIKey(ctx, userID, defaultClientID)
	}

	plaintext, keyHash, keyPrefix, err := generateKey(userAPIKeyPrefix)
	if err != nil {
		return nil, "", err
	}
	row := s.db.QueryRow(
		ctx,
		`update public.user_api_keys
		 set key_hash = $1,
		     key_prefix = $2,
		     revoked_at = null,
		     created_at = now()
		 where user_id = $3::uuid and client_id = $4
		 returning id, user_id::text, client_id, key_prefix, revoked_at, created_at`,
		keyHash,
		keyPrefix,
		userID,
		*clientID,
	)
	record, err := scanUserAPIKey(row)
	if err == pgx.ErrNoRows {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	return &record, plaintext, nil
}

func (s *APIKeyStore) RevokeUserAPIKeys(
	ctx context.Context,
	userID string,
	clientID *string,
) ([]internal_keys.UserAPIKey, error) {
	rows, err := s.db.Query(
		ctx,
		`with matched as (
		   select id, revoked_at as prior_revoked_at
		   from public.user_api_keys
		   where user_id = $1::uuid
		     and ($2::text is null or client_id = $2)
		 ), updated as (
		   update public.user_api_keys as keys
		   set revoked_at = coalesce(keys.revoked_at, now())
		   from matched
		   where keys.id = matched.id
		   returning
		     keys.id,
		     keys.user_id::text as user_id,
		     keys.client_id,
		     keys.key_prefix,
		     keys.revoked_at,
		     keys.created_at
		 )
		 select
		   updated.id,
		   updated.user_id,
		   updated.client_id,
		   updated.key_prefix,
		   updated.revoked_at,
		   updated.created_at,
		   (matched.prior_revoked_at is null) as revoked_now
		 from updated
		 join matched on matched.id = updated.id
		 order by updated.id`,
		userID,
		clientID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]internal_keys.UserAPIKey, 0)
	for rows.Next() {
		item, err := scanRevokedUserAPIKey(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func generateKey(prefix string) (string, string, string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", "", "", fmt.Errorf("generate API key: %w", err)
	}
	plaintext := prefix + base64.RawURLEncoding.EncodeToString(random)
	digest := sha256.Sum256([]byte(plaintext))
	return plaintext, hex.EncodeToString(digest[:]), plaintext[:12], nil
}

func normalizeAPIKeyScope(value string) string {
	if strings.TrimSpace(value) == "" {
		return "*"
	}
	return value
}

func businessScopeHasProvisioning(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || value == "*" {
		return false
	}
	for _, item := range strings.Split(value, ",") {
		if strings.TrimSpace(item) == "agent_provisioning" {
			return true
		}
	}
	return false
}

func activeProvisioningKeyExistsTx(
	ctx context.Context,
	tx pgx.Tx,
	excludeID int64,
) (bool, error) {
	var exists bool
	err := tx.QueryRow(
		ctx,
		`select exists (
		   select 1
		     from public.agent_api_keys
		    where id <> $1
		      and deleted_at is null
		      and is_revoked = false
		      and (expires_at is null or expires_at > now())
		      and business_scope <> '*'
		      and exists (
		        select 1
		          from unnest(string_to_array(business_scope, ',')) as part
		         where btrim(part) = 'agent_provisioning'
		      )
		 )`,
		excludeID,
	).Scan(&exists)
	return exists, err
}

type keyRowScanner interface {
	Scan(dest ...any) error
}

func scanAPIKey(row keyRowScanner) (internal_keys.APIKey, error) {
	var (
		item       internal_keys.APIKey
		agentID    pgtype.Text
		itemKey    pgtype.Text
		expiresAt  pgtype.Timestamptz
		lastUsedAt pgtype.Timestamptz
		deletedAt  pgtype.Timestamptz
	)
	err := row.Scan(
		&item.ID,
		&item.KeyPrefix,
		&item.Label,
		&item.Scope,
		&item.ProjectScope,
		&item.BusinessScope,
		&agentID,
		&itemKey,
		&item.IsRevoked,
		&expiresAt,
		&item.CreatedAt,
		&lastUsedAt,
		&deletedAt,
	)
	if err != nil {
		return internal_keys.APIKey{}, err
	}
	item.AgentID = Text(agentID)
	item.ItemKey = Text(itemKey)
	item.ExpiresAt = timestampPointer(expiresAt)
	item.LastUsedAt = timestampPointer(lastUsedAt)
	item.DeletedAt = timestampPointer(deletedAt)
	return item, nil
}

func scanUserAPIKey(row keyRowScanner) (internal_keys.UserAPIKey, error) {
	var (
		item      internal_keys.UserAPIKey
		revokedAt pgtype.Timestamptz
		createdAt pgtype.Timestamptz
	)
	err := row.Scan(
		&item.ID,
		&item.UserID,
		&item.ClientID,
		&item.KeyPrefix,
		&revokedAt,
		&createdAt,
	)
	if err != nil {
		return internal_keys.UserAPIKey{}, err
	}
	item.RevokedAt = timestampPointer(revokedAt)
	item.CreatedAt = timestampPointer(createdAt)
	return item, nil
}

func scanRevokedUserAPIKey(row keyRowScanner) (internal_keys.UserAPIKey, error) {
	var (
		item      internal_keys.UserAPIKey
		revokedAt pgtype.Timestamptz
		createdAt pgtype.Timestamptz
	)
	if err := row.Scan(
		&item.ID,
		&item.UserID,
		&item.ClientID,
		&item.KeyPrefix,
		&revokedAt,
		&createdAt,
		&item.RevokedNow,
	); err != nil {
		return internal_keys.UserAPIKey{}, err
	}
	item.RevokedAt = timestampPointer(revokedAt)
	item.CreatedAt = timestampPointer(createdAt)
	return item, nil
}
