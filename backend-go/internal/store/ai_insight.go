package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type AIInsightStore struct {
	db                 FullDB
	auditor            audit.Service
	observationEnabled bool
}

func NewAIInsightStore(db FullDB, auditor audit.Service) *AIInsightStore {
	return NewAIInsightStoreWithObservation(db, auditor, true)
}

func NewAIInsightStoreWithObservation(
	db FullDB,
	auditor audit.Service,
	observationEnabled bool,
) *AIInsightStore {
	if auditor == nil && db != nil {
		auditor = audit.NewService(db)
	}
	return &AIInsightStore{
		db:                 db,
		auditor:            auditor,
		observationEnabled: observationEnabled,
	}
}

var _ ai_insight.Store = (*AIInsightStore)(nil)
var _ ai_insight.ScheduleGeneratorStore = (*AIInsightStore)(nil)

func (s *AIInsightStore) logActionTx(ctx context.Context, tx pgx.Tx, entry audit.Entry) error {
	if s.auditor == nil {
		return errors.New("audit service is not configured")
	}
	return s.auditor.LogActionTx(ctx, tx, entry)
}

func (s *AIInsightStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) (ai_insight.ProjectInfo, error) {
	return verifyAIInsightProjectAccess(ctx, s.db, projectID, operator, isAdmin)
}

func verifyAIInsightProjectAccess(
	ctx context.Context,
	db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	},
	projectID int64,
	operator string,
	isAdmin bool,
) (ai_insight.ProjectInfo, error) {
	var info ai_insight.ProjectInfo
	err := db.QueryRow(
		ctx,
		`select id, project_name, country, project_operator, assistant_operator
		 from public.projects where id = $1`,
		projectID,
	).Scan(&info.ID, &info.Name, &info.Country, &info.ProjectOperator, &info.AssistantOperator)
	if errors.Is(err, pgx.ErrNoRows) {
		return ai_insight.ProjectInfo{}, ai_insight.ErrProjectNotFound
	}
	if err != nil {
		return ai_insight.ProjectInfo{}, err
	}
	if isAdmin {
		return info, nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return ai_insight.ProjectInfo{}, ai_insight.ErrProjectForbidden
	}
	if textContainsName(info.ProjectOperator, operator) || textContainsName(info.AssistantOperator, operator) {
		return info, nil
	}
	return ai_insight.ProjectInfo{}, ai_insight.ErrProjectForbidden
}

func (s *AIInsightStore) AccessibleProjectIDs(ctx context.Context, operator string, isAdmin bool) ([]int64, error) {
	if !isAdmin && strings.TrimSpace(operator) == "" {
		return []int64{}, nil
	}
	query := `select id from public.projects where is_active = true order by sort_order asc, id asc`
	if !isAdmin {
		query = `select id, project_operator, assistant_operator from public.projects where is_active = true order by sort_order asc, id asc`
	}
	rows, err := s.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []int64{}, nil
	}
	defer rows.Close()
	ids := make([]int64, 0)
	for rows.Next() {
		if isAdmin {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			ids = append(ids, id)
			continue
		}
		var id int64
		var projectOperator, assistantOperator *string
		if err := rows.Scan(&id, &projectOperator, &assistantOperator); err != nil {
			return nil, err
		}
		if textContainsName(projectOperator, operator) || textContainsName(assistantOperator, operator) {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

const insightSelectColumns = `
	id, project_id, project_name, country, title, content, insight_type,
	date_range_start, date_range_end, status, sub_status, error_message,
	strategy_metadata, created_by, created_at, updated_at`

func scanInsightDetail(row pgx.Row) (*ai_insight.InsightDetail, error) {
	var detail ai_insight.InsightDetail
	var start, end time.Time
	err := row.Scan(
		&detail.ID, &detail.ProjectID, &detail.ProjectName, &detail.Country,
		&detail.Title, &detail.Content, &detail.InsightType, &start, &end,
		&detail.Status, &detail.SubStatus, &detail.ErrorMessage, &detail.StrategyMetadata,
		&detail.CreatedBy, &detail.CreatedAt, &detail.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	detail.DateRangeStart = ai_insight.DateOnly(start)
	detail.DateRangeEnd = ai_insight.DateOnly(end)
	return &detail, nil
}

func scanInsightItem(row pgx.Row) (*ai_insight.InsightItem, error) {
	var item ai_insight.InsightItem
	var start, end time.Time
	err := row.Scan(
		&item.ID, &item.ProjectID, &item.ProjectName, &item.Country, &item.Title,
		&item.InsightType, &start, &end, &item.Status, &item.SubStatus,
		&item.ErrorMessage, &item.CreatedBy, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	item.DateRangeStart = ai_insight.DateOnly(start)
	item.DateRangeEnd = ai_insight.DateOnly(end)
	return &item, nil
}

func (s *AIInsightStore) ListInsights(ctx context.Context, filter ai_insight.ListFilter) ([]ai_insight.InsightItem, int, error) {
	var accessible []int64
	if !filter.IsAdmin {
		ids, err := s.AccessibleProjectIDs(ctx, filter.Operator, false)
		if err != nil {
			return nil, 0, err
		}
		if len(ids) == 0 {
			return []ai_insight.InsightItem{}, 0, nil
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
		add("project_id = any($%d)", accessible)
	}
	if filter.ProjectID != nil {
		add("project_id = $%d", *filter.ProjectID)
	}
	if filter.Country != nil && *filter.Country != "" {
		add("country = $%d", strings.ToUpper(*filter.Country))
	}
	if filter.Status != nil && *filter.Status != "" {
		add("status = $%d", *filter.Status)
	}
	if filter.Type != nil && *filter.Type != "" {
		add("insight_type = $%d", *filter.Type)
	}
	where := ""
	if len(conditions) > 0 {
		where = " where " + strings.Join(conditions, " and ")
	}
	countSQL := "select count(*) from public.ai_insights" + where
	var total int
	if err := s.db.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = 20
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}
	args = append(args, limit, offset)
	query := "select id, project_id, project_name, country, title, insight_type, date_range_start, date_range_end, status, sub_status, error_message, created_by, created_at, updated_at from public.ai_insights" +
		where + fmt.Sprintf(" order by created_at desc limit $%d offset $%d", len(args)-1, len(args))
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	if rows == nil {
		return []ai_insight.InsightItem{}, total, nil
	}
	defer rows.Close()
	items := make([]ai_insight.InsightItem, 0)
	for rows.Next() {
		row := insightRowsScanner{rows: rows}
		item, err := scanInsightItem(row)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

type insightRowsScanner struct{ rows Rows }

func (scanner insightRowsScanner) Scan(dest ...any) error { return scanner.rows.Scan(dest...) }

func (s *AIInsightStore) GetInsight(ctx context.Context, insightID int64) (*ai_insight.InsightDetail, error) {
	detail, err := scanInsightDetail(s.db.QueryRow(ctx, `select `+insightSelectColumns+` from public.ai_insights where id = $1`, insightID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ai_insight.ErrInsightNotFound
	}
	return detail, err
}

func (s *AIInsightStore) GetLatestInsight(ctx context.Context, projectID int64, country string) (*ai_insight.InsightDetail, error) {
	detail, err := scanInsightDetail(s.db.QueryRow(
		ctx,
		`select `+insightSelectColumns+` from public.ai_insights
		 where project_id = $1 and country = $2 and status = 'completed'
		 order by created_at desc limit 1`,
		projectID, strings.ToUpper(country),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ai_insight.ErrInsightNotFound
	}
	return detail, err
}

func (s *AIInsightStore) GetInsightStatus(ctx context.Context, insightID int64) (*ai_insight.InsightStatusSnapshot, error) {
	var snapshot ai_insight.InsightStatusSnapshot
	err := s.db.QueryRow(
		ctx,
		`select id, project_id, title, content, status, sub_status, error_message
		 from public.ai_insights where id = $1`,
		insightID,
	).Scan(&snapshot.ID, &snapshot.ProjectID, &snapshot.Title, &snapshot.Content, &snapshot.Status, &snapshot.SubStatus, &snapshot.ErrorMessage)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ai_insight.ErrInsightNotFound
	}
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func (s *AIInsightStore) CreateInsight(ctx context.Context, input ai_insight.CreateInsightInput) (*ai_insight.InsightDetail, error) {
	var created *ai_insight.InsightDetail
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var projectName string
		if err := txDB.QueryRow(ctx, `select project_name from public.projects where id = $1`, input.ProjectID).Scan(&projectName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ai_insight.ErrProjectNotFound
			}
			return err
		}
		detail, err := scanInsightDetail(txDB.QueryRow(
			ctx,
			`insert into public.ai_insights (
				project_id, project_name, country, title, content, insight_type,
				date_range_start, date_range_end, status, created_by, created_at, updated_at
			 ) values ($1,$2,$3,'生成中...','',$4,$5,$6,'pending',$7,now(),now())
			 returning `+insightSelectColumns,
			input.ProjectID, projectName, strings.ToUpper(input.Country), input.InsightType,
			input.DateRangeStart, input.DateRangeEnd, operatorOrUnknown(input.Operator),
		))
		if err != nil {
			return err
		}
		created = detail
		target := strconv.FormatInt(detail.ID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(
			input.Audit, "ai_insights.generate", "ai_insight", target, nil, detail, nil,
		))
	})
	return created, err
}

func (s *AIInsightStore) UpdateInsightContent(ctx context.Context, insightID int64, input ai_insight.UpdateInsightInput) (*ai_insight.InsightDetail, error) {
	var updated *ai_insight.InsightDetail
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		detail, err := scanInsightDetail(txDB.QueryRow(ctx, `select `+insightSelectColumns+` from public.ai_insights where id = $1 for update`, insightID))
		if errors.Is(err, pgx.ErrNoRows) {
			return ai_insight.ErrInsightNotFound
		}
		if err != nil {
			return err
		}
		if _, err := verifyAIInsightProjectAccess(ctx, txDB, detail.ProjectID, input.Operator, input.IsAdmin); err != nil {
			return err
		}
		before := *detail
		detail.Content = normalizeLegacyMarkdown(strings.TrimSpace(input.Content))
		updatedRow, err := scanInsightDetail(txDB.QueryRow(
			ctx,
			`update public.ai_insights set content = $1, updated_at = now() where id = $2 returning `+insightSelectColumns,
			detail.Content, insightID,
		))
		if err != nil {
			return err
		}
		updated = updatedRow
		target := strconv.FormatInt(insightID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(
			input.Audit, "ai_insights.update", "ai_insight", target, before, updatedRow, nil,
		))
	})
	return updated, err
}

func (s *AIInsightStore) DeleteInsight(ctx context.Context, insightID int64, operator string, isAdmin bool, meta ai_insight.MutationMeta) (bool, error) {
	deleted := false
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		detail, err := scanInsightDetail(txDB.QueryRow(ctx, `select `+insightSelectColumns+` from public.ai_insights where id = $1 for update`, insightID))
		if errors.Is(err, pgx.ErrNoRows) {
			return ai_insight.ErrInsightNotFound
		}
		if err != nil {
			return err
		}
		if _, err := verifyAIInsightProjectAccess(ctx, txDB, detail.ProjectID, operator, isAdmin); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `delete from public.ai_insights where id = $1`, insightID)
		if err != nil {
			return err
		}
		deleted = tag.RowsAffected() > 0
		target := strconv.FormatInt(insightID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(meta, "ai_insights.delete", "ai_insight", target, detail, nil, nil))
	})
	return deleted, err
}

func (s *AIInsightStore) ResetInsightForRetry(ctx context.Context, insightID int64, operator string, isAdmin bool, meta ai_insight.MutationMeta) (*ai_insight.InsightDetail, error) {
	var updated *ai_insight.InsightDetail
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		detail, err := scanInsightDetail(txDB.QueryRow(ctx, `select `+insightSelectColumns+` from public.ai_insights where id = $1 for update`, insightID))
		if errors.Is(err, pgx.ErrNoRows) {
			return ai_insight.ErrInsightNotFound
		}
		if err != nil {
			return err
		}
		if _, err := verifyAIInsightProjectAccess(ctx, txDB, detail.ProjectID, operator, isAdmin); err != nil {
			return err
		}
		if detail.Status == "completed" {
			return ai_insight.ErrInsightCompleted
		}
		before := *detail
		updatedRow, err := scanInsightDetail(txDB.QueryRow(
			ctx,
			`update public.ai_insights
			 set status = 'pending', sub_status = null, error_message = null,
			     content = '', title = '生成中...', updated_at = now()
			 where id = $1 returning `+insightSelectColumns,
			insightID,
		))
		if err != nil {
			return err
		}
		updated = updatedRow
		target := strconv.FormatInt(insightID, 10)
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(meta, "ai_insights.retry", "ai_insight", target, before, updatedRow, nil))
	})
	return updated, err
}

func operatorOrUnknown(operator string) string {
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return "unknown"
	}
	return operator
}

func normalizeLegacyMarkdown(content string) string {
	return content
}
