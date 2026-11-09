package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inspections"
)

func TestInspectionStoreVerifyProjectAccessChecksExistenceAndOperators(t *testing.T) {
	ctx := context.Background()
	db := &inspectionFakeDB{
		row: inspectionFakeRow{values: []any{"owner, alice", "assistant"}},
	}
	store := NewInspectionStore(db)

	if err := store.VerifyProjectAccess(ctx, 7, "alice", false); err != nil {
		t.Fatalf("VerifyProjectAccess(owner) = %v", err)
	}
	if len(db.queryRowCalls) != 1 ||
		!strings.Contains(db.queryRowCalls[0].sql, "from public.projects") {
		t.Fatalf("project access SQL = %#v", db.queryRowCalls)
	}
	if err := store.VerifyProjectAccess(ctx, 7, "bob", false); !errors.Is(err, inspections.ErrProjectForbidden) {
		t.Fatalf("VerifyProjectAccess(other) = %v, want forbidden", err)
	}
	db.row = inspectionFakeRow{values: []any{"owner alice", "assistant"}}
	if err := store.VerifyProjectAccess(ctx, 7, "alice", false); !errors.Is(err, inspections.ErrProjectForbidden) {
		t.Fatalf("space-separated operator was split: %v", err)
	}
	db.row = inspectionFakeRow{values: []any{"owner, alice", "assistant"}}
	if err := store.VerifyProjectAccess(ctx, 7, "", false); !errors.Is(err, inspections.ErrProjectForbidden) {
		t.Fatalf("VerifyProjectAccess(empty) = %v, want forbidden", err)
	}
	if err := store.VerifyProjectAccess(ctx, 7, "", true); err != nil {
		t.Fatalf("VerifyProjectAccess(admin) = %v", err)
	}

	db.row = inspectionFakeRow{err: pgx.ErrNoRows}
	if err := store.VerifyProjectAccess(ctx, 99, "alice", true); !errors.Is(err, inspections.ErrProjectNotFound) {
		t.Fatalf("admin missing project = %v, want not found", err)
	}
}

func TestInspectionStoreGetReportUsesUSScopeAndLoadsScreenshots(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	db := &inspectionFakeDB{
		row: inspectionFakeRow{values: []any{
			int64(9), int64(4), int64(7), "draft",
			`{"account_health_rating":"Good","negative_feedback":1}`,
			`{"ip_infringement":1}`,
			nil, nil, nil,
			now, now, "North",
		}},
		rowsQueueQuery: []Rows{
			&inspectionFakeRows{batches: [][]any{{
				int64(12), int64(9), "inspection-screenshots/north/report_9/a.png",
				nil, "shot.png", "image/png", int64(8), nil, int64(0), now,
			}}},
		},
	}
	store := NewInspectionStore(db)

	report, err := store.GetReport(context.Background(), 4, 7)
	if err != nil {
		t.Fatalf("GetReport() error = %v", err)
	}
	if report == nil {
		t.Fatal("GetReport() = nil")
	}
	if report.ID != 9 || report.ProjectName != "North" || report.HealthData == nil ||
		report.HealthData.NegativeFeedback == nil || *report.HealthData.NegativeFeedback != 1 {
		t.Fatalf("GetReport() = %#v", report)
	}
	if len(report.Screenshots) != 1 || report.Screenshots[0].Filename != "shot.png" {
		t.Fatalf("screenshots = %#v", report.Screenshots)
	}
	if len(db.queryRowCalls) != 1 ||
		!strings.Contains(db.queryRowCalls[0].sql, "r.country = 'US'") {
		t.Fatalf("report SQL = %#v", db.queryRowCalls)
	}
	if got := db.queryRowCalls[0].args; len(got) != 2 || got[0] != int64(4) || got[1] != int64(7) {
		t.Fatalf("report args = %#v", got)
	}
}

func TestInspectionStorePeriodQueriesUseRealTableAndPagination(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	weekStart := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	weekEnd := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	db := &inspectionFakeDB{
		row: inspectionFakeRow{values: []any{int64(1)}},
		rowsQueueQuery: []Rows{&inspectionFakeRows{batches: [][]any{{
			int64(4), weekStart, weekEnd, now, now,
		}}}},
	}
	store := NewInspectionStore(db)

	response, err := store.ListPeriods(context.Background(), 20, 10)
	if err != nil {
		t.Fatalf("ListPeriods() error = %v", err)
	}
	if response.Total != 1 || len(response.Items) != 1 || response.Items[0].ID != 4 {
		t.Fatalf("ListPeriods() = %#v", response)
	}
	if len(db.queryCalls) != 1 ||
		!strings.Contains(db.queryCalls[0].sql, "from public.inspection_periods") ||
		!strings.Contains(db.queryCalls[0].sql, "order by week_start desc") ||
		!strings.Contains(db.queryCalls[0].sql, "limit $1 offset $2") {
		t.Fatalf("periods SQL = %#v", db.queryCalls)
	}

	db.rowsQueue = []pgx.Row{
		inspectionFakeRow{values: []any{int64(4), weekStart, weekEnd, now, now}},
	}
	period, err := store.GetOrCreateCurrentPeriod(context.Background())
	if err != nil {
		t.Fatalf("GetOrCreateCurrentPeriod() error = %v", err)
	}
	if period.ID != 4 {
		t.Fatalf("current period = %#v", period)
	}
	lastQuery := db.queryRowCalls[len(db.queryRowCalls)-1]
	if !strings.Contains(lastQuery.sql, "insert into public.inspection_periods") ||
		!strings.Contains(lastQuery.sql, "on conflict (week_start)") {
		t.Fatalf("current period SQL = %s", lastQuery.sql)
	}
}

func TestInspectionStoreCreateOrUpdateUsesPartialJSONAndReturning(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	fakeDatabase := &inspectionFakeDB{
		rowsQueue: []pgx.Row{
			inspectionFakeRow{values: []any{int64(9)}},
			inspectionFakeRow{values: []any{
				int64(9), int64(4), int64(7), "draft",
				`{"negative_feedback":1}`,
				nil,
				"summary",
				nil, nil,
				now, now, "North",
			}},
		},
		rowsQueueQuery: []Rows{&inspectionFakeRows{}},
	}
	db := &inspectionFakeWriteDB{inspectionFakeDB: fakeDatabase}
	store := NewInspectionStore(db)
	negativeFeedback := 1
	summary := "summary"
	input := inspections.ReportWriteInput{
		HealthDataSet:    true,
		HealthData:       &inspections.HealthData{NegativeFeedback: &negativeFeedback},
		StatusSummarySet: true,
		StatusSummary:    &summary,
	}

	report, err := store.CreateOrUpdateReport(context.Background(), 4, 7, input)
	if err != nil {
		t.Fatalf("CreateOrUpdateReport() error = %v", err)
	}
	if report == nil || report.ID != 9 || report.StatusSummary == nil || *report.StatusSummary != "summary" {
		t.Fatalf("CreateOrUpdateReport() = %#v", report)
	}
	if len(fakeDatabase.queryRowCalls) < 1 {
		t.Fatal("missing upsert QueryRow call")
	}
	call := fakeDatabase.queryRowCalls[0]
	if !strings.Contains(call.sql, "on conflict (period_id, project_id, country)") ||
		!strings.Contains(call.sql, "when $6::boolean") {
		t.Fatalf("upsert SQL = %s", call.sql)
	}
	if len(call.args) != 8 {
		t.Fatalf("upsert args = %#v", call.args)
	}
	if call.args[2] != `{"account_health_rating":null,"negative_feedback":1,"a2z_claims":null,"chargeback_claims":null,"late_shipment_rate":null,"pre_fulfillment_cancel_rate":null,"valid_tracking_rate":null,"on_time_delivery_rate":null}` {
		t.Fatalf("health JSON arg = %#v", call.args[2])
	}
	if call.args[3] != nil {
		t.Fatalf("compliance JSON arg = %#v, want nil preserve", call.args[3])
	}
	if call.args[5] != true || call.args[6] != false || call.args[7] != true {
		t.Fatalf("set flags = %#v", call.args[5:])
	}
}

func TestInspectionStoreHistoryFiltersByProjectScopeAndPagination(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	historyRows := &inspectionFakeRows{batches: [][]any{{
		int64(9), int64(4),
		time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC),
		int64(7), "North", "submitted",
		`{"account_health_rating":"Good"}`,
		`{"ip_infringement":2}`,
		"summary", "alice", now,
	}}}
	screenshotRows := &inspectionFakeRows{batches: [][]any{{
		int64(12), int64(9), "inspection-screenshots/north/report_9/a.png",
		nil, "shot.png", "image/png", int64(8), "caption", int64(0), now,
	}}}
	db := &inspectionFakeDB{
		row:            inspectionFakeRow{values: []any{int64(1)}},
		rowsQueueQuery: []Rows{historyRows, screenshotRows},
	}
	store := NewInspectionStore(db)
	periodID := int64(4)
	projectID := int64(7)

	response, err := store.ListHistory(context.Background(), inspections.HistoryFilter{
		PeriodID: &periodID, ProjectID: &projectID,
		Limit: 25, Offset: 5, Operator: "alice",
	})
	if err != nil {
		t.Fatalf("ListHistory() error = %v", err)
	}
	if response.Total != 1 || len(response.Items) != 1 ||
		response.Items[0].ProjectName != "North" ||
		response.Items[0].ComplianceTotal == nil ||
		*response.Items[0].ComplianceTotal != 2 {
		t.Fatalf("ListHistory() = %#v", response)
	}
	if len(response.Items[0].Screenshots) != 1 {
		t.Fatalf("history screenshots = %#v", response.Items[0].Screenshots)
	}
	if len(db.queryCalls) != 2 {
		t.Fatalf("history queries = %#v", db.queryCalls)
	}
	query := db.queryCalls[0]
	for _, fragment := range []string{
		"r.period_id = $1",
		"r.project_id = $2",
		"$3::boolean",
		"btrim(names.value) = $4",
		"limit $5 offset $6",
	} {
		if !strings.Contains(query.sql, fragment) {
			t.Fatalf("history SQL missing %q: %s", fragment, query.sql)
		}
	}
	if len(query.args) != 6 ||
		query.args[2] != false ||
		query.args[3] != "alice" ||
		query.args[4] != 25 ||
		query.args[5] != 5 {
		t.Fatalf("history args = %#v", query.args)
	}
}

func TestInspectionStoreRejectsUnsafeScreenshotPaths(t *testing.T) {
	tests := []string{
		"../../etc/passwd",
		"/inspection-screenshots/north/report_9/a.png",
		`inspection-screenshots\north\report_9\a.png`,
		"inspection-screenshots/../a.png",
		"inspection-screenshots/north//a.png",
		"other/north/a.png",
		"inspection-screenshots/north/report_9/a\n.png",
	}
	for _, key := range tests {
		if inspectionSafeStorageKey(key) {
			t.Errorf("inspectionSafeStorageKey(%q) = true, want false", key)
		}
	}
	if !inspectionSafeStorageKey("inspection-screenshots/north/report_9/a.png") {
		t.Fatal("valid inspection key rejected")
	}

	db := &inspectionFakeDB{}
	store := NewInspectionStore(&inspectionFakeWriteDB{inspectionFakeDB: db})
	_, err := store.InsertScreenshot(context.Background(), inspections.InsertScreenshotInput{
		ReportID: 9, R2Key: "../../etc/passwd",
		Filename: "shot.png", ContentType: "image/png", FileSize: 8,
	})
	if err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("InsertScreenshot(unsafe) error = %v", err)
	}
	if len(db.queryRowCalls) != 0 {
		t.Fatalf("unsafe insert reached database: %#v", db.queryRowCalls)
	}
}

func TestInspectionStoreInsertScreenshotUsesReportLockAndSortOrder(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	db := &inspectionFakeWriteDB{inspectionFakeDB: &inspectionFakeDB{
		rowsQueue: []pgx.Row{
			inspectionFakeRow{values: []any{int64(7)}},
			inspectionFakeRow{values: []any{
				int64(12), int64(9), "inspection-screenshots/north/report_9/a.png",
				nil, "shot.png", "image/png", int64(8), nil, int64(0), now,
			}},
		},
	}}
	store := NewInspectionStore(db)

	record, err := store.InsertScreenshot(context.Background(), inspections.InsertScreenshotInput{
		ReportID: 9, R2Key: "inspection-screenshots/north/report_9/a.png",
		Filename: "shot.png", ContentType: "image/png", FileSize: 8,
	})
	if err != nil {
		t.Fatalf("InsertScreenshot() error = %v", err)
	}
	if record == nil || record.ProjectID != 7 || record.SortOrder != 0 {
		t.Fatalf("InsertScreenshot() = %#v", record)
	}
	if len(db.inspectionFakeDB.queryRowCalls) != 2 {
		t.Fatalf("insert screenshot queries = %#v", db.inspectionFakeDB.queryRowCalls)
	}
	if !strings.Contains(db.inspectionFakeDB.queryRowCalls[0].sql, "for update") {
		t.Fatalf("report lock SQL = %s", db.inspectionFakeDB.queryRowCalls[0].sql)
	}
	insertSQL := db.inspectionFakeDB.queryRowCalls[1].sql
	if !strings.Contains(insertSQL, "coalesce(max(sort_order), -1) + 1") ||
		!strings.Contains(insertSQL, "from public.inspection_screenshots") ||
		strings.Contains(insertSQL, "returning s.") {
		t.Fatalf("insert SQL = %s", insertSQL)
	}
}

func TestInspectionStoreGetAndDeleteScreenshotUseReportProjectScope(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	db := &inspectionFakeWriteDB{
		inspectionFakeDB: &inspectionFakeDB{
			row: inspectionFakeRow{values: []any{
				int64(12), int64(9), "inspection-screenshots/north/report_9/a.png",
				nil, "shot.png", "image/png", int64(8), nil, int64(0), now, int64(7),
			}},
		},
		execTag: pgconn.NewCommandTag("DELETE 1"),
	}
	store := NewInspectionStore(db)

	record, err := store.GetScreenshot(context.Background(), 12)
	if err != nil {
		t.Fatalf("GetScreenshot() error = %v", err)
	}
	if record == nil || record.ProjectID != 7 || record.ReportID != 9 {
		t.Fatalf("GetScreenshot() = %#v", record)
	}
	if !strings.Contains(db.inspectionFakeDB.queryRowCalls[0].sql, "join public.inspection_reports") ||
		!strings.Contains(db.inspectionFakeDB.queryRowCalls[0].sql, "r.project_id") {
		t.Fatalf("screenshot scope SQL = %s", db.inspectionFakeDB.queryRowCalls[0].sql)
	}

	deleted, err := store.DeleteScreenshot(context.Background(), 12)
	if err != nil {
		t.Fatalf("DeleteScreenshot() error = %v", err)
	}
	if !deleted || len(db.execCalls) != 1 ||
		!strings.Contains(db.execCalls[0].sql, "delete from public.inspection_screenshots") {
		t.Fatalf("DeleteScreenshot() = %v, exec=%#v", deleted, db.execCalls)
	}
}

func TestInspectionStoreThresholdWarningsPreserveRealValues(t *testing.T) {
	feedback := 1
	validTracking := 94.5
	warnings := inspectionThresholdWarnings(
		&inspections.HealthData{
			NegativeFeedback:  &feedback,
			ValidTrackingRate: &validTracking,
		},
		nil,
	)
	if len(warnings) != 2 {
		t.Fatalf("warnings = %#v, want 2", warnings)
	}
	if warnings[0].Value != 1 || warnings[0].Severity != "warning" {
		t.Fatalf("warning[0] = %#v", warnings[0])
	}
	if warnings[1].Value != 94.5 || warnings[1].Severity != "critical" {
		t.Fatalf("warning[1] = %#v", warnings[1])
	}
	if strings.Contains(warnings[0].Message, "0xc") {
		t.Fatalf("warning message leaked pointer address: %q", warnings[0].Message)
	}
}

func TestInspectionStoreMarkOverdueRunsInTransaction(t *testing.T) {
	db := &inspectionFakeWriteDB{inspectionFakeDB: &inspectionFakeDB{}}
	store := NewInspectionStore(db)
	if err := store.markInspectionReportsOverdue(context.Background(), 4); err != nil {
		t.Fatalf("markInspectionReportsOverdue() error = %v", err)
	}
	if !db.committed {
		t.Fatal("overdue update was not committed")
	}
	if len(db.execCalls) != 1 {
		t.Fatalf("overdue exec calls = %#v", db.execCalls)
	}
	if !strings.Contains(db.execCalls[0].sql, "status <> 'submitted'") {
		t.Fatalf("overdue SQL = %s", db.execCalls[0].sql)
	}
	if len(db.execCalls[0].args) != 1 || db.execCalls[0].args[0] != int64(4) {
		t.Fatalf("overdue args = %#v", db.execCalls[0].args)
	}
}

func TestInspectionStoreRunInTxRollsBackOnBusinessError(t *testing.T) {
	db := &inspectionFakeWriteDB{inspectionFakeDB: &inspectionFakeDB{}}
	store := NewInspectionStore(db)
	expected := errors.New("business error")
	err := store.RunInTx(context.Background(), func(
		_ context.Context,
		_ pgx.Tx,
		txStore inspections.Store,
	) error {
		if txStore == nil {
			t.Fatal("transaction store is nil")
		}
		return expected
	})
	if !errors.Is(err, expected) {
		t.Fatalf("RunInTx() error = %v, want %v", err, expected)
	}
	if db.committed {
		t.Fatal("transaction committed after business error")
	}
	if !db.rolledBack {
		t.Fatal("transaction was not rolled back")
	}
}

func TestInspectionStoreEmptyNonAdminHistoryDoesNotQuery(t *testing.T) {
	db := &inspectionFakeDB{}
	store := NewInspectionStore(db)
	response, err := store.ListHistory(context.Background(), inspections.HistoryFilter{
		Limit: 50, Operator: "",
	})
	if err != nil {
		t.Fatalf("ListHistory(empty operator) error = %v", err)
	}
	if response.Total != 0 || len(response.Items) != 0 {
		t.Fatalf("ListHistory(empty operator) = %#v", response)
	}
	if len(db.queryCalls) != 0 || len(db.queryRowCalls) != 0 {
		t.Fatalf("empty operator reached DB: %#v %#v", db.queryCalls, db.queryRowCalls)
	}
}

type inspectionQueryCall struct {
	sql  string
	args []any
}

type inspectionFakeDB struct {
	rows           Rows
	rowsErr        error
	row            pgx.Row
	rowsQueue      []pgx.Row
	rowsQueueQuery []Rows
	queryCalls     []inspectionQueryCall
	queryRowCalls  []inspectionQueryCall
	pingErr        error
}

func (database *inspectionFakeDB) Query(
	_ context.Context,
	sql string,
	args ...any,
) (Rows, error) {
	database.queryCalls = append(database.queryCalls, inspectionQueryCall{sql: sql, args: args})
	if len(database.rowsQueueQuery) > 0 {
		next := database.rowsQueueQuery[0]
		database.rowsQueueQuery = database.rowsQueueQuery[1:]
		return next, database.rowsErr
	}
	return database.rows, database.rowsErr
}

func (database *inspectionFakeDB) QueryRow(
	_ context.Context,
	sql string,
	args ...any,
) pgx.Row {
	database.queryRowCalls = append(
		database.queryRowCalls,
		inspectionQueryCall{sql: sql, args: args},
	)
	if len(database.rowsQueue) > 0 {
		next := database.rowsQueue[0]
		database.rowsQueue = database.rowsQueue[1:]
		return next
	}
	return database.row
}

func (database *inspectionFakeDB) Ping(context.Context) error {
	return database.pingErr
}

func (database *inspectionFakeDB) Exec(
	context.Context,
	string,
	...any,
) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (database *inspectionFakeDB) Begin(context.Context) (pgx.Tx, error) {
	return &inspectionFakeTx{db: database}, nil
}

type inspectionFakeWriteDB struct {
	*inspectionFakeDB
	execCalls  []inspectionQueryCall
	execTag    pgconn.CommandTag
	execErr    error
	committed  bool
	rolledBack bool
}

func (database *inspectionFakeWriteDB) Exec(
	_ context.Context,
	sql string,
	args ...any,
) (pgconn.CommandTag, error) {
	database.execCalls = append(database.execCalls, inspectionQueryCall{sql: sql, args: args})
	return database.execTag, database.execErr
}

func (database *inspectionFakeWriteDB) Begin(context.Context) (pgx.Tx, error) {
	return &inspectionFakeTx{fakeWriteDB: database}, nil
}

type inspectionFakeTx struct {
	db          *inspectionFakeDB
	fakeWriteDB *inspectionFakeWriteDB
}

func (tx *inspectionFakeTx) Commit(context.Context) error {
	if tx.fakeWriteDB != nil {
		tx.fakeWriteDB.committed = true
	}
	return nil
}

func (tx *inspectionFakeTx) Rollback(context.Context) error {
	if tx.fakeWriteDB != nil {
		tx.fakeWriteDB.rolledBack = true
	}
	return nil
}

func (tx *inspectionFakeTx) Exec(
	ctx context.Context,
	sql string,
	args ...any,
) (pgconn.CommandTag, error) {
	if tx.fakeWriteDB != nil {
		return tx.fakeWriteDB.Exec(ctx, sql, args...)
	}
	return tx.db.Exec(ctx, sql, args...)
}

func (tx *inspectionFakeTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, nil
}

func (tx *inspectionFakeTx) QueryRow(
	ctx context.Context,
	sql string,
	args ...any,
) pgx.Row {
	if tx.fakeWriteDB != nil {
		return tx.fakeWriteDB.QueryRow(ctx, sql, args...)
	}
	return tx.db.QueryRow(ctx, sql, args...)
}

func (tx *inspectionFakeTx) CopyFrom(
	context.Context,
	pgx.Identifier,
	[]string,
	pgx.CopyFromSource,
) (int64, error) {
	return 0, nil
}

func (tx *inspectionFakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}

func (tx *inspectionFakeTx) LargeObjects() pgx.LargeObjects {
	return pgx.LargeObjects{}
}

func (tx *inspectionFakeTx) Prepare(
	context.Context,
	string,
	string,
) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (tx *inspectionFakeTx) Conn() *pgx.Conn {
	return nil
}

func (tx *inspectionFakeTx) Begin(context.Context) (pgx.Tx, error) {
	return tx, nil
}

type inspectionFakeRow struct {
	values []any
	err    error
}

func (row inspectionFakeRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	return inspectionScanValues(dest, row.values)
}

type inspectionFakeRows struct {
	batches [][]any
	index   int
	err     error
	closed  bool
}

func (rows *inspectionFakeRows) Next() bool {
	if rows.index >= len(rows.batches) {
		return false
	}
	rows.index++
	return true
}

func (rows *inspectionFakeRows) Scan(dest ...any) error {
	if rows.index == 0 || rows.index > len(rows.batches) {
		return errors.New("scan called outside row")
	}
	return inspectionScanValues(dest, rows.batches[rows.index-1])
}

func (rows *inspectionFakeRows) Err() error {
	return rows.err
}

func (rows *inspectionFakeRows) Close() {
	rows.closed = true
}

func inspectionScanValues(dest, values []any) error {
	if len(dest) != len(values) {
		return fmt.Errorf(
			"scan destination count mismatch: got %d values for %d destinations",
			len(values),
			len(dest),
		)
	}
	for index, value := range values {
		switch target := dest[index].(type) {
		case *int:
			switch typed := value.(type) {
			case int:
				*target = typed
			case int64:
				*target = int(typed)
			default:
				return fmt.Errorf("scan value %T is not int", value)
			}
		case *int64:
			switch typed := value.(type) {
			case int64:
				*target = typed
			case int:
				*target = int64(typed)
			default:
				return fmt.Errorf("scan value %T is not int64", value)
			}
		case *string:
			typed, ok := value.(string)
			if !ok {
				return fmt.Errorf("scan value %T is not string", value)
			}
			*target = typed
		case **string:
			if value == nil {
				*target = nil
				continue
			}
			switch typed := value.(type) {
			case string:
				*target = &typed
			case *string:
				*target = typed
			default:
				return fmt.Errorf("scan value %T is not string pointer", value)
			}
		case *time.Time:
			if value == nil {
				*target = time.Time{}
				continue
			}
			typed, ok := value.(time.Time)
			if !ok {
				return fmt.Errorf("scan value %T is not time.Time", value)
			}
			*target = typed
		case **time.Time:
			if value == nil {
				*target = nil
				continue
			}
			switch typed := value.(type) {
			case time.Time:
				*target = &typed
			case *time.Time:
				*target = typed
			default:
				return fmt.Errorf("scan value %T is not time.Time pointer", value)
			}
		case *bool:
			typed, ok := value.(bool)
			if !ok {
				return fmt.Errorf("scan value %T is not bool", value)
			}
			*target = typed
		case *float64:
			typed, ok := value.(float64)
			if !ok {
				return fmt.Errorf("scan value %T is not float64", value)
			}
			*target = typed
		case *pgtype.Text:
			typed, ok := value.(pgtype.Text)
			if !ok {
				return fmt.Errorf("scan value %T is not pgtype.Text", value)
			}
			*target = typed
		default:
			return fmt.Errorf("unsupported scan destination %T", dest[index])
		}
	}
	return nil
}
