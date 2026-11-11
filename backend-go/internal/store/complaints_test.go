package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/complaints"
)

func TestComplaintStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()

	// 1. Admin always succeeds without querying
	adminStore := NewComplaintStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	if err := adminStore.VerifyProjectAccess(ctx, 1, "any_op", true); err != nil {
		t.Fatalf("expected admin to succeed, got %v", err)
	}

	// 2. Project not found returns ErrProjectNotFound
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	missingStore := NewComplaintStore(&fakeWriteDB{fakeDB: missingDB})
	if err := missingStore.VerifyProjectAccess(ctx, 999, "alice", false); !errors.Is(err, complaints.ErrProjectNotFound) {
		t.Fatalf("expected ErrProjectNotFound, got %v", err)
	}

	// 3. Empty operator returns ErrProjectForbidden
	foundDB := &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice, bob"),
		stringPointer("charlie"),
	}}}
	foundStore := NewComplaintStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "", false); !errors.Is(err, complaints.ErrProjectForbidden) {
		t.Fatalf("expected ErrProjectForbidden for empty operator, got %v", err)
	}

	// 4. Authorized operator in project_operator succeeds
	foundDB = &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}
	foundStore = NewComplaintStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "alice", false); err != nil {
		t.Fatalf("expected alice to be allowed, got %v", err)
	}

	// 5. Authorized operator in assistant_operator succeeds
	foundDB = &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}
	foundStore = NewComplaintStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "charlie", false); err != nil {
		t.Fatalf("expected charlie to be allowed, got %v", err)
	}

	// 6. Unauthorized operator returns ErrProjectForbidden
	foundDB = &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice、bob"),
		stringPointer("charlie"),
	}}}
	foundStore = NewComplaintStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "david", false); !errors.Is(err, complaints.ErrProjectForbidden) {
		t.Fatalf("expected ErrProjectForbidden for david, got %v", err)
	}
}

func TestComplaintStoreCanTransition(t *testing.T) {
	// Legal forward transitions
	if !complaints.CanTransition("pending", "drafted") {
		t.Error("expected pending -> drafted to be legal")
	}
	if !complaints.CanTransition("drafted", "replied") {
		t.Error("expected drafted -> replied to be legal")
	}
	if !complaints.CanTransition("replied", "resolved") {
		t.Error("expected replied -> resolved to be legal")
	}
	if !complaints.CanTransition("resolved", "closed_no_response") {
		t.Error("expected resolved -> closed_no_response to be legal")
	}
	if !complaints.CanTransition("pending", "resolved") {
		t.Error("expected pending -> resolved to be legal (skipping intermediate forward)")
	}
	if !complaints.CanTransition("drafted", "drafted") {
		t.Error("expected idempotent status to be legal")
	}

	// Illegal backward transitions
	if complaints.CanTransition("resolved", "pending") {
		t.Error("expected resolved -> pending to be illegal")
	}
	if complaints.CanTransition("replied", "drafted") {
		t.Error("expected replied -> drafted to be illegal")
	}
	if complaints.CanTransition("closed_no_response", "resolved") {
		t.Error("expected closed_no_response -> resolved to be illegal")
	}
	if complaints.CanTransition("invalid", "pending") {
		t.Error("expected invalid from_status to be illegal")
	}
	if complaints.CanTransition("pending", "invalid") {
		t.Error("expected invalid to_status to be illegal")
	}
}

func TestComplaintStoreSlaLevel(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)

	// Closed statuses are always closed
	if lvl := slaLevel("replied", nil, now); lvl != "closed" {
		t.Errorf("expected closed, got %s", lvl)
	}
	if lvl := slaLevel("resolved", nil, now); lvl != "closed" {
		t.Errorf("expected closed, got %s", lvl)
	}

	// Nil or empty SLA
	if lvl := slaLevel("pending", nil, now); lvl != "ok" {
		t.Errorf("expected ok for nil SLA, got %s", lvl)
	}

	// Overdue
	overdueTime := now.Add(-1 * time.Hour).Format(time.RFC3339)
	if lvl := slaLevel("pending", &complaints.SlaInfo{ReplyDeadline: &overdueTime}, now); lvl != "overdue" {
		t.Errorf("expected overdue, got %s", lvl)
	}

	// Due soon (< 24h)
	dueSoonTime := now.Add(12 * time.Hour).Format(time.RFC3339)
	if lvl := slaLevel("pending", &complaints.SlaInfo{ReplyDeadline: &dueSoonTime}, now); lvl != "due_soon" {
		t.Errorf("expected due_soon, got %s", lvl)
	}

	// OK (> 24h)
	okTime := now.Add(48 * time.Hour).Format(time.RFC3339)
	if lvl := slaLevel("pending", &complaints.SlaInfo{ReplyDeadline: &okTime}, now); lvl != "ok" {
		t.Errorf("expected ok, got %s", lvl)
	}
}

func TestComplaintStorePatchStatusTransitionValidation(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	triageJSON := `{"category":"with_order","has_order":true,"summary_zh":"test"}`
	historyJSON := `[]`
	messagesJSON := `[]`

	// Complaint currently "resolved"
	db := &fakeWriteDB{
		fakeDB: &fakeDB{
			row: fakeRow{values: []any{
				int64(1), int64(10), int64(1), "Shop A", "US",
				"Buyer", "2026-11-01", "2026-11-01",
				"Subject", "with_order", true, "resolved",
				&triageJSON, nil, nil, &historyJSON,
				nil, &now, nil,
				1, "Body", &messagesJSON, &now, &now,
			}},
		},
	}
	store := NewComplaintStore(db)

	// Try backwards transition to "pending"
	statusPending := "pending"
	_, err := store.PatchComplaint(ctx, 1, complaints.ComplaintPatchRequest{Status: &statusPending}, "op")
	if err == nil || !strings.Contains(err.Error(), "非法状态流转") {
		t.Fatalf("expected illegal transition error, got %v", err)
	}
}

func TestComplaintStoreGetOverviewMissingRunReturnsZeros(t *testing.T) {
	ctx := context.Background()
	db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store := NewComplaintStore(&fakeWriteDB{fakeDB: db})

	resp, err := store.GetOverview(ctx, "2026-11-07", nil)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if resp.Date != "2026-11-07" || resp.Metrics.TotalNeedsReply != 0 || len(resp.Projects) != 0 || len(resp.Trend) != 0 {
		t.Fatalf("unexpected empty overview: %#v", resp)
	}
}

func stringPointer(s string) *string {
	return &s
}

func TestComplaintStorePatchInvalidReplySentAtReturns400(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	triageJSON := `{"primary_category":"product_issue"}`
	historyJSON := `[]`
	messagesJSON := `[]`

	db := &fakeWriteDB{
		fakeDB: &fakeDB{
			row: fakeRow{values: []any{
				int64(1), int64(10), int64(1), "Shop A", "US",
				"Buyer", "2026-11-01", "2026-11-01",
				"Subject", "with_order", true, "pending",
				&triageJSON, nil, nil, &historyJSON,
				nil, &now, nil,
				1, "Body", &messagesJSON, &now, &now,
			}},
		},
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	store := NewComplaintStore(db)

	badTime := "not-a-valid-time"
	_, err := store.PatchComplaint(ctx, 1, complaints.ComplaintPatchRequest{ReplySentAt: &badTime}, "op")
	if err == nil || !strings.Contains(err.Error(), "reply_sent_at 时间格式无效") {
		t.Fatalf("expected 400 invalid time format error, got: %v", err)
	}
}

func TestComplaintStorePatchConcurrentConflictReturns409(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	triageJSON := `{"primary_category":"product_issue"}`
	historyJSON := `[]`
	messagesJSON := `[]`

	// DB returns UPDATE 0 to simulate concurrent update collision
	db := &fakeWriteDB{
		fakeDB: &fakeDB{
			row: fakeRow{values: []any{
				int64(1), int64(10), int64(1), "Shop A", "US",
				"Buyer", "2026-11-01", "2026-11-01",
				"Subject", "with_order", true, "pending",
				&triageJSON, nil, nil, &historyJSON,
				nil, &now, nil,
				1, "Body", &messagesJSON, &now, &now,
			}},
		},
		execTag: pgconn.NewCommandTag("UPDATE 0"),
	}
	store := NewComplaintStore(db)

	statusDrafted := "drafted"
	_, err := store.PatchComplaint(ctx, 1, complaints.ComplaintPatchRequest{Status: &statusDrafted}, "op")
	if err == nil || !strings.Contains(err.Error(), "409") || !strings.Contains(err.Error(), "并发修改") {
		t.Fatalf("expected 409 conflict error on concurrent collision, got: %v", err)
	}
}
