package store

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_credentials"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type AgentCredentialStore struct {
	db      FullDB
	auditor audit.Service
}

var _ agent_credentials.KeyStore = (*AgentCredentialStore)(nil)

func NewAgentCredentialStore(db FullDB, auditors ...audit.Service) *AgentCredentialStore {
	var auditor audit.Service
	if len(auditors) > 0 {
		auditor = auditors[0]
	}
	return &AgentCredentialStore{db: db, auditor: auditor}
}

func NewAgentCredentialsStore(db FullDB, auditors ...audit.Service) *AgentCredentialStore {
	return NewAgentCredentialStore(db, auditors...)
}

func (store *AgentCredentialStore) ListAgentKeys(
	ctx context.Context,
) ([]agent_credentials.AgentKey, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("agent credential store database is nil")
	}
	rows, err := store.db.Query(
		ctx,
		`select id, key_prefix, label, scope, project_scope, business_scope,
		        agent_id, item_key, is_revoked, expires_at, created_at,
		        last_used_at, deleted_at
		   from public.agent_api_keys
		  where agent_id is not null
		    and deleted_at is null
		  order by created_at desc, id desc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]agent_credentials.AgentKey, 0)
	for rows.Next() {
		item, err := scanAgentCredentialKey(rows)
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

func (store *AgentCredentialStore) CreateAgentKey(
	ctx context.Context,
	input agent_credentials.AgentKeyCreateInput,
	actor agent_credentials.Actor,
	auditEntry audit.Entry,
) (*agent_credentials.AgentKey, string, error) {
	if store == nil || store.db == nil {
		return nil, "", errors.New("agent credential store database is nil")
	}
	if store.auditor == nil {
		return nil, "", agent_credentials.ErrAuditUnavailable
	}
	plaintext, keyHash, keyPrefix, err := generateKey(agentAPIKeyPrefix)
	if err != nil {
		return nil, "", err
	}
	createdBy := strings.TrimSpace(actor.AgentID)
	if createdBy == "" {
		createdBy = "agent-provisioner"
	}
	var record *agent_credentials.AgentKey
	err = RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(
			ctx,
			`select pg_advisory_xact_lock(hashtextextended($1, 0))`,
			"agent-key:"+input.AgentID,
		); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRow(
			ctx,
			`select exists (
			   select 1
			     from public.agent_api_keys
			    where agent_id = $1
			      and deleted_at is null
			      and is_revoked = false
			      and (expires_at is null or expires_at > now())
			 )`,
			input.AgentID,
		).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return agent_credentials.ErrAgentKeyExists
		}
		row := tx.QueryRow(
			ctx,
			`insert into public.agent_api_keys (
			   key_hash, key_prefix, label, scope, project_scope, business_scope,
			   expires_at, created_by, agent_id, item_key
			 )
			 values ($1, $2, $3, 'read', $4, $5, $6, $7, $8, $9)
			 returning
			   id, key_prefix, label, scope, project_scope, business_scope,
			   agent_id, item_key, is_revoked, expires_at, created_at,
			   last_used_at, deleted_at`,
			keyHash,
			keyPrefix,
			input.Label,
			input.ProjectScope,
			input.BusinessScope,
			input.ExpiresAt,
			createdBy,
			input.AgentID,
			nullableString(input.ItemKey),
		)
		created, err := scanAgentCredentialKey(row)
		if err != nil {
			return err
		}
		record = &created
		auditEntry.TargetID = int64PointerString(created.ID)
		if auditEntry.AgentID == nil {
			auditEntry.AgentID = credentialStringPtr(actor.AgentID)
		}
		if auditEntry.AgentName == nil {
			auditEntry.AgentName = credentialStringPtr(actor.Name)
		}
		if err := store.auditor.LogActionTx(ctx, tx, auditEntry); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	return record, plaintext, nil
}

func (store *AgentCredentialStore) UpdateAgentKey(
	ctx context.Context,
	id int64,
	input agent_credentials.AgentKeyUpdateInput,
	actor agent_credentials.Actor,
	auditEntry audit.Entry,
) (*agent_credentials.AgentKey, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("agent credential store database is nil")
	}
	if store.auditor == nil {
		return nil, agent_credentials.ErrAuditUnavailable
	}
	var updated *agent_credentials.AgentKey
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(
			ctx,
			`select pg_advisory_xact_lock(hashtextextended($1, 0))`,
			"agent-key:"+strconv.FormatInt(id, 10),
		); err != nil {
			return err
		}
		current, err := scanAgentCredentialKey(tx.QueryRow(
			ctx,
			`select id, key_prefix, label, scope, project_scope, business_scope,
			        agent_id, item_key, is_revoked, expires_at, created_at,
			        last_used_at, deleted_at
			   from public.agent_api_keys
			  where id = $1
			    and deleted_at is null
			  for update`,
			id,
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return agent_credentials.ErrAgentKeyNotFound
		}
		if err != nil {
			return err
		}
		if input.Label != nil {
			current.Label = *input.Label
		}
		if input.ProjectScope != nil {
			current.ProjectScope = normalizeInternalScope(*input.ProjectScope)
		}
		if input.BusinessScope != nil {
			current.BusinessScope = normalizeInternalScope(*input.BusinessScope)
		}
		if input.ItemKey != nil {
			if strings.TrimSpace(*input.ItemKey) == "" {
				current.ItemKey = nil
			} else {
				value := *input.ItemKey
				current.ItemKey = &value
			}
		}
		updatedRecord, err := scanAgentCredentialKey(tx.QueryRow(
			ctx,
			`update public.agent_api_keys
			    set label = $2,
			        project_scope = $3,
			        business_scope = $4,
			        item_key = $5
			  where id = $1
			    and deleted_at is null
			  returning id, key_prefix, label, scope, project_scope,
			            business_scope, agent_id, item_key, is_revoked,
			            expires_at, created_at, last_used_at, deleted_at`,
			id,
			current.Label,
			current.ProjectScope,
			current.BusinessScope,
			nullableString(current.ItemKey),
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return agent_credentials.ErrAgentKeyNotFound
		}
		if err != nil {
			return err
		}
		updated = &updatedRecord
		auditEntry.TargetID = int64PointerString(id)
		if auditEntry.AgentID == nil {
			auditEntry.AgentID = credentialStringPtr(actor.AgentID)
		}
		if auditEntry.AgentName == nil {
			auditEntry.AgentName = credentialStringPtr(actor.Name)
		}
		return store.auditor.LogActionTx(ctx, tx, auditEntry)
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

func (store *AgentCredentialStore) ValidateProjects(
	ctx context.Context,
	ids []int64,
) (agent_credentials.ProjectValidation, error) {
	if len(ids) == 0 {
		return agent_credentials.ProjectValidation{}, nil
	}
	if store == nil || store.db == nil {
		return agent_credentials.ProjectValidation{}, errors.New("agent credential store database is nil")
	}
	ids = uniqueSortedIDs(ids)
	rows, err := store.db.Query(
		ctx,
		`select id, coalesce(is_active, true)
		   from public.projects
		  where id = any($1)`,
		ids,
	)
	if err != nil {
		return agent_credentials.ProjectValidation{}, err
	}
	activeIDs := make(map[int64]bool, len(ids))
	for rows.Next() {
		var id int64
		var active bool
		if err := rows.Scan(&id, &active); err != nil {
			rows.Close()
			return agent_credentials.ProjectValidation{}, err
		}
		if active {
			activeIDs[id] = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return agent_credentials.ProjectValidation{}, err
	}
	rows.Close()

	validation := agent_credentials.ProjectValidation{}
	for _, id := range ids {
		if !activeIDs[id] {
			validation.InvalidIDs = append(validation.InvalidIDs, id)
		}
	}
	if len(validation.InvalidIDs) == 0 {
		return validation, nil
	}
	availableRows, err := store.db.Query(
		ctx,
		`select id
		   from public.projects
		  where coalesce(is_active, true)
		  order by id`,
	)
	if err != nil {
		return agent_credentials.ProjectValidation{}, err
	}
	defer availableRows.Close()
	for availableRows.Next() {
		var id int64
		if err := availableRows.Scan(&id); err != nil {
			return agent_credentials.ProjectValidation{}, err
		}
		validation.AvailableIDs = append(validation.AvailableIDs, id)
	}
	if err := availableRows.Err(); err != nil {
		return agent_credentials.ProjectValidation{}, err
	}
	return validation, nil
}

func (store *AgentCredentialStore) ActiveAgentKeyExists(
	ctx context.Context,
	agentID string,
) (bool, error) {
	if store == nil || store.db == nil {
		return false, errors.New("agent credential store database is nil")
	}
	var exists bool
	err := store.db.QueryRow(
		ctx,
		`select exists (
		   select 1
		     from public.agent_api_keys
		    where agent_id = $1
		      and deleted_at is null
		      and is_revoked = false
		      and (expires_at is null or expires_at > now())
		 )`,
		agentID,
	).Scan(&exists)
	return exists, err
}

func (store *AgentCredentialStore) ProjectByName(
	ctx context.Context,
	name string,
) (int64, bool, error) {
	if store == nil || store.db == nil {
		return 0, false, errors.New("agent credential store database is nil")
	}
	var id int64
	var active bool
	err := store.db.QueryRow(
		ctx,
		`select id, coalesce(is_active, true)
		   from public.projects
		  where project_name = $1
		  limit 1`,
		name,
	).Scan(&id, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return id, active, nil
}

type agentCredentialScanner interface {
	Scan(dest ...any) error
}

func scanAgentCredentialKey(row agentCredentialScanner) (agent_credentials.AgentKey, error) {
	var (
		record     agent_credentials.AgentKey
		agentID    pgtype.Text
		itemKey    pgtype.Text
		expiresAt  pgtype.Timestamptz
		lastUsedAt pgtype.Timestamptz
		deletedAt  pgtype.Timestamptz
	)
	err := row.Scan(
		&record.ID,
		&record.KeyPrefix,
		&record.Label,
		&record.Scope,
		&record.ProjectScope,
		&record.BusinessScope,
		&agentID,
		&itemKey,
		&record.IsRevoked,
		&expiresAt,
		&record.CreatedAt,
		&lastUsedAt,
		&deletedAt,
	)
	if err != nil {
		return agent_credentials.AgentKey{}, err
	}
	record.AgentID = Text(agentID)
	record.ItemKey = Text(itemKey)
	record.ExpiresAt = agentTimestampPointer(expiresAt)
	record.LastUsedAt = agentTimestampPointer(lastUsedAt)
	record.DeletedAt = agentTimestampPointer(deletedAt)
	if strings.TrimSpace(record.ProjectScope) == "" {
		record.ProjectScope = "*"
	}
	if strings.TrimSpace(record.BusinessScope) == "" {
		record.BusinessScope = "*"
	}
	return record, nil
}

func uniqueSortedIDs(ids []int64) []int64 {
	set := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id > 0 {
			set[id] = true
		}
	}
	result := make([]int64, 0, len(set))
	for id := range set {
		result = append(result, id)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func normalizeInternalScope(value string) string {
	if strings.TrimSpace(value) == "" {
		return "*"
	}
	return value
}

func nullableString(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return *value
}

func int64PointerString(value int64) *string {
	formatted := strconv.FormatInt(value, 10)
	return &formatted
}

func credentialStringPtr(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func agentTimestampPointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}
