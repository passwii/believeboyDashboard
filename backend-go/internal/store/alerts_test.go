package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
)

func TestAlertStoreGetProjectUsesReadOnlyProjectLookup(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{
		pgtype.Text{String: "operator-a、operator-b", Valid: true},
		pgtype.Text{String: "assistant-a", Valid: true},
	}}}

	project, err := NewAlertStore(db).GetProject(context.Background(), "12")
	if err != nil {
		t.Fatalf("GetProject() error = %v", err)
	}
	if project == nil || project.ProjectOperator == nil ||
		*project.ProjectOperator != "operator-a、operator-b" ||
		project.AssistantOperator == nil || *project.AssistantOperator != "assistant-a" {
		t.Errorf("GetProject() = %#v, want both operator fields", project)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := db.queryRowCalls[0].sql
	assertReadOnlySQL(t, query)
	if !contains(query, "project_operator") ||
		!contains(query, "assistant_operator") ||
		!contains(query, "where id = $1::bigint") {
		t.Errorf("SQL = %s, want project visibility fields and parameterized id", query)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{"12"})
}

func TestAlertStoreGetProjectReturnsNilWhenMissing(t *testing.T) {
	db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	project, err := NewAlertStore(db).GetProject(context.Background(), "999")
	if err != nil {
		t.Fatalf("GetProject() error = %v", err)
	}
	if project != nil {
		t.Errorf("GetProject() = %#v, want nil", project)
	}
}

func TestAlertStoreListRulesUsesParameterizedReadOnlySQL(t *testing.T) {
	projectID := "12"
	metric := "acos"
	isActive := false
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		int64(2),
		"acos high",
		int64(12),
		"US",
		"acos",
		"threshold",
		"above",
		float64(0.25),
		7,
		"warning",
		"in_app",
		false,
		"operator-a",
		createdAt,
		createdAt,
	}}}}

	rows, err := NewAlertStore(db).ListRules(context.Background(), alerts.RuleFilters{
		ProjectID: &projectID,
		Metric:    &metric,
		IsActive:  &isActive,
	})
	if err != nil {
		t.Fatalf("ListRules() error = %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("ListRules() rows = %d, want 1", len(rows))
	}
	got := rows[0]
	if got.ID != 2 || got.ProjectID != 12 || got.Metric != "acos" ||
		got.Threshold != 0.25 || got.IsActive || !got.CreatedAt.Equal(createdAt) {
		t.Errorf("ListRules() row = %#v, want persisted rule", got)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("Query() calls = %d, want 1", len(db.queryCalls))
	}
	query := db.queryCalls[0].sql
	assertReadOnlySQL(t, query)
	for _, fragment := range []string{
		"($1::bigint is null or project_id = $1::bigint)",
		"($2::text is null or metric = $2)",
		"($3::boolean is null or is_active = $3)",
		"order by created_at desc",
	} {
		if !contains(query, fragment) {
			t.Errorf("SQL = %s, want fragment %q", query, fragment)
		}
	}
	assertArgs(t, db.queryCalls[0].args, []any{&projectID, &metric, &isActive})
}

func TestAlertStoreListEventsUsesFiltersAndBoundedPagination(t *testing.T) {
	projectID := "12"
	severity := "critical"
	status := "active"
	triggeredAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	acknowledgedAt := triggeredAt.Add(time.Minute)
	db := &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{9}}},
		rows: &fakeRows{batches: [][]any{{
			int64(3),
			int64(2),
			int64(12),
			"acos",
			float64(1.2),
			float64(1),
			float64(20),
			"critical",
			"message",
			"active",
			triggeredAt,
			acknowledgedAt,
			pgtype.Text{String: "operator-a", Valid: true},
			pgtype.Float8{Float64: 0.9, Valid: true},
			pgtype.Int4{Int32: 2, Valid: true},
			pgtype.Float8{Float64: 3.5, Valid: true},
			pgtype.Text{String: "2026-10", Valid: true},
			pgtype.Int4{Int32: 4, Valid: true},
		}}},
	}

	rows, total, err := NewAlertStore(db).ListEvents(
		context.Background(),
		alerts.EventFilters{
			ProjectID: &projectID,
			Severity:  &severity,
			Status:    &status,
			Page:      2,
			PageSize:  5,
		},
	)
	if err != nil {
		t.Fatalf("ListEvents() error = %v", err)
	}
	if total != 9 || len(rows) != 1 {
		t.Fatalf("ListEvents() = total %d rows %d, want 9 and 1", total, len(rows))
	}
	got := rows[0]
	if got.ID != 3 || got.AcknowledgedAt == nil ||
		!got.AcknowledgedAt.Equal(acknowledgedAt) || got.MatchRate == nil ||
		*got.MatchRate != 0.9 || got.MismatchedItems == nil ||
		*got.MismatchedItems != 2 || got.ReportID == nil || *got.ReportID != 4 {
		t.Errorf("ListEvents() row = %#v, want persisted event", got)
	}
	if len(db.queryRowCalls) != 1 || len(db.queryCalls) != 1 {
		t.Fatalf("queries = row %d many %d, want 1 each", len(db.queryRowCalls), len(db.queryCalls))
	}
	countSQL := db.queryRowCalls[0].sql
	listSQL := db.queryCalls[0].sql
	assertReadOnlySQL(t, countSQL)
	assertReadOnlySQL(t, listSQL)
	for _, query := range []string{countSQL, listSQL} {
		for _, fragment := range []string{
			"($1::bigint is null or project_id = $1::bigint)",
			"($2::text is null or severity = $2)",
			"($3::text is null or status = $3)",
		} {
			if !contains(query, fragment) {
				t.Errorf("SQL = %s, want fragment %q", query, fragment)
			}
		}
	}
	if !contains(listSQL, "order by triggered_at desc") ||
		!contains(listSQL, "offset $4") ||
		!contains(listSQL, "limit $5") {
		t.Errorf("SQL = %s, want triggered_at desc and bounded paging", listSQL)
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{&projectID, &severity, &status})
	assertArgs(t, db.queryCalls[0].args, []any{&projectID, &severity, &status, 5, 5})
}

func TestAlertStoreListEventsReturnsEmptySlice(t *testing.T) {
	db := &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{0}}},
		rows:      &fakeRows{},
	}
	rows, total, err := NewAlertStore(db).ListEvents(
		context.Background(),
		alerts.EventFilters{Page: 1, PageSize: 20},
	)
	if err != nil {
		t.Fatalf("ListEvents() error = %v", err)
	}
	if total != 0 || rows == nil || len(rows) != 0 {
		t.Errorf("ListEvents() = total %d rows %#v, want empty non-nil slice", total, rows)
	}
}

func TestAlertStoreStatsUsesOneReadOnlyAggregate(t *testing.T) {
	projectID := "12"
	db := &fakeDB{row: fakeRow{values: []any{5, 2, 2, 1, 4, 3}}}

	got, err := NewAlertStore(db).Stats(context.Background(), &projectID, "2026-10-27")
	if err != nil {
		t.Fatalf("Stats() error = %v", err)
	}
	if got.TotalActive != 5 || got.CriticalCount != 2 || got.WarningCount != 2 ||
		got.InfoCount != 1 || got.AcknowledgedToday != 4 || got.ResolvedToday != 3 {
		t.Errorf("Stats() = %#v, want aggregate counts", got)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := db.queryRowCalls[0].sql
	assertReadOnlySQL(t, query)
	for _, fragment := range []string{
		"count(*) filter (where status = 'active')",
		"severity = 'critical'",
		"severity = 'warning'",
		"severity = 'info'",
		"acknowledged_at >= $2::date",
		"triggered_at::date = $2::date",
		"($1::bigint is null or project_id = $1::bigint)",
	} {
		if !contains(query, fragment) {
			t.Errorf("SQL = %s, want fragment %q", query, fragment)
		}
	}
	assertArgs(t, db.queryRowCalls[0].args, []any{&projectID, "2026-10-27"})
}

func TestAlertStorePropagatesErrors(t *testing.T) {
	wantErr := errors.New("database down")
	db := &fakeDB{
		row:       fakeRow{err: wantErr},
		rowsQueue: []pgx.Row{fakeRow{err: wantErr}},
		rows:      &fakeRows{err: wantErr},
	}
	store := NewAlertStore(db)
	if _, err := store.GetProject(context.Background(), "1"); !errors.Is(err, wantErr) {
		t.Errorf("GetProject() error = %v, want %v", err, wantErr)
	}
	if _, err := store.ListRules(context.Background(), alerts.RuleFilters{}); !errors.Is(err, wantErr) {
		t.Errorf("ListRules() error = %v, want %v", err, wantErr)
	}
	if _, _, err := store.ListEvents(
		context.Background(),
		alerts.EventFilters{Page: 1, PageSize: 20},
	); !errors.Is(err, wantErr) {
		t.Errorf("ListEvents() error = %v, want %v", err, wantErr)
	}
	if _, err := store.Stats(context.Background(), nil, "2026-10-27"); !errors.Is(err, wantErr) {
		t.Errorf("Stats() error = %v, want %v", err, wantErr)
	}
}
