package store

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type mockTx struct {
	committed  bool
	rolledBack bool
	commitErr  error
}

func (m *mockTx) Commit(context.Context) error {
	m.committed = true
	return m.commitErr
}

func (m *mockTx) Rollback(context.Context) error {
	m.rolledBack = true
	return nil
}

func (m *mockTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (m *mockTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, nil
}

func (m *mockTx) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakeRow{}
}

func (m *mockTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}

func (m *mockTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}

func (m *mockTx) LargeObjects() pgx.LargeObjects {
	return pgx.LargeObjects{}
}

func (m *mockTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (m *mockTx) Conn() *pgx.Conn {
	return nil
}

func (m *mockTx) Begin(context.Context) (pgx.Tx, error) {
	return m, nil
}

type mockTransactor struct {
	tx       *mockTx
	beginErr error
}

func (m *mockTransactor) Begin(context.Context) (pgx.Tx, error) {
	if m.beginErr != nil {
		return nil, m.beginErr
	}
	return m.tx, nil
}

func TestRunInTxCommitsOnSuccess(t *testing.T) {
	tx := &mockTx{}
	txer := &mockTransactor{tx: tx}

	err := RunInTx(context.Background(), txer, func(currTx pgx.Tx) error {
		return nil
	})
	if err != nil {
		t.Fatalf("RunInTx() error = %v, want nil", err)
	}
	if !tx.committed {
		t.Error("tx.committed = false, want true")
	}
}

func TestRunInTxRollsBackOnError(t *testing.T) {
	tx := &mockTx{}
	txer := &mockTransactor{tx: tx}
	expectedErr := errors.New("business error")

	err := RunInTx(context.Background(), txer, func(currTx pgx.Tx) error {
		return expectedErr
	})
	if !errors.Is(err, expectedErr) {
		t.Fatalf("RunInTx() error = %v, want %v", err, expectedErr)
	}
	if tx.committed {
		t.Error("tx.committed = true, want false")
	}
	if !tx.rolledBack {
		t.Error("tx.rolledBack = false, want true")
	}
}

func TestRunInTxRejectsNilTransactor(t *testing.T) {
	err := RunInTx(context.Background(), nil, func(currTx pgx.Tx) error {
		return nil
	})
	if err == nil {
		t.Fatal("RunInTx(nil) error = nil, want error")
	}
}

func TestTxDBMethodsDelegateToTx(t *testing.T) {
	tx := &mockTx{}
	db := NewTxDB(tx)

	if err := db.Ping(context.Background()); err != nil {
		t.Errorf("db.Ping() error = %v", err)
	}
	tag, err := db.Exec(context.Background(), "UPDATE x SET y = 1")
	if err != nil || tag.RowsAffected() != 1 {
		t.Errorf("db.Exec() = %v, %v", tag, err)
	}
	if _, err := db.Begin(context.Background()); err != nil {
		t.Errorf("db.Begin() error = %v", err)
	}
}
