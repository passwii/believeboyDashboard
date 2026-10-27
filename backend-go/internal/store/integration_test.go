package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestPGXIntegrationBLFTestReadsExchangeRatesAndProfile(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection for integration coverage")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}

	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	defer connection.Release()
	tx, err := connection.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatalf("BeginTx(read-only) error = %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	db := txDB{tx: tx}
	exchangeStore := NewExchangeRateStore(db)
	rows, total, err := exchangeStore.List(ctx, nil, nil, 1, 2)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if total < len(rows) {
		t.Errorf("total = %d, rows = %d, want total >= len(rows)", total, len(rows))
	}
	if len(rows) > 0 {
		if _, err := exchangeStore.Get(ctx, rows[0].ID); err != nil {
			t.Errorf("Get(%d) error = %v", rows[0].ID, err)
		}
	}
	if _, err := exchangeStore.ListOptionRows(ctx); err != nil {
		t.Errorf("ListOptionRows() error = %v", err)
	}

	profileStore := NewProfileStore(db)
	var userID string
	if err := tx.QueryRow(ctx, "select id::text from public.user_accounts limit 1").Scan(&userID); err == nil {
		if _, err := profileStore.GetByUserID(ctx, userID); err != nil {
			t.Errorf("Profile GetByUserID() error = %v", err)
		}
	} else if err != pgx.ErrNoRows {
		t.Errorf("select profile fixture error = %v", err)
	}
}

type txDB struct {
	tx pgx.Tx
}

func (db txDB) Query(ctx context.Context, sql string, args ...any) (Rows, error) {
	return db.tx.Query(ctx, sql, args...)
}

func (db txDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return db.tx.QueryRow(ctx, sql, args...)
}

func (db txDB) Ping(context.Context) error {
	return nil
}
