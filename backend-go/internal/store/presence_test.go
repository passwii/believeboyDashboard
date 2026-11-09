package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/presence"
)

func TestPresenceStoreScansActiveRowsAndSQL(t *testing.T) {
	lastSeen := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		"42", "运营甲", (*string)(nil), (*string)(nil),
		"/orders", "订单", lastSeen,
	}}}}
	items, err := NewPresenceStore(&fakeWriteDB{fakeDB: db}).ListActivePresence(
		context.Background(), "42", lastSeen.Add(-90*time.Second),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || !items[0].IsCurrentUser ||
		items[0].AvatarURL == nil || items[0].LastSeenAt != "2026-11-08T08:00:00Z" {
		t.Fatalf("items = %#v", items)
	}
	if !strings.Contains(db.queryCalls[0].sql, "last_seen_at >= $1") {
		t.Errorf("SQL = %s", db.queryCalls[0].sql)
	}
}

func TestPresenceStoreUpsertUsesConflictUpsert(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{}}
	err := NewPresenceStore(db).UpsertPresence(context.Background(), presence.UpsertInput{
		UserID: "42", DisplayName: "运营甲", CurrentPath: "/orders",
		CurrentPageTitle: "订单",
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(db.execCalls) != 1 || !strings.Contains(db.execCalls[0].sql, "ON CONFLICT (user_id)") {
		t.Fatalf("exec calls = %#v", db.execCalls)
	}
}
