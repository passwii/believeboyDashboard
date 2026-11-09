package tasks

import (
	"context"
	"fmt"
	"time"

	"github.com/hibiken/asynq"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const returnAnalysisRefreshDaySQL = `
WITH return_groups AS (
    SELECT
        r.project_id,
        r.country,
        r.sku,
        max(r.asin) AS asin,
        count(DISTINCT r.order_id) AS return_count,
        sum(r.quantity) AS return_quantity,
        mode() WITHIN GROUP (ORDER BY r.reason) AS reason_top1,
        mode() WITHIN GROUP (ORDER BY r.detailed_disposition) AS disposition_top1,
        mode() WITHIN GROUP (ORDER BY r.fulfillment_center_id) AS dominant_fc_id
    FROM analysis_return_rows r
    JOIN analysis_source_files f ON f.id = r.source_file_id
    WHERE r.return_date = $1::date
      AND f.report_type = 'return_report'
      AND f.is_current = TRUE
    GROUP BY r.project_id, r.country, r.sku
),
sales_groups AS (
    SELECT
        project_id,
        country,
        sku,
        sum(quantity) AS sales_quantity
    FROM analysis_sales_order_rows
    WHERE purchase_date_pt <= $1::date
      AND is_counted_sales = TRUE
      AND order_status NOT IN ('Cancelled', 'Pending')
      AND sku IS NOT NULL
    GROUP BY project_id, country, sku
),
combined AS (
    SELECT
        r.*,
        coalesce(s.sales_quantity, 0) AS sales_quantity
    FROM return_groups r
    LEFT JOIN sales_groups s
      ON s.project_id = r.project_id
     AND s.country = r.country
     AND s.sku = r.sku
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
INSERT INTO analysis_return_aggregates (
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
    s.reason_top1,
    NULL,
    NULL,
    s.disposition_top1,
    NULL,
    s.dominant_fc_id,
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

const deleteReturnAnalysisAggregatesSQL = `
DELETE FROM analysis_return_aggregates
`

const selectReturnAnalysisRangeSQL = `
SELECT
    coalesce(min(return_date), CURRENT_DATE - 90),
    coalesce(max(return_date), CURRENT_DATE - 1)
FROM analysis_return_rows
`

func (handler *TaskHandler) HandleReturnAnalysisRefreshDaily(
	ctx context.Context,
	task *asynq.Task,
) error {
	const taskType = queue.TypeReturnAnalysisRefreshDaily
	return handler.runSafely(taskType, func() error {
		var payload ReturnAnalysisRefreshPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		if err := payload.Validate(); err != nil {
			return err
		}

		endDate, lookbackDays, err := handler.returnAnalysisWindow(payload)
		if err != nil {
			return err
		}
		startDate := endDate.AddDate(0, 0, -(lookbackDays - 1))
		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		rowsWritten, daysProcessed, err := refreshReturnAnalysisRange(
			ctx,
			db,
			startDate,
			endDate,
		)
		if err != nil {
			return err
		}
		return handler.writeResult(task, taskResult{
			TaskType: taskType,
			Status:   "completed",
			Data: map[string]any{
				"rows_written":   rowsWritten,
				"days_processed": daysProcessed,
				"range_start":    startDate.Format("2006-01-02"),
				"range_end":      endDate.Format("2006-01-02"),
			},
		})
	})
}

func (handler *TaskHandler) HandleReturnAnalysisRebuild(
	ctx context.Context,
	task *asynq.Task,
) error {
	const taskType = queue.TypeReturnAnalysisRebuild
	return handler.runSafely(taskType, func() error {
		var payload ReturnAnalysisRebuildPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		db, err := handler.requireDB()
		if err != nil {
			return err
		}

		var startDate, endDate time.Time
		if err := db.QueryRow(ctx, selectReturnAnalysisRangeSQL).Scan(
			&startDate,
			&endDate,
		); err != nil {
			return fmt.Errorf("load return analysis rebuild range: %w", err)
		}
		startDate = truncateDate(startDate)
		endDate = truncateDate(endDate)
		if endDate.Before(startDate) {
			return fmt.Errorf("return analysis rebuild range is invalid: %s..%s", startDate, endDate)
		}
		if _, err := db.Exec(ctx, deleteReturnAnalysisAggregatesSQL); err != nil {
			return fmt.Errorf("delete return analysis aggregates: %w", err)
		}
		rowsWritten, daysProcessed, err := refreshReturnAnalysisRange(
			ctx,
			db,
			startDate,
			endDate,
		)
		if err != nil {
			return err
		}
		return handler.writeResult(task, taskResult{
			TaskType: taskType,
			Status:   "completed",
			Data: map[string]any{
				"rows_written":   rowsWritten,
				"days_processed": daysProcessed,
				"range_start":    startDate.Format("2006-01-02"),
				"range_end":      endDate.Format("2006-01-02"),
			},
		})
	})
}

func (handler *TaskHandler) returnAnalysisWindow(
	payload ReturnAnalysisRefreshPayload,
) (time.Time, int, error) {
	location := handler.location()
	now := handler.currentTime(nil).In(location)
	endDate := time.Date(
		now.Year(),
		now.Month(),
		now.Day(),
		0,
		0,
		0,
		0,
		location,
	).AddDate(0, 0, -1)
	if payload.TargetDate != nil {
		parsed, err := time.ParseInLocation("2006-01-02", *payload.TargetDate, location)
		if err != nil {
			return time.Time{}, 0, errInvalid("target_date", "must be YYYY-MM-DD")
		}
		endDate = parsed
	}
	lookbackDays := intValue(payload.LookbackDays, 7)
	if lookbackDays < 1 || lookbackDays > 90 {
		return time.Time{}, 0, errInvalid("lookback_days", "must be between 1 and 90")
	}
	return endDate, lookbackDays, nil
}

func refreshReturnAnalysisRange(
	ctx context.Context,
	db store.FullDB,
	startDate time.Time,
	endDate time.Time,
) (int64, int, error) {
	var rowsWritten int64
	daysProcessed := 0
	for day := startDate; !day.After(endDate); day = day.AddDate(0, 0, 1) {
		if err := ctx.Err(); err != nil {
			return rowsWritten, daysProcessed, err
		}
		tag, err := db.Exec(ctx, returnAnalysisRefreshDaySQL, day.Format("2006-01-02"))
		if err != nil {
			return rowsWritten, daysProcessed, fmt.Errorf(
				"refresh return analysis for %s: %w",
				day.Format("2006-01-02"),
				err,
			)
		}
		rowsWritten += tag.RowsAffected()
		daysProcessed++
	}
	return rowsWritten, daysProcessed, nil
}

func truncateDate(value time.Time) time.Time {
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, value.Location())
}
