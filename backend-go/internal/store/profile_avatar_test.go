package store

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func TestProfileStoreUpdateAvatarCommitsRowAndAuditOnSameTransaction(t *testing.T) {
	newAvatarURL := "https://cdn.example.com/avatars/user-123/new.png"
	db := &stage10CProfileDB{
		row: stage10CProfileRow{values: []any{
			"user-123",
			"owner@example.com",
			"owner",
			pgtype.Text{},
			false,
			true,
			pgtype.Text{String: "operator", Valid: true},
			pgtype.Text{String: newAvatarURL, Valid: true},
			nil,
			time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
			time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC),
		}},
	}
	auditor := &stage10CProfileTxAuditor{}

	updated, err := NewProfileStore(db).UpdateAvatar(
		context.Background(),
		"user-123",
		profile.AvatarUpdateInput{
			AvatarURL: &newAvatarURL,
			Audit: profile.AvatarAudit{
				Action:     "profile.avatar.upload",
				TargetType: "user_account",
				TargetID:   stage10CProfileStringPointer("user-123"),
			},
			Auditor: auditor,
		},
	)
	if err != nil {
		t.Fatalf("UpdateAvatar() error = %v", err)
	}
	if updated == nil || updated.AvatarURL == nil || *updated.AvatarURL != newAvatarURL {
		t.Fatalf("UpdateAvatar() = %#v, want updated avatar URL", updated)
	}
	if auditor.tx != db.tx || auditor.entry.Action != "profile.avatar.upload" {
		t.Errorf("audit = tx:%#v entry:%#v, want same transaction and upload action", auditor.tx, auditor.entry)
	}
	if !db.tx.committed {
		t.Error("transaction was not committed")
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "set avatar_url = $1") ||
		!strings.Contains(query, "where id::text = $2") {
		t.Errorf("avatar SQL = %s, want parameterized URL and user filter", query)
	}
	if got, _ := db.queryRowCalls[0].args[0].(*string); got == nil || *got != newAvatarURL {
		t.Errorf("avatar arg = %#v, want %q", db.queryRowCalls[0].args[0], newAvatarURL)
	}
}

func TestProfileStoreUpdateAvatarRollsBackWhenAuditFails(t *testing.T) {
	db := &stage10CProfileDB{
		row: stage10CProfileRow{values: []any{
			"user-123",
			"owner@example.com",
			"owner",
			pgtype.Text{},
			false,
			true,
			pgtype.Text{String: "operator", Valid: true},
			pgtype.Text{},
			nil,
			nil,
			nil,
		}},
	}
	auditor := &stage10CProfileTxAuditor{err: errors.New("audit down")}

	_, err := NewProfileStore(db).UpdateAvatar(
		context.Background(),
		"user-123",
		profile.AvatarUpdateInput{Auditor: auditor},
	)
	if err == nil {
		t.Fatal("UpdateAvatar() error = nil, want audit failure")
	}
	if !db.tx.rolledBack || db.tx.committed {
		t.Errorf("transaction state = committed:%t rolled_back:%t, want rollback", db.tx.committed, db.tx.rolledBack)
	}
}

func TestProfileAvatarAuditorPopulatesRequestMetadata(t *testing.T) {
	service := audit.NewMockService()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/system-management/profile/avatar",
		nil,
	)
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	request.Header.Set("User-Agent", "stage10c-test")

	err := NewProfileAvatarAuditor(service).LogActionTx(
		context.Background(),
		nil,
		profile.AvatarAudit{
			Action:     "profile.avatar.upload",
			TargetType: "user_account",
			TargetID:   stage10CProfileStringPointer("user-123"),
			Operator:   stage10CProfileStringPointer("运营 A"),
			Request:    request,
		},
	)
	if err != nil {
		t.Fatalf("LogActionTx() error = %v", err)
	}
	if len(service.Entries) != 1 {
		t.Fatalf("audit entries = %d, want 1", len(service.Entries))
	}
	entry := service.Entries[0]
	if entry.Action != "profile.avatar.upload" ||
		entry.RequestMethod == nil || *entry.RequestMethod != http.MethodPost ||
		entry.RequestPath == nil || *entry.RequestPath != "/api/v1/system-management/profile/avatar" ||
		entry.IPAddress == nil || *entry.IPAddress != "203.0.113.9" ||
		entry.UserAgent == nil || *entry.UserAgent != "stage10c-test" {
		t.Errorf("audit entry = %#v, want populated request metadata", entry)
	}
}

type stage10CProfileTxAuditor struct {
	tx    pgx.Tx
	entry profile.AvatarAudit
	err   error
}

func (auditor *stage10CProfileTxAuditor) LogActionTx(
	_ context.Context,
	tx pgx.Tx,
	entry profile.AvatarAudit,
) error {
	auditor.tx = tx
	auditor.entry = entry
	return auditor.err
}

type stage10CProfileDB struct {
	row           pgx.Row
	tx            *stage10CProfileTx
	queryRowCalls []stage10CQueryRowCall
}

type stage10CQueryRowCall struct {
	sql  string
	args []any
}

func (db *stage10CProfileDB) Query(
	context.Context,
	string,
	...any,
) (Rows, error) {
	return nil, nil
}

func (db *stage10CProfileDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.queryRowCalls = append(db.queryRowCalls, stage10CQueryRowCall{sql: sql, args: args})
	return db.row
}

func (*stage10CProfileDB) Ping(context.Context) error {
	return nil
}

func (*stage10CProfileDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (db *stage10CProfileDB) Begin(context.Context) (pgx.Tx, error) {
	db.tx = &stage10CProfileTx{db: db}
	return db.tx, nil
}

type stage10CProfileTx struct {
	db         *stage10CProfileDB
	committed  bool
	rolledBack bool
}

func (tx *stage10CProfileTx) Begin(context.Context) (pgx.Tx, error) {
	return tx, nil
}

func (tx *stage10CProfileTx) Commit(context.Context) error {
	tx.committed = true
	return nil
}

func (tx *stage10CProfileTx) Rollback(context.Context) error {
	tx.rolledBack = true
	return nil
}

func (*stage10CProfileTx) CopyFrom(
	context.Context,
	pgx.Identifier,
	[]string,
	pgx.CopyFromSource,
) (int64, error) {
	return 0, nil
}

func (*stage10CProfileTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}

func (*stage10CProfileTx) LargeObjects() pgx.LargeObjects {
	return pgx.LargeObjects{}
}

func (*stage10CProfileTx) Prepare(
	context.Context,
	string,
	string,
) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (*stage10CProfileTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (tx *stage10CProfileTx) Query(
	context.Context,
	string,
	...any,
) (pgx.Rows, error) {
	return nil, nil
}

func (tx *stage10CProfileTx) QueryRow(
	ctx context.Context,
	sql string,
	args ...any,
) pgx.Row {
	return tx.db.QueryRow(ctx, sql, args...)
}

func (*stage10CProfileTx) Conn() *pgx.Conn {
	return nil
}

type stage10CProfileRow struct {
	values []any
	err    error
}

func (row stage10CProfileRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return errors.New("destination count mismatch")
	}
	for index, value := range row.values {
		switch target := dest[index].(type) {
		case *string:
			*target = value.(string)
		case *bool:
			*target = value.(bool)
		case *pgtype.Text:
			if value == nil {
				*target = pgtype.Text{}
			} else {
				*target = value.(pgtype.Text)
			}
		case *pgtype.Timestamptz:
			if value == nil {
				*target = pgtype.Timestamptz{}
			} else {
				*target = pgtype.Timestamptz{Time: value.(time.Time), Valid: true}
			}
		default:
			return errors.New("unsupported scan destination")
		}
	}
	return nil
}

func stage10CProfileStringPointer(value string) *string {
	return &value
}
