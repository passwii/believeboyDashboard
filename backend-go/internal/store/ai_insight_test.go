package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func TestAIInsightStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()
	projectOperator := "alice、bob"
	assistantOperator := "carol"
	db := &fakeDB{row: fakeRow{values: []any{
		int64(7), "Project", "US", &projectOperator, &assistantOperator,
	}}}
	store := NewAIInsightStore(fakeWriteDB{fakeDB: db}.full(), audit.NewMockService())
	info, err := store.VerifyProjectAccess(ctx, 7, "bob", false)
	if err != nil || info.Name != "Project" || info.Country != "US" {
		t.Fatalf("VerifyProjectAccess() = %#v, %v", info, err)
	}
	if _, err := store.VerifyProjectAccess(ctx, 7, "david", false); !errors.Is(err, ai_insight.ErrProjectForbidden) {
		t.Fatalf("unauthorized error = %v", err)
	}
	if _, err := store.VerifyProjectAccess(ctx, 7, "", false); !errors.Is(err, ai_insight.ErrProjectForbidden) {
		t.Fatalf("empty operator error = %v", err)
	}
	db.row = fakeRow{err: pgx.ErrNoRows}
	if _, err := store.VerifyProjectAccess(ctx, 99, "alice", true); !errors.Is(err, ai_insight.ErrProjectNotFound) {
		t.Fatalf("missing project error = %v", err)
	}
}

func TestAIInsightStoreGetAndListSQLScan(t *testing.T) {
	now := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	strategy := `{"version":1}`
	rowValues := []any{
		int64(9), int64(3), "Project", "US", "Title", "# Content", "daily",
		time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC),
		"completed", (*string)(nil), (*string)(nil), &strategy, "alice", now, now,
	}
	db := &fakeDB{row: fakeRow{values: rowValues}}
	store := NewAIInsightStore(fakeWriteDB{fakeDB: db}.full(), audit.NewMockService())
	detail, err := store.GetInsight(context.Background(), 9)
	if err != nil {
		t.Fatalf("GetInsight() error = %v", err)
	}
	if detail.DateRangeStart != "2026-11-01" || detail.Content != "# Content" || detail.StrategyMetadata == nil {
		t.Fatalf("detail = %#v", detail)
	}
	if !strings.Contains(db.queryRowCalls[0].sql, "public.ai_insights") {
		t.Fatalf("query = %s", db.queryRowCalls[0].sql)
	}

	listDB := &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{2}}},
		rows: &fakeRows{batches: [][]any{
			{int64(10), int64(3), "Project", "US", "T1", "daily", time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC), "completed", (*string)(nil), (*string)(nil), "alice", now, now},
			{int64(11), int64(3), "Project", "US", "T2", "weekly", time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC), "failed", stringPointer("err"), stringPointer("boom"), "alice", now, now},
		}},
	}
	itemStore := NewAIInsightStore(fakeWriteDB{fakeDB: listDB}.full(), audit.NewMockService())
	items, total, err := itemStore.ListInsights(context.Background(), ai_insight.ListFilter{
		ProjectID: int64Pointer(3), Limit: 20, IsAdmin: true,
	})
	if err != nil || total != 2 || len(items) != 2 {
		t.Fatalf("ListInsights() items=%#v total=%d err=%v", items, total, err)
	}
	if !strings.Contains(listDB.queryCalls[0].sql, "from public.ai_insights") {
		t.Fatalf("list query = %s", listDB.queryCalls[0].sql)
	}
}

func TestAIInsightStoreScheduleAndRunSQLScan(t *testing.T) {
	now := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	cronExpression := "0 7 * * *"
	model := "test-model"
	db := &fakeDB{row: aiInsightSQLRow{values: []any{
		int64(7), int64(3), "Project", "US", "daily", cronExpression,
		"yesterday", &model, true, 4, 0, (*time.Time)(nil), pgtype.Int8{},
		(*string)(nil), (*time.Time)(nil), "alice", now, now,
	}}}
	store := NewAIInsightStore(fakeWriteDB{fakeDB: db}.full(), audit.NewMockService())
	schedule, err := store.GetSchedule(context.Background(), 7)
	if err != nil || schedule.ProjectName != "Project" || !schedule.IsActive {
		t.Fatalf("GetSchedule() = %#v, %v", schedule, err)
	}
	if !strings.Contains(db.queryRowCalls[0].sql, "public.insight_schedules") {
		t.Fatalf("query = %s", db.queryRowCalls[0].sql)
	}

	runID := "33333333-3333-4333-8333-333333333333"
	db.rowsQueue = []pgx.Row{fakeRow{values: []any{
		runID, 2, "insight", "schedule_report_summary.v1", int64(3), "US",
		"schedule_report_summary", 1, "default", "test-model", "failed",
		"generating", 30, "idem-1", strings.Repeat("a", 64),
		[]byte(`{"report.context":{}}`), []byte(`[{"status":"queued"}]`),
		[]byte(`{"input_tokens":1}`), nil, (*string)(nil),
		[]byte(`{"code":"PROVIDER_UNAVAILABLE"}`), (*int)(nil), now,
		(*time.Time)(nil), (*time.Time)(nil), now,
	}}}
	run, err := store.GetRun(context.Background(), runID)
	if err != nil || run.Status != "failed" || run.Attempt != 2 || string(run.SlotsJSON) == "" {
		t.Fatalf("GetRun() = %#v, %v", run, err)
	}
	if !strings.Contains(db.queryRowCalls[1].sql, "public.insight_runs") {
		t.Fatalf("run query = %s", db.queryRowCalls[1].sql)
	}
}

func TestAIInsightStoreCreateScheduledInsightTransaction(t *testing.T) {
	now := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	location := time.FixedZone("CST", 8*60*60)
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, location)
	end := time.Date(2026, 11, 7, 0, 0, 0, 0, location)
	model := "schedule-model"
	db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
		aiInsightSQLRow{values: []any{
			int64(7), int64(3), "US", "daily", "0 7 * * *", "last_7d",
			&model, true, 4, 0, (*time.Time)(nil), pgtype.Int8{},
			(*string)(nil), (*time.Time)(nil), "alice", now, now,
		}},
		fakeRow{values: []any{"Project"}},
		aiInsightSQLRow{values: []any{
			int64(91), int64(3), "Project", "US", "定时生成中...", "", "daily",
			start, end, "pending", (*string)(nil), (*string)(nil), (*string)(nil),
			"scheduler:7", now, now,
		}},
	}}}
	auditor := audit.NewMockService()
	store := NewAIInsightStore(db, auditor)

	generation, err := store.CreateScheduledInsight(context.Background(), 7, start, end)
	if err != nil {
		t.Fatalf("CreateScheduledInsight() error = %v", err)
	}
	if generation == nil || generation.InsightID != 91 || generation.ProjectName != "Project" {
		t.Fatalf("CreateScheduledInsight() = %#v", generation)
	}
	if generation.DateRangeStart != "2026-11-01" || generation.DateRangeEnd != "2026-11-07" {
		t.Fatalf("generation date range = %s..%s", generation.DateRangeStart, generation.DateRangeEnd)
	}
	if generation.Model == nil || *generation.Model != model {
		t.Fatalf("generation model = %#v, want %q", generation.Model, model)
	}
	if len(db.queryRowCalls) != 3 {
		t.Fatalf("query row calls = %d, want schedule/project/insert", len(db.queryRowCalls))
	}
	if !strings.Contains(db.queryRowCalls[0].sql, "for update") {
		t.Fatalf("schedule query = %s, want row lock", db.queryRowCalls[0].sql)
	}
	if !strings.Contains(db.queryRowCalls[2].sql, "insert into public.ai_insights") {
		t.Fatalf("insert query = %s", db.queryRowCalls[2].sql)
	}
	if len(db.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want schedule counter update", len(db.execCalls))
	}
	counterSQL := db.execCalls[0].sql
	for _, fragment := range []string{"last_run_at", "last_insight_id", "run_count = run_count + 1", "last_error = null"} {
		if !strings.Contains(counterSQL, fragment) {
			t.Errorf("counter SQL = %s, want %q", counterSQL, fragment)
		}
	}
	assertArgs(t, db.execCalls[0].args, []any{int64(91), int64(7)})
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "ai_insights.generate" {
		t.Fatalf("audit entries = %#v", auditor.Entries)
	}
}

func TestAIInsightStoreCreateScheduledInsightRejectsMissingOrInactive(t *testing.T) {
	now := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	start := time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)
	end := start
	tests := []struct {
		name string
		row  pgx.Row
		want error
	}{
		{
			name: "missing schedule",
			row:  fakeRow{err: pgx.ErrNoRows},
			want: ai_insight.ErrScheduleNotFound,
		},
		{
			name: "inactive schedule",
			row: aiInsightSQLRow{values: []any{
				int64(7), int64(3), "US", "daily", "0 7 * * *", "yesterday",
				(*string)(nil), false, 4, 0, (*time.Time)(nil), pgtype.Int8{},
				(*string)(nil), (*time.Time)(nil), "alice", now, now,
			}},
			want: ai_insight.ErrScheduleInactive,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{test.row}}}
			auditor := audit.NewMockService()
			store := NewAIInsightStore(db, auditor)

			_, err := store.CreateScheduledInsight(context.Background(), 7, start, end)
			if !errors.Is(err, test.want) {
				t.Fatalf("CreateScheduledInsight() error = %v, want %v", err, test.want)
			}
			if len(db.execCalls) != 0 {
				t.Fatalf("exec calls = %#v, want rollback before writes", db.execCalls)
			}
			if len(auditor.Entries) != 0 {
				t.Fatalf("audit entries = %#v, want none", auditor.Entries)
			}
		})
	}
}

func TestAIInsightStoreFailScheduleRunUpdatesCountersAndAudit(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{}}
	auditor := audit.NewMockService()
	store := NewAIInsightStore(db, auditor)

	err := store.FailScheduleRun(context.Background(), 7, 91, "provider failed")
	if err != nil {
		t.Fatalf("FailScheduleRun() error = %v", err)
	}
	if len(db.execCalls) != 2 {
		t.Fatalf("exec calls = %d, want insight + schedule updates", len(db.execCalls))
	}
	if !strings.Contains(db.execCalls[0].sql, "public.ai_insights") {
		t.Fatalf("insight SQL = %s", db.execCalls[0].sql)
	}
	if !strings.Contains(db.execCalls[1].sql, "failure_count=failure_count+1") ||
		!strings.Contains(db.execCalls[1].sql, "last_error=$1") {
		t.Fatalf("schedule SQL = %s", db.execCalls[1].sql)
	}
	assertArgs(t, db.execCalls[1].args, []any{"provider failed", int64(7)})
	if len(auditor.Entries) != 1 || auditor.Entries[0].Result != "failure" {
		t.Fatalf("audit entries = %#v", auditor.Entries)
	}
}

func TestAIInsightStoreFailScheduleRunTruncatesFieldsIndependently(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{}}
	store := NewAIInsightStore(db, audit.NewMockService())

	err := store.FailScheduleRun(context.Background(), 7, 91, strings.Repeat("x", 2100))
	if err != nil {
		t.Fatalf("FailScheduleRun() error = %v", err)
	}
	insightMessage, _ := db.execCalls[0].args[0].(string)
	scheduleMessage, _ := db.execCalls[1].args[0].(string)
	if len([]rune(insightMessage)) != 2000 {
		t.Fatalf("insight message length = %d, want 2000", len([]rune(insightMessage)))
	}
	if len([]rune(scheduleMessage)) != 500 {
		t.Fatalf("schedule message length = %d, want 500", len([]rune(scheduleMessage)))
	}
}

func TestAIInsightObservationSQLScan(t *testing.T) {
	runID := "run-1"
	status := "completed"
	duration := 1000
	totalTokens := 500
	streamBytes := 200
	streamXLen := 20
	now := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	db := &fakeDB{rows: &aiInsightSQLRows{batches: [][]any{{
		"insight_run", &runID, (*int)(nil), "insight", (*string)(nil), (*string)(nil),
		(*string)(nil), &status, (*int)(nil), &duration, (*int)(nil), (*int)(nil),
		&totalTokens, (*int)(nil), (*int)(nil), 2, 1, true, 5, &streamBytes,
		&streamXLen, (*int)(nil), false, pgtype.Bool{}, (*string)(nil),
		pgtype.Bool{}, false, (*string)(nil), now,
	}}}}
	store := NewAIInsightStore(fakeWriteDB{fakeDB: db}.full(), audit.NewMockService())
	rows, err := store.ListObservationRows(context.Background(), now.Add(-24*time.Hour), nil)
	if err != nil || len(rows) != 1 || rows[0].StreamOpens != 2 || !rows[0].ReconnectCompleted {
		t.Fatalf("ListObservationRows() = %#v, %v", rows, err)
	}
	if !strings.Contains(db.queryCalls[0].sql, "public.insight_run_observations") {
		t.Fatalf("observation query = %s", db.queryCalls[0].sql)
	}
}

func TestAIInsightDomainAggregationSQLScan(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC)
	db := &fakeDB{rows: &fakeRows{batches: [][]any{
		{time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), 10, 120.5, 4},
		{time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), 8, 90.25, 3},
	}}}
	store := NewAIInsightStore(fakeWriteDB{fakeDB: db}.full(), audit.NewMockService())
	rows, err := store.aggregateAdSales(context.Background(), 3, "US", start, end)
	if err != nil || len(rows) != 2 || rows[0]["order_qty"] != 10 {
		t.Fatalf("aggregateAdSales() = %#v, %v", rows, err)
	}
	if !strings.Contains(db.queryCalls[0].sql, "analysis_sales_order_rows") {
		t.Fatalf("sales query = %s", db.queryCalls[0].sql)
	}
}

func TestNextCronTimeUsesShanghaiClock(t *testing.T) {
	now := time.Date(2026, 11, 8, 23, 30, 0, 0, aiInsightShanghaiLocation())
	next := nextCronTime("0 7 * * *", now)
	if next == nil || next.Hour() != 7 || next.Day() != 9 {
		t.Fatalf("nextCronTime() = %v", next)
	}
}

func TestCanonicalRunJSONOutputsParse(t *testing.T) {
	run := &insight_runs.Run{OutputsJSON: []byte(`{"main":{"format":"markdown","content":"x","content_sha256":"a"}}`)}
	var outputs map[string]insight_runs.Output
	if err := json.Unmarshal(run.OutputsJSON, &outputs); err != nil || outputs["main"].Content != "x" {
		t.Fatalf("outputs=%#v err=%v", outputs, err)
	}
}

type aiInsightSQLRow struct {
	values []any
}

func (row aiInsightSQLRow) Scan(dest ...any) error {
	if len(dest) != len(row.values) {
		return errors.New("scan destination count mismatch")
	}
	for index := range dest {
		switch target := dest[index].(type) {
		case *pgtype.Int8:
			value, ok := row.values[index].(pgtype.Int8)
			if !ok {
				return errors.New("scan value is not pgtype.Int8")
			}
			*target = value
		case *pgtype.Bool:
			value, ok := row.values[index].(pgtype.Bool)
			if !ok {
				return errors.New("scan value is not pgtype.Bool")
			}
			*target = value
		default:
			if err := scanValues([]any{dest[index]}, []any{row.values[index]}); err != nil {
				return err
			}
		}
	}
	return nil
}

type aiInsightSQLRows struct {
	batches [][]any
	index   int
	closed  bool
}

func (rows *aiInsightSQLRows) Next() bool {
	if rows.index >= len(rows.batches) {
		return false
	}
	rows.index++
	return true
}

func (rows *aiInsightSQLRows) Scan(dest ...any) error {
	if rows.index == 0 || rows.index > len(rows.batches) {
		return errors.New("scan called outside row")
	}
	return aiInsightSQLRow{values: rows.batches[rows.index-1]}.Scan(dest...)
}

func (rows *aiInsightSQLRows) Err() error { return nil }
func (rows *aiInsightSQLRows) Close()     { rows.closed = true }

// full converts the shared fake database into the FullDB surface used by the
// production store while retaining the same query queues.
func (fake fakeWriteDB) full() FullDB {
	return &fake
}
