package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

const alertDetectionLockKey int64 = 736_278_941

func (s *AlertStore) Detect(
	ctx context.Context,
	input alerts.DetectionInput,
) (alerts.DetectionResult, error) {
	transactor, ok := s.db.(Transactor)
	if !ok {
		return alerts.DetectionResult{}, alerts.ErrDetectionUnavailable
	}

	var result alerts.DetectionResult
	err := RunInTx(ctx, transactor, func(tx pgx.Tx) error {
		var locked bool
		if err := tx.QueryRow(
			ctx,
			`select pg_try_advisory_xact_lock($1)`,
			alertDetectionLockKey,
		).Scan(&locked); err != nil {
			return err
		}
		if !locked {
			return alerts.ErrDetectionConflict
		}

		rows, err := tx.Query(
			ctx,
			`select
			   id, name, project_id, country, metric, trigger_type, condition,
			   threshold, window_days, severity, notification_channels, is_active,
			   created_by, created_at, updated_at
			 from public.alert_rules
			 where is_active = true
			 order by id
			 for update`,
		)
		if err != nil {
			return err
		}
		rules := make([]alerts.Rule, 0)
		for rows.Next() {
			rule, scanErr := scanAlertRule(rows)
			if scanErr != nil {
				rows.Close()
				return scanErr
			}
			rules = append(rules, rule)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		for _, rule := range rules {
			result.RulesEvaluated++
			baseline, current, available, err := alertMetricValues(ctx, tx, rule, input.Today)
			if err != nil {
				return err
			}
			if !available {
				continue
			}
			deviation := float64(0)
			if baseline != 0 {
				deviation = (current - baseline) / baseline * 100
			}
			if !alertRuleTriggered(rule, current, baseline, deviation) {
				continue
			}

			var duplicate bool
			if err := tx.QueryRow(
				ctx,
				`select exists (
				   select 1
				   from public.alert_events
				   where rule_id = $1
				     and status = 'active'
				     and triggered_at >= now() - interval '24 hours'
				 )`,
				rule.ID,
			).Scan(&duplicate); err != nil {
				return err
			}
			if duplicate {
				continue
			}

			message := alertMessage(rule.Metric, rule.Condition, current, baseline, deviation)
			tag, err := tx.Exec(
				ctx,
				`insert into public.alert_events (
				   rule_id, project_id, metric, current_value, baseline_value,
				   deviation_pct, severity, message, status
				 )
				 values ($1, $2, $3, $4, $5, $6, $7, $8, 'active')`,
				rule.ID,
				rule.ProjectID,
				rule.Metric,
				current,
				baseline,
				deviation,
				rule.Severity,
				message,
			)
			if err != nil {
				return err
			}
			if tag.RowsAffected() > 0 {
				result.EventsCreated++
				// FastAPI reports one dispatched message per created event.
				result.MessagesSent++
			}
		}

		entry := alertAuditEntry(input.Audit)
		entry.AfterJSON = map[string]any{
			"rules_evaluated": result.RulesEvaluated,
			"events_created":  result.EventsCreated,
			"messages_sent":   result.MessagesSent,
		}
		return audit.NewService(tx).LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		return alerts.DetectionResult{}, err
	}
	return result, nil
}

func alertMetricValues(
	ctx context.Context,
	tx pgx.Tx,
	rule alerts.Rule,
	today string,
) (float64, float64, bool, error) {
	window := rule.WindowDays
	if window <= 0 {
		window = 7
	}

	switch rule.Metric {
	case "sales_amount", "order_qty":
		valueColumn := "ordered_sales_amount"
		if rule.Metric == "order_qty" {
			valueColumn = "units_ordered"
		}
		var baseline, current float64
		err := tx.QueryRow(
			ctx,
			`select
			   coalesce((
			     select avg(abr.`+valueColumn+`)
			     from public.analysis_business_rows abr
			     join public.analysis_source_files asf on asf.id = abr.source_file_id
			     where asf.project_id = $1
			       and asf.country = $2
			       and asf.is_current = true
			       and asf.report_date >= $3::date - $4::integer
			       and asf.report_date <= $3::date - 1
			   ), 0)::double precision,
			   coalesce((
			     select sum(abr.`+valueColumn+`)
			     from public.analysis_business_rows abr
			     join public.analysis_source_files asf on asf.id = abr.source_file_id
			     where asf.project_id = $1
			       and asf.country = $2
			       and asf.is_current = true
			       and asf.report_date = $3::date - 1
			   ), 0)::double precision`,
			rule.ProjectID,
			rule.Country,
			today,
			window,
		).Scan(&baseline, &current)
		if err != nil {
			return 0, 0, false, err
		}
		return baseline, current, baseline > 0 && current > 0, nil

	case "ad_spend":
		var baseline, current float64
		err := tx.QueryRow(
			ctx,
			`select
			   coalesce((
			     select sum(acr.spend)
			     from public.ad_campaign_report_rows acr
			     join public.ad_source_files asf on asf.id = acr.source_file_id
			     where asf.project_id = $1
			       and asf.country = $2
			       and asf.is_current = true
			       and asf.report_date = $3::date - 1
			   ), 0)::double precision,
			   coalesce((
			     select sum(acr.spend)
			     from public.ad_campaign_report_rows acr
			     join public.ad_source_files asf on asf.id = acr.source_file_id
			     where asf.project_id = $1
			       and asf.country = $2
			       and asf.is_current = true
			       and asf.report_date >= $3::date - $4::integer
			       and asf.report_date <= $3::date - 1
			   ), 0)::double precision`,
			rule.ProjectID,
			rule.Country,
			today,
			window,
		).Scan(&baseline, &current)
		if err != nil {
			return 0, 0, false, err
		}
		// FastAPI currently uses current ad spend as its own baseline.
		baseline = current
		return baseline, current, baseline > 0 && current > 0, nil

	case "acos":
		var baseline, current float64
		err := tx.QueryRow(
			ctx,
			`select
			   coalesce((
			     select sum(acr.spend) / nullif(sum(acr.sales_7d), 0) * 100
			     from public.ad_campaign_report_rows acr
			     join public.ad_source_files asf on asf.id = acr.source_file_id
			     where asf.project_id = $1
			       and asf.country = $2
			       and asf.is_current = true
			       and asf.report_date >= $3::date - $4::integer
			       and asf.report_date <= $3::date - 1
			   ), 0)::double precision,
			   coalesce((
			     select sum(acr.spend) / nullif(sum(acr.sales_7d), 0) * 100
			     from public.ad_campaign_report_rows acr
			     join public.ad_source_files asf on asf.id = acr.source_file_id
			     where asf.project_id = $1
			       and asf.country = $2
			       and asf.is_current = true
			       and asf.report_date = $3::date - 1
			   ), 0)::double precision`,
			rule.ProjectID,
			rule.Country,
			today,
			window,
		).Scan(&baseline, &current)
		if err != nil {
			return 0, 0, false, err
		}
		return baseline, current, baseline > 0 && current > 0, nil

	default:
		return 0, 0, false, nil
	}
}

func alertRuleTriggered(rule alerts.Rule, current, baseline, deviation float64) bool {
	switch rule.Condition {
	case "below":
		return current < baseline*(1-rule.Threshold/100)
	case "above":
		return current > baseline*(1+rule.Threshold/100)
	case "drop_pct":
		return deviation < -rule.Threshold
	case "rise_pct":
		return deviation > rule.Threshold
	default:
		return false
	}
}

func alertMessage(metric, condition string, current, baseline, deviation float64) string {
	labels := map[string]string{
		"sales_amount":   "销售额",
		"order_qty":      "订单量",
		"ad_spend":       "广告花费",
		"acos":           "ACOS",
		"return_rate":    "退货率",
		"inventory_risk": "库存风险",
	}
	label := labels[metric]
	if label == "" {
		label = metric
	}
	direction := "上升"
	if condition == "below" || condition == "drop_pct" {
		direction = "下降"
	}
	return fmt.Sprintf(
		"%s%s %+.1f%%，当前 %.0f，基线 %.0f",
		label,
		direction,
		deviation,
		current,
		baseline,
	)
}
