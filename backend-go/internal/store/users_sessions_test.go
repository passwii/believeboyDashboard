package store

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/users"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func TestRevokeUserSessionsRevokesRedisThenAuditsInTransaction(t *testing.T) {
	db := &stage10CProfileDB{
		row: stage10CProfileRow{values: []any{"user-123"}},
	}
	revoker := &stage10CUserSessionRevoker{count: 2}
	auditor := &stage10CUserAuditor{}
	operator := "管理员 A"

	revoked, err := revokeUserSessions(
		context.Background(),
		db,
		users.SessionRevocationInput{
			UserID:   "user-123",
			Operator: &operator,
			Revoker:  revoker,
			Auditor:  auditor,
		},
	)
	if err != nil {
		t.Fatalf("RevokeSessions() error = %v", err)
	}
	if revoked != 2 || revoker.calls != 1 || revoker.userID != "user-123" {
		t.Errorf("revoked = %d, revoker = %#v, want two target sessions", revoked, revoker)
	}
	if !db.tx.committed {
		t.Error("transaction was not committed")
	}
	if auditor.tx != db.tx {
		t.Errorf("audit tx = %#v, want same transaction %#v", auditor.tx, db.tx)
	}
	if auditor.entry.Action != "users.revoke_sessions" ||
		auditor.entry.TargetType != "user_account" ||
		auditor.entry.TargetID == nil || *auditor.entry.TargetID != "user-123" ||
		auditor.entry.Operator == nil || *auditor.entry.Operator != operator {
		t.Errorf("audit entry = %#v, want target and operator", auditor.entry)
	}
	if count, _ := auditor.entry.AfterJSON.(map[string]any)["revoked"].(int); count != 2 {
		t.Errorf("audit after = %#v, want revoked=2", auditor.entry.AfterJSON)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("query calls = %d, want one user existence check", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "user_accounts") || strings.Contains(query, "user_api_keys") {
		t.Errorf("SQL = %s, want FastAPI-compatible session-only revocation", query)
	}
}

func TestRevokeUserSessionsDoesNotFakeSuccessOnRedisFailure(t *testing.T) {
	db := &stage10CProfileDB{
		row: stage10CProfileRow{values: []any{"user-123"}},
	}
	auditor := &stage10CUserAuditor{}
	revoker := &stage10CUserSessionRevoker{err: errors.New("redis unavailable")}

	_, err := revokeUserSessions(
		context.Background(),
		db,
		users.SessionRevocationInput{
			UserID:  "user-123",
			Revoker: revoker,
			Auditor: auditor,
		},
	)
	if !errors.Is(err, users.ErrSessionRevocationUnavailable) {
		t.Fatalf("RevokeSessions() error = %v, want unavailable", err)
	}
	if !db.tx.rolledBack || db.tx.committed {
		t.Errorf("transaction = committed:%t rolled_back:%t, want rollback", db.tx.committed, db.tx.rolledBack)
	}
	if auditor.entry.Action != "" {
		t.Errorf("audit entry = %#v, want none on revocation failure", auditor.entry)
	}
}

func TestRevokeUserSessionsRollsBackAuditFailure(t *testing.T) {
	db := &stage10CProfileDB{
		row: stage10CProfileRow{values: []any{"user-123"}},
	}
	revoker := &stage10CUserSessionRevoker{count: 1}
	auditor := &stage10CUserAuditor{err: errors.New("audit unavailable")}

	_, err := revokeUserSessions(
		context.Background(),
		db,
		users.SessionRevocationInput{
			UserID:  "user-123",
			Revoker: revoker,
			Auditor: auditor,
		},
	)
	if err == nil {
		t.Fatal("RevokeSessions() error = nil, want audit failure")
	}
	if revoker.calls != 1 {
		t.Errorf("revoker calls = %d, want 1", revoker.calls)
	}
	if !db.tx.rolledBack || db.tx.committed {
		t.Errorf("transaction = committed:%t rolled_back:%t, want rollback", db.tx.committed, db.tx.rolledBack)
	}
}

func TestRevokeUserSessionsReturnsNotFoundBeforeRedis(t *testing.T) {
	db := &stage10CProfileDB{
		row: stage10CProfileRow{err: pgx.ErrNoRows},
	}
	revoker := &stage10CUserSessionRevoker{}

	_, err := revokeUserSessions(
		context.Background(),
		db,
		users.SessionRevocationInput{
			UserID:  "missing",
			Revoker: revoker,
			Auditor: &stage10CUserAuditor{},
		},
	)
	if !errors.Is(err, users.ErrUserNotFound) {
		t.Fatalf("RevokeSessions() error = %v, want not found", err)
	}
	if revoker.calls != 0 {
		t.Errorf("revoker calls = %d, want 0", revoker.calls)
	}
}

type stage10CUserSessionRevoker struct {
	count  int
	err    error
	calls  int
	userID string
}

func (revoker *stage10CUserSessionRevoker) DeleteUserSessions(
	_ context.Context,
	userID string,
) (int, error) {
	revoker.calls++
	revoker.userID = userID
	return revoker.count, revoker.err
}

type stage10CUserAuditor struct {
	tx    pgx.Tx
	entry audit.Entry
	err   error
}

func (*stage10CUserAuditor) LogAction(context.Context, audit.Entry) error {
	return nil
}

func (auditor *stage10CUserAuditor) LogActionTx(
	_ context.Context,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	auditor.tx = tx
	auditor.entry = entry
	return auditor.err
}

func (*stage10CUserAuditor) LogView(
	context.Context,
	string,
	string,
	*string,
	any,
	*http.Request,
) error {
	return nil
}
