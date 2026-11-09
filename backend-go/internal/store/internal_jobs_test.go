package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_jobs"
)

func TestInternalJobStoreRunInTxAndLock(t *testing.T) {
	db := &scheduledTestDB{row: scheduledTestRow{values: []any{1}}}
	store := NewInternalJobStore(db)
	called := false
	err := store.RunInTx(context.Background(), func(
		_ context.Context,
		_ pgx.Tx,
		txStore internal_jobs.Store,
	) error {
		called = true
		if txStore == nil {
			return errors.New("tx store is nil")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("RunInTx() error = %v", err)
	}
	if !called {
		t.Fatal("RunInTx callback was not called")
	}

	if err := store.AcquireJobLock(context.Background(), internal_jobs.RebuildLockKey()); err != nil {
		t.Fatalf("AcquireJobLock() error = %v", err)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("lock QueryRow calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "pg_advisory_xact_lock") ||
		db.queryRowCalls[0].args[0] != internal_jobs.RebuildLockKey() {
		t.Fatalf("lock query/args = %s %#v", query, db.queryRowCalls[0].args)
	}
}

func TestInternalJobStoreFindIdempotencyRecord(t *testing.T) {
	db := &scheduledTestDB{row: scheduledTestRow{values: []any{
		[]byte(`{"fingerprint":"fp-refresh"}`),
		[]byte(`{"rows_written":42}`),
	}}}
	record, err := NewInternalJobStore(db).FindIdempotencyRecord(
		context.Background(),
		"internal_jobs.return_analysis.refresh",
		"idem-refresh",
	)
	if err != nil {
		t.Fatalf("FindIdempotencyRecord() error = %v", err)
	}
	if record == nil || record.Fingerprint != "fp-refresh" ||
		string(record.Response) != `{"rows_written":42}` {
		t.Fatalf("record = %#v", record)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "public.operation_audit_logs") ||
		!strings.Contains(query, "result = 'success'") {
		t.Fatalf("idempotency SQL = %s", query)
	}
}
