package tasks

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	selectActiveAlertRulesSQL = `
SELECT id, name, project_id, country, metric, trigger_type, condition,
       threshold, window_days, severity, notification_channels
FROM alert_rules
WHERE is_active = TRUE
ORDER BY id
`
	salesAmountMetricSQL = `
WITH daily AS (
    SELECT purchase_date_pt AS data_date,
           coalesce(sum(
               coalesce(item_price, 0)
               + coalesce(shipping_price, 0)
               + coalesce(item_tax, 0)
               + coalesce(shipping_tax, 0)
           ), 0)::double precision AS value
    FROM analysis_sales_order_rows
    WHERE project_id = $1
      AND country = $2
      AND purchase_date_pt >= $4::date
      AND purchase_date_pt <= $3::date
      AND is_counted_sales = TRUE
      AND order_status NOT IN ('Cancelled', 'Pending')
    GROUP BY purchase_date_pt
)
SELECT
    coalesce((SELECT value FROM daily WHERE data_date = $3::date), 0),
    coalesce((SELECT avg(value) FROM daily), 0)
`
	orderQuantityMetricSQL = `
WITH daily AS (
    SELECT purchase_date_pt AS data_date,
           coalesce(sum(quantity), 0)::double precision AS value
    FROM analysis_sales_order_rows
    WHERE project_id = $1
      AND country = $2
      AND purchase_date_pt >= $4::date
      AND purchase_date_pt <= $3::date
      AND is_counted_sales = TRUE
      AND order_status NOT IN ('Cancelled', 'Pending')
    GROUP BY purchase_date_pt
)
SELECT
    coalesce((SELECT value FROM daily WHERE data_date = $3::date), 0),
    coalesce((SELECT avg(value) FROM daily), 0)
`
	adSpendMetricSQL = `
WITH daily AS (
    SELECT f.report_date AS data_date,
           coalesce(sum(r.spend), 0)::double precision AS value
    FROM ad_upload_files f
    JOIN ad_upload_campaign_rows r ON r.source_file_id = f.id
    WHERE f.project_id = $1
      AND f.country = $2
      AND f.report_type = 'ad_campaign_report'
      AND f.is_current = TRUE
      AND f.report_date >= $4::date
      AND f.report_date <= $3::date
    GROUP BY f.report_date
)
SELECT
    coalesce((SELECT value FROM daily WHERE data_date = $3::date), 0),
    coalesce((SELECT avg(value) FROM daily), 0)
`
	acosMetricSQL = `
WITH daily AS (
    SELECT f.report_date AS data_date,
           coalesce(
               sum(r.spend) / nullif(sum(r.sales_7d), 0) * 100,
               0
           )::double precision AS value
    FROM ad_upload_files f
    JOIN ad_upload_campaign_rows r ON r.source_file_id = f.id
    WHERE f.project_id = $1
      AND f.country = $2
      AND f.report_type = 'ad_campaign_report'
      AND f.is_current = TRUE
      AND f.report_date >= $4::date
      AND f.report_date <= $3::date
    GROUP BY f.report_date
)
SELECT
    coalesce((SELECT value FROM daily WHERE data_date = $3::date), 0),
    coalesce((SELECT avg(value) FROM daily), 0)
`
	returnRateMetricSQL = `
WITH daily AS (
    SELECT data_date,
           coalesce(
               sum(return_quantity)::double precision
               / nullif(sum(sales_quantity), 0) * 100,
               0
           ) AS value
    FROM analysis_return_aggregates
    WHERE project_id = $1
      AND country = $2
      AND data_date >= $4::date
      AND data_date <= $3::date
    GROUP BY data_date
)
SELECT
    coalesce((SELECT value FROM daily WHERE data_date = $3::date), 0),
    coalesce((SELECT avg(value) FROM daily), 0)
`
	insertAlertEventSQL = `
INSERT INTO alert_events (
    rule_id, project_id, metric, current_value, baseline_value, deviation_pct,
    severity, message, status, triggered_at
)
SELECT
    $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9
WHERE NOT EXISTS (
    SELECT 1
    FROM alert_events
    WHERE rule_id = $1
      AND metric = $3
      AND triggered_at >= $10
)
`
)

type alertRuleRecord struct {
	ID                   int64
	Name                 string
	ProjectID            int64
	Country              string
	Metric               string
	TriggerType          string
	Condition            string
	Threshold            float64
	WindowDays           int
	Severity             string
	NotificationChannels string
}

func (handler *TaskHandler) HandleAlertDetect(ctx context.Context, task *asynq.Task) error {
	const taskType = "alert_detect"
	return handler.runSafely(taskType, func() error {
		var payload AlertDetectPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		rules, err := loadActiveAlertRules(ctx, db)
		if err != nil {
			return err
		}

		now := handler.currentTime(payload.Now)
		location := handler.location()
		nowLocal := now.In(location)
		endDate := time.Date(
			nowLocal.Year(),
			nowLocal.Month(),
			nowLocal.Day(),
			0,
			0,
			0,
			0,
			location,
		).AddDate(0, 0, -1)

		eventsCreated := int64(0)
		for _, rule := range rules {
			windowDays := rule.WindowDays
			if windowDays <= 0 {
				windowDays = 7
			}
			startDate := endDate.AddDate(0, 0, -(windowDays - 1))
			metricSQL, err := alertMetricSQL(rule.Metric)
			if err != nil {
				return err
			}
			var currentValue, baselineValue float64
			if err := db.QueryRow(
				ctx,
				metricSQL,
				rule.ProjectID,
				rule.Country,
				endDate.Format("2006-01-02"),
				startDate.Format("2006-01-02"),
			).Scan(&currentValue, &baselineValue); err != nil {
				return fmt.Errorf("evaluate alert rule %d metric %s: %w", rule.ID, rule.Metric, err)
			}
			if currentValue == 0 && baselineValue == 0 {
				continue
			}
			deviation := float64(0)
			if baselineValue != 0 {
				deviation = (currentValue - baselineValue) / baselineValue * 100
			}
			triggered, err := alertRuleTriggered(rule.Condition, rule.Threshold, currentValue, baselineValue, deviation)
			if err != nil {
				return fmt.Errorf("alert rule %d: %w", rule.ID, err)
			}
			if !triggered {
				continue
			}
			message := buildAlertMessage(rule.Metric, rule.Condition, currentValue, baselineValue, deviation)
			dedupCutoff := now.Add(-24 * time.Hour)
			tag, err := db.Exec(
				ctx,
				insertAlertEventSQL,
				rule.ID,
				rule.ProjectID,
				rule.Metric,
				currentValue,
				baselineValue,
				deviation,
				rule.Severity,
				message,
				now,
				dedupCutoff,
			)
			if err != nil {
				return fmt.Errorf("insert alert event for rule %d: %w", rule.ID, err)
			}
			eventsCreated += tag.RowsAffected()
		}

		return handler.writeResult(task, taskResult{
			TaskType: queue.TypeAlertDetect,
			Status:   "completed",
			Data: map[string]any{
				"rules_evaluated": len(rules),
				"events_created":  eventsCreated,
			},
		})
	})
}

func loadActiveAlertRules(ctx context.Context, db store.FullDB) ([]alertRuleRecord, error) {
	rows, err := db.Query(ctx, selectActiveAlertRulesSQL)
	if err != nil {
		return nil, fmt.Errorf("load active alert rules: %w", err)
	}
	defer rows.Close()

	var rules []alertRuleRecord
	for rows.Next() {
		var rule alertRuleRecord
		if err := rows.Scan(
			&rule.ID,
			&rule.Name,
			&rule.ProjectID,
			&rule.Country,
			&rule.Metric,
			&rule.TriggerType,
			&rule.Condition,
			&rule.Threshold,
			&rule.WindowDays,
			&rule.Severity,
			&rule.NotificationChannels,
		); err != nil {
			return nil, fmt.Errorf("scan active alert rule: %w", err)
		}
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate active alert rules: %w", err)
	}
	return rules, nil
}

func alertMetricSQL(metric string) (string, error) {
	switch strings.TrimSpace(metric) {
	case "sales_amount":
		return salesAmountMetricSQL, nil
	case "order_qty":
		return orderQuantityMetricSQL, nil
	case "ad_spend":
		return adSpendMetricSQL, nil
	case "acos":
		return acosMetricSQL, nil
	case "return_rate":
		return returnRateMetricSQL, nil
	default:
		return "", fmt.Errorf("unsupported alert metric %q", metric)
	}
}

func alertRuleTriggered(
	condition string,
	threshold float64,
	currentValue float64,
	baselineValue float64,
	deviation float64,
) (bool, error) {
	switch strings.TrimSpace(condition) {
	case "below":
		return currentValue < baselineValue*(1-threshold/100), nil
	case "above":
		return currentValue > baselineValue*(1+threshold/100), nil
	case "drop_pct":
		return deviation < -threshold, nil
	case "rise_pct":
		return deviation > threshold, nil
	default:
		return false, fmt.Errorf("unsupported alert condition %q", condition)
	}
}

func buildAlertMessage(
	metric string,
	condition string,
	currentValue float64,
	baselineValue float64,
	deviation float64,
) string {
	label := map[string]string{
		"sales_amount": "销售额",
		"order_qty":    "订单量",
		"ad_spend":     "广告花费",
		"acos":         "ACOS",
		"return_rate":  "退货率",
	}[metric]
	if label == "" {
		label = metric
	}
	direction := "上升"
	if condition == "below" || condition == "drop_pct" {
		direction = "下降"
	}
	return fmt.Sprintf(
		"%s%s %+.1f%%，当前 %.2f，基线 %.2f",
		label,
		direction,
		deviation,
		currentValue,
		baselineValue,
	)
}
