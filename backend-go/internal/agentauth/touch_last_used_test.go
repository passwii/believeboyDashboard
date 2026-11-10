package agentauth

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type touchLastUsedDB struct {
	query string
	args  []any
}

func (db *touchLastUsedDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return nil
}

func (db *touchLastUsedDB) Exec(_ context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	db.query = query
	db.args = args
	return pgconn.CommandTag{}, nil
}

// Regression: without an explicit timestamptz cast, pgx's parameter inference
// produced "operator does not exist: timestamp with time zone <= interval" and
// every first use of an agent key failed with 401 token_invalid.
func TestTouchLastUsedUsesExplicitTimestamptzCast(t *testing.T) {
	db := &touchLastUsedDB{}
	store := NewPGXCredentialStore(db)
	at := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	if err := store.TouchLastUsed(context.Background(), 7, at); err != nil {
		t.Fatalf("TouchLastUsed() error = %v", err)
	}
	if count := strings.Count(db.query, "::timestamptz"); count != 2 {
		t.Fatalf("query has %d timestamptz casts, want 2: %s", count, db.query)
	}
	if len(db.args) != 2 || db.args[0] != int64(7) {
		t.Fatalf("unexpected args: %#v", db.args)
	}
}
