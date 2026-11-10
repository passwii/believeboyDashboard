package tasks

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis"
	productreports "github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/testutil"
)

type remediationProductAnalysisExecutor struct {
	calls  int
	input  ProductAnalysisReportExecutionInput
	result *ProductAnalysisReportExecutionResult
	err    error
}

func (executor *remediationProductAnalysisExecutor) Execute(
	_ context.Context,
	input ProductAnalysisReportExecutionInput,
) (*ProductAnalysisReportExecutionResult, error) {
	executor.calls++
	executor.input = input
	if executor.err != nil {
		return nil, executor.err
	}
	return executor.result, nil
}

type remediationProductAnalysisFilesRunner struct {
	calls  int
	input  store.ProductAnalysisFilesInput
	result *product_analysis.RunResponse
	err    error
}

func (runner *remediationProductAnalysisFilesRunner) Run(
	_ context.Context,
	input store.ProductAnalysisFilesInput,
) (*product_analysis.RunResponse, error) {
	runner.calls++
	runner.input = input
	if runner.err != nil {
		return nil, runner.err
	}
	return runner.result, nil
}

func TestRemediationRunJobProductAnalysisSuccess(t *testing.T) {
	payload := []byte(`{
		"job_type":"product_analysis",
		"file_id":"business.csv",
		"params":{
			"project_id":7,
			"project_name":"Project A",
			"country":"US",
			"report_start_date":"2026-10-26",
			"report_end_date":"2026-11-01",
			"file_ids":{
				"business_report":"business.csv",
				"payment_report":"payment.csv",
				"ad_report":"ad.xlsx"
			},
			"resolved_file_paths":{
				"business_report":"/tmp/business.csv",
				"payment_report":"/tmp/payment.csv",
				"ad_report":"/tmp/ad.xlsx"
			}
		}
	}`)
	executor := &remediationProductAnalysisExecutor{
		result: &ProductAnalysisReportExecutionResult{
			ResultPath:  "/tmp/product-analysis.xlsx",
			Filename:    "product-analysis.xlsx",
			RowCount:    3,
			PeriodCount: 1,
		},
	}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{
				int64(42),
				productreports.JobType,
				productreports.StatusPending,
				payload,
				(*string)(nil),
			}},
			remediationRow{values: []any{int64(77)}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		ProductAnalysisReportExecutor: executor,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})

	if err := handler.HandleRunJob(context.Background(), task); err != nil {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	if executor.calls != 1 {
		t.Fatalf("product executor calls = %d, want 1", executor.calls)
	}
	if executor.input.JobID != 42 ||
		executor.input.ProjectID != 7 ||
		executor.input.ProjectName != "Project A" ||
		executor.input.Country != "US" ||
		executor.input.ReportStartDate != "2026-10-26" ||
		executor.input.ReportEndDate != "2026-11-01" {
		t.Fatalf("product executor input = %#v", executor.input)
	}
	if executor.input.FileIDs["business_report"] != "business.csv" ||
		executor.input.ResolvedFilePaths["payment_report"] != "/tmp/payment.csv" {
		t.Fatalf("product executor paths = %#v %#v", executor.input.FileIDs, executor.input.ResolvedFilePaths)
	}
	assertRunJobStatusWrites(t, db, true, false)
}

func TestRunJobProductAnalysisMissingExecutorMarksFailed(t *testing.T) {
	payload := []byte(`{
		"job_type":"product_analysis",
		"params":{
			"project_id":7,
			"project_name":"Project A",
			"country":"US",
			"report_start_date":"2026-10-26",
			"report_end_date":"2026-11-01",
			"file_ids":{
				"business_report":"business.csv",
				"payment_report":"payment.csv",
				"ad_report":"ad.xlsx"
			}
		}
	}`)
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{
				int64(42),
				productreports.JobType,
				productreports.StatusPending,
				payload,
				(*string)(nil),
			}},
			remediationRow{values: []any{int64(77)}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})

	err := handler.HandleRunJob(context.Background(), task)
	if !errors.Is(err, ErrDependencyNotConfigured) {
		t.Fatalf("HandleRunJob() error = %v, want ErrDependencyNotConfigured", err)
	}
	assertRunJobStatusWrites(t, db, false, true)
}

func TestRunJobProductAnalysisExecutorFailureMarksFailed(t *testing.T) {
	payload := []byte(`{
		"job_type":"product_analysis",
		"params":{
			"project_id":7,
			"project_name":"Project A",
			"country":"US",
			"report_start_date":"2026-10-26",
			"report_end_date":"2026-11-01",
			"file_ids":{
				"business_report":"business.csv",
				"payment_report":"payment.csv",
				"ad_report":"ad.xlsx"
			}
		}
	}`)
	executor := &remediationProductAnalysisExecutor{err: errors.New("calculation failed")}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{
				int64(42),
				productreports.JobType,
				productreports.StatusPending,
				payload,
				(*string)(nil),
			}},
			remediationRow{values: []any{int64(77)}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		ProductAnalysisReportExecutor: executor,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})

	err := handler.HandleRunJob(context.Background(), task)
	if err == nil || !strings.Contains(err.Error(), "calculation failed") {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	if executor.calls != 1 {
		t.Fatalf("product executor calls = %d, want 1", executor.calls)
	}
	assertRunJobStatusWrites(t, db, false, true)
}

func TestRunJobProductAnalysisRunningReusesLatestRun(t *testing.T) {
	payload := []byte(`{
		"job_type":"product_analysis",
		"params":{
			"project_id":7,
			"project_name":"Project A",
			"country":"US",
			"report_start_date":"2026-10-26",
			"report_end_date":"2026-11-01",
			"file_ids":{
				"business_report":"business.csv",
				"payment_report":"payment.csv",
				"ad_report":"ad.xlsx"
			}
		}
	}`)
	executor := &remediationProductAnalysisExecutor{
		result: &ProductAnalysisReportExecutionResult{
			ResultPath: "/tmp/product-analysis.xlsx",
			Filename:   "product-analysis.xlsx",
			RowCount:   1,
		},
	}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{
				int64(42),
				productreports.JobType,
				productreports.StatusRunning,
				payload,
				(*string)(nil),
			}},
			remediationRow{values: []any{int64(77)}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		ProductAnalysisReportExecutor: executor,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})

	if err := handler.HandleRunJob(context.Background(), task); err != nil {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	if executor.calls != 1 {
		t.Fatalf("product executor calls = %d, want 1", executor.calls)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, call := range db.execCalls {
		if strings.Contains(call.sql, "INSERT INTO public.job_runs") {
			t.Fatalf("running product job created a second run: %s", call.sql)
		}
	}
}

func TestRunJobProductAnalysisSuccessIsIdempotent(t *testing.T) {
	payload := []byte(`{"job_type":"product_analysis","params":{"project_id":7}}`)
	executor := &remediationProductAnalysisExecutor{
		result: &ProductAnalysisReportExecutionResult{ResultPath: "/tmp/new.xlsx"},
	}
	db := &remediationDB{
		queryRowResponses: []pgx.Row{
			remediationRow{values: []any{
				int64(42),
				productreports.JobType,
				productreports.StatusSuccess,
				payload,
				(*string)(nil),
			}},
		},
	}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		ProductAnalysisReportExecutor: executor,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})

	if err := handler.HandleRunJob(context.Background(), task); err != nil {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	if executor.calls != 0 {
		t.Fatalf("already-successful product job executor calls = %d, want 0", executor.calls)
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.execCalls) != 0 {
		t.Fatalf("already-successful product job made %d writes", len(db.execCalls))
	}
}

func TestProductAnalysisExecutorWritesRealXLSX(t *testing.T) {
	uploadRoot := t.TempDir()
	resultRoot := t.TempDir()
	files := createProductAnalysisInputFiles(t, uploadRoot)
	if err := os.WriteFile(
		filepath.Join(uploadRoot, "inventory.csv"),
		[]byte("sku\tasin\tavailable\tinv-age-0-to-90-days\trecommended-action\nSKU-1\tASIN-1\t12\t10\tKeep\n"),
		0o600,
	); err != nil {
		t.Fatalf("write inventory fixture: %v", err)
	}
	runner := &remediationProductAnalysisFilesRunner{
		result: &product_analysis.RunResponse{
			ProjectID:    7,
			ProjectName:  "Project A",
			Country:      "US",
			TotalPeriods: 1,
			Periods: []product_analysis.CalculationPeriod{
				{
					ReportStartDate: "2026-10-26",
					ReportEndDate:   "2026-11-01",
					Summary: map[string]any{
						"日期":   "20261026-1101",
						"SKU":  "汇总",
						"ASIN": "汇总",
						"总销量":  3,
						"总销售额": 100.0,
					},
					Details: []map[string]any{
						{
							"日期":   "20261026-1101",
							"SKU":  "SKU-1",
							"ASIN": "ASIN-1",
							"总销量":  3,
							"总销售额": 100.0,
						},
					},
				},
			},
		},
	}
	executor := newProductAnalysisReportFileExecutor(runner, uploadRoot, resultRoot)
	result, err := executor.Execute(
		context.Background(),
		ProductAnalysisReportExecutionInput{
			JobID:             42,
			ProjectID:         7,
			ProjectName:       "Project A",
			Country:           "US",
			ReportStartDate:   "2026-10-26",
			ReportEndDate:     "2026-11-01",
			FileIDs:           map[string]string{},
			ResolvedFilePaths: files,
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if runner.calls != 1 {
		t.Fatalf("files runner calls = %d, want 1", runner.calls)
	}
	if result == nil || result.ResultPath == "" || result.RowCount != 1 || result.PeriodCount != 1 {
		t.Fatalf("Execute() result = %#v", result)
	}
	file, err := os.Open(result.ResultPath)
	if err != nil {
		t.Fatalf("open result: %v", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() == 0 {
		t.Fatalf("result stat = %#v, %v", info, err)
	}
	reader, err := zip.NewReader(file, info.Size())
	if err != nil {
		t.Fatalf("open result zip: %v", err)
	}
	entries := map[string][]byte{}
	for _, entry := range reader.File {
		entryReader, err := entry.Open()
		if err != nil {
			t.Fatalf("open zip entry %s: %v", entry.Name, err)
		}
		content, err := io.ReadAll(entryReader)
		_ = entryReader.Close()
		if err != nil {
			t.Fatalf("read zip entry %s: %v", entry.Name, err)
		}
		entries[entry.Name] = content
	}
	for _, name := range []string{
		"xl/workbook.xml",
		"xl/worksheets/sheet1.xml",
		"xl/worksheets/sheet2.xml",
	} {
		if len(entries[name]) == 0 {
			t.Fatalf("missing xlsx part %q", name)
		}
	}
	if !bytes.Contains(entries["xl/workbook.xml"], []byte("产品分析")) ||
		!bytes.Contains(entries["xl/workbook.xml"], []byte("库存详情")) {
		t.Fatalf("workbook sheets = %s", entries["xl/workbook.xml"])
	}
}

func TestProductAnalysisExecutorRejectsTraversalAndSymlink(t *testing.T) {
	testutil.RequireSymlink(t)
	uploadRoot := t.TempDir()
	resultRoot := t.TempDir()
	files := createProductAnalysisInputFiles(t, uploadRoot)

	outside := filepath.Join(t.TempDir(), "outside.csv")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	symlinkPath := filepath.Join(uploadRoot, "business-link.csv")
	if err := os.Symlink(outside, symlinkPath); err != nil {
		t.Fatalf("create symlink: %v", err)
	}

	testCases := []struct {
		name string
		path string
	}{
		{name: "traversal", path: filepath.Join(uploadRoot, "..", "outside.csv")},
		{name: "symlink", path: symlinkPath},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runner := &remediationProductAnalysisFilesRunner{}
			executor := newProductAnalysisReportFileExecutor(runner, uploadRoot, resultRoot)
			paths := copyStringMap(files)
			paths["business_report"] = testCase.path
			_, err := executor.Execute(
				context.Background(),
				ProductAnalysisReportExecutionInput{
					JobID:             42,
					ProjectID:         7,
					ProjectName:       "Project A",
					Country:           "US",
					ReportStartDate:   "2026-10-26",
					ReportEndDate:     "2026-11-01",
					ResolvedFilePaths: paths,
				},
			)
			if err == nil {
				t.Fatal("Execute() error = nil, want unsafe path rejection")
			}
			if runner.calls != 0 {
				t.Fatalf("unsafe path reached runner %d times", runner.calls)
			}
		})
	}
}

func assertRunJobStatusWrites(
	t *testing.T,
	db *remediationDB,
	wantSuccess bool,
	wantFailure bool,
) {
	t.Helper()
	db.mu.Lock()
	defer db.mu.Unlock()
	var successJob, successRun, failedJob, failedRun bool
	for _, call := range db.execCalls {
		switch {
		case strings.Contains(call.sql, "UPDATE public.jobs") &&
			strings.Contains(call.sql, "status = 'success'"):
			successJob = true
		case strings.Contains(call.sql, "UPDATE public.job_runs") &&
			strings.Contains(call.sql, "result_path = $3"):
			successRun = true
		case strings.Contains(call.sql, "UPDATE public.jobs") &&
			strings.Contains(call.sql, "status = 'failed'"):
			failedJob = true
		case strings.Contains(call.sql, "UPDATE public.job_runs") &&
			strings.Contains(call.sql, "error_message = CASE"):
			failedRun = true
		}
	}
	if wantSuccess && (!successJob || !successRun) {
		t.Fatalf("success writes missing: job=%v run=%v calls=%#v", successJob, successRun, db.execCalls)
	}
	if wantFailure && (!failedJob || !failedRun) {
		t.Fatalf("failure writes missing: job=%v run=%v calls=%#v", failedJob, failedRun, db.execCalls)
	}
}

func createProductAnalysisInputFiles(t *testing.T, uploadRoot string) map[string]string {
	t.Helper()
	files := map[string]string{
		"business_report":  filepath.Join(uploadRoot, "business.csv"),
		"payment_report":   filepath.Join(uploadRoot, "payment.csv"),
		"ad_report":        filepath.Join(uploadRoot, "ad.xlsx"),
		"inventory_report": filepath.Join(uploadRoot, "inventory.csv"),
	}
	for _, path := range files {
		if err := os.WriteFile(path, []byte("fixture"), 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	return files
}

func copyStringMap(source map[string]string) map[string]string {
	destination := make(map[string]string, len(source))
	for key, value := range source {
		destination[key] = value
	}
	return destination
}
