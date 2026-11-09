package store

import (
	"context"
	"reflect"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

type fakeWriteDB struct {
	*fakeDB
	execCalls []queryCall
	execTag   pgconn.CommandTag
	execErr   error
}

func (f *fakeWriteDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execCalls = append(f.execCalls, queryCall{sql: sql, args: args})
	return f.execTag, f.execErr
}

func (f *fakeWriteDB) Begin(_ context.Context) (pgx.Tx, error) {
	return &fakeTx{fakeWriteDB: f}, nil
}

type fakeTx struct {
	*fakeWriteDB
	committed  bool
	rolledBack bool
}

func (t *fakeTx) Commit(context.Context) error {
	t.committed = true
	return nil
}

func (t *fakeTx) Rollback(context.Context) error {
	t.rolledBack = true
	return nil
}

func (t *fakeTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}

func (t *fakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}

func (t *fakeTx) LargeObjects() pgx.LargeObjects {
	return pgx.LargeObjects{}
}

func (t *fakeTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (t *fakeTx) Conn() *pgx.Conn {
	return nil
}

type fakePgxRows struct {
	rows Rows
}

func (r fakePgxRows) Next() bool {
	if r.rows == nil {
		return false
	}
	return r.rows.Next()
}

func (r fakePgxRows) Scan(dest ...any) error {
	if r.rows == nil {
		return nil
	}
	return r.rows.Scan(dest...)
}

func (r fakePgxRows) Close() {
	if r.rows != nil {
		r.rows.Close()
	}
}

func (r fakePgxRows) Err() error {
	if r.rows == nil {
		return nil
	}
	return r.rows.Err()
}

func (r fakePgxRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r fakePgxRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r fakePgxRows) Values() ([]any, error) {
	return nil, nil
}

func (r fakePgxRows) RawValues() [][]byte {
	return nil
}

func (r fakePgxRows) Conn() *pgx.Conn {
	return nil
}

func (r fakePgxRows) TypeMap() *pgtype.Map {
	return pgtype.NewMap()
}

func (t *fakeTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := t.fakeWriteDB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return fakePgxRows{}, nil
	}
	return fakePgxRows{rows: rows}, nil
}

func (t *fakeTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return t.fakeWriteDB.QueryRow(ctx, sql, args...)
}

func (t *fakeTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return t.fakeWriteDB.Exec(ctx, sql, args...)
}

func (t *fakeTx) Begin(ctx context.Context) (pgx.Tx, error) {
	return t, nil
}

func assertWriteArgsEqual(got, want []any) bool {
	return reflect.DeepEqual(got, want)
}
