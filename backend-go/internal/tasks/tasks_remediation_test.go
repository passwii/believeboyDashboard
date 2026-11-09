package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

type remediationExecCall struct {
	sql  string
	args []any
}

type remediationQueryCall struct {
	sql  string
	args []any
}

type remediationExecResponse struct {
	tag pgconn.CommandTag
	err error
}

type remediationQueryResponse struct {
	rows store.Rows
	err  error
}

type remediationDB struct {
	mu sync.Mutex

	execCalls         []remediationExecCall
	execResponses     []remediationExecResponse
	queryCalls        []remediationQueryCall
	queryResponses    []remediationQueryResponse
	queryRowCalls     []remediationQueryCall
	queryRowResponses []pgx.Row
}

func (db *remediationDB) Query(ctx context.Context, sql string, args ...any) (store.Rows, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.queryCalls = append(db.queryCalls, remediationQueryCall{sql: sql, args: append([]any(nil), args...)})
	if len(db.queryResponses) == 0 {
		return &remediationRows{}, nil
	}
	response := db.queryResponses[0]
	db.queryResponses = db.queryResponses[1:]
	return response.rows, response.err
}

func (db *remediationDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.queryRowCalls = append(db.queryRowCalls, remediationQueryCall{sql: sql, args: append([]any(nil), args...)})
	if len(db.queryRowResponses) == 0 {
		return remediationRow{err: pgx.ErrNoRows}
	}
	row := db.queryRowResponses[0]
	db.queryRowResponses = db.queryRowResponses[1:]
	return row
}

func (db *remediationDB) Ping(context.Context) error { return nil }

func (db *remediationDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.execCalls = append(db.execCalls, remediationExecCall{sql: sql, args: append([]any(nil), args...)})
	if len(db.execResponses) == 0 {
		return pgconn.NewCommandTag("UPDATE 1"), nil
	}
	response := db.execResponses[0]
	db.execResponses = db.execResponses[1:]
	return response.tag, response.err
}

func (db *remediationDB) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("transactions are not used by remediation tests")
}

func (db *remediationDB) execArgsContain(predicate func([]any) bool) bool {
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, call := range db.execCalls {
		if predicate(call.args) {
			return true
		}
	}
	return false
}

type remediationRows struct {
	values [][]any
	index  int
	err    error
}

func remediationStaticRows(values ...[]any) *remediationRows {
	return &remediationRows{values: values, index: -1}
}

func (rows *remediationRows) Next() bool {
	if rows.index+1 >= len(rows.values) {
		return false
	}
	rows.index++
	return true
}

func (rows *remediationRows) Scan(dest ...any) error {
	if rows.err != nil {
		return rows.err
	}
	if rows.index < 0 || rows.index >= len(rows.values) {
		return errors.New("scan called without a current row")
	}
	values := rows.values[rows.index]
	if len(dest) != len(values) {
		return errors.New("remediation row scan destination mismatch")
	}
	for i := range dest {
		if err := remediationAssign(dest[i], values[i]); err != nil {
			return err
		}
	}
	return nil
}

func (rows *remediationRows) Err() error { return rows.err }
func (rows *remediationRows) Close()     {}

type remediationRow struct {
	values []any
	err    error
}

func (row remediationRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return errors.New("remediation QueryRow scan destination mismatch")
	}
	for i := range dest {
		if err := remediationAssign(dest[i], row.values[i]); err != nil {
			return err
		}
	}
	return nil
}

func remediationAssign(destination, source any) error {
	switch target := destination.(type) {
	case *any:
		*target = source
	case *int:
		switch value := source.(type) {
		case int:
			*target = value
		case int64:
			*target = int(value)
		default:
			return errors.New("source is not int-compatible")
		}
	case *int64:
		switch value := source.(type) {
		case int:
			*target = int64(value)
		case int64:
			*target = value
		default:
			return errors.New("source is not int64-compatible")
		}
	case *string:
		if source == nil {
			*target = ""
			return nil
		}
		value, ok := source.(string)
		if !ok {
			return errors.New("source is not string-compatible")
		}
		*target = value
	case **string:
		if source == nil || (reflect.ValueOf(source).Kind() == reflect.Pointer && reflect.ValueOf(source).IsNil()) {
			*target = nil
			return nil
		}
		value, ok := source.(string)
		if !ok {
			return errors.New("source is not *string-compatible")
		}
		copyValue := value
		*target = &copyValue
	case *bool:
		value, ok := source.(bool)
		if !ok {
			return errors.New("source is not bool-compatible")
		}
		*target = value
	case *float64:
		switch value := source.(type) {
		case float64:
			*target = value
		case int:
			*target = float64(value)
		case int64:
			*target = float64(value)
		default:
			return errors.New("source is not float64-compatible")
		}
	case **float64:
		if source == nil || (reflect.ValueOf(source).Kind() == reflect.Pointer && reflect.ValueOf(source).IsNil()) {
			*target = nil
			return nil
		}
		var value float64
		switch typed := source.(type) {
		case float64:
			value = typed
		case int:
			value = float64(typed)
		case int64:
			value = float64(typed)
		default:
			return errors.New("source is not *float64-compatible")
		}
		*target = &value
	case *time.Time:
		value, ok := source.(time.Time)
		if !ok {
			return errors.New("source is not time.Time-compatible")
		}
		*target = value
	case **time.Time:
		if source == nil || (reflect.ValueOf(source).Kind() == reflect.Pointer && reflect.ValueOf(source).IsNil()) {
			*target = nil
			return nil
		}
		value, ok := source.(time.Time)
		if !ok {
			return errors.New("source is not *time.Time-compatible")
		}
		copyValue := value
		*target = &copyValue
	case *[]byte:
		switch value := source.(type) {
		case []byte:
			*target = append([]byte(nil), value...)
		case json.RawMessage:
			*target = append([]byte(nil), value...)
		case string:
			*target = []byte(value)
		default:
			return errors.New("source is not []byte-compatible")
		}
	case *[]int64:
		value, ok := source.([]int64)
		if !ok {
			return errors.New("source is not []int64-compatible")
		}
		*target = append([]int64(nil), value...)
	case *[]string:
		value, ok := source.([]string)
		if !ok {
			return errors.New("source is not []string-compatible")
		}
		*target = append([]string(nil), value...)
	default:
		value := reflect.ValueOf(destination)
		if value.Kind() != reflect.Pointer || value.IsNil() {
			return errors.New("unsupported remediation scan destination")
		}
		sourceValue := reflect.ValueOf(source)
		if sourceValue.IsValid() && sourceValue.Type().AssignableTo(value.Elem().Type()) {
			value.Elem().Set(sourceValue)
			return nil
		}
		return errors.New("unsupported remediation scan destination")
	}
	return nil
}

type remediationExecutor struct {
	result any
	err    error
	calls  int
}

func (executor *remediationExecutor) Execute(context.Context, string, any) (any, error) {
	executor.calls++
	return executor.result, executor.err
}

type remediationFinalizer struct {
	calls      int
	reportID   int64
	resultPath string
	jobID      int64
	result     store.MonthlyReportComputedResult
	err        error
}

func (finalizer *remediationFinalizer) Finalize(
	_ context.Context,
	reportID int64,
	jobID int64,
	result store.MonthlyReportComputedResult,
) error {
	finalizer.calls++
	finalizer.reportID = reportID
	finalizer.jobID = jobID
	finalizer.result = result
	finalizer.resultPath = result.ResultPath
	return finalizer.err
}

type remediationGenerator struct {
	calls  int
	report *store.MonthlyReportComputedResult
	err    error
}

func (generator *remediationGenerator) Generate(
	_ context.Context,
	_ MonthlyReportGenerationInput,
) (*store.MonthlyReportComputedResult, error) {
	generator.calls++
	if generator.err != nil {
		return nil, generator.err
	}
	if generator.report != nil {
		return generator.report, nil
	}
	return &store.MonthlyReportComputedResult{
		ResultPath: "/tmp/report.xlsx",
		PT3:        map[string]string{"income_total": "0.00"},
		PT4:        map[string]string{"income_total": "0.00"},
	}, nil
}

type remediationBuildExecutor struct {
	calls   int
	buildID int64
	result  any
	err     error
}

func (executor *remediationBuildExecutor) ExecuteBuild(_ context.Context, buildID int64) (any, error) {
	executor.calls++
	executor.buildID = buildID
	return executor.result, executor.err
}

type remediationMailer struct {
	calls   int
	to      string
	subject string
	body    string
	err     error
}

func (mailer *remediationMailer) Send(
	_ context.Context,
	to string,
	subject string,
	body string,
) error {
	mailer.calls++
	mailer.to = to
	mailer.subject = subject
	mailer.body = body
	return mailer.err
}

func remediationTask(t *testing.T, taskType string, payload any) *asynq.Task {
	t.Helper()
	raw, err := queue.MarshalPayload(payload)
	if err != nil {
		t.Fatalf("MarshalPayload() error = %v", err)
	}
	return asynq.NewTask(taskType, raw)
}

func TestRemediationExternalHandlersFailWhenExecutorMissing(t *testing.T) {
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{})
	cases := []struct {
		name   string
		task   *asynq.Task
		handle func(context.Context, *asynq.Task) error
		want   error
	}{
		{
			name:   "generate insight",
			task:   remediationTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{ScheduleID: remediationInt64Pointer(1)}),
			handle: handler.HandleGenerateInsight,
			want:   ErrDependencyNotConfigured,
		},
		{
			name:   "execute insight run",
			task:   remediationTask(t, queue.TypeExecuteInsightRun, ExecuteInsightRunPayload{RunID: "run-1"}),
			handle: handler.HandleExecuteInsightRun,
			want:   ErrExecutorNotConfigured,
		},
		{
			name: "dispatch one",
			task: remediationTask(t, queue.TypeDispatchOne, DispatchOnePayload{
				SubscriptionID: 1,
				Email:          "ops@example.com",
				Country:        "US",
				Frequency:      "daily",
			}),
			handle: handler.HandleDispatchOne,
			want:   ErrExecutorNotConfigured,
		},
		{
			name:   "delivery summary",
			task:   remediationTask(t, queue.TypeGenerateDeliverySummary, GenerateDeliverySummaryPayload{LogID: 1}),
			handle: handler.HandleGenerateDeliverySummary,
			want:   ErrExecutorNotConfigured,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := testCase.handle(context.Background(), testCase.task)
			if err == nil {
				t.Fatalf("%s with nil Executor returned nil", testCase.name)
			}
			if !errors.Is(err, testCase.want) {
				t.Fatalf("%s error = %v, want %v", testCase.name, err, testCase.want)
			}
		})
	}
}

func TestRemediationPreviewRequiresBuildExecutor(t *testing.T) {
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{})
	task := remediationTask(t, queue.TypeBuildMonthlyReportPreview, MonthlyReportPreviewPayload{BuildID: 9})
	err := handler.HandleBuildMonthlyReportPreview(context.Background(), task)
	if !errors.Is(err, ErrDependencyNotConfigured) {
		t.Fatalf("preview error = %v, want ErrDependencyNotConfigured", err)
	}
}

func TestRemediationPreviewExecutesInjectedBuild(t *testing.T) {
	buildExecutor := &remediationBuildExecutor{result: map[string]any{"status": "success"}}
	handler := NewTaskHandlerWithDB(nil, HandlerConfig{MonthlyReportBuildExecutor: buildExecutor})
	task := remediationTask(t, queue.TypeBuildMonthlyReportPreview, MonthlyReportPreviewPayload{BuildID: 12})
	if err := handler.HandleBuildMonthlyReportPreview(context.Background(), task); err != nil {
		t.Fatalf("HandleBuildMonthlyReportPreview() error = %v", err)
	}
	if buildExecutor.calls != 1 || buildExecutor.buildID != 12 {
		t.Fatalf("build executor calls=%d buildID=%d", buildExecutor.calls, buildExecutor.buildID)
	}
}

func TestRemediationRunJobAlreadyDoneIsIdempotent(t *testing.T) {
	payload := []byte(`{"job_type":"unknown","params":{}}`)
	db := &remediationDB{queryRowResponses: []pgx.Row{
		remediationRow{values: []any{int64(42), "unknown", "success", payload, (*string)(nil)}},
	}}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})
	if err := handler.HandleRunJob(context.Background(), task); err != nil {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.execCalls) != 0 {
		t.Fatalf("already-success job made %d writes", len(db.execCalls))
	}
}

func TestRemediationRunJobMonthlySuccessUsesFinalizer(t *testing.T) {
	payload := []byte(`{"job_type":"monthly_report","file_id":"tx.csv","params":{"report_id":5,"project_id":7,"project_name":"Project A","country":"US","report_month":"2026-10","transaction_file_id":"tx.csv"}}`)
	generator := &remediationGenerator{}
	finalizer := &remediationFinalizer{}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{int64(42), "monthly_report", "pending", payload, (*string)(nil)}},
			remediationRow{values: []any{int64(77)}},
			remediationRow{values: []any{int64(5), "pending", "", int64(7), "Project A", "US", "2026-10"}},
		},
		execResponses: []remediationExecResponse{
			{tag: pgconn.NewCommandTag("UPDATE 1")},
			{tag: pgconn.NewCommandTag("UPDATE 1")},
			{tag: pgconn.NewCommandTag("UPDATE 1")},
			{tag: pgconn.NewCommandTag("UPDATE 1")},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		MonthlyReportGenerator: generator,
		MonthlyReportFinalizer: finalizer,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})
	if err := handler.HandleRunJob(context.Background(), task); err != nil {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	if generator.calls != 1 {
		t.Fatalf("generator calls = %d, want 1", generator.calls)
	}
	if finalizer.calls != 1 || finalizer.reportID != 5 || finalizer.jobID != 42 ||
		finalizer.resultPath != "/tmp/report.xlsx" {
		t.Fatalf("finalizer call = %#v", finalizer)
	}
}

func TestRemediationRunJobRunningReusesLatestRun(t *testing.T) {
	payload := []byte(`{"job_type":"monthly_report","file_id":"tx.csv","params":{"report_id":5,"project_id":7,"project_name":"Project A","country":"US","report_month":"2026-10","transaction_file_id":"tx.csv"}}`)
	generator := &remediationGenerator{}
	finalizer := &remediationFinalizer{}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{int64(42), "monthly_report", "running", payload, (*string)(nil)}},
			remediationRow{values: []any{int64(77)}},
			remediationRow{values: []any{int64(5), "running", "", int64(7), "Project A", "US", "2026-10"}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		MonthlyReportGenerator: generator,
		MonthlyReportFinalizer: finalizer,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})
	if err := handler.HandleRunJob(context.Background(), task); err != nil {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, call := range db.execCalls {
		if strings.Contains(call.sql, "INSERT INTO public.job_runs") {
			t.Fatalf("running job created a second run: %s", call.sql)
		}
	}
	if finalizer.calls != 1 || finalizer.jobID != 42 {
		t.Fatalf("finalizer call = %#v", finalizer)
	}
}

func TestRemediationRunJobReusesAlreadyFinalizedMonthlyReport(t *testing.T) {
	payload := []byte(`{"job_type":"monthly_report","file_id":"tx.csv","params":{"report_id":5,"project_id":7,"project_name":"Project A","country":"US","report_month":"2026-10","transaction_file_id":"tx.csv"}}`)
	generator := &remediationGenerator{}
	finalizer := &remediationFinalizer{}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{int64(42), "monthly_report", "pending", payload, (*string)(nil)}},
			remediationRow{values: []any{int64(77)}},
			remediationRow{values: []any{int64(5), "success", "/tmp/report.xlsx", int64(7), "Project A", "US", "2026-10"}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		MonthlyReportGenerator: generator,
		MonthlyReportFinalizer: finalizer,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})
	if err := handler.HandleRunJob(context.Background(), task); err != nil {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	if generator.calls != 0 || finalizer.calls != 0 {
		t.Fatalf("already-finalized report was regenerated: generator=%d finalizer=%d", generator.calls, finalizer.calls)
	}
}

func TestRemediationRunJobRequiresMonthlyDependencies(t *testing.T) {
	payload := []byte(`{"job_type":"monthly_report","file_id":"tx.csv","params":{"report_id":5,"project_id":7,"project_name":"Project A","country":"US","report_month":"2026-10","transaction_file_id":"tx.csv"}}`)
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{int64(42), "monthly_report", "pending", payload, (*string)(nil)}},
			remediationRow{values: []any{int64(77)}},
			remediationRow{values: []any{int64(5), "pending", "", int64(7), "Project A", "US", "2026-10"}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})
	err := handler.HandleRunJob(context.Background(), task)
	if !errors.Is(err, ErrDependencyNotConfigured) {
		t.Fatalf("monthly dependency error = %v, want ErrDependencyNotConfigured", err)
	}
}

func TestRemediationRunJobFinalizerFailureMarksReportAndRunFailed(t *testing.T) {
	payload := []byte(`{"job_type":"monthly_report","file_id":"tx.csv","params":{"report_id":5,"project_id":7,"project_name":"Project A","country":"US","report_month":"2026-10","transaction_file_id":"tx.csv"}}`)
	generator := &remediationGenerator{}
	finalizer := &remediationFinalizer{err: errors.New("finalize failed")}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{int64(42), "monthly_report", "pending", payload, (*string)(nil)}},
			remediationRow{values: []any{int64(77)}},
			remediationRow{values: []any{int64(5), "pending", "", int64(7), "Project A", "US", "2026-10"}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		MonthlyReportGenerator: generator,
		MonthlyReportFinalizer: finalizer,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})
	err := handler.HandleRunJob(context.Background(), task)
	if err == nil || !strings.Contains(err.Error(), "finalize failed") {
		t.Fatalf("finalizer failure error = %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	var reportFailed, runAppended, jobFailed bool
	for _, call := range db.execCalls {
		if strings.Contains(call.sql, "UPDATE public.monthly_reports") && strings.Contains(call.sql, "status = 'failed'") {
			reportFailed = true
		}
		if strings.Contains(call.sql, "UPDATE public.job_runs") && strings.Contains(call.sql, "error_message = CASE") {
			runAppended = true
		}
		if strings.Contains(call.sql, "UPDATE public.jobs") && strings.Contains(call.sql, "status = 'failed'") {
			jobFailed = true
		}
	}
	if !reportFailed || !runAppended || !jobFailed {
		t.Fatalf("failure updates missing: report=%v run=%v job=%v calls=%#v", reportFailed, runAppended, jobFailed, db.execCalls)
	}
}

func TestRemediationCleanupUsesParameterizedSQLAndScopedDirectories(t *testing.T) {
	root := t.TempDir()
	buildDir := filepath.Join(root, "builds", "3")
	uploadDir := filepath.Join(root, "uploads", "4")
	if err := os.MkdirAll(buildDir, 0o700); err != nil {
		t.Fatalf("MkdirAll(build) error = %v", err)
	}
	if err := os.MkdirAll(uploadDir, 0o700); err != nil {
		t.Fatalf("MkdirAll(upload) error = %v", err)
	}
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	db := &remediationDB{
		queryResponses: []remediationQueryResponse{
			{rows: remediationStaticRows([]any{int64(3)})},
			{rows: remediationStaticRows([]any{int64(4)})},
		},
		execResponses: []remediationExecResponse{
			{tag: pgconn.NewCommandTag("UPDATE 1")},
			{tag: pgconn.NewCommandTag("UPDATE 2")},
			{tag: pgconn.NewCommandTag("UPDATE 3")},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		AgentMonthlyReportRoot:         root,
		AgentMonthlyReportBuildTimeout: 25 * time.Minute,
		Now:                            func() time.Time { return now },
	})
	task := remediationTask(t, queue.TypeAgentMonthlyReportCleanup, AgentMonthlyReportCleanupPayload{})
	if err := handler.HandleAgentMonthlyReportCleanup(context.Background(), task); err != nil {
		t.Fatalf("HandleAgentMonthlyReportCleanup() error = %v", err)
	}
	if _, err := os.Stat(buildDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("build dir still exists: %v", err)
	}
	if _, err := os.Stat(uploadDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("upload dir still exists: %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, call := range db.execCalls {
		if strings.Contains(call.sql, "agent_monthly_report_") && len(call.args) == 0 {
			t.Fatalf("cleanup SQL is not parameterized: %s", call.sql)
		}
	}
}

func TestRemediationCleanupPropagatesDatabaseError(t *testing.T) {
	db := &remediationDB{
		execResponses: []remediationExecResponse{
			{err: errors.New("cleanup database unavailable")},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		AgentMonthlyReportRoot: t.TempDir(),
	})
	task := remediationTask(t, queue.TypeAgentMonthlyReportCleanup, AgentMonthlyReportCleanupPayload{})
	err := handler.HandleAgentMonthlyReportCleanup(context.Background(), task)
	if err == nil || !strings.Contains(err.Error(), "cleanup database unavailable") {
		t.Fatalf("cleanup DB error = %v", err)
	}
}

func TestRemediationAlertDetectReadsRulesAndWritesDeduplicatedEvent(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	db := &remediationDB{
		queryResponses: []remediationQueryResponse{
			{rows: remediationStaticRows([]any{
				int64(1), "sales drop", int64(7), "US", "sales_amount",
				"threshold", "drop_pct", float64(20), 7, "warning", "in_app",
			})},
		},
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{float64(70), float64(100)}},
		},
		execResponses: []remediationExecResponse{
			{tag: pgconn.NewCommandTag("INSERT 1")},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{Now: func() time.Time { return now }})
	task := remediationTask(t, queue.TypeAlertDetect, AlertDetectPayload{})
	if err := handler.HandleAlertDetect(context.Background(), task); err != nil {
		t.Fatalf("HandleAlertDetect() error = %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.queryCalls) != 1 || !strings.Contains(db.queryCalls[0].sql, "alert_rules") {
		t.Fatalf("alert rule query = %#v", db.queryCalls)
	}
	if len(db.queryRowCalls) != 1 || !strings.Contains(db.queryRowCalls[0].sql, "analysis_sales_order_rows") {
		t.Fatalf("alert metric query = %#v", db.queryRowCalls)
	}
	if len(db.execCalls) != 1 ||
		!strings.Contains(db.execCalls[0].sql, "INSERT INTO alert_events") ||
		!strings.Contains(db.execCalls[0].sql, "NOT EXISTS") {
		t.Fatalf("alert insert = %#v", db.execCalls)
	}
}

func TestRemediationReturnRefreshUsesLookbackAndAggregateSQL(t *testing.T) {
	location := time.FixedZone("CST", 8*60*60)
	now := time.Date(2026, 11, 8, 0, 0, 0, 0, location)
	db := &remediationDB{}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		Location: location,
		Now:      func() time.Time { return now },
	})
	task := remediationTask(t, queue.TypeReturnAnalysisRefreshDaily, ReturnAnalysisRefreshPayload{
		LookbackDays: remediationIntPointer(3),
	})
	if err := handler.HandleReturnAnalysisRefreshDaily(context.Background(), task); err != nil {
		t.Fatalf("HandleReturnAnalysisRefreshDaily() error = %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.execCalls) != 3 {
		t.Fatalf("return refresh writes = %d, want 3", len(db.execCalls))
	}
	for _, call := range db.execCalls {
		if !strings.Contains(call.sql, "analysis_return_aggregates") ||
			!strings.Contains(call.sql, "ON CONFLICT") {
			t.Fatalf("return refresh SQL = %s", call.sql)
		}
	}
}

func TestRemediationReturnRebuildDeletesAndRepopulatesRange(t *testing.T) {
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{
				time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC),
				time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC),
			}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{})
	task := remediationTask(t, queue.TypeReturnAnalysisRebuild, ReturnAnalysisRebuildPayload{})
	if err := handler.HandleReturnAnalysisRebuild(context.Background(), task); err != nil {
		t.Fatalf("HandleReturnAnalysisRebuild() error = %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.execCalls) != 4 {
		t.Fatalf("return rebuild writes = %d, want delete + 3 days", len(db.execCalls))
	}
	if !strings.Contains(db.execCalls[0].sql, "DELETE FROM analysis_return_aggregates") {
		t.Fatalf("first rebuild SQL = %s", db.execCalls[0].sql)
	}
}

func TestRemediationCRMRuleEngineHonorsConfigDisable(t *testing.T) {
	db := &remediationDB{}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{CRMRuleEngineEnabled: false})
	task := remediationTask(t, queue.TypeCRMRuleEngine, CRMRuleEnginePayload{})
	if err := handler.HandleCRMRuleEngine(context.Background(), task); err != nil {
		t.Fatalf("HandleCRMRuleEngine() error = %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.queryCalls) != 0 || len(db.execCalls) != 0 {
		t.Fatalf("disabled rule engine queried/wrote: queries=%#v writes=%#v", db.queryCalls, db.execCalls)
	}
}

func TestRemediationCRMRuleEngineEnabledUsesRulesTables(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	db := &remediationDB{
		queryResponses: []remediationQueryResponse{
			{rows: remediationStaticRows([]any{int64(1), "empty rule", "customer", "stale_follow_up", 0})},
			{rows: remediationStaticRows()},
			{rows: remediationStaticRows()},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		CRMRuleEngineEnabled: true,
		Now:                  func() time.Time { return now },
	})
	task := remediationTask(t, queue.TypeCRMRuleEngine, CRMRuleEnginePayload{})
	if err := handler.HandleCRMRuleEngine(context.Background(), task); err != nil {
		t.Fatalf("HandleCRMRuleEngine() error = %v", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.queryCalls) != 3 {
		t.Fatalf("rule engine queries = %d, want rules/conditions/actions", len(db.queryCalls))
	}
	if !strings.Contains(db.queryCalls[0].sql, "crm_rules") ||
		!strings.Contains(db.queryCalls[1].sql, "crm_rule_conditions") ||
		!strings.Contains(db.queryCalls[2].sql, "crm_rule_actions") {
		t.Fatalf("rule engine query tables = %#v", db.queryCalls)
	}
	if len(db.execCalls) != 1 || !strings.Contains(db.execCalls[0].sql, "crm_audit_logs") {
		t.Fatalf("rule execution log = %#v", db.execCalls)
	}
}

func TestRemediationCRMStaleEmailRequiresMailerAfterSettingsRead(t *testing.T) {
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{7, true}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{CRMStaleEmailEnabled: true})
	task := remediationTask(t, queue.TypeCRMStaleEmail, CRMStaleEmailPayload{})
	err := handler.HandleCRMStaleEmail(context.Background(), task)
	if !errors.Is(err, ErrDependencyNotConfigured) {
		t.Fatalf("stale email error = %v, want ErrDependencyNotConfigured", err)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.queryRowCalls) != 1 ||
		!strings.Contains(db.queryRowCalls[0].sql, "crm_workflow_settings") {
		t.Fatalf("stale email settings query = %#v", db.queryRowCalls)
	}
}

func TestRemediationCRMStaleEmailSendsAndMarksSuccessfulEntities(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	mailer := &remediationMailer{}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{7, true}},
		},
		queryResponses: []remediationQueryResponse{
			{rows: remediationStaticRows(
				[]any{
					"customer", int64(1), "Acme", "owner-1", "Owner",
					"owner@example.com", now.AddDate(0, 0, -8), (*time.Time)(nil),
				},
				[]any{
					"lead", int64(2), "Lead", "owner-1", "Owner",
					"owner@example.com", now.AddDate(0, 0, -9), (*time.Time)(nil),
				},
			)},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		CRMStaleEmailEnabled: true,
		Mailer:               mailer,
		Now:                  func() time.Time { return now },
	})
	task := remediationTask(t, queue.TypeCRMStaleEmail, CRMStaleEmailPayload{})
	if err := handler.HandleCRMStaleEmail(context.Background(), task); err != nil {
		t.Fatalf("HandleCRMStaleEmail() error = %v", err)
	}
	if mailer.calls != 1 || mailer.to != "owner@example.com" ||
		!strings.Contains(mailer.subject, "超过 7 天未跟进") ||
		!strings.Contains(mailer.body, "Acme") ||
		!strings.Contains(mailer.body, "Lead") {
		t.Fatalf("mailer call = %#v", mailer)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.execCalls) != 2 ||
		!strings.Contains(db.execCalls[0].sql, "crm_customers") ||
		!strings.Contains(db.execCalls[1].sql, "crm_leads") {
		t.Fatalf("stale email marker writes = %#v", db.execCalls)
	}
}

func TestRemediationValidateRuntimeAggregatesMissingDependencies(t *testing.T) {
	handler := NewTaskHandlerWithDB(nil, DefaultHandlerConfig())
	err := handler.ValidateRuntime()
	if err == nil {
		t.Fatal("ValidateRuntime() error = nil")
	}
	for _, fragment := range []string{"database", "monthly report generator", "monthly report finalizer", "mailer"} {
		if !strings.Contains(strings.ToLower(err.Error()), fragment) {
			t.Fatalf("ValidateRuntime() = %v, missing %q", err, fragment)
		}
	}
}

func TestRemediationValidateRuntimeAcceptsCompleteConfiguration(t *testing.T) {
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{
		MonthlyReportGenerator:         &remediationGenerator{},
		MonthlyReportFinalizer:         &remediationFinalizer{},
		Mailer:                         &remediationMailer{},
		CRMStaleEmailEnabled:           true,
		AgentMonthlyReportRoot:         t.TempDir(),
		AgentMonthlyReportBuildTimeout: 25 * time.Minute,
	})
	if err := handler.ValidateRuntime(); err != nil {
		t.Fatalf("ValidateRuntime() error = %v", err)
	}
}

func TestRemediationCRMHandlersUseConfiguredDefaults(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	seaDB := &remediationDB{queryRowResponses: []pgx.Row{
		remediationRow{values: []any{int64(1), int64(2)}},
	}}
	seaHandler := NewTaskHandlerWithDB(seaDB, HandlerConfig{
		CRMSeaReclaimDays: 9,
		Now:               func() time.Time { return now },
	})
	seaTask := remediationTask(t, queue.TypeCRMSeaReclaim, CRMSeaReclaimPayload{})
	if err := seaHandler.HandleCRMSeaReclaim(context.Background(), seaTask); err != nil {
		t.Fatalf("HandleCRMSeaReclaim() error = %v", err)
	}
	seaDB.mu.Lock()
	wantCutoff := now.AddDate(0, 0, -9)
	if len(seaDB.queryRowCalls) != 1 ||
		!reflect.DeepEqual(seaDB.queryRowCalls[0].args[0], wantCutoff) ||
		!strings.Contains(seaDB.queryRowCalls[0].args[1].(string), "9 天") {
		t.Fatalf("sea reclaim args = %#v", seaDB.queryRowCalls)
	}
	seaDB.mu.Unlock()

	taskDB := &remediationDB{execResponses: []remediationExecResponse{
		{tag: pgconn.NewCommandTag("UPDATE 2")},
	}}
	taskHandler := NewTaskHandlerWithDB(taskDB, HandlerConfig{
		CRMTaskReminderLeadHours: 12,
		Now:                      func() time.Time { return now },
	})
	task := remediationTask(t, queue.TypeCRMTaskReminder, CRMTaskReminderPayload{})
	if err := taskHandler.HandleCRMTaskReminder(context.Background(), task); err != nil {
		t.Fatalf("HandleCRMTaskReminder() error = %v", err)
	}
	taskDB.mu.Lock()
	defer taskDB.mu.Unlock()
	matchedTaskArgs := false
	for _, call := range taskDB.execCalls {
		if len(call.args) == 2 &&
			reflect.DeepEqual(call.args[0], now) &&
			reflect.DeepEqual(call.args[1], now.Add(12*time.Hour)) {
			matchedTaskArgs = true
			break
		}
	}
	if !matchedTaskArgs {
		t.Fatalf("task reminder config args = %#v", taskDB.execCalls)
	}
}

func remediationIntPointer(value int) *int { return &value }

func remediationInt64Pointer(value int64) *int64 { return &value }
