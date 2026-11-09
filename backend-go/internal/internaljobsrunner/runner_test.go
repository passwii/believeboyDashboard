package internaljobsrunner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_jobs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func TestRunnerRejectsInvalidParametersBeforeCreatingJob(t *testing.T) {
	runner := New(nil)
	if _, err := runner.RefreshReturnAnalysis(context.Background(), "2026-2-3", 1); err == nil {
		t.Fatal("invalid date error = nil")
	}
	if _, err := runner.RefreshReturnAnalysis(context.Background(), "2026-02-03", 0); err == nil {
		t.Fatal("invalid backfill error = nil")
	}
	if _, err := runner.RebuildReturnAnalysis(context.Background()); !errors.Is(
		err,
		internal_jobs.ErrDependencyNotConfigured,
	) {
		t.Fatalf("missing database error = %v", err)
	}
}

func TestRunnerRefreshBLFTestRollback(t *testing.T) {
	db, pool := openRunnerIntegrationDB(t)
	tx := beginRunnerIntegrationTx(t, pool)

	target := "2026-06-15"
	projectID := seedReturnAnalysisFixture(t, tx, target)
	runner := New(db, WithNow(func() time.Time {
		return time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	}))
	rebuildStart, rebuildEnd, err := runner.loadDefaultRebuildSpan(context.Background(), db)
	if err != nil {
		t.Fatalf("loadDefaultRebuildSpan() error = %v", err)
	}
	if rebuildEnd.Format("2006-01-02") != "2026-11-07" ||
		rebuildStart.After(rebuildEnd) {
		t.Fatalf(
			"default rebuild span = %s..%s",
			rebuildStart.Format("2006-01-02"),
			rebuildEnd.Format("2006-01-02"),
		)
	}
	ctx := internal_jobs.WithRunnerExecution(
		context.Background(),
		tx,
		"internal-jobs-runner-test",
	)
	result, err := runner.RefreshReturnAnalysis(ctx, target, 1)
	if err != nil {
		t.Fatalf("RefreshReturnAnalysis() error = %v", err)
	}
	if result.RowsWritten != 1 || result.Projects != 1 {
		t.Fatalf("RefreshReturnAnalysis() result = %#v", result)
	}
	assertAggregateFixture(t, tx, target, projectID, 2)
	second, err := runner.RefreshReturnAnalysis(ctx, target, 1)
	if err != nil {
		t.Fatalf("second RefreshReturnAnalysis() error = %v", err)
	}
	if second.RowsWritten != 1 || second.Projects != 1 {
		t.Fatalf("second RefreshReturnAnalysis() result = %#v", second)
	}
	assertAggregateFixture(t, tx, target, projectID, 3)
	jobID, jobStatus, jobPayload := latestInternalJob(t, tx, returnAnalysisRefreshJobType)
	if jobStatus != "success" {
		t.Fatalf("job status = %q, want success", jobStatus)
	}
	if !strings.Contains(jobPayload, target) {
		t.Fatalf("job payload = %s, want target date %s", jobPayload, target)
	}
	runStatus, runError := latestInternalJobRun(t, tx, jobID)
	if runStatus != "finished" || runError != "" {
		t.Fatalf("job run status/error = %q/%q, want finished/no error", runStatus, runError)
	}
}

func TestRunnerRecordsExecutionFailureBLFTestRollback(t *testing.T) {
	db, pool := openRunnerIntegrationDB(t)
	tx := beginRunnerIntegrationTx(t, pool)

	runner := New(db, WithNow(func() time.Time {
		return time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	}))
	runner.refreshRange = func(
		context.Context,
		store.FullDB,
		time.Time,
		time.Time,
	) (rangeResult, error) {
		return rangeResult{}, errors.New("forced refresh failure")
	}
	ctx := internal_jobs.WithRunnerExecution(
		context.Background(),
		tx,
		"internal-jobs-runner-test",
	)
	_, err := runner.RefreshReturnAnalysis(ctx, "2026-11-07", 1)
	if err == nil || !strings.Contains(err.Error(), "forced refresh failure") {
		t.Fatalf("RefreshReturnAnalysis() error = %v", err)
	}
	jobID, jobStatus, _ := latestInternalJob(t, tx, returnAnalysisRefreshJobType)
	if jobStatus != "failed" {
		t.Fatalf("job status = %q, want failed", jobStatus)
	}
	runStatus, runError := latestInternalJobRun(t, tx, jobID)
	if runStatus != "finished" || !strings.Contains(runError, "forced refresh failure") {
		t.Fatalf("job run status/error = %q/%q", runStatus, runError)
	}
}

func TestRunnerRecordsRebuildPreflightFailureBLFTestRollback(t *testing.T) {
	db, pool := openRunnerIntegrationDB(t)
	tx := beginRunnerIntegrationTx(t, pool)

	runner := New(db)
	runner.loadRebuildSpan = func(context.Context, store.FullDB) (time.Time, time.Time, error) {
		return time.Time{}, time.Time{}, errors.New("forced rebuild range failure")
	}
	ctx := internal_jobs.WithRunnerExecution(
		context.Background(),
		tx,
		"internal-jobs-runner-test",
	)
	_, err := runner.RebuildReturnAnalysis(ctx)
	if err == nil || !strings.Contains(err.Error(), "forced rebuild range failure") {
		t.Fatalf("RebuildReturnAnalysis() error = %v", err)
	}
	jobID, jobStatus, _ := latestInternalJob(t, tx, returnAnalysisRebuildJobType)
	if jobStatus != "failed" {
		t.Fatalf("job status = %q, want failed", jobStatus)
	}
	runStatus, runError := latestInternalJobRun(t, tx, jobID)
	if runStatus != "finished" || !strings.Contains(runError, "forced rebuild range failure") {
		t.Fatalf("job run status/error = %q/%q", runStatus, runError)
	}
}

func TestRunnerRebuildBLFTestRollback(t *testing.T) {
	db, pool := openRunnerIntegrationDB(t)
	tx := beginRunnerIntegrationTx(t, pool)

	target := "2026-06-15"
	projectID := seedReturnAnalysisFixture(t, tx, target)
	runner := New(db)
	runner.loadRebuildSpan = func(context.Context, store.FullDB) (time.Time, time.Time, error) {
		parsed, err := parseISODate(target, runner.location)
		return parsed, parsed, err
	}
	ctx := internal_jobs.WithRunnerExecution(
		context.Background(),
		tx,
		"internal-jobs-runner-test",
	)
	result, err := runner.RebuildReturnAnalysis(ctx)
	if err != nil {
		t.Fatalf("RebuildReturnAnalysis() error = %v", err)
	}
	if result.RangeStart != target || result.RangeEnd != target {
		t.Fatalf("rebuild range = %s..%s, want %s", result.RangeStart, result.RangeEnd, target)
	}
	if result.RowsWritten != 1 || result.ProjectsTouched != 1 {
		t.Fatalf("rebuild result = %#v", result)
	}
	assertAggregateFixture(t, tx, target, projectID, 2)
	jobID, jobStatus, _ := latestInternalJob(t, tx, returnAnalysisRebuildJobType)
	if jobStatus != "success" {
		t.Fatalf("job status = %q, want success", jobStatus)
	}
	runStatus, runError := latestInternalJobRun(t, tx, jobID)
	if runStatus != "finished" || runError != "" {
		t.Fatalf("job run status/error = %q/%q, want finished/no error", runStatus, runError)
	}
}

func openRunnerIntegrationDB(t *testing.T) (store.FullDB, *pgxpool.Pool) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	ctx := context.Background()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)
	return store.NewPGXDB(pool), pool
}

func beginRunnerIntegrationTx(t *testing.T, pool *pgxpool.Pool) pgx.Tx {
	t.Helper()
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	t.Cleanup(func() {
		_ = tx.Rollback(context.Background())
	})
	return tx
}

func seedReturnAnalysisFixture(t *testing.T, tx pgx.Tx, dateText string) int64 {
	t.Helper()
	var projectID, returnSourceID, salesSourceID int64
	if err := tx.QueryRow(
		context.Background(),
		`insert into public.projects (
		   project_name, sort_order, country, is_active, project_context,
		   sku_context, vat_enabled
		 ) values ($1, 0, 'US', false, '{}'::json, '{}'::json, false)
		 returning id`,
		fmt.Sprintf("internal-jobs-runner-%d", time.Now().UnixNano()),
	).Scan(&projectID); err != nil {
		t.Fatalf("create project fixture: %v", err)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	if err := tx.QueryRow(
		context.Background(),
		`insert into public.analysis_source_files (
		   project_id, report_type, period_start_date, period_end_date,
		   is_current, upload_file_id, upload_file_path, stored_filename,
		   logical_filename, storage_key, ingestion_status, country, report_date
		 ) values (
		   $1, 'return_report', $2::date, $2::date, true, $3, $4, $5,
		   $5, $4, 'success', 'US', $2::date
		 ) returning id`,
		projectID,
		dateText,
		"return-"+suffix,
		"return/"+suffix+".csv",
		"return-"+suffix+".csv",
	).Scan(&returnSourceID); err != nil {
		t.Fatalf("create return source fixture: %v", err)
	}
	if err := tx.QueryRow(
		context.Background(),
		`insert into public.analysis_source_files (
		   project_id, report_type, period_start_date, period_end_date,
		   is_current, upload_file_id, upload_file_path, stored_filename,
		   logical_filename, storage_key, ingestion_status, country, report_date
		 ) values (
		   $1, 'sales_report', $2::date, $2::date, true, $3, $4, $5,
		   $5, $4, 'success', 'US', $2::date
		 ) returning id`,
		projectID,
		dateText,
		"sales-"+suffix,
		"sales/"+suffix+".csv",
		"sales-"+suffix+".csv",
	).Scan(&salesSourceID); err != nil {
		t.Fatalf("create sales source fixture: %v", err)
	}

	if _, err := tx.Exec(
		context.Background(),
		`insert into public.analysis_return_rows (
		   source_file_id, source_row_no, return_date, order_id, sku, asin,
		   quantity, fulfillment_center_id, detailed_disposition, reason,
		   status, original_return_datetime, project_id, country
		 ) values (
		   $1, 1, $2::date, 'runner-order-1', 'runner-sku-1', 'B0RUNNER',
		   2, 'PHX6', 'SELLABLE', 'NOT_AS_DESCRIBED',
		   'Unit returned to inventory', $2 || 'T00:00:00', $3, 'US'
		 )`,
		returnSourceID,
		dateText,
		projectID,
	); err != nil {
		t.Fatalf("create return row fixture: %v", err)
	}

	for index, quantity := range []int{10, 10} {
		if _, err := tx.Exec(
			context.Background(),
			`insert into public.analysis_sales_order_rows (
			   project_id, country, source_file_id, source_row_no,
			   amazon_order_id, purchase_at_utc, purchase_at_pt,
			   purchase_date_pt, order_status, sku, quantity, item_price,
			   shipping_price, item_tax, shipping_tax, is_counted_sales,
			   raw_row
			 ) values (
			   $1, 'US', $2, $3, $4, $5::timestamptz, $5::timestamp,
			   $5::date, 'Shipped', 'runner-sku-1', $6, 1,
			   0, 0, 0, true, '{}'::json
			 )`,
			projectID,
			salesSourceID,
			index+1,
			fmt.Sprintf("runner-sale-%d", index+1),
			dateText+"T12:00:00Z",
			quantity,
		); err != nil {
			t.Fatalf("create sales row fixture: %v", err)
		}
	}
	return projectID
}

func assertAggregateFixture(
	t *testing.T,
	tx pgx.Tx,
	dateText string,
	projectID int64,
	expectedDataVersion int,
) {
	t.Helper()
	var (
		returnCount     int
		returnQuantity  int
		salesQuantity   int
		reasonTop1      string
		dispositionTop1 string
		dominantFC      string
		dataVersion     int
	)
	if err := tx.QueryRow(
		context.Background(),
		`select return_count, return_quantity, sales_quantity,
		        reason_top1, disposition_top1, dominant_fc_id, data_version
		 from public.analysis_return_aggregates
		 where project_id = $1
		   and country = 'US'
		   and sku = 'runner-sku-1'
		   and data_date = $2::date`,
		projectID,
		dateText,
	).Scan(
		&returnCount,
		&returnQuantity,
		&salesQuantity,
		&reasonTop1,
		&dispositionTop1,
		&dominantFC,
		&dataVersion,
	); err != nil {
		t.Fatalf("load aggregate fixture: %v", err)
	}
	if returnCount != 1 || returnQuantity != 2 || salesQuantity != 20 {
		t.Fatalf(
			"aggregate counts = return_count:%d return_quantity:%d sales:%d",
			returnCount,
			returnQuantity,
			salesQuantity,
		)
	}
	if reasonTop1 != "NOT_AS_DESCRIBED" ||
		dispositionTop1 != "SELLABLE" ||
		dominantFC != "PHX6" ||
		dataVersion != expectedDataVersion {
		t.Fatalf(
			"aggregate labels = %q/%q/%q data_version=%d, want %d",
			reasonTop1,
			dispositionTop1,
			dominantFC,
			dataVersion,
			expectedDataVersion,
		)
	}
}

func latestInternalJob(
	t *testing.T,
	tx pgx.Tx,
	jobType string,
) (int64, string, string) {
	t.Helper()
	var (
		id      int64
		status  string
		payload string
	)
	if err := tx.QueryRow(
		context.Background(),
		`select id, status::text, payload_json::text
		 from public.jobs
		 where job_type = $1
		 order by id desc
		 limit 1`,
		jobType,
	).Scan(&id, &status, &payload); err != nil {
		t.Fatalf("load latest internal job: %v", err)
	}
	return id, status, payload
}

func latestInternalJobRun(
	t *testing.T,
	tx pgx.Tx,
	jobID int64,
) (string, string) {
	t.Helper()
	var (
		finishedAt pgtype.Timestamptz
		errorText  *string
	)
	if err := tx.QueryRow(
		context.Background(),
		`select finished_at, error_message
		 from public.job_runs
		 where job_id = $1
		 order by id desc
		 limit 1`,
		jobID,
	).Scan(&finishedAt, &errorText); err != nil {
		t.Fatalf("load latest internal job run: %v", err)
	}
	status := "running"
	if finishedAt.Valid {
		status = "finished"
	}
	errorValue := ""
	if errorText != nil {
		errorValue = *errorText
	}
	return status, errorValue
}
