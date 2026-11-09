package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

type scheduledQueryCall struct {
	sql  string
	args []any
}

type scheduledTestDB struct {
	rows           Rows
	row            pgx.Row
	rowsQueue      []pgx.Row
	rowsQueueQuery []Rows
	queryCalls     []scheduledQueryCall
	queryRowCalls  []scheduledQueryCall
	execCalls      []scheduledQueryCall
	execTag        pgconn.CommandTag
	execErr        error
}

func (db *scheduledTestDB) Query(
	_ context.Context,
	sql string,
	args ...any,
) (Rows, error) {
	db.queryCalls = append(db.queryCalls, scheduledQueryCall{sql: sql, args: args})
	if len(db.rowsQueueQuery) > 0 {
		next := db.rowsQueueQuery[0]
		db.rowsQueueQuery = db.rowsQueueQuery[1:]
		return next, nil
	}
	if db.rows == nil {
		return &scheduledTestRows{}, nil
	}
	return db.rows, nil
}

func (db *scheduledTestDB) QueryRow(
	_ context.Context,
	sql string,
	args ...any,
) pgx.Row {
	db.queryRowCalls = append(db.queryRowCalls, scheduledQueryCall{sql: sql, args: args})
	if len(db.rowsQueue) > 0 {
		next := db.rowsQueue[0]
		db.rowsQueue = db.rowsQueue[1:]
		return next
	}
	if db.row == nil {
		return scheduledTestRow{}
	}
	return db.row
}

func (*scheduledTestDB) Ping(context.Context) error { return nil }

func (db *scheduledTestDB) Exec(
	_ context.Context,
	sql string,
	args ...any,
) (pgconn.CommandTag, error) {
	db.execCalls = append(db.execCalls, scheduledQueryCall{sql: sql, args: args})
	return db.execTag, db.execErr
}

func (db *scheduledTestDB) Begin(context.Context) (pgx.Tx, error) {
	return &scheduledTestTx{db: db}, nil
}

type scheduledTestTx struct {
	db *scheduledTestDB
}

func (tx *scheduledTestTx) Begin(context.Context) (pgx.Tx, error) { return tx, nil }

func (tx *scheduledTestTx) Commit(context.Context) error { return nil }

func (*scheduledTestTx) Rollback(context.Context) error { return nil }

func (tx *scheduledTestTx) Query(
	ctx context.Context,
	sql string,
	args ...any,
) (pgx.Rows, error) {
	rows, err := tx.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scheduledPGXRows{rows: rows}, nil
}

func (tx *scheduledTestTx) QueryRow(
	ctx context.Context,
	sql string,
	args ...any,
) pgx.Row {
	return tx.db.QueryRow(ctx, sql, args...)
}

func (tx *scheduledTestTx) Exec(
	ctx context.Context,
	sql string,
	args ...any,
) (pgconn.CommandTag, error) {
	return tx.db.Exec(ctx, sql, args...)
}

func (*scheduledTestTx) CopyFrom(
	context.Context,
	pgx.Identifier,
	[]string,
	pgx.CopyFromSource,
) (int64, error) {
	return 0, nil
}

func (*scheduledTestTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}

func (*scheduledTestTx) LargeObjects() pgx.LargeObjects { return pgx.LargeObjects{} }

func (*scheduledTestTx) Prepare(
	context.Context,
	string,
	string,
) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (*scheduledTestTx) Conn() *pgx.Conn { return nil }

type scheduledTestRow struct {
	values []any
	err    error
}

func (row scheduledTestRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	return scanScheduledTestValues(dest, row.values)
}

type scheduledTestRows struct {
	batches [][]any
	index   int
	err     error
}

func (rows *scheduledTestRows) Next() bool {
	if rows.index >= len(rows.batches) {
		return false
	}
	rows.index++
	return true
}

func (rows *scheduledTestRows) Scan(dest ...any) error {
	if rows.index == 0 || rows.index > len(rows.batches) {
		return errors.New("scan called outside row")
	}
	return scanScheduledTestValues(dest, rows.batches[rows.index-1])
}

func (rows *scheduledTestRows) Err() error { return rows.err }

func (*scheduledTestRows) Close() {}

type scheduledPGXRows struct {
	rows Rows
}

func (rows scheduledPGXRows) Next() bool {
	if rows.rows == nil {
		return false
	}
	return rows.rows.Next()
}

func (rows scheduledPGXRows) Scan(dest ...any) error {
	if rows.rows == nil {
		return nil
	}
	return rows.rows.Scan(dest...)
}

func (rows scheduledPGXRows) Close() {
	if rows.rows != nil {
		rows.rows.Close()
	}
}

func (rows scheduledPGXRows) Err() error {
	if rows.rows == nil {
		return nil
	}
	return rows.rows.Err()
}

func (scheduledPGXRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }

func (scheduledPGXRows) FieldDescriptions() []pgconn.FieldDescription { return nil }

func (scheduledPGXRows) Values() ([]any, error) { return nil, nil }

func (scheduledPGXRows) RawValues() [][]byte { return nil }

func (scheduledPGXRows) Conn() *pgx.Conn { return nil }

func (scheduledPGXRows) TypeMap() *pgtype.Map { return pgtype.NewMap() }

func scanScheduledTestValues(dest, values []any) error {
	if len(dest) != len(values) {
		return fmt.Errorf("scan destination count = %d, values = %d", len(dest), len(values))
	}
	for index, value := range values {
		if value == nil {
			switch target := dest[index].(type) {
			case *string:
				*target = ""
			case **string:
				*target = nil
			case *int:
				*target = 0
			case **int:
				*target = nil
			case *int64:
				*target = 0
			case **int64:
				*target = nil
			case **time.Time:
				*target = nil
			case *pgtype.Text:
				*target = pgtype.Text{}
			case *pgtype.Timestamptz:
				*target = pgtype.Timestamptz{}
			default:
				return fmt.Errorf("unsupported nil destination %T", dest[index])
			}
			continue
		}
		switch target := dest[index].(type) {
		case *string:
			text, ok := value.(string)
			if !ok {
				return fmt.Errorf("value %T is not string", value)
			}
			*target = text
		case **string:
			switch typed := value.(type) {
			case string:
				*target = &typed
			case *string:
				*target = typed
			default:
				return fmt.Errorf("value %T is not string pointer", value)
			}
		case *int:
			switch typed := value.(type) {
			case int:
				*target = typed
			case int64:
				*target = int(typed)
			default:
				return fmt.Errorf("value %T is not int", value)
			}
		case **int:
			switch typed := value.(type) {
			case int:
				*target = &typed
			case *int:
				*target = typed
			default:
				return fmt.Errorf("value %T is not int pointer", value)
			}
		case *int64:
			switch typed := value.(type) {
			case int:
				*target = int64(typed)
			case int64:
				*target = typed
			default:
				return fmt.Errorf("value %T is not int64", value)
			}
		case **int64:
			switch typed := value.(type) {
			case int64:
				*target = &typed
			case *int64:
				*target = typed
			default:
				return fmt.Errorf("value %T is not int64 pointer", value)
			}
		case *bool:
			boolean, ok := value.(bool)
			if !ok {
				return fmt.Errorf("value %T is not bool", value)
			}
			*target = boolean
		case *time.Time:
			timestamp, ok := value.(time.Time)
			if !ok {
				return fmt.Errorf("value %T is not time.Time", value)
			}
			*target = timestamp
		case *[]byte:
			payload, ok := value.([]byte)
			if !ok {
				return fmt.Errorf("value %T is not []byte", value)
			}
			*target = payload
		default:
			if reflect.PointerTo(reflect.TypeOf(value)).AssignableTo(reflect.TypeOf(dest[index])) {
				reflect.ValueOf(dest[index]).Elem().Set(reflect.ValueOf(value))
				continue
			}
			return fmt.Errorf("unsupported scan destination %T for value %T", dest[index], value)
		}
	}
	return nil
}
