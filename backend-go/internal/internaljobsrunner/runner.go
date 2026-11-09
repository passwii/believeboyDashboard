package internaljobsrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_jobs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

var ErrDatabaseNotConfigured = errors.New("internal jobs runner database is not configured")

const (
	returnAnalysisRefreshJobType = "return_analysis_refresh"
	returnAnalysisRebuildJobType = "return_analysis_rebuild"
	businessSavepoint            = "internal_jobs_business"
	completionSavepoint          = "internal_jobs_completion"
)

const insertInternalJobSQL = `
INSERT INTO public.jobs (job_type, status, payload_json, operator)
VALUES ($1, 'pending'::public.jobstatus, $2::json, $3)
RETURNING id
`

const insertInternalJobRunSQL = `
INSERT INTO public.job_runs (job_id, started_at, operator, log_excerpt)
VALUES ($1, $2, $3, $4)
RETURNING id
`

const markInternalJobRunningSQL = `
UPDATE public.jobs
SET status = 'running',
    updated_at = $2
WHERE id = $1
`

const markInternalJobSuccessSQL = `
UPDATE public.jobs
SET status = 'success',
    updated_at = $2
WHERE id = $1
`

const markInternalJobFailedSQL = `
UPDATE public.jobs
SET status = 'failed',
    updated_at = $2
WHERE id = $1
  AND status <> 'success'
`

const finishInternalJobRunSuccessSQL = `
UPDATE public.job_runs
SET finished_at = $2,
    log_excerpt = $3,
    error_message = NULL,
    result_path = NULL
WHERE id = $1
`

const finishInternalJobRunFailedSQL = `
UPDATE public.job_runs
SET finished_at = $2,
    log_excerpt = $3,
    error_message = CASE
        WHEN error_message IS NULL OR error_message = '' THEN $4
        ELSE error_message || E'\n' || $4
    END
WHERE id = $1
`

const countReturnAnalysisProjectsSQL = `
SELECT count(*)
FROM (
    SELECT DISTINCT r.project_id, r.country
    FROM public.analysis_return_rows r
    JOIN public.analysis_source_files f ON f.id = r.source_file_id
    WHERE r.return_date = $1::date
      AND f.report_type = 'return_report'
      AND f.is_current = TRUE
) projects
`

const selectEarliestReturnAnalysisDateSQL = `
SELECT coalesce(min(return_date), $1::date)::text
FROM public.analysis_return_rows
`

const deleteReturnAnalysisAggregatesSQL = `
DELETE FROM public.analysis_return_aggregates
`

const countReturnAnalysisAggregateProjectsSQL = `
SELECT count(DISTINCT project_id)
FROM public.analysis_return_aggregates
`

const refreshReturnAnalysisDaySQL = `
WITH return_groups AS (
    SELECT
        r.project_id,
        r.country,
        r.sku,
        max(r.asin) AS asin,
        count(DISTINCT r.order_id) AS return_count,
        sum(r.quantity) AS return_quantity
    FROM public.analysis_return_rows r
    JOIN public.analysis_source_files f ON f.id = r.source_file_id
    WHERE r.return_date = $1::date
      AND f.report_type = 'return_report'
      AND f.is_current = TRUE
    GROUP BY r.project_id, r.country, r.sku
),
reason_stats AS (
    SELECT
        g.project_id,
        g.country,
        g.sku,
        r.reason AS top_value,
        count(*) AS occurrences,
        row_number() OVER (
            PARTITION BY g.project_id, g.country, g.sku
            ORDER BY count(*) DESC, r.reason ASC
        ) AS row_rank
    FROM return_groups g
    JOIN public.analysis_return_rows r
      ON r.project_id = g.project_id
     AND r.country = g.country
     AND r.sku = g.sku
    JOIN public.analysis_source_files f ON f.id = r.source_file_id
    WHERE r.return_date = $1::date
      AND f.report_type = 'return_report'
      AND f.is_current = TRUE
      AND nullif(btrim(r.reason), '') IS NOT NULL
    GROUP BY g.project_id, g.country, g.sku, r.reason
),
disposition_stats AS (
    SELECT
        g.project_id,
        g.country,
        g.sku,
        r.detailed_disposition AS top_value,
        row_number() OVER (
            PARTITION BY g.project_id, g.country, g.sku
            ORDER BY count(*) DESC, r.detailed_disposition ASC
        ) AS row_rank
    FROM return_groups g
    JOIN public.analysis_return_rows r
      ON r.project_id = g.project_id
     AND r.country = g.country
     AND r.sku = g.sku
    JOIN public.analysis_source_files f ON f.id = r.source_file_id
    WHERE r.return_date = $1::date
      AND f.report_type = 'return_report'
      AND f.is_current = TRUE
      AND nullif(btrim(r.detailed_disposition), '') IS NOT NULL
    GROUP BY g.project_id, g.country, g.sku, r.detailed_disposition
),
fulfillment_center_stats AS (
    SELECT
        g.project_id,
        g.country,
        g.sku,
        r.fulfillment_center_id AS top_value,
        row_number() OVER (
            PARTITION BY g.project_id, g.country, g.sku
            ORDER BY count(*) DESC, r.fulfillment_center_id ASC
        ) AS row_rank
    FROM return_groups g
    JOIN public.analysis_return_rows r
      ON r.project_id = g.project_id
     AND r.country = g.country
     AND r.sku = g.sku
    JOIN public.analysis_source_files f ON f.id = r.source_file_id
    WHERE r.return_date = $1::date
      AND f.report_type = 'return_report'
      AND f.is_current = TRUE
      AND nullif(btrim(r.fulfillment_center_id), '') IS NOT NULL
    GROUP BY g.project_id, g.country, g.sku, r.fulfillment_center_id
),
sales_groups AS (
    SELECT
        so.project_id,
        so.country,
        so.sku,
        sum(so.quantity) AS sales_quantity
    FROM public.analysis_sales_order_rows so
    JOIN return_groups g
      ON g.project_id = so.project_id
     AND g.country = so.country
     AND g.sku = so.sku
    WHERE so.purchase_date_pt <= $1::date
      AND so.is_counted_sales = TRUE
      AND so.order_status NOT IN ('Cancelled', 'Pending')
      AND so.sku IS NOT NULL
    GROUP BY so.project_id, so.country, so.sku
),
combined AS (
    SELECT
        g.*,
        coalesce(s.sales_quantity, 0) AS sales_quantity
    FROM return_groups g
    LEFT JOIN sales_groups s
      ON s.project_id = g.project_id
     AND s.country = g.country
     AND s.sku = g.sku
),
bounds AS (
    SELECT
        c.*,
        least(
            1.0,
            greatest(
                0.0,
                c.return_quantity::numeric / nullif(c.sales_quantity, 0)
            )
        ) AS p,
        1.0 + (1.96 * 1.96) / nullif(c.sales_quantity, 0) AS denominator
    FROM combined c
),
scored AS (
    SELECT
        b.*,
        CASE
            WHEN b.sales_quantity < 15 THEN 0::numeric
            ELSE greatest(
                0::numeric,
                (
                    (
                        b.p + (1.96 * 1.96) / (2.0 * b.sales_quantity)
                    ) / b.denominator
                    - (
                        1.96
                        * sqrt(
                            greatest(
                                0::numeric,
                                b.p * (1.0 - b.p) / b.sales_quantity
                                + (1.96 * 1.96) / (4.0 * b.sales_quantity * b.sales_quantity)
                            )
                        )
                        / b.denominator
                    )
                ) * 100
            )
        END AS wilson_lower
    FROM bounds b
)
INSERT INTO public.analysis_return_aggregates (
    project_id,
    country,
    sku,
    asin,
    data_date,
    return_count,
    return_quantity,
    sales_quantity,
    return_rate,
    cycle_avg_days,
    cycle_min_days,
    cycle_max_days,
    reason_top1,
    reason_top1_pct,
    reason_top1_display,
    disposition_top1,
    disposition_top1_display,
    dominant_fc_id,
    risk_level,
    wilson_lower,
    data_version,
    computed_at
)
SELECT
    s.project_id,
    s.country,
    s.sku,
    s.asin,
    $1::date,
    s.return_count,
    s.return_quantity,
    s.sales_quantity,
    CASE
        WHEN s.sales_quantity > 0
        THEN round(s.return_quantity::numeric / s.sales_quantity * 100, 3)
        ELSE 0
    END,
    NULL,
    NULL,
    NULL,
    rs.top_value,
    CASE
        WHEN s.return_count > 0 AND rs.occurrences IS NOT NULL
        THEN round(rs.occurrences::numeric / s.return_count * 100, 2)
        ELSE 0
    END,
    NULL,
    ds.top_value,
    NULL,
    fcs.top_value,
    CASE
        WHEN s.sales_quantity < 15 THEN 'no_data'
        WHEN s.wilson_lower >= 10 THEN 'critical'
        WHEN s.wilson_lower >= 6 THEN 'warning'
        ELSE 'normal'
    END,
    round(s.wilson_lower, 3),
    2,
    now()
FROM scored s
LEFT JOIN reason_stats rs
  ON rs.project_id = s.project_id
 AND rs.country = s.country
 AND rs.sku = s.sku
 AND rs.row_rank = 1
LEFT JOIN disposition_stats ds
  ON ds.project_id = s.project_id
 AND ds.country = s.country
 AND ds.sku = s.sku
 AND ds.row_rank = 1
LEFT JOIN fulfillment_center_stats fcs
  ON fcs.project_id = s.project_id
 AND fcs.country = s.country
 AND fcs.sku = s.sku
 AND fcs.row_rank = 1
ON CONFLICT (project_id, country, sku, data_date)
DO UPDATE SET
    asin = EXCLUDED.asin,
    return_count = EXCLUDED.return_count,
    return_quantity = EXCLUDED.return_quantity,
    sales_quantity = EXCLUDED.sales_quantity,
    return_rate = EXCLUDED.return_rate,
    cycle_avg_days = EXCLUDED.cycle_avg_days,
    cycle_min_days = EXCLUDED.cycle_min_days,
    cycle_max_days = EXCLUDED.cycle_max_days,
    reason_top1 = EXCLUDED.reason_top1,
    reason_top1_pct = EXCLUDED.reason_top1_pct,
    reason_top1_display = EXCLUDED.reason_top1_display,
    disposition_top1 = EXCLUDED.disposition_top1,
    disposition_top1_display = EXCLUDED.disposition_top1_display,
    dominant_fc_id = EXCLUDED.dominant_fc_id,
    risk_level = EXCLUDED.risk_level,
    wilson_lower = EXCLUDED.wilson_lower,
    data_version = analysis_return_aggregates.data_version + 1,
    computed_at = EXCLUDED.computed_at
`

type rangeResult struct {
	rowsWritten   int64
	daysProcessed int
	daysWithData  int
	maxProjects   int
	rangeStart    string
	rangeEnd      string
}

type rangeExecutor func(
	context.Context,
	store.FullDB,
	time.Time,
	time.Time,
) (rangeResult, error)

type rebuildBoundsLoader func(context.Context, store.FullDB) (time.Time, time.Time, error)

type jobOutcome struct {
	rowsWritten   int64
	projects      int
	rangeStart    string
	rangeEnd      string
	daysProcessed int
}

type jobSpec struct {
	jobType string
	payload map[string]any
}

type startedJob struct {
	jobID int64
	runID int64
}

type Runner struct {
	db              store.FullDB
	now             func() time.Time
	location        *time.Location
	refreshRange    rangeExecutor
	rebuildRange    rangeExecutor
	loadRebuildSpan rebuildBoundsLoader
}

type Option func(*Runner)

func WithNow(now func() time.Time) Option {
	return func(runner *Runner) {
		if now != nil {
			runner.now = now
		}
	}
}

func WithLocation(location *time.Location) Option {
	return func(runner *Runner) {
		if location != nil {
			runner.location = location
		}
	}
}

func New(db store.FullDB, options ...Option) *Runner {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		location = time.FixedZone("CST", 8*60*60)
	}
	runner := &Runner{
		db:       db,
		now:      time.Now,
		location: location,
	}
	runner.refreshRange = refreshReturnAnalysisRange
	runner.rebuildRange = rebuildReturnAnalysisRange
	runner.loadRebuildSpan = runner.loadDefaultRebuildSpan
	for _, option := range options {
		if option != nil {
			option(runner)
		}
	}
	return runner
}

func (runner *Runner) RefreshReturnAnalysis(
	ctx context.Context,
	targetDate string,
	backfillDays int,
) (internal_jobs.RefreshResult, error) {
	start, end, err := runner.refreshSpan(targetDate, backfillDays)
	if err != nil {
		return internal_jobs.RefreshResult{}, err
	}
	if err := runner.requireDatabase(); err != nil {
		return internal_jobs.RefreshResult{}, err
	}
	payload := map[string]any{
		"target_date":   end.Format("2006-01-02"),
		"backfill_days": backfillDays,
		"range_start":   start.Format("2006-01-02"),
		"range_end":     end.Format("2006-01-02"),
	}
	outcome, err := runner.executeJob(
		ctx,
		jobSpec{jobType: returnAnalysisRefreshJobType, payload: payload},
		func(ctx context.Context, db store.FullDB) (jobOutcome, error) {
			result, err := runner.refreshRange(ctx, db, start, end)
			if err != nil {
				return jobOutcome{}, err
			}
			return jobOutcome{
				rowsWritten:   result.rowsWritten,
				projects:      result.maxProjects,
				rangeStart:    result.rangeStart,
				rangeEnd:      result.rangeEnd,
				daysProcessed: result.daysProcessed,
			}, nil
		},
	)
	if err != nil {
		return internal_jobs.RefreshResult{}, err
	}
	return internal_jobs.RefreshResult{
		RowsWritten: outcome.rowsWritten,
		Projects:    outcome.projects,
	}, nil
}

func (runner *Runner) RebuildReturnAnalysis(
	ctx context.Context,
) (internal_jobs.RebuildResult, error) {
	if err := runner.requireDatabase(); err != nil {
		return internal_jobs.RebuildResult{}, err
	}
	outcome, err := runner.executeJob(
		ctx,
		jobSpec{
			jobType: returnAnalysisRebuildJobType,
			payload: map[string]any{"mode": "full_history"},
		},
		func(ctx context.Context, db store.FullDB) (jobOutcome, error) {
			start, end, err := runner.loadRebuildSpan(ctx, db)
			if err != nil {
				return jobOutcome{}, err
			}
			if end.Before(start) {
				return jobOutcome{}, fmt.Errorf(
					"return analysis rebuild range is invalid: %s..%s",
					start.Format("2006-01-02"),
					end.Format("2006-01-02"),
				)
			}
			result, err := runner.rebuildRange(ctx, db, start, end)
			if err != nil {
				return jobOutcome{}, err
			}
			return jobOutcome{
				rowsWritten:   result.rowsWritten,
				projects:      result.maxProjects,
				rangeStart:    result.rangeStart,
				rangeEnd:      result.rangeEnd,
				daysProcessed: result.daysProcessed,
			}, nil
		},
	)
	if err != nil {
		return internal_jobs.RebuildResult{}, err
	}
	return internal_jobs.RebuildResult{
		RangeStart:      outcome.rangeStart,
		RangeEnd:        outcome.rangeEnd,
		RowsWritten:     outcome.rowsWritten,
		ProjectsTouched: outcome.projects,
	}, nil
}

func (runner *Runner) requireDatabase() error {
	if runner == nil || runner.db == nil {
		return fmt.Errorf("%w: %v", internal_jobs.ErrDependencyNotConfigured, ErrDatabaseNotConfigured)
	}
	return nil
}

func (runner *Runner) refreshSpan(targetDate string, backfillDays int) (time.Time, time.Time, error) {
	if backfillDays < 1 || backfillDays > 90 {
		return time.Time{}, time.Time{}, fmt.Errorf("backfill_days must be between 1 and 90")
	}
	end, err := parseISODate(targetDate, runner.location)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	start := end.AddDate(0, 0, -(backfillDays - 1))
	return start, end, nil
}

func parseISODate(value string, location *time.Location) (time.Time, error) {
	value = strings.TrimSpace(value)
	if len(value) != len("2006-01-02") {
		return time.Time{}, errors.New("target_date must be YYYY-MM-DD")
	}
	parsed, err := time.ParseInLocation("2006-01-02", value, location)
	if err != nil || parsed.Format("2006-01-02") != value {
		return time.Time{}, errors.New("target_date must be YYYY-MM-DD")
	}
	return parsed, nil
}

func (runner *Runner) loadDefaultRebuildSpan(
	ctx context.Context,
	db store.FullDB,
) (time.Time, time.Time, error) {
	now := runner.now().In(runner.location)
	fallbackStart := time.Date(
		now.Year(),
		now.Month(),
		now.Day(),
		0,
		0,
		0,
		0,
		runner.location,
	).AddDate(0, 0, -90)
	rangeEnd := time.Date(
		now.Year(),
		now.Month(),
		now.Day(),
		0,
		0,
		0,
		0,
		runner.location,
	).AddDate(0, 0, -1)
	var rangeStartText string
	if err := db.QueryRow(
		ctx,
		selectEarliestReturnAnalysisDateSQL,
		fallbackStart.Format("2006-01-02"),
	).Scan(&rangeStartText); err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("load return analysis rebuild range: %w", err)
	}
	rangeStart, err := parseISODate(rangeStartText, runner.location)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("parse return analysis rebuild start: %w", err)
	}
	return rangeStart, rangeEnd, nil
}

func refreshReturnAnalysisRange(
	ctx context.Context,
	db store.FullDB,
	start time.Time,
	end time.Time,
) (rangeResult, error) {
	result := rangeResult{
		rangeStart: start.Format("2006-01-02"),
		rangeEnd:   end.Format("2006-01-02"),
	}
	if end.Before(start) {
		return result, fmt.Errorf("return analysis refresh range is invalid: %s..%s", result.rangeStart, result.rangeEnd)
	}
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		dateText := day.Format("2006-01-02")
		var projects int
		if err := db.QueryRow(ctx, countReturnAnalysisProjectsSQL, dateText).Scan(&projects); err != nil {
			return result, fmt.Errorf("count return analysis projects for %s: %w", dateText, err)
		}
		tag, err := db.Exec(ctx, refreshReturnAnalysisDaySQL, dateText)
		if err != nil {
			return result, fmt.Errorf("refresh return analysis for %s: %w", dateText, err)
		}
		rows := int64(tag.RowsAffected())
		result.rowsWritten += rows
		result.daysProcessed++
		if rows > 0 {
			result.daysWithData++
		}
		if projects > result.maxProjects {
			result.maxProjects = projects
		}
	}
	return result, nil
}

func rebuildReturnAnalysisRange(
	ctx context.Context,
	db store.FullDB,
	start time.Time,
	end time.Time,
) (rangeResult, error) {
	if _, err := db.Exec(ctx, deleteReturnAnalysisAggregatesSQL); err != nil {
		return rangeResult{}, fmt.Errorf("delete return analysis aggregates: %w", err)
	}
	result, err := refreshReturnAnalysisRange(ctx, db, start, end)
	if err != nil {
		return result, err
	}
	var projectsTouched int
	if err := db.QueryRow(ctx, countReturnAnalysisAggregateProjectsSQL).Scan(&projectsTouched); err != nil {
		return result, fmt.Errorf("count return analysis aggregate projects: %w", err)
	}
	result.maxProjects = projectsTouched
	return result, nil
}

func (runner *Runner) executeJob(
	ctx context.Context,
	spec jobSpec,
	execute func(context.Context, store.FullDB) (jobOutcome, error),
) (jobOutcome, error) {
	if tx := internal_jobs.RunnerTransactionFromContext(ctx); tx != nil {
		return runner.executeJobInTx(ctx, store.NewTxDB(tx), spec, execute)
	}

	tx, err := runner.db.Begin(ctx)
	if err != nil {
		return jobOutcome{}, fmt.Errorf("begin internal job transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.WithoutCancel(ctx))
	}()
	txDB := store.NewTxDB(tx)
	outcome, workErr := runner.executeJobInTx(ctx, txDB, spec, execute)
	commitCtx := ctx
	if workErr != nil {
		commitCtx = context.WithoutCancel(ctx)
	}
	if err := tx.Commit(commitCtx); err != nil {
		if workErr != nil {
			return outcome, errors.Join(workErr, fmt.Errorf("commit internal job failure state: %w", err))
		}
		return outcome, fmt.Errorf("commit internal job transaction: %w", err)
	}
	return outcome, workErr
}

func (runner *Runner) executeJobInTx(
	ctx context.Context,
	db store.FullDB,
	spec jobSpec,
	execute func(context.Context, store.FullDB) (jobOutcome, error),
) (jobOutcome, error) {
	started, err := runner.startJob(ctx, db, spec)
	if err != nil {
		var markErr error
		if started.jobID != 0 {
			markErr = runner.finishFailure(context.WithoutCancel(ctx), db, started, err)
		}
		return jobOutcome{}, errors.Join(err, markErr)
	}

	if _, err := db.Exec(ctx, "SAVEPOINT "+businessSavepoint); err != nil {
		markErr := runner.finishFailure(context.WithoutCancel(ctx), db, started, err)
		return jobOutcome{}, errors.Join(fmt.Errorf("create internal job savepoint: %w", err), markErr)
	}

	outcome, executeErr := execute(ctx, db)
	if executeErr != nil {
		rollbackErr := rollbackToBusinessSavepoint(context.WithoutCancel(ctx), db)
		markErr := runner.finishFailure(context.WithoutCancel(ctx), db, started, executeErr)
		return outcome, errors.Join(executeErr, rollbackErr, markErr)
	}
	if _, err := db.Exec(ctx, "RELEASE SAVEPOINT "+businessSavepoint); err != nil {
		rollbackErr := rollbackToBusinessSavepoint(context.WithoutCancel(ctx), db)
		markErr := runner.finishFailure(context.WithoutCancel(ctx), db, started, err)
		return outcome, errors.Join(fmt.Errorf("release internal job savepoint: %w", err), rollbackErr, markErr)
	}

	if _, err := db.Exec(ctx, "SAVEPOINT "+completionSavepoint); err != nil {
		markErr := runner.finishFailure(context.WithoutCancel(ctx), db, started, err)
		return outcome, errors.Join(fmt.Errorf("create internal job completion savepoint: %w", err), markErr)
	}
	if err := runner.finishSuccess(ctx, db, started, outcome); err != nil {
		rollbackErr := rollbackToSavepoint(context.WithoutCancel(ctx), db, completionSavepoint)
		markErr := runner.finishFailure(context.WithoutCancel(ctx), db, started, err)
		return outcome, errors.Join(err, rollbackErr, markErr)
	}
	if _, err := db.Exec(ctx, "RELEASE SAVEPOINT "+completionSavepoint); err != nil {
		rollbackErr := rollbackToSavepoint(context.WithoutCancel(ctx), db, completionSavepoint)
		markErr := runner.finishFailure(context.WithoutCancel(ctx), db, started, err)
		return outcome, errors.Join(fmt.Errorf("release internal job completion savepoint: %w", err), rollbackErr, markErr)
	}
	return outcome, nil
}

func (runner *Runner) startJob(
	ctx context.Context,
	db store.FullDB,
	spec jobSpec,
) (startedJob, error) {
	payload, err := json.Marshal(spec.payload)
	if err != nil {
		return startedJob{}, fmt.Errorf("encode internal job payload: %w", err)
	}
	now := runner.now().UTC()
	operator := internal_jobs.RunnerOperatorFromContext(ctx)
	var jobID int64
	if err := db.QueryRow(
		ctx,
		insertInternalJobSQL,
		spec.jobType,
		string(payload),
		operator,
	).Scan(&jobID); err != nil {
		return startedJob{}, fmt.Errorf("create internal job: %w", err)
	}
	logExcerpt, _ := json.Marshal(map[string]any{
		"stage":    "started",
		"progress": 5,
		"message":  "处理中：任务已启动",
	})
	var runID int64
	if err := db.QueryRow(
		ctx,
		insertInternalJobRunSQL,
		jobID,
		now,
		operator,
		string(logExcerpt),
	).Scan(&runID); err != nil {
		return startedJob{jobID: jobID}, fmt.Errorf("create internal job run: %w", err)
	}
	tag, err := db.Exec(ctx, markInternalJobRunningSQL, jobID, now)
	if err != nil {
		return startedJob{jobID: jobID, runID: runID}, fmt.Errorf("mark internal job running: %w", err)
	}
	if err := requireOneRow(tag, "mark internal job running"); err != nil {
		return startedJob{jobID: jobID, runID: runID}, err
	}
	return startedJob{jobID: jobID, runID: runID}, nil
}

func (runner *Runner) finishSuccess(
	ctx context.Context,
	db store.FullDB,
	started startedJob,
	outcome jobOutcome,
) error {
	now := runner.now().UTC()
	logExcerpt, err := json.Marshal(map[string]any{
		"stage":          "completed",
		"progress":       100,
		"message":        "任务完成",
		"rows_written":   outcome.rowsWritten,
		"projects":       outcome.projects,
		"days_processed": outcome.daysProcessed,
		"range_start":    outcome.rangeStart,
		"range_end":      outcome.rangeEnd,
	})
	if err != nil {
		return fmt.Errorf("encode internal job completion log: %w", err)
	}
	tag, err := db.Exec(
		ctx,
		markInternalJobSuccessSQL,
		started.jobID,
		now,
	)
	if err != nil {
		return fmt.Errorf("mark internal job success: %w", err)
	}
	if err := requireOneRow(tag, "mark internal job success"); err != nil {
		return err
	}
	tag, err = db.Exec(
		ctx,
		finishInternalJobRunSuccessSQL,
		started.runID,
		now,
		string(logExcerpt),
	)
	if err != nil {
		return fmt.Errorf("finish internal job run success: %w", err)
	}
	if err := requireOneRow(tag, "finish internal job run success"); err != nil {
		return err
	}
	return nil
}

func (runner *Runner) finishFailure(
	ctx context.Context,
	db store.FullDB,
	started startedJob,
	workErr error,
) error {
	if started.jobID == 0 {
		return nil
	}
	now := runner.now().UTC()
	message := "internal job failed"
	if workErr != nil && strings.TrimSpace(workErr.Error()) != "" {
		message = clipMessage(workErr.Error(), 4000)
	}
	logExcerpt, _ := json.Marshal(map[string]any{
		"stage":    "failed",
		"progress": 100,
		"message":  message,
	})
	var errs []error
	tag, err := db.Exec(
		ctx,
		markInternalJobFailedSQL,
		started.jobID,
		now,
	)
	if err != nil {
		errs = append(errs, fmt.Errorf("mark internal job failed: %w", err))
	} else if rowErr := requireOneRow(tag, "mark internal job failed"); rowErr != nil {
		errs = append(errs, rowErr)
	}
	if started.runID != 0 {
		tag, err := db.Exec(
			ctx,
			finishInternalJobRunFailedSQL,
			started.runID,
			now,
			string(logExcerpt),
			message,
		)
		if err != nil {
			errs = append(errs, fmt.Errorf("finish internal job run failed: %w", err))
		} else if rowErr := requireOneRow(tag, "finish internal job run failed"); rowErr != nil {
			errs = append(errs, rowErr)
		}
	}
	return errors.Join(errs...)
}

func rollbackToBusinessSavepoint(ctx context.Context, db store.FullDB) error {
	return rollbackToSavepoint(ctx, db, businessSavepoint)
}

func rollbackToSavepoint(ctx context.Context, db store.FullDB, savepoint string) error {
	if _, err := db.Exec(ctx, "ROLLBACK TO SAVEPOINT "+savepoint); err != nil {
		return fmt.Errorf("rollback internal job savepoint: %w", err)
	}
	if _, err := db.Exec(ctx, "RELEASE SAVEPOINT "+savepoint); err != nil {
		return fmt.Errorf("release rolled back internal job savepoint: %w", err)
	}
	return nil
}

func clipMessage(value string, maxRunes int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes])
	}
	return value
}

func requireOneRow(tag interface{ RowsAffected() int64 }, action string) error {
	if tag.RowsAffected() == 1 {
		return nil
	}
	return fmt.Errorf("%s affected %d rows, want 1", action, tag.RowsAffected())
}

var _ internal_jobs.Runner = (*Runner)(nil)
