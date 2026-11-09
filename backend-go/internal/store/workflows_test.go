package store

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/workflows"
)

func TestWorkflowStoreListTemplatesReturnsMetadataOnlyInOrder(t *testing.T) {
	db := &workflowRowsDB{queryResults: []Rows{
		&fakeRows{batches: [][]any{
			{"launch", "store_launch", "店铺启动"},
			{"product", "product_development", "产品开发"},
		}},
	}}

	got, err := NewWorkflowStore(db).ListWorkflowTemplates(context.Background())
	if err != nil {
		t.Fatalf("ListWorkflowTemplates() error = %v", err)
	}
	if len(got) != 2 || got[0].Key != "launch" || got[1].Kind != "product_development" {
		t.Fatalf("templates = %#v, want ordered metadata", got)
	}
	if len(db.queryCalls) != 1 ||
		!strings.Contains(db.queryCalls[0].sql, "from public.workflow_templates") ||
		!strings.Contains(db.queryCalls[0].sql, "order by sort_order asc, id asc") {
		t.Errorf("template query = %#v", db.queryCalls)
	}
	for _, forbidden := range []string{"workflow_template_tasks", "description"} {
		if strings.Contains(db.queryCalls[0].sql, forbidden) {
			t.Errorf("template query unexpectedly includes %q: %s", forbidden, db.queryCalls[0].sql)
		}
	}
}

func TestWorkflowStoreListsNestedWorkflowDataAndPreservesEmptyArrays(t *testing.T) {
	createdAt := time.Date(2026, 11, 1, 12, 0, 0, 123000000, time.UTC)
	db := &workflowRowsDB{queryResults: []Rows{
		&fakeRows{batches: [][]any{{
			int64(3), int64(7), "store_launch", "店铺启动", "launch", pgtype.Text{},
		}}},
		&fakeRows{batches: [][]any{{
			int64(4), int64(3), "注册店铺", pgtype.Text{String: "说明", Valid: true},
			0, "in_progress", pgtype.Text{}, pgtype.Int4{}, pgtype.Text{}, pgtype.Text{},
		}}},
		&fakeRows{batches: [][]any{{
			int64(8), int64(4), pgtype.Text{String: "步骤", Valid: true}, "准备材料", 0,
		}}},
		&fakeRows{batches: [][]any{{
			int64(12), int64(4), "file.pdf", "application/pdf", int64(42),
			pgtype.Text{}, createdAt, pgtype.Text{String: "upload", Valid: true},
		}}},
	}}

	got, err := NewWorkflowStore(db).ListProjectWorkflows(context.Background(), 7)
	if err != nil {
		t.Fatalf("ListProjectWorkflows() error = %v", err)
	}
	if len(got) != 1 || got[0].ID != 3 || got[0].Status != "in_progress" ||
		got[0].TaskCount != 1 || len(got[0].Tasks) != 1 ||
		len(got[0].Tasks[0].Contents) != 1 || len(got[0].Tasks[0].Attachments) != 1 {
		t.Fatalf("workflows = %#v, want nested workflow", got)
	}
	if got[0].StartDate != nil || got[0].Tasks[0].StartDate != nil ||
		got[0].Tasks[0].Attachments[0].CreatedAt != "2026-11-01T12:00:00.123000Z" {
		t.Errorf("workflow date/time fields = %#v", got[0])
	}
	if len(db.queryCalls) != 4 {
		t.Fatalf("query count = %d, want workflows/tasks/contents/attachments", len(db.queryCalls))
	}
	for i, fragment := range []string{"from public.project_workflows", "from public.project_workflow_tasks", "from public.project_workflow_task_contents", "from public.project_workflow_task_attachments"} {
		if !strings.Contains(db.queryCalls[i].sql, fragment) {
			t.Errorf("query %d = %s, want %q", i, db.queryCalls[i].sql, fragment)
		}
	}
}

func TestWorkflowStoreSummaryAggregatesStatusAndDateBounds(t *testing.T) {
	db := &workflowRowsDB{queryResults: []Rows{
		&fakeRows{batches: [][]any{
			{int64(7), int64(3), "store_launch", "店铺启动", "launch", pgtype.Text{}, pgtype.Text{String: "completed", Valid: true}, pgtype.Text{String: "2026-10-01", Valid: true}, pgtype.Text{String: "2026-10-02", Valid: true}},
			{int64(7), int64(3), "store_launch", "店铺启动", "launch", pgtype.Text{}, pgtype.Text{String: "completed", Valid: true}, pgtype.Text{String: "2026-10-03", Valid: true}, pgtype.Text{String: "2026-10-04", Valid: true}},
			{int64(7), int64(4), "product_development", "新品", "product", pgtype.Text{}, pgtype.Text{}, pgtype.Text{}, pgtype.Text{}},
		}},
	}}

	got, err := NewWorkflowStore(db).ListWorkflowSummaries(context.Background(), []int64{7, 8})
	if err != nil {
		t.Fatalf("ListWorkflowSummaries() error = %v", err)
	}
	if len(got[7]) != 2 || got[7][0].Status != "completed" ||
		got[7][0].CompletedTaskCount != 2 || got[7][0].ScheduleDays == nil ||
		*got[7][0].ScheduleDays != 4 || got[7][1].Status != "not_started" {
		t.Fatalf("summaries = %#v, want aggregate status and date range", got)
	}
	if _, ok := got[8]; !ok || got[8] == nil {
		t.Fatalf("empty project summary = %#v, want empty slice", got[8])
	}
	if len(db.queryCalls) != 1 || !strings.Contains(db.queryCalls[0].sql, "left join public.project_workflow_tasks") {
		t.Errorf("summary queries = %#v, want one batched left join", db.queryCalls)
	}
}

func TestWorkflowStoreProjectSchedulesSkipsEmptyProjectIDs(t *testing.T) {
	db := &workflowRowsDB{}
	got, err := NewWorkflowStore(db).ListProjectSchedules(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListProjectSchedules() error = %v", err)
	}
	if len(got) != 0 || len(db.queryCalls) != 0 {
		t.Fatalf("schedules = %#v, queries = %d, want empty and no query", got, len(db.queryCalls))
	}
}

type workflowRowsDB struct {
	queryCalls   []queryCall
	queryResults []Rows
	queryErr     error
	row          pgx.Row
}

func (db *workflowRowsDB) Query(_ context.Context, sql string, args ...any) (Rows, error) {
	db.queryCalls = append(db.queryCalls, queryCall{sql: sql, args: args})
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if len(db.queryResults) == 0 {
		return &fakeRows{}, nil
	}
	rows := db.queryResults[0]
	db.queryResults = db.queryResults[1:]
	return rows, nil
}
func (*workflowRowsDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakeRow{err: errors.New("unexpected QueryRow")}
}
func (*workflowRowsDB) Ping(context.Context) error { return nil }

func TestWorkflowTemplateRecordScanPreservesNullableAndNestedFields(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	db := &workflowRowsDB{queryResults: []Rows{
		&fakeRows{batches: [][]any{{
			int64(9), "template-a", "product_development", "模板",
			pgtype.Text{String: "说明", Valid: true}, 2,
		}}},
		&fakeRows{batches: [][]any{{
			int64(10), int64(9), "节点", pgtype.Text{},
			0, pgtype.Text{String: "amazon_registration_form", Valid: true},
			pgtype.Int4{Int32: 3, Valid: true},
		}}},
		&fakeRows{batches: [][]any{{
			int64(11), int64(10), pgtype.Text{}, "正文", 0,
		}}},
		&fakeRows{batches: [][]any{{
			int64(12), int64(10), "template-task-10/file.pdf", "file.pdf",
			"application/pdf", int64(5), pgtype.Text{String: "管理员", Valid: true}, createdAt,
		}}},
	}}

	record, err := loadTemplateRecord(context.Background(), db, "t.id = $1", 9)
	if err != nil {
		t.Fatalf("loadTemplateRecord() error = %v", err)
	}
	if record == nil || record.Description == nil || *record.Description != "说明" ||
		len(record.Tasks) != 1 || record.Tasks[0].DurationDays == nil ||
		*record.Tasks[0].DurationDays != 3 {
		t.Fatalf("template record = %#v", record)
	}
	if len(record.Tasks[0].Contents) != 1 || len(record.Tasks[0].Attachments) != 1 ||
		record.Tasks[0].Attachments[0].R2Key != "template-task-10/file.pdf" {
		t.Fatalf("nested template data = %#v", record.Tasks[0])
	}
	if len(db.queryCalls) != 4 {
		t.Fatalf("template queries = %d, want templates/tasks/contents/attachments", len(db.queryCalls))
	}
}

func TestWorkflowTaskOrderHelpersRejectMismatchAndInsertDeterministically(t *testing.T) {
	if err := validateOrderSet([]int64{4, 5, 6}, []int64{6, 4, 5}); err != nil {
		t.Fatalf("valid order rejected: %v", err)
	}
	if err := validateOrderSet([]int64{4, 5}, []int64{4}); err == nil {
		t.Fatal("incomplete order accepted")
	}
	if err := validateOrderSet([]int64{4, 5}, []int64{4, 4}); err == nil {
		t.Fatal("duplicate order accepted")
	}
	got := insertInt64At([]int64{4, 5, 6}, 7, 1)
	if len(got) != 4 || got[0] != 4 || got[1] != 7 || got[2] != 5 || got[3] != 6 {
		t.Fatalf("insertInt64At() = %v", got)
	}
}

func TestWorkflowStoreMapsUniqueViolationToConflict(t *testing.T) {
	err := mapWorkflowDBError(&pgconn.PgError{
		Code:    "23505",
		Message: "duplicate key",
	})
	status, detail := projects.HTTPError(err)
	if status != http.StatusConflict || detail != "资源已存在" {
		t.Fatalf("HTTPError() = %d %q, want 409", status, detail)
	}
}

func TestUpdateTaskStatusCommitsSingleTransactionAndAudits(t *testing.T) {
	db := newWorkflowWriteTestDB()
	db.rowQueue = []pgx.Row{fakeRow{values: []any{int64(3)}}}
	db.rowsQueue = []Rows{
		&fakeRows{batches: [][]any{{
			int64(3), int64(7), "store_launch", "店铺启动", "launch", pgtype.Text{},
		}}},
		&fakeRows{batches: [][]any{{
			int64(4), int64(3), "注册", pgtype.Text{}, 0, "completed",
			pgtype.Text{}, pgtype.Int4{}, pgtype.Text{}, pgtype.Text{},
		}}},
		&fakeRows{},
		&fakeRows{},
	}

	got, err := NewWorkflowStore(db).UpdateTaskStatus(context.Background(), 4, "completed")
	if err != nil {
		t.Fatalf("UpdateTaskStatus() error = %v", err)
	}
	if got == nil || got.ID != 3 || got.Status != "completed" {
		t.Fatalf("updated workflow = %#v", got)
	}
	if !db.tx.committed {
		t.Fatalf("tx committed=%v rolledBack=%v", db.tx.committed, db.tx.rolledBack)
	}
	updateFound, auditFound := false, false
	for _, call := range db.tx.execCalls {
		switch {
		case strings.Contains(call.sql, "update public.project_workflow_tasks"):
			updateFound = true
		case strings.Contains(call.sql, "operation_audit_logs"):
			auditFound = true
			if len(call.args) < 2 || call.args[1] != "workflow.task.status" {
				t.Fatalf("audit args = %#v", call.args)
			}
		}
	}
	if !updateFound || !auditFound {
		t.Fatalf("exec calls = %#v, want update and audit", db.tx.execCalls)
	}
}

func TestWorkflowMutationRollsBackWhenAuditFails(t *testing.T) {
	db := newWorkflowWriteTestDB()
	db.auditErr = errors.New("audit unavailable")
	db.rowQueue = []pgx.Row{fakeRow{values: []any{int64(3)}}}
	db.rowsQueue = []Rows{
		&fakeRows{batches: [][]any{{
			int64(3), int64(7), "store_launch", "店铺启动", "launch", pgtype.Text{},
		}}},
		&fakeRows{batches: [][]any{{
			int64(4), int64(3), "注册", pgtype.Text{}, 0, "completed",
			pgtype.Text{}, pgtype.Int4{}, pgtype.Text{}, pgtype.Text{},
		}}},
		&fakeRows{},
		&fakeRows{},
	}

	_, err := NewWorkflowStore(db).UpdateTaskStatus(context.Background(), 4, "completed")
	if err == nil {
		t.Fatal("expected audit error")
	}
	if db.tx.committed || !db.tx.rolledBack {
		t.Fatalf("tx committed=%v rolledBack=%v, want rollback", db.tx.committed, db.tx.rolledBack)
	}
}

func TestReorderProjectTasksCommitsDenseOrderInTransaction(t *testing.T) {
	db := newWorkflowWriteTestDB()
	db.rowQueue = []pgx.Row{fakeRow{values: []any{int64(7)}}}
	db.rowsQueue = []Rows{
		&fakeRows{batches: [][]any{{int64(4), 0}, {int64(5), 1}}},
		&fakeRows{batches: [][]any{{
			int64(3), int64(7), "store_launch", "店铺启动", "launch", pgtype.Text{},
		}}},
		&fakeRows{batches: [][]any{
			{int64(5), int64(3), "第二步", pgtype.Text{}, 0, "not_started", pgtype.Text{}, pgtype.Int4{}, pgtype.Text{}, pgtype.Text{}},
			{int64(4), int64(3), "第一步", pgtype.Text{}, 1, "not_started", pgtype.Text{}, pgtype.Int4{}, pgtype.Text{}, pgtype.Text{}},
		}},
		&fakeRows{},
		&fakeRows{},
		&fakeRows{batches: [][]any{{
			int64(3), int64(7), "store_launch", "店铺启动", "launch", pgtype.Text{},
		}}},
		&fakeRows{batches: [][]any{
			{int64(5), int64(3), "第二步", pgtype.Text{}, 0, "not_started", pgtype.Text{}, pgtype.Int4{}, pgtype.Text{}, pgtype.Text{}},
			{int64(4), int64(3), "第一步", pgtype.Text{}, 1, "not_started", pgtype.Text{}, pgtype.Int4{}, pgtype.Text{}, pgtype.Text{}},
		}},
		&fakeRows{},
		&fakeRows{},
	}

	got, err := NewWorkflowStore(db).ReorderProjectTasks(
		context.Background(),
		7,
		3,
		[]int64{5, 4},
	)
	if err != nil {
		t.Fatalf("ReorderProjectTasks() error = %v", err)
	}
	if got == nil || len(got.Tasks) != 2 || got.Tasks[0].ID != 5 || got.Tasks[1].ID != 4 {
		t.Fatalf("reordered workflow = %#v", got)
	}
	if !db.tx.committed {
		t.Fatalf("reorder tx committed=%v rolledBack=%v", db.tx.committed, db.tx.rolledBack)
	}
	orderUpdates, auditFound := 0, false
	for _, call := range db.tx.execCalls {
		switch {
		case strings.Contains(call.sql, "set sort_order"):
			orderUpdates++
		case strings.Contains(call.sql, "operation_audit_logs"):
			auditFound = true
		}
	}
	if orderUpdates != 2 || !auditFound {
		t.Fatalf("reorder exec calls = %#v", db.tx.execCalls)
	}
}

func TestCopyTemplateUsesOneTransactionAndCopiesContentAndAttachmentShares(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	db := newWorkflowWriteTestDB()
	db.rowQueue = []pgx.Row{
		fakeRow{err: pgx.ErrNoRows},
		fakeRow{values: []any{int64(20)}},
		fakeRow{values: []any{int64(21)}},
	}
	db.rowsQueue = []Rows{
		&fakeRows{batches: [][]any{{
			int64(9), "template-a", "product_development", "模板",
			pgtype.Text{String: "说明", Valid: true}, 2,
		}}},
		&fakeRows{batches: [][]any{{
			int64(10), int64(9), "节点", pgtype.Text{}, 0,
			pgtype.Text{}, pgtype.Int4{Int32: 2, Valid: true},
		}}},
		&fakeRows{batches: [][]any{{
			int64(11), int64(10), pgtype.Text{}, "内容", 0,
		}}},
		&fakeRows{batches: [][]any{{
			int64(12), int64(10), "project-launch-templates/template-task-10/file.pdf",
			"file.pdf", "application/pdf", int64(5), pgtype.Text{}, createdAt,
		}}},
		&fakeRows{batches: [][]any{{
			int64(20), "copy-a", "product_development", "模板（副本）",
			pgtype.Text{String: "说明", Valid: true}, 3,
		}}},
		&fakeRows{batches: [][]any{{
			int64(21), int64(20), "节点", pgtype.Text{}, 0,
			pgtype.Text{}, pgtype.Int4{Int32: 2, Valid: true},
		}}},
		&fakeRows{batches: [][]any{{
			int64(22), int64(21), pgtype.Text{}, "内容", 0,
		}}},
		&fakeRows{batches: [][]any{{
			int64(23), int64(21), "project-launch-templates/template-task-10/file.pdf",
			"file.pdf", "application/pdf", int64(5), pgtype.Text{}, createdAt,
		}}},
	}

	key := "copy-a"
	title := "模板（副本）"
	got, err := NewWorkflowStore(db).CopyWorkflowTemplate(
		context.Background(),
		9,
		workflows.TemplateCopyRequest{Title: &title, Key: &key},
	)
	if err != nil {
		t.Fatalf("CopyWorkflowTemplate() error = %v", err)
	}
	if got == nil || got.ID != 20 || len(got.Tasks) != 1 ||
		len(got.Tasks[0].Contents) != 1 || len(got.Tasks[0].Attachments) != 1 {
		t.Fatalf("copied template = %#v", got)
	}
	if !db.tx.committed {
		t.Fatalf("copy tx committed=%v rolledBack=%v", db.tx.committed, db.tx.rolledBack)
	}
	contentCopied, attachmentCopied, auditFound := false, false, false
	for _, call := range db.tx.execCalls {
		switch {
		case strings.Contains(call.sql, "insert into public.workflow_template_task_contents"):
			contentCopied = true
		case strings.Contains(call.sql, "insert into public.workflow_template_task_attachments"):
			attachmentCopied = true
			if len(call.args) < 2 ||
				call.args[1] != "project-launch-templates/template-task-10/file.pdf" {
				t.Fatalf("attachment copy args = %#v", call.args)
			}
		case strings.Contains(call.sql, "operation_audit_logs"):
			auditFound = true
		}
	}
	if !contentCopied || !attachmentCopied || !auditFound {
		t.Fatalf("copy exec calls = %#v", db.tx.execCalls)
	}
}

type workflowWriteTestDB struct {
	rowsQueue []Rows
	rowQueue  []pgx.Row
	execCalls []queryCall
	execTag   pgconn.CommandTag
	auditErr  error
	tx        *workflowWriteTestTx
}

func newWorkflowWriteTestDB() *workflowWriteTestDB {
	return &workflowWriteTestDB{execTag: pgconn.NewCommandTag("UPDATE 1")}
}

func (db *workflowWriteTestDB) Query(_ context.Context, sql string, args ...any) (Rows, error) {
	db.execCalls = append(db.execCalls, queryCall{sql: sql, args: args})
	if len(db.rowsQueue) == 0 {
		return &fakeRows{}, nil
	}
	rows := db.rowsQueue[0]
	db.rowsQueue = db.rowsQueue[1:]
	return rows, nil
}

func (db *workflowWriteTestDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.execCalls = append(db.execCalls, queryCall{sql: sql, args: args})
	if len(db.rowQueue) == 0 {
		return fakeRow{err: pgx.ErrNoRows}
	}
	row := db.rowQueue[0]
	db.rowQueue = db.rowQueue[1:]
	return row
}

func (db *workflowWriteTestDB) Ping(context.Context) error { return nil }
func (db *workflowWriteTestDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return db.execTag, nil
}
func (db *workflowWriteTestDB) Begin(context.Context) (pgx.Tx, error) {
	db.tx = &workflowWriteTestTx{db: db, execTag: db.execTag, auditErr: db.auditErr}
	return db.tx, nil
}

type workflowWriteTestTx struct {
	db         *workflowWriteTestDB
	execTag    pgconn.CommandTag
	execCalls  []queryCall
	committed  bool
	rolledBack bool
	auditErr   error
}

func (tx *workflowWriteTestTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.execCalls = append(tx.execCalls, queryCall{sql: sql, args: args})
	if tx.auditErr != nil && strings.Contains(sql, "operation_audit_logs") {
		return pgconn.CommandTag{}, tx.auditErr
	}
	if strings.Contains(sql, "delete") || strings.Contains(sql, "insert") {
		return pgconn.NewCommandTag("INSERT 1"), nil
	}
	return tx.execTag, nil
}
func (tx *workflowWriteTestTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := tx.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return fakePgxRows{rows: rows}, nil
}
func (tx *workflowWriteTestTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return tx.db.QueryRow(ctx, sql, args...)
}
func (tx *workflowWriteTestTx) Commit(context.Context) error {
	tx.committed = true
	return nil
}
func (tx *workflowWriteTestTx) Rollback(context.Context) error {
	tx.rolledBack = true
	return nil
}
func (tx *workflowWriteTestTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (tx *workflowWriteTestTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}
func (tx *workflowWriteTestTx) LargeObjects() pgx.LargeObjects {
	return pgx.LargeObjects{}
}
func (tx *workflowWriteTestTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (tx *workflowWriteTestTx) Conn() *pgx.Conn { return nil }
func (tx *workflowWriteTestTx) Begin(context.Context) (pgx.Tx, error) {
	return tx, nil
}
