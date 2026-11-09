package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type monthlyReportTaskJobPayload struct {
	JobType string `json:"job_type"`
	FileID  string `json:"file_id"`
	Params  struct {
		ReportID          int64             `json:"report_id"`
		MonthlyReportID   int64             `json:"monthly_report_id"`
		ProjectID         int64             `json:"project_id"`
		ProjectName       string            `json:"project_name"`
		Country           string            `json:"country"`
		ReportMonth       string            `json:"report_month"`
		TransactionFileID string            `json:"transaction_file_id"`
		FileIDs           map[string]string `json:"file_ids"`
	} `json:"params"`
}

type monthlyReportTaskProgressPayload struct {
	Stage    string `json:"stage"`
	Progress int    `json:"progress"`
	Message  any    `json:"message"`
}

func (s *MonthlyReportStore) GetTask(
	ctx context.Context,
	taskID int64,
) (*monthly_reports.MonthlyReportTask, error) {
	var (
		jobID       int64
		status      string
		payloadJSON []byte
		createdAt   time.Time
		updatedAt   time.Time
		logExcerpt  *string
		runError    *string
		runResult   *string
		runStarted  pgtype.Timestamptz
		runFinished pgtype.Timestamptz
	)
	err := s.db.QueryRow(
		ctx,
		`select job.id,
		        job.status::text,
		        job.payload_json,
		        job.created_at,
		        job.updated_at,
		        run.log_excerpt,
		        run.error_message,
		        run.result_path,
		        run.started_at,
		        run.finished_at
		   from public.jobs job
		   left join lateral (
		     select jr.log_excerpt, jr.error_message, jr.result_path,
		            jr.started_at, jr.finished_at
		       from public.job_runs jr
		      where jr.job_id = job.id
		      order by jr.id desc
		      limit 1
		   ) run on true
		  where job.id = $1
		    and job.job_type = 'monthly_report'
		    and job.created_at > now() - interval '24 hours'`,
		taskID,
	).Scan(
		&jobID,
		&status,
		&payloadJSON,
		&createdAt,
		&updatedAt,
		&logExcerpt,
		&runError,
		&runResult,
		&runStarted,
		&runFinished,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, monthly_reports.ErrTaskNotFound
		}
		return nil, err
	}

	var payload monthlyReportTaskJobPayload
	if len(payloadJSON) > 0 {
		_ = json.Unmarshal(payloadJSON, &payload)
	}
	projectID, report, err := s.loadTaskMonthlyReport(ctx, payload)
	if err != nil {
		return nil, err
	}

	stage, progress, message := monthlyReportTaskProgress(status, logExcerpt)
	persistenceStatus, persistenceMessage := monthlyReportTaskPersistence(report)
	errorMessage := runError
	if errorMessage == nil && status == monthly_reports.MonthlyReportStatusFailed {
		value := "处理失败"
		errorMessage = &value
	}
	var resultPath *string
	if candidate := trimOptionalString(runResult); candidate != nil {
		if resolved := existingRegularFile(candidate, s.resultRoot); resolved != "" {
			resultPath = &resolved
		}
	}
	if resultPath == nil && report != nil {
		if candidate := trimOptionalString(report.ResultFilePath); candidate != nil {
			if resolved := existingRegularFile(candidate, s.resultRoot); resolved != "" {
				resultPath = &resolved
			}
		}
	}

	taskUpdatedAt := updatedAt
	for _, candidate := range []time.Time{
		monthlyReportTaskTimeOrZero(startedAtValue(runStarted)),
		monthlyReportTaskTimeOrZero(finishedAtValue(runFinished)),
	} {
		if !candidate.IsZero() && candidate.After(taskUpdatedAt) {
			taskUpdatedAt = candidate
		}
	}

	return &monthly_reports.MonthlyReportTask{
		TaskID:             jobID,
		Status:             status,
		Stage:              stage,
		Progress:           progress,
		Message:            message,
		ErrorMessage:       errorMessage,
		PersistenceStatus:  persistenceStatus,
		PersistenceMessage: persistenceMessage,
		CreatedAt:          httpapi.Timestamp(createdAt),
		UpdatedAt:          httpapi.Timestamp(taskUpdatedAt),
		ProjectID:          projectID,
		ResultFilePath:     resultPath,
	}, nil
}

func (s *MonthlyReportStore) GetTaskResult(
	ctx context.Context,
	taskID int64,
) (*monthly_reports.MonthlyReportExport, error) {
	task, err := s.GetTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task.Status != monthly_reports.MonthlyReportStatusCompleted {
		return nil, monthly_reports.ErrTaskNotFinished
	}
	path := existingRegularFile(task.ResultFilePath, s.resultRoot)
	if path == "" {
		return nil, monthly_reports.ErrExportNotFound
	}
	return &monthly_reports.MonthlyReportExport{
		Filename:    filepath.Base(path),
		ContentType: contentTypeForPath(path),
		Path:        path,
		ProjectID:   task.ProjectID,
	}, nil
}

type monthlyReportTaskReport struct {
	ID             int64
	ProjectID      int64
	Status         string
	ResultFilePath *string
	ErrorMessage   *string
}

func (s *MonthlyReportStore) loadTaskMonthlyReport(
	ctx context.Context,
	payload monthlyReportTaskJobPayload,
) (int64, *monthlyReportTaskReport, error) {
	reportID := payload.Params.ReportID
	if reportID <= 0 {
		reportID = payload.Params.MonthlyReportID
	}
	transactionFileID := strings.TrimSpace(payload.Params.TransactionFileID)
	if transactionFileID == "" {
		transactionFileID = strings.TrimSpace(payload.Params.FileIDs["transaction_report"])
	}
	if transactionFileID == "" {
		transactionFileID = strings.TrimSpace(payload.FileID)
	}

	if reportID > 0 {
		report, err := s.loadMonthlyReportTaskReport(ctx, "where report.id = $1", reportID)
		if err != nil {
			return 0, nil, err
		}
		if report != nil {
			return report.ProjectID, report, nil
		}
	}

	country := strings.TrimSpace(payload.Params.Country)
	reportMonth := strings.TrimSpace(payload.Params.ReportMonth)
	if country != "" && reportMonth != "" && transactionFileID != "" {
		args := []any{country, reportMonth, transactionFileID}
		projectClause := ""
		if payload.Params.ProjectID > 0 {
			args = append(args, payload.Params.ProjectID)
			projectClause = fmt.Sprintf("and report.project_id = $%d", len(args))
		} else if projectName := strings.TrimSpace(payload.Params.ProjectName); projectName != "" {
			args = append(args, projectName)
			projectClause = fmt.Sprintf("and report.project_name = $%d", len(args))
		}
		report, err := s.loadMonthlyReportTaskReport(
			ctx,
			`where report.country = $1
			   and report.report_month = $2
			   and report.transaction_file_id = $3 `+projectClause,
			args...,
		)
		if err != nil {
			return 0, nil, err
		}
		if report != nil {
			return report.ProjectID, report, nil
		}
	}

	return payload.Params.ProjectID, nil, nil
}

func (s *MonthlyReportStore) loadMonthlyReportTaskReport(
	ctx context.Context,
	whereSQL string,
	args ...any,
) (*monthlyReportTaskReport, error) {
	var report monthlyReportTaskReport
	err := s.db.QueryRow(
		ctx,
		`select report.id, report.project_id, report.status::text,
		        report.result_file_path, report.error_message
		   from public.monthly_reports report
		 `+whereSQL+`
		  order by report.created_at desc
		  limit 1`,
		args...,
	).Scan(
		&report.ID,
		&report.ProjectID,
		&report.Status,
		&report.ResultFilePath,
		&report.ErrorMessage,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &report, nil
}

func monthlyReportTaskProgress(
	status string,
	logExcerpt *string,
) (string, int, *string) {
	if logExcerpt != nil && strings.TrimSpace(*logExcerpt) != "" {
		raw := strings.TrimSpace(*logExcerpt)
		var payload monthlyReportTaskProgressPayload
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			stage := strings.TrimSpace(payload.Stage)
			if stage == "" {
				stage = monthlyReportTaskFallbackStage(status)
			}
			progress := payload.Progress
			if progress < 0 {
				progress = 0
			}
			if progress > 100 {
				progress = 100
			}
			message := monthlyReportTaskMessageValue(payload.Message)
			if message == nil {
				message = monthlyReportStringPointerValue(monthlyReportTaskFallbackMessage(status))
			}
			return stage, progress, message
		}
		return monthlyReportTaskFallbackStage(status),
			monthlyReportTaskFallbackProgress(status),
			monthlyReportStringPointerValue(raw)
	}
	return monthlyReportTaskFallbackStage(status),
		monthlyReportTaskFallbackProgress(status),
		monthlyReportStringPointerValue(monthlyReportTaskFallbackMessage(status))
}

func monthlyReportTaskFallbackStage(status string) string {
	switch status {
	case monthly_reports.MonthlyReportStatusPending:
		return "started"
	case monthly_reports.MonthlyReportStatusCalculating:
		return "processing"
	case monthly_reports.MonthlyReportStatusCompleted:
		return "completed"
	default:
		return "failed"
	}
}

func monthlyReportTaskFallbackProgress(status string) int {
	switch status {
	case monthly_reports.MonthlyReportStatusCompleted,
		monthly_reports.MonthlyReportStatusFailed:
		return 100
	case monthly_reports.MonthlyReportStatusPending:
		return 2
	default:
		return 10
	}
}

func monthlyReportTaskFallbackMessage(status string) string {
	switch status {
	case monthly_reports.MonthlyReportStatusPending:
		return "处理中：任务排队中"
	case monthly_reports.MonthlyReportStatusCalculating:
		return "处理中：任务执行中"
	case monthly_reports.MonthlyReportStatusCompleted:
		return "处理完成：报表已生成，可下载"
	default:
		return "处理失败"
	}
}

func monthlyReportTaskMessageValue(value any) *string {
	if value == nil {
		return nil
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" || text == "<nil>" {
		return nil
	}
	return &text
}

func monthlyReportTaskPersistence(
	report *monthlyReportTaskReport,
) (string, *string) {
	if report == nil {
		return "idle", nil
	}
	switch report.Status {
	case monthly_reports.MonthlyReportStatusPending:
		return report.Status, monthlyReportStringPointerValue("等待写入数据库")
	case monthly_reports.MonthlyReportStatusCalculating:
		return report.Status, monthlyReportStringPointerValue("后台同步中：正在写入数据库")
	case monthly_reports.MonthlyReportStatusCompleted:
		return report.Status, monthlyReportStringPointerValue("后台同步完成：数据库已更新")
	case monthly_reports.MonthlyReportStatusFailed:
		message := "后台同步失败：数据库同步失败"
		if report.ErrorMessage != nil && strings.TrimSpace(*report.ErrorMessage) != "" {
			message = "后台同步失败：" + strings.TrimSpace(*report.ErrorMessage)
		}
		return report.Status, &message
	default:
		return report.Status, report.ErrorMessage
	}
}

func startedAtValue(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}

func finishedAtValue(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}

func monthlyReportTaskTimeOrZero(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}
	return *value
}
