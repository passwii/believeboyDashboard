package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB is the read-only pgx surface shared by stores and service adapters.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Ping(ctx context.Context) error
}

// Execer executes statements that do not return rows.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Transactor begins a database transaction.
type Transactor interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// FullDB combines DB, Execer, and Transactor.
type FullDB interface {
	DB
	Execer
	Transactor
}

type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

// OpenPool validates the database URL and creates a pgx connection pool.
func OpenPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(normalizeDatabaseURL(databaseURL))
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: invalid connection string")
	}
	cfg.AfterConnect = configureTimestamptzScanLocation

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open database pool: %w", err)
	}
	return pool, nil
}

func configureTimestamptzScanLocation(
	_ context.Context,
	conn *pgx.Conn,
) error {
	timezone := conn.PgConn().ParameterStatus("TimeZone")
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return fmt.Errorf("load PostgreSQL TimeZone %q: %w", timezone, err)
	}
	conn.TypeMap().RegisterType(&pgtype.Type{
		Name: "timestamptz",
		OID:  pgtype.TimestamptzOID,
		Codec: &pgtype.TimestamptzCodec{
			ScanLocation: location,
		},
	})
	return nil
}

func normalizeDatabaseURL(databaseURL string) string {
	schemeEnd := strings.Index(databaseURL, "://")
	if schemeEnd < 0 {
		return databaseURL
	}

	scheme := databaseURL[:schemeEnd]
	baseScheme, driver, found := strings.Cut(scheme, "+")
	if !found {
		return databaseURL
	}
	switch baseScheme + "+" + driver {
	case "postgresql+psycopg", "postgresql+psycopg2", "postgresql+asyncpg":
		return "postgresql" + databaseURL[len(scheme):]
	case "postgres+psycopg", "postgres+psycopg2", "postgres+asyncpg":
		return "postgres" + databaseURL[len(scheme):]
	default:
		return databaseURL
	}
}

type poolDB struct {
	pool *pgxpool.Pool
}

func NewPGXDB(pool *pgxpool.Pool) FullDB {
	if pool == nil {
		return nil
	}
	return poolDB{pool: pool}
}

func (db poolDB) Query(ctx context.Context, sql string, args ...any) (Rows, error) {
	return db.pool.Query(ctx, sql, args...)
}

func (db poolDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return db.pool.QueryRow(ctx, sql, args...)
}

func (db poolDB) Ping(ctx context.Context) error {
	return db.pool.Ping(ctx)
}

func (db poolDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return db.pool.Exec(ctx, sql, args...)
}

func (db poolDB) Begin(ctx context.Context) (pgx.Tx, error) {
	return db.pool.Begin(ctx)
}

// TxDB adapts a pgx.Tx to satisfy FullDB so stores can execute queries within an active transaction.
type TxDB struct {
	tx pgx.Tx
}

func NewTxDB(tx pgx.Tx) TxDB {
	return TxDB{tx: tx}
}

func (db TxDB) Query(ctx context.Context, sql string, args ...any) (Rows, error) {
	return db.tx.Query(ctx, sql, args...)
}

func (db TxDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return db.tx.QueryRow(ctx, sql, args...)
}

func (db TxDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return db.tx.Exec(ctx, sql, args...)
}

func (db TxDB) Ping(context.Context) error {
	return nil
}

func (db TxDB) Begin(ctx context.Context) (pgx.Tx, error) {
	return db.tx.Begin(ctx)
}

// RunInTx executes fn inside a transaction. If fn returns an error, the transaction
// is rolled back. If fn returns nil, the transaction is committed.
func RunInTx(ctx context.Context, txer Transactor, fn func(tx pgx.Tx) error) error {
	if txer == nil {
		return fmt.Errorf("transactor is nil")
	}
	tx, err := txer.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// Text converts nullable pgx text values without leaking pgtype into handlers.
func Text(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}
