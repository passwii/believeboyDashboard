package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/project_goals"
)

func TestProjectGoalStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()

	// 1. Admin always succeeds
	adminStore := NewProjectGoalStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	if err := adminStore.VerifyProjectAccess(ctx, 1, "any_op", true); err != nil {
		t.Fatalf("expected admin to succeed, got %v", err)
	}

	// 2. Project not found
	missingStore := NewProjectGoalStore(&fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}})
	if err := missingStore.VerifyProjectAccess(ctx, 999, "alice", false); !errors.Is(err, project_goals.ErrProjectNotFound) {
		t.Fatalf("expected ErrProjectNotFound, got %v", err)
	}

	// 3. Empty operator forbidden
	foundDB := &fakeDB{row: fakeRow{values: []any{
		stringPointer("alice, bob"),
		stringPointer("charlie"),
	}}}
	foundStore := NewProjectGoalStore(&fakeWriteDB{fakeDB: foundDB})
	if err := foundStore.VerifyProjectAccess(ctx, 1, "", false); !errors.Is(err, project_goals.ErrProjectForbidden) {
		t.Fatalf("expected ErrProjectForbidden for empty operator, got %v", err)
	}

	// 4. Authorized operator in project_operator
	if err := foundStore.VerifyProjectAccess(ctx, 1, "alice", false); err != nil {
		t.Fatalf("expected alice to be authorized, got %v", err)
	}

	// 5. Authorized operator in assistant_operator
	if err := foundStore.VerifyProjectAccess(ctx, 1, "charlie", false); err != nil {
		t.Fatalf("expected charlie to be authorized, got %v", err)
	}

	// 6. Unauthorized operator
	if err := foundStore.VerifyProjectAccess(ctx, 1, "david", false); !errors.Is(err, project_goals.ErrProjectForbidden) {
		t.Fatalf("expected david to be forbidden, got %v", err)
	}
}

func TestProjectGoalStoreCreateConflict(t *testing.T) {
	ctx := context.Background()

	conflictDB := &fakeDB{
		row: fakeRow{
			err: &pgconn.PgError{Code: "23505", Message: "duplicate key value violates unique constraint project_goals_unique_period"},
		},
	}
	store := NewProjectGoalStore(&fakeWriteDB{fakeDB: conflictDB})
	m := 3
	_, err := store.CreateGoal(ctx, project_goals.ProjectGoalCreate{
		ProjectID:    1,
		Country:      "US",
		GoalType:     "monthly",
		MetricType:   "sales_amount",
		PeriodYear:   2026,
		PeriodMonth:  &m,
		TargetAmount: 10000.0,
	})
	if !errors.Is(err, project_goals.ErrGoalConflict) {
		t.Fatalf("expected ErrGoalConflict, got %v", err)
	}
}

func TestProjectGoalStoreDaysInMonth(t *testing.T) {
	// Feb 2026 (non-leap) -> 28
	if d := daysInMonth(2026, 2); d != 28 {
		t.Errorf("Feb 2026 days = %d, want 28", d)
	}
	// Feb 2024 (leap) -> 29
	if d := daysInMonth(2024, 2); d != 29 {
		t.Errorf("Feb 2024 days = %d, want 29", d)
	}
	// Jan -> 31, Apr -> 30
	if d := daysInMonth(2026, 1); d != 31 {
		t.Errorf("Jan days = %d, want 31", d)
	}
	if d := daysInMonth(2026, 4); d != 30 {
		t.Errorf("Apr days = %d, want 30", d)
	}
}

func TestProjectGoalStoreScanItem(t *testing.T) {
	now := time.Now().UTC()
	var num pgtype.Numeric
	_ = num.Scan("15000.50")

	row := fakeRow{
		values: []any{
			int64(42),
			int64(7),
			"DE",
			"monthly",
			"sales_amount",
			2026,
			pgtype.Int4{Int32: 5, Valid: true},
			num,
			now,
			now,
		},
	}

	item, err := scanProjectGoalItem(row)
	if err != nil {
		t.Fatalf("scan error: %v", err)
	}
	if item.ID != 42 || item.ProjectID != 7 || item.Country != "DE" || item.Currency != "EUR" {
		t.Errorf("unexpected item fields: %+v", item)
	}
	if item.PeriodMonth == nil || *item.PeriodMonth != 5 {
		t.Errorf("period_month = %v, want 5", item.PeriodMonth)
	}
	if item.TargetAmount != 15000.50 {
		t.Errorf("target_amount = %f, want 15000.50", item.TargetAmount)
	}
}

func TestProjectGoalStoreRunInTx(t *testing.T) {
	ctx := context.Background()
	writeDB := &fakeWriteDB{fakeDB: &fakeDB{}}
	store := NewProjectGoalStore(writeDB)

	called := false
	err := store.RunInTx(ctx, func(_ context.Context, _ pgx.Tx, txStore project_goals.Store) error {
		called = true
		if txStore == nil {
			return errors.New("txStore is nil")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("RunInTx error: %v", err)
	}
	if !called {
		t.Fatalf("expected fn to be called inside RunInTx")
	}
}
