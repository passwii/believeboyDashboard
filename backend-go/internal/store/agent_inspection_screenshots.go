package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_inspection"
)

const agentInspectionScreenshotSelectSQL = `
	select s.id, s.report_id, r.period_id, r.project_id,
	       p.project_name, ip.week_start,
	       s.r2_key, s.thumbnail_key, s.filename, s.content_type,
	       s.file_size, s.caption, s.sort_order, s.created_at
	from public.inspection_screenshots s
	join public.inspection_reports r on r.id = s.report_id
	join public.projects p on p.id = r.project_id
	join public.inspection_periods ip on ip.id = r.period_id`

func (s *AgentInspectionStore) GetScreenshot(
	ctx context.Context,
	screenshotID int64,
) (*agent_inspection.Screenshot, error) {
	row := s.db.QueryRow(
		ctx,
		agentInspectionScreenshotSelectSQL+`
		 where s.id = $1
		 limit 1`,
		screenshotID,
	)
	screenshot, err := scanAgentInspectionScreenshot(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &screenshot, nil
}

func (s *AgentInspectionStore) LockScreenshot(
	ctx context.Context,
	screenshotID int64,
) (*agent_inspection.Screenshot, error) {
	row := s.db.QueryRow(
		ctx,
		agentInspectionScreenshotSelectSQL+`
		 where s.id = $1
		 limit 1
		 for update of s`,
		screenshotID,
	)
	screenshot, err := scanAgentInspectionScreenshot(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &screenshot, nil
}

func (s *AgentInspectionStore) GetScreenshotByIdempotency(
	ctx context.Context,
	agentID string,
	idempotencyKey string,
	requestPath string,
) (*agent_inspection.Screenshot, error) {
	var targetID, auditPath string
	err := s.db.QueryRow(
		ctx,
		`select coalesce(target_id, ''), coalesce(request_path, '')
		 from public.operation_audit_logs
		 where agent_id = $1
		   and idempotency_key = $2
		   and action = 'platform_inspection.upload_screenshot'
		   and result = 'success'
		   and target_type = 'inspection_screenshot'
		 order by id desc
		 limit 1`,
		agentID,
		idempotencyKey,
	).Scan(&targetID, &auditPath)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if auditPath != "" && auditPath != requestPath {
		return nil, agent_inspection.ErrIdempotencyConflict
	}
	screenshotID, err := strconv.ParseInt(targetID, 10, 64)
	if err != nil {
		return nil, nil
	}
	return s.GetScreenshot(ctx, screenshotID)
}

func (s *AgentInspectionStore) InsertScreenshot(
	ctx context.Context,
	input agent_inspection.InsertScreenshotInput,
) (*agent_inspection.Screenshot, error) {
	var (
		projectID int64
		periodID  int64
	)
	err := s.db.QueryRow(
		ctx,
		`select project_id, period_id
		 from public.inspection_reports
		 where id = $1
		 for update`,
		input.ReportID,
	).Scan(&projectID, &periodID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, agent_inspection.ErrReportNotFound
	}
	if err != nil {
		return nil, err
	}

	row := s.db.QueryRow(
		ctx,
		`insert into public.inspection_screenshots (
		   report_id, r2_key, thumbnail_key, filename, content_type,
		   file_size, caption, sort_order, created_at
		 )
		 values (
		   $1, $2, $3, $4, $5, $6, $7,
		   (
		     select coalesce(max(sort_order), -1) + 1
		     from public.inspection_screenshots
		     where report_id = $1
		   ),
		   now()
		 )
		 returning id`,
		input.ReportID,
		input.R2Key,
		input.ThumbnailKey,
		input.Filename,
		input.ContentType,
		input.FileSize,
		input.Caption,
	)
	var screenshotID int64
	if err := row.Scan(&screenshotID); err != nil {
		return nil, fmt.Errorf("insert inspection screenshot: %w", err)
	}
	screenshot, err := s.GetScreenshot(ctx, screenshotID)
	if err != nil {
		return nil, err
	}
	if screenshot == nil {
		return nil, agent_inspection.ErrScreenshotNotFound
	}
	if screenshot.ProjectID != projectID || screenshot.PeriodID != periodID {
		return nil, fmt.Errorf("inspection screenshot relation mismatch")
	}
	return screenshot, nil
}

func (s *AgentInspectionStore) DeleteScreenshot(
	ctx context.Context,
	screenshotID int64,
) (bool, error) {
	execer, ok := s.db.(Execer)
	if !ok {
		return false, errors.New("agent inspection database does not support Exec")
	}
	tag, err := execer.Exec(
		ctx,
		`delete from public.inspection_screenshots where id = $1`,
		screenshotID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func scanAgentInspectionScreenshot(
	row interface{ Scan(...any) error },
) (agent_inspection.Screenshot, error) {
	var (
		screenshot agent_inspection.Screenshot
		createdAt  time.Time
		weekStart  time.Time
	)
	err := row.Scan(
		&screenshot.ID, &screenshot.ReportID,
		&screenshot.PeriodID, &screenshot.ProjectID,
		&screenshot.ProjectName, &weekStart,
		&screenshot.R2Key, &screenshot.ThumbnailKey,
		&screenshot.Filename, &screenshot.ContentType,
		&screenshot.FileSize, &screenshot.Caption,
		&screenshot.SortOrder, &createdAt,
	)
	if err != nil {
		return agent_inspection.Screenshot{}, err
	}
	screenshot.WeekStart = weekStart.Format("2006-01-02")
	screenshot.CreatedAt = createdAt
	return screenshot, nil
}
