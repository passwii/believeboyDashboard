package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_keys"
)

func TestAPIKeyStoreCreatesHashOnlyAgentKey(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{
		int64(7),
		"bbx_12345678",
		"agent",
		"read",
		"1,2",
		"reports",
		pgtype.Text{},
		pgtype.Text{},
		false,
		nil,
		createdAt,
		nil,
		nil,
	}}}

	record, plaintext, err := NewAPIKeyStore(db).CreateAPIKey(
		context.Background(),
		internal_keys.APIKeyCreateInput{
			Label:         " agent ",
			Scope:         "read",
			ProjectScope:  "1,2",
			BusinessScope: "reports",
		},
		"admin",
	)
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	if record == nil || record.ID != 7 || record.KeyPrefix != "bbx_12345678" ||
		plaintext == "" || !strings.HasPrefix(plaintext, "bbx_") {
		t.Fatalf("CreateAPIKey() = (%#v, %q), want persisted record and bbx key", record, plaintext)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "insert into public.agent_api_keys") ||
		!strings.Contains(query, "returning") || strings.Contains(query, "$1) values") {
		t.Errorf("create SQL = %s, want insert returning stored key metadata", query)
	}
	hash := sha256.Sum256([]byte(plaintext))
	if got := db.queryRowCalls[0].args[0]; got != hex.EncodeToString(hash[:]) {
		t.Errorf("stored key_hash = %#v, want SHA-256 of plaintext", got)
	}
	for _, arg := range db.queryRowCalls[0].args {
		if arg == plaintext {
			t.Fatal("plaintext API key was passed to the database")
		}
	}
}

func TestAPIKeyStorePatchNormalizesScopesAndKeepsUntouchedFields(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 2, 3, 4, 0, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{
			int64(7),
			"bbx_12345678",
			"旧的名称",
			"read",
			"1",
			"inventory",
			pgtype.Text{String: "agent-1", Valid: true},
			pgtype.Text{String: "multica://old", Valid: true},
			false,
			nil,
			createdAt,
			nil,
			nil,
		}},
		fakeRow{values: []any{
			int64(7),
			"bbx_12345678",
			"新的名称",
			"read",
			"*",
			"shipments",
			pgtype.Text{String: "agent-1", Valid: true},
			pgtype.Text{},
			false,
			nil,
			createdAt,
			nil,
			nil,
		}},
	}}}
	label := "新的名称"
	projectScope := ""
	businessScope := "shipments"
	itemKey := ""
	record, err := NewAPIKeyStore(db).UpdateAPIKey(
		context.Background(),
		7,
		internal_keys.APIKeyUpdateInput{
			Label:         &label,
			ProjectScope:  &projectScope,
			BusinessScope: &businessScope,
			ItemKey:       &itemKey,
		},
	)
	if err != nil {
		t.Fatalf("UpdateAPIKey() error = %v", err)
	}
	if record == nil || record.Label != "新的名称" ||
		record.ProjectScope != "*" || record.BusinessScope != "shipments" ||
		record.ItemKey != nil {
		t.Fatalf("UpdateAPIKey() = %#v", record)
	}
	if len(db.queryRowCalls) != 2 {
		t.Fatalf("QueryRow calls = %d, want select + update", len(db.queryRowCalls))
	}
	updateArgs := db.queryRowCalls[1].args
	if updateArgs[0] != int64(7) || updateArgs[1] != "新的名称" ||
		updateArgs[2] != "*" || updateArgs[3] != "shipments" ||
		updateArgs[4] != (*string)(nil) {
		t.Fatalf("update args = %#v", updateArgs)
	}
}

func TestAPIKeyStorePatchRejectsSecondProvisioningHolderBeforeUpdate(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 2, 3, 4, 0, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{
			int64(7),
			"bbx_12345678",
			"other",
			"read",
			"1",
			"inventory",
			pgtype.Text{},
			pgtype.Text{},
			false,
			nil,
			createdAt,
			nil,
			nil,
		}},
		fakeRow{values: []any{true}},
	}}}
	scope := "inventory,agent_provisioning"
	_, err := NewAPIKeyStore(db).UpdateAPIKey(
		context.Background(),
		7,
		internal_keys.APIKeyUpdateInput{BusinessScope: &scope},
	)
	if !errors.Is(err, internal_keys.ErrAPIKeyUpdateConflict) {
		t.Fatalf("UpdateAPIKey() error = %v, want conflict", err)
	}
	if len(db.queryRowCalls) != 2 {
		t.Fatalf("QueryRow calls = %d, want conflict before update", len(db.queryRowCalls))
	}
}

func TestAPIKeyStoreListsAgentKeysAndCanIncludeDeleted(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		int64(7),
		"bbx_12345678",
		"agent",
		"read",
		"*",
		"*",
		pgtype.Text{String: "agent-1", Valid: true},
		pgtype.Text{},
		false,
		nil,
		createdAt,
		nil,
		nil,
	}}}}

	items, err := NewAPIKeyStore(db).ListAPIKeys(context.Background(), false)
	if err != nil {
		t.Fatalf("ListAPIKeys() error = %v", err)
	}
	if len(items) != 1 || items[0].ID != 7 ||
		items[0].AgentID == nil || *items[0].AgentID != "agent-1" ||
		items[0].DeletedAt != nil {
		t.Fatalf("ListAPIKeys() = %#v, want non-deleted metadata", items)
	}
	if !strings.Contains(strings.ToLower(db.queryCalls[0].sql), "deleted_at is null") {
		t.Errorf("list SQL = %s, want default deleted-key filter", db.queryCalls[0].sql)
	}

	db.queryCalls = nil
	db.rows = &fakeRows{}
	if _, err := NewAPIKeyStore(db).ListAPIKeys(context.Background(), true); err != nil {
		t.Fatalf("ListAPIKeys(includeDeleted=true) error = %v", err)
	}
	if strings.Contains(strings.ToLower(db.queryCalls[0].sql), "deleted_at is null") {
		t.Errorf("include-deleted SQL unexpectedly filters tombstones: %s", db.queryCalls[0].sql)
	}
}

func TestAPIKeyStoreSoftDeletesAgentKey(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{
		int64(7),
		"bbx_12345678",
		"agent",
		"read",
		"*",
		"*",
		pgtype.Text{},
		pgtype.Text{},
		false,
		nil,
		createdAt,
		nil,
		createdAt,
	}}}

	record, err := NewAPIKeyStore(db).DeleteAPIKey(context.Background(), 7)
	if err != nil {
		t.Fatalf("DeleteAPIKey() error = %v", err)
	}
	if record == nil || record.ID != 7 || record.DeletedAt == nil ||
		!record.DeletedAt.Equal(createdAt) || record.IsRevoked {
		t.Fatalf("DeleteAPIKey() = %#v, want soft-deleted record without changing revocation state", record)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "set deleted_at = coalesce(deleted_at, now())") {
		t.Errorf("delete SQL = %s, want idempotent tombstone update", query)
	}
}

func TestAPIKeyStoreRevokesAndActivatesOnlyLiveKeys(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	for _, testCase := range []struct {
		name    string
		revoked bool
		call    func(*APIKeyStore) (*internal_keys.APIKey, error)
	}{
		{
			name:    "revoke",
			revoked: true,
			call: func(store *APIKeyStore) (*internal_keys.APIKey, error) {
				return store.RevokeAPIKey(context.Background(), 7)
			},
		},
		{
			name:    "activate",
			revoked: false,
			call: func(store *APIKeyStore) (*internal_keys.APIKey, error) {
				return store.ActivateAPIKey(context.Background(), 7)
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			db := &fakeDB{row: fakeRow{values: []any{
				int64(7),
				"bbx_12345678",
				"agent",
				"read",
				"*",
				"*",
				pgtype.Text{},
				pgtype.Text{},
				testCase.revoked,
				nil,
				createdAt,
				nil,
				nil,
			}}}
			record, err := testCase.call(NewAPIKeyStore(db))
			if err != nil {
				t.Fatalf("status update error = %v", err)
			}
			if record == nil || record.ID != 7 || record.IsRevoked != testCase.revoked {
				t.Fatalf("status update = %#v, want id 7 revoked=%v", record, testCase.revoked)
			}
			query := strings.ToLower(db.queryRowCalls[0].sql)
			if !strings.Contains(query, "deleted_at is null") ||
				!strings.Contains(query, "set is_revoked = $2") {
				t.Errorf("status SQL = %s, want live-key revoke/activate update", query)
			}
			if db.queryRowCalls[0].args[1] != testCase.revoked {
				t.Errorf("is_revoked arg = %#v, want %v", db.queryRowCalls[0].args[1], testCase.revoked)
			}
		})
	}
}

func TestAPIKeyStoreCreatesHashOnlyUserKeyPerClientSlot(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{
		int64(8),
		"user-123",
		"mac-install-a",
		"blf_12345678",
		nil,
		createdAt,
	}}}

	record, plaintext, err := NewAPIKeyStore(db).CreateUserAPIKey(
		context.Background(),
		"user-123",
		"mac-install-a",
	)
	if err != nil {
		t.Fatalf("CreateUserAPIKey() error = %v", err)
	}
	if record == nil || record.ID != 8 || record.UserID != "user-123" ||
		record.ClientID != "mac-install-a" || plaintext == "" ||
		!strings.HasPrefix(plaintext, "blf_") {
		t.Fatalf("CreateUserAPIKey() = (%#v, %q), want user slot and blf key", record, plaintext)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "on conflict (user_id, client_id) do update") {
		t.Errorf("user-key SQL = %s, want slot-scoped rotation", query)
	}
	if !strings.Contains(query, "row_number() over") ||
		!strings.Contains(query, "ranked.active_count - $5") ||
		db.queryRowCalls[0].args[4] != maxActiveUserKeys {
		t.Errorf("user-key SQL/args = (%s, %#v), want five-key cap eviction", query, db.queryRowCalls[0].args)
	}
	hash := sha256.Sum256([]byte(plaintext))
	if got := db.queryRowCalls[0].args[0]; got != hex.EncodeToString(hash[:]) {
		t.Errorf("stored key_hash = %#v, want SHA-256 of plaintext", got)
	}
	for _, arg := range db.queryRowCalls[0].args {
		if arg == plaintext {
			t.Fatal("plaintext user API key was passed to the database")
		}
	}
}

func TestAPIKeyStoreListsAndRevokesUserKeys(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		int64(8),
		"user-123",
		"mac-install-a",
		"blf_12345678",
		nil,
		createdAt,
	}}}}
	items, err := NewAPIKeyStore(db).ListUserAPIKeys(context.Background())
	if err != nil {
		t.Fatalf("ListUserAPIKeys() error = %v", err)
	}
	if len(items) != 1 || items[0].UserID != "user-123" ||
		items[0].ClientID != "mac-install-a" || items[0].RevokedAt != nil {
		t.Fatalf("ListUserAPIKeys() = %#v, want one active slot", items)
	}

	db.row = fakeRow{values: []any{
		int64(8),
		"user-123",
		"mac-install-a",
		"blf_12345678",
		createdAt,
		createdAt,
	}}
	record, err := NewAPIKeyStore(db).DeleteUserAPIKey(context.Background(), 8)
	if err != nil {
		t.Fatalf("DeleteUserAPIKey() error = %v", err)
	}
	if record == nil || record.RevokedAt == nil || !record.RevokedAt.Equal(createdAt) {
		t.Fatalf("DeleteUserAPIKey() = %#v, want revoked key", record)
	}
	if !strings.Contains(strings.ToLower(db.queryRowCalls[len(db.queryRowCalls)-1].sql), "set revoked_at = coalesce(revoked_at, now())") {
		t.Errorf("delete SQL = %s, want idempotent revocation", db.queryRowCalls[len(db.queryRowCalls)-1].sql)
	}
}

func TestAPIKeyStoreRevokeReportsChangedRowsAndKeepsIdempotentMatches(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		int64(8),
		"user-123",
		"mac-install-a",
		"blf_12345678",
		createdAt,
		createdAt,
		true,
	}, {
		int64(9),
		"user-123",
		"desktop",
		"blf_87654321",
		createdAt,
		createdAt,
		false,
	}}}}
	items, err := NewAPIKeyStore(db).RevokeUserAPIKeys(context.Background(), "user-123", nil)
	if err != nil {
		t.Fatalf("RevokeUserAPIKeys() error = %v", err)
	}
	if len(items) != 2 || !items[0].RevokedNow || items[1].RevokedNow {
		t.Fatalf("RevokeUserAPIKeys() = %#v, want changed and previously revoked rows", items)
	}
	if !strings.Contains(strings.ToLower(db.queryCalls[0].sql), "prior_revoked_at is null") {
		t.Errorf("revoke SQL = %s, want previous revocation state for idempotent count", db.queryCalls[0].sql)
	}
	assertArgs(t, db.queryCalls[0].args, []any{"user-123", (*string)(nil)})
}

func TestAPIKeyStoreRotateUpdatesExistingUserSlot(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{
		int64(8),
		"user-123",
		"mac-install-a",
		"blf_12345678",
		nil,
		createdAt,
	}}}
	clientID := "mac-install-a"

	record, plaintext, err := NewAPIKeyStore(db).RotateUserAPIKey(
		context.Background(),
		"user-123",
		&clientID,
	)
	if err != nil {
		t.Fatalf("RotateUserAPIKey() error = %v", err)
	}
	if record == nil || record.ID != 8 || plaintext == "" {
		t.Fatalf("RotateUserAPIKey() = (%#v, %q), want existing slot and new key", record, plaintext)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "update public.user_api_keys") ||
		!strings.Contains(query, "where user_id = $3::uuid and client_id = $4") {
		t.Errorf("rotate SQL = %s, want existing user slot update", query)
	}
	hash := sha256.Sum256([]byte(plaintext))
	if got := db.queryRowCalls[0].args[0]; got != hex.EncodeToString(hash[:]) {
		t.Errorf("stored key_hash = %#v, want SHA-256 of plaintext", got)
	}
}
