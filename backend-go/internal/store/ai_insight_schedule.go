package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/robfig/cron/v3"
)

const insightScheduleColumns = `
	s.id, s.project_id, coalesce(p.project_name, '未知项目'), s.country,
	s.insight_type, s.cron_expression, s.date_range_strategy, s.model,
	s.is_active, s.run_count, s.failure_count, s.last_run_at,
	s.last_insight_id, s.last_error, s.next_run_at, s.created_by,
	s.created_at, s.updated_at`

const insightScheduleColumnsNoProject = `
	s.id, s.project_id, s.country, s.insight_type, s.cron_expression,
	s.date_range_strategy, s.model, s.is_active, s.run_count, s.failure_count,
	s.last_run_at, s.last_insight_id, s.last_error, s.next_run_at,
	s.created_by, s.created_at, s.updated_at`

func scanSchedule(row pgx.Row, projectName string) (*ai_insight.Schedule, error) {
	schedule := ai_insight.Schedule{ProjectName: projectName}
	var lastInsightID pgtype.Int8
	err := row.Scan(
		&schedule.ID, &schedule.ProjectID, &schedule.Country, &schedule.InsightType,
		&schedule.CronExpression, &schedule.DateRangeStrategy, &schedule.Model,
		&schedule.IsActive, &schedule.RunCount, &schedule.FailureCount,
		&schedule.LastRunAt, &lastInsightID, &schedule.LastError,
		&schedule.NextRunAt, &schedule.CreatedBy, &schedule.CreatedAt, &schedule.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if lastInsightID.Valid {
		value := lastInsightID.Int64
		schedule.LastInsightID = &value
	}
	return &schedule, nil
}

func scanScheduleWithProject(row pgx.Row) (*ai_insight.Schedule, error) {
	var schedule ai_insight.Schedule
	var lastInsightID pgtype.Int8
	err := row.Scan(
		&schedule.ID, &schedule.ProjectID, &schedule.ProjectName, &schedule.Country,
		&schedule.InsightType, &schedule.CronExpression, &schedule.DateRangeStrategy,
		&schedule.Model, &schedule.IsActive, &schedule.RunCount, &schedule.FailureCount,
		&schedule.LastRunAt, &lastInsightID, &schedule.LastError,
		&schedule.NextRunAt, &schedule.CreatedBy, &schedule.CreatedAt, &schedule.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if lastInsightID.Valid {
		value := lastInsightID.Int64
		schedule.LastInsightID = &value
	}
	return &schedule, nil
}

func (s *AIInsightStore) ListSchedules(ctx context.Context, filter ai_insight.ScheduleFilter) ([]ai_insight.Schedule, error) {
	var accessible []int64
	if !filter.IsAdmin {
		ids, err := s.AccessibleProjectIDs(ctx, filter.Operator, false)
		if err != nil {
			return nil, err
		}
		if len(ids) == 0 {
			return []ai_insight.Schedule{}, nil
		}
		accessible = ids
	}
	args := make([]any, 0)
	conditions := make([]string, 0)
	add := func(condition string, value any) {
		args = append(args, value)
		conditions = append(conditions, fmt.Sprintf(condition, len(args)))
	}
	if len(accessible) > 0 {
		add("s.project_id = any($%d)", accessible)
	}
	if filter.ProjectID != nil {
		add("s.project_id = $%d", *filter.ProjectID)
	}
	if filter.IsActive != nil {
		add("s.is_active = $%d", *filter.IsActive)
	}
	if filter.Type != nil && *filter.Type != "" {
		add("s.insight_type = $%d", *filter.Type)
	}
	query := `select ` + insightScheduleColumns + `
		from public.insight_schedules s
		left join public.projects p on p.id = s.project_id`
	if len(conditions) > 0 {
		query += " where " + strings.Join(conditions, " and ")
	}
	query += " order by s.created_at desc"
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []ai_insight.Schedule{}, nil
	}
	defer rows.Close()
	items := make([]ai_insight.Schedule, 0)
	for rows.Next() {
		schedule, err := scanScheduleWithProject(insightRowsScanner{rows: rows})
		if err != nil {
			return nil, err
		}
		items = append(items, *schedule)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AIInsightStore) GetSchedule(ctx context.Context, scheduleID int64) (*ai_insight.Schedule, error) {
	schedule, err := scanScheduleWithProject(s.db.QueryRow(
		ctx,
		`select `+insightScheduleColumns+`
		 from public.insight_schedules s
		 left join public.projects p on p.id = s.project_id
		 where s.id = $1`,
		scheduleID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ai_insight.ErrScheduleNotFound
	}
	return schedule, err
}

func (s *AIInsightStore) CreateSchedule(ctx context.Context, input ai_insight.CreateScheduleInput) (*ai_insight.Schedule, error) {
	var created *ai_insight.Schedule
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var projectName string
		if err := txDB.QueryRow(ctx, `select project_name from public.projects where id = $1`, input.ProjectID).Scan(&projectName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ai_insight.ErrProjectNotFound
			}
			return err
		}
		next := nextCronTime(input.CronExpression, time.Now())
		schedule, err := scanSchedule(txDB.QueryRow(
			ctx,
			`insert into public.insight_schedules (
				project_id, country, insight_type, cron_expression, date_range_strategy,
				model, is_active, created_by, next_run_at, created_at, updated_at
			 ) values ($1,$2,$3,$4,$5,$6,true,$7,$8,now(),now())
			 returning `+insightScheduleColumnsNoProject,
			input.ProjectID, strings.ToUpper(input.Country), input.InsightType,
			input.CronExpression, input.DateRangeStrategy, input.Model,
			operatorOrUnknown(input.Operator), next,
		), projectName)
		if err != nil {
			return err
		}
		created = schedule
		target := strconv.FormatInt(schedule.ID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(input.Audit, "insight_schedules.create", "insight_schedule", target, nil, schedule, nil))
	})
	return created, err
}

func (s *AIInsightStore) UpdateSchedule(ctx context.Context, scheduleID int64, input ai_insight.UpdateScheduleInput) (*ai_insight.Schedule, error) {
	var updated *ai_insight.Schedule
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		schedule, err := scanSchedule(txDB.QueryRow(ctx, `select `+insightScheduleColumnsNoProject+` from public.insight_schedules s where s.id = $1 for update`, scheduleID), "未知项目")
		if errors.Is(err, pgx.ErrNoRows) {
			return ai_insight.ErrScheduleNotFound
		}
		if err != nil {
			return err
		}
		if _, err := verifyAIInsightProjectAccess(ctx, txDB, schedule.ProjectID, input.Operator, input.IsAdmin); err != nil {
			return err
		}
		before := *schedule
		if input.Country != nil {
			schedule.Country = strings.ToUpper(*input.Country)
		}
		if input.InsightType != nil {
			schedule.InsightType = *input.InsightType
		}
		if input.CronExpression != nil {
			schedule.CronExpression = *input.CronExpression
			schedule.NextRunAt = nextCronTime(schedule.CronExpression, time.Now())
		}
		if input.DateRangeStrategy != nil {
			schedule.DateRangeStrategy = *input.DateRangeStrategy
		}
		if input.ModelSet {
			schedule.Model = input.Model
		}
		if input.IsActive != nil {
			schedule.IsActive = *input.IsActive
		}
		row, err := scanSchedule(txDB.QueryRow(
			ctx,
			`update public.insight_schedules set
				country=$1, insight_type=$2, cron_expression=$3,
				date_range_strategy=$4, model=$5, is_active=$6,
				next_run_at=$7, updated_at=now()
			 where id=$8 returning `+insightScheduleColumnsNoProject,
			schedule.Country, schedule.InsightType, schedule.CronExpression,
			schedule.DateRangeStrategy, schedule.Model, schedule.IsActive,
			schedule.NextRunAt, scheduleID,
		), "未知项目")
		if err != nil {
			return err
		}
		updated = row
		target := strconv.FormatInt(scheduleID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(input.Audit, "insight_schedules.update", "insight_schedule", target, before, row, nil))
	})
	return updated, err
}

func (s *AIInsightStore) DeleteSchedule(ctx context.Context, scheduleID int64, operator string, isAdmin bool, meta ai_insight.MutationMeta) (bool, error) {
	deleted := false
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		schedule, err := scanSchedule(txDB.QueryRow(ctx, `select `+insightScheduleColumnsNoProject+` from public.insight_schedules s where s.id = $1 for update`, scheduleID), "未知项目")
		if errors.Is(err, pgx.ErrNoRows) {
			return ai_insight.ErrScheduleNotFound
		}
		if err != nil {
			return err
		}
		if _, err := verifyAIInsightProjectAccess(ctx, txDB, schedule.ProjectID, operator, isAdmin); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `delete from public.insight_schedules where id = $1`, scheduleID)
		if err != nil {
			return err
		}
		deleted = tag.RowsAffected() > 0
		target := strconv.FormatInt(scheduleID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(meta, "insight_schedules.delete", "insight_schedule", target, schedule, nil, nil))
	})
	return deleted, err
}

func (s *AIInsightStore) ToggleSchedule(ctx context.Context, scheduleID int64, operator string, isAdmin bool, meta ai_insight.MutationMeta) (*ai_insight.Schedule, error) {
	var updated *ai_insight.Schedule
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		schedule, err := scanSchedule(txDB.QueryRow(ctx, `select `+insightScheduleColumnsNoProject+` from public.insight_schedules s where s.id = $1 for update`, scheduleID), "未知项目")
		if errors.Is(err, pgx.ErrNoRows) {
			return ai_insight.ErrScheduleNotFound
		}
		if err != nil {
			return err
		}
		if _, err := verifyAIInsightProjectAccess(ctx, txDB, schedule.ProjectID, operator, isAdmin); err != nil {
			return err
		}
		before := *schedule
		schedule.IsActive = !schedule.IsActive
		if schedule.IsActive {
			schedule.NextRunAt = nextCronTime(schedule.CronExpression, time.Now())
		}
		row, err := scanSchedule(txDB.QueryRow(
			ctx,
			`update public.insight_schedules
			 set is_active=$1, next_run_at=$2, updated_at=now()
			 where id=$3 returning `+insightScheduleColumnsNoProject,
			schedule.IsActive, schedule.NextRunAt, scheduleID,
		), "未知项目")
		if err != nil {
			return err
		}
		updated = row
		target := strconv.FormatInt(scheduleID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(meta, "insight_schedules.toggle", "insight_schedule", target, before, row, nil))
	})
	return updated, err
}

// CreateScheduledInsight implements the schedule-only Celery-compatible path:
// one transaction validates the active schedule, creates the legacy AIInsight
// row, and advances schedule counters. The provider call happens after commit.
func (s *AIInsightStore) CreateScheduledInsight(
	ctx context.Context,
	scheduleID int64,
	startDate, endDate time.Time,
) (*ai_insight.GenerationContext, error) {
	var generationContext *ai_insight.GenerationContext
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		schedule, err := scanSchedule(
			txDB.QueryRow(
				ctx,
				`select `+insightScheduleColumnsNoProject+`
				 from public.insight_schedules s
				 where s.id = $1 for update`,
				scheduleID,
			),
			"未知项目",
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return ai_insight.ErrScheduleNotFound
		}
		if err != nil {
			return err
		}
		if !schedule.IsActive {
			return ai_insight.ErrScheduleInactive
		}
		var projectName string
		if err := txDB.QueryRow(
			ctx,
			`select project_name from public.projects where id = $1`,
			schedule.ProjectID,
		).Scan(&projectName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ai_insight.ErrProjectNotFound
			}
			return err
		}
		createdBy := fmt.Sprintf("scheduler:%d", scheduleID)
		detail, err := scanInsightDetail(txDB.QueryRow(
			ctx,
			`insert into public.ai_insights (
				project_id, project_name, country, title, content, insight_type,
				date_range_start, date_range_end, status, created_by, created_at, updated_at
			 ) values ($1,$2,$3,'定时生成中...','',$4,$5,$6,'pending',$7,now(),now())
			 returning `+insightSelectColumns,
			schedule.ProjectID,
			projectName,
			schedule.Country,
			schedule.InsightType,
			startDate,
			endDate,
			createdBy,
		))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			ctx,
			`update public.insight_schedules
			 set last_run_at = now(), last_insight_id = $1,
			     run_count = run_count + 1, last_error = null, updated_at = now()
			 where id = $2`,
			detail.ID,
			scheduleID,
		); err != nil {
			return err
		}
		generationContext = &ai_insight.GenerationContext{
			InsightID:      detail.ID,
			ProjectID:      schedule.ProjectID,
			ProjectName:    projectName,
			Country:        schedule.Country,
			InsightType:    schedule.InsightType,
			DateRangeStart: ai_insight.DateOnly(startDate),
			DateRangeEnd:   ai_insight.DateOnly(endDate),
			Model:          schedule.Model,
		}
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(
			ai_insight.MutationMeta{Operator: createdBy},
			"ai_insights.generate",
			"ai_insight",
			strconv.FormatInt(detail.ID, 10),
			nil,
			map[string]any{
				"schedule_id":      scheduleID,
				"project_id":       schedule.ProjectID,
				"project_name":     projectName,
				"country":          schedule.Country,
				"insight_type":     schedule.InsightType,
				"date_range_start": ai_insight.DateOnly(startDate),
				"date_range_end":   ai_insight.DateOnly(endDate),
				"status":           "pending",
			},
			nil,
		))
	})
	if err != nil {
		return nil, err
	}
	return generationContext, nil
}

func (s *AIInsightStore) RunScheduleNow(ctx context.Context, scheduleID int64, operator string, isAdmin bool, meta ai_insight.MutationMeta) (*ai_insight.RunScheduleResult, error) {
	var result *ai_insight.RunScheduleResult
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		schedule, err := scanSchedule(txDB.QueryRow(ctx, `select `+insightScheduleColumnsNoProject+` from public.insight_schedules s where s.id = $1 for update`, scheduleID), "未知项目")
		if errors.Is(err, pgx.ErrNoRows) {
			return ai_insight.ErrScheduleNotFound
		}
		if err != nil {
			return err
		}
		if _, err := verifyAIInsightProjectAccess(ctx, txDB, schedule.ProjectID, operator, isAdmin); err != nil {
			return err
		}
		var projectName string
		if err := txDB.QueryRow(ctx, `select project_name from public.projects where id = $1`, schedule.ProjectID).Scan(&projectName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ai_insight.ErrProjectNotFound
			}
			return err
		}
		reference := time.Now().In(aiInsightShanghaiLocation())
		start, end := ai_insight.CalculateDateRange(schedule.DateRangeStrategy, reference)
		createdBy := "scheduler:manual"
		if strings.TrimSpace(operator) != "" {
			createdBy = "scheduler:" + operator
		}
		detail, err := scanInsightDetail(txDB.QueryRow(
			ctx,
			`insert into public.ai_insights (
				project_id, project_name, country, title, content, insight_type,
				date_range_start, date_range_end, status, created_by, created_at, updated_at
			 ) values ($1,$2,$3,'定时生成中...','',$4,$5,$6,'pending',$7,now(),now())
			 returning `+insightSelectColumns,
			schedule.ProjectID, projectName, schedule.Country, schedule.InsightType,
			start, end, createdBy,
		))
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`update public.insight_schedules
			 set last_run_at=now(), last_insight_id=$1, run_count=run_count+1,
			     last_error=null, updated_at=now()
			 where id=$2`,
			detail.ID, scheduleID,
		)
		if err != nil {
			return err
		}
		result = &ai_insight.RunScheduleResult{
			ScheduleID: scheduleID,
			InsightID:  detail.ID,
			Status:     "pending",
			Message:    fmt.Sprintf("洞察生成已启动，ID: %d", detail.ID),
		}
		target := strconv.FormatInt(detail.ID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(meta, "insight_schedules.run_now", "ai_insight", target, nil, result, nil))
	})
	return result, err
}

func (s *AIInsightStore) FailScheduleRun(ctx context.Context, scheduleID, insightID int64, message string) error {
	insightMessage := truncateText(message, 2000)
	scheduleMessage := truncateText(message, 500)
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(
			ctx,
			`update public.ai_insights
			 set status='failed', sub_status=null, error_message=$1, updated_at=now()
			 where id=$2`,
			insightMessage, insightID,
		)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`update public.insight_schedules
			 set failure_count=failure_count+1, last_error=$1, updated_at=now()
			 where id=$2`,
			scheduleMessage, scheduleID,
		)
		if err != nil {
			return err
		}
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(
			ai_insight.MutationMeta{Operator: "system:insight-worker"},
			"insight_schedules.run_now", "insight_schedule",
			strconv.FormatInt(scheduleID, 10), nil,
			map[string]any{"insight_id": insightID, "status": "failed", "message": scheduleMessage},
			errors.New(scheduleMessage),
		))
	})
}

func (s *AIInsightStore) ListAdAgentRuns(ctx context.Context, projectID *int64, limit int) ([]ai_insight.AdAgentRun, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	query := `select run_id, project_id, dimensions_analyzed, dimensions_skipped
		from public.ad_agent_runs`
	args := []any{}
	if projectID != nil {
		args = append(args, *projectID)
		query += " where project_id = $1"
	}
	args = append(args, limit)
	query += fmt.Sprintf(" order by created_at desc limit $%d", len(args))
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []ai_insight.AdAgentRun{}, nil
	}
	defer rows.Close()
	items := make([]ai_insight.AdAgentRun, 0)
	for rows.Next() {
		var run ai_insight.AdAgentRun
		var analyzedRaw, skippedRaw []byte
		if err := rows.Scan(&run.RunID, &run.ProjectID, &analyzedRaw, &skippedRaw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(analyzedRaw, &run.DimensionsAnalyzed)
		_ = json.Unmarshal(skippedRaw, &run.DimensionsSkipped)
		items = append(items, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AIInsightStore) LoadGenerationContext(ctx context.Context, insightID int64) (*ai_insight.GenerationContext, error) {
	var result ai_insight.GenerationContext
	var start, end time.Time
	var strategy *string
	err := s.db.QueryRow(
		ctx,
		`select id, project_id, project_name, country, insight_type,
		        date_range_start, date_range_end, strategy_metadata
		 from public.ai_insights where id=$1`,
		insightID,
	).Scan(&result.InsightID, &result.ProjectID, &result.ProjectName, &result.Country,
		&result.InsightType, &start, &end, &strategy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ai_insight.ErrInsightNotFound
	}
	if err != nil {
		return nil, err
	}
	result.DateRangeStart = ai_insight.DateOnly(start)
	result.DateRangeEnd = ai_insight.DateOnly(end)
	result.StrategyMeta = strategy
	return &result, nil
}

func (s *AIInsightStore) SetGenerationStatus(ctx context.Context, insightID int64, status, subStatus string) error {
	tag, err := s.db.Exec(
		ctx,
		`update public.ai_insights
		 set status=$1, sub_status=nullif($2,''), updated_at=now()
		 where id=$3`,
		status, subStatus, insightID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ai_insight.ErrInsightNotFound
	}
	return nil
}

func (s *AIInsightStore) CompleteGeneration(ctx context.Context, insightID int64, title, content string) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`update public.ai_insights
			 set title=$1, content=$2, status='completed', sub_status=null,
			     error_message=null, updated_at=now()
			 where id=$3`,
			truncateText(title, 255), content, insightID,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ai_insight.ErrInsightNotFound
		}
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(
			ai_insight.MutationMeta{Operator: "system:insight-worker"},
			"ai_insights.generate", "ai_insight",
			strconv.FormatInt(insightID, 10), nil,
			map[string]any{"status": "completed", "title": truncateText(title, 255), "content_chars": len([]rune(content))},
			nil,
		))
	})
}

func (s *AIInsightStore) FailGeneration(ctx context.Context, insightID int64, message string) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`update public.ai_insights
			 set status='failed', sub_status=null, error_message=$1, updated_at=now()
			 where id=$2`,
			truncateText(message, 2000), insightID,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ai_insight.ErrInsightNotFound
		}
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(
			ai_insight.MutationMeta{Operator: "system:insight-worker"},
			"ai_insights.generate", "ai_insight",
			strconv.FormatInt(insightID, 10), nil,
			map[string]any{"status": "failed", "message": truncateText(message, 2000)},
			errors.New(message),
		))
	})
}

func nextCronTime(expression string, now time.Time) *time.Time {
	schedule, err := cron.ParseStandard(expression)
	if err != nil {
		return nil
	}
	next := schedule.Next(now.In(aiInsightShanghaiLocation()))
	return &next
}

func aiInsightShanghaiLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("Asia/Shanghai", 8*60*60)
	}
	return location
}

func truncateText(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
