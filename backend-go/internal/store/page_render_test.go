package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestPageRenderStoreScansOwnerRecord(t *testing.T) {
	created := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		"p1", int64(42), "Title", "markdown", "page.md", "text/markdown",
		int64(7), "key", "https://r2/key", created,
	}}}}
	items, err := NewPageRenderStore(&fakeWriteDB{fakeDB: db}).ListPages(
		context.Background(), 42, 20, 0,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != "p1" || items[0].CreatedAt != "2026-11-08T08:00:00Z" {
		t.Fatalf("items = %#v", items)
	}
	if !strings.Contains(db.queryCalls[0].sql, "owner_user_id = $1") {
		t.Errorf("SQL = %s", db.queryCalls[0].sql)
	}
}

func TestPageRenderStoreDeleteIsOwnerScoped(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{}, execTag: pgconn.NewCommandTag("DELETE 1")}
	deleted, err := NewPageRenderStore(db).DeletePage(context.Background(), "p1", 42)
	if err != nil || !deleted {
		t.Fatalf("deleted=%v err=%v", deleted, err)
	}
	if !strings.Contains(db.execCalls[0].sql, "owner_user_id = $2") {
		t.Errorf("SQL = %s", db.execCalls[0].sql)
	}
}
