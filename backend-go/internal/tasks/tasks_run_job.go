package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	selectRunJobSQL = `
SELECT id, job_type, status, payload_json, operator
FROM public.jobs
WHERE id = $1
`
	selectLatestJobRunSQL = `
SELECT id
FROM public.job_runs
WHERE job_id = $1
ORDER BY id DESC
LIMIT 1
`
	insertJobRunSQL = `
INSERT INTO public.job_runs (job_id, started_at, operator, log_excerpt)
VALUES ($1, $2, $3, $4)
RETURNING id
`
	markJobRunningSQL = `
UPDATE public.jobs
SET status = 'running',
    updated_at = $2
WHERE id = $1
`
	markJobSuccessSQL = `
UPDATE public.jobs
SET status = 'success',
    updated_at = $2
WHERE id = $1
`
	markJobFailedSQL = `
UPDATE public.jobs
SET status = 'failed',
    updated_at = $2
WHERE id = $1
    AND status <> 'success'
`
	finishJobRunSuccessSQL = `
UPDATE public.job_runs
SET finished_at = $2,
    result_path = $3,
    log_excerpt = $4,
    error_message = NULL
WHERE id = $1
`
	finishJobRunFailedSQL = `
UPDATE public.job_runs
SET finished_at = $2,
    error_message = CASE
        WHEN error_message IS NULL OR error_message = '' THEN $3
        ELSE error_message || E'\n' || $3
    END
WHERE id = $1
`
	selectMonthlyReportForJobSQL = `
SELECT id, status::text, coalesce(result_file_path, ''),
       project_id, project_name, country, report_month
FROM public.monthly_reports
WHERE id = $1
`
	markMonthlyReportFailedSQL = `
UPDATE public.monthly_reports
SET status = 'failed',
    error_message = $2,
    updated_at = $3
WHERE id = $1
`
	markMonthlyReportRunningSQL = `
UPDATE public.monthly_reports
SET status = 'running',
    error_message = NULL,
    updated_at = $2
WHERE id = $1
  AND status IN ('pending', 'running')
`
)

type runJobRecord struct {
	ID          int64
	JobType     string
	Status      string
	PayloadJSON []byte
	Operator    *string
}

type jobPayloadEnvelope struct {
	JobType           string                     `json:"job_type"`
	FileID            string                     `json:"file_id"`
	TransactionFileID string                     `json:"transaction_file_id"`
	Params            map[string]json.RawMessage `json:"params"`
}

func (handler *TaskHandler) HandleRunJob(ctx context.Context, task *asynq.Task) error {
	const taskType = queue.TypeRunJob
	return handler.runSafely(taskType, func() error {
		var payload RunJobPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		if err := payload.Validate(); err != nil {
			return err
		}

		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		job, err := handler.loadRunJob(ctx, db, payload.JobID)
		if err != nil {
			return err
		}
		if job.Status == "success" {
			return handler.writeResult(task, taskResult{
				TaskType: taskType,
				Status:   "already_done",
				Data: map[string]any{
					"job_id": job.ID,
				},
			})
		}

		now := handler.currentTime(nil)
		runID, err := handler.claimJobRun(ctx, db, *job, now)
		if err != nil {
			handler.markRunJobFailedBestEffort(ctx, db, *job, runID, now, err)
			return err
		}

		runErr := handler.executeRunJob(ctx, db, task, *job, runID, now)
		if runErr != nil {
			handler.markRunJobFailedBestEffort(ctx, db, *job, runID, now, runErr)
			return runErr
		}
		return nil
	})
}

func (handler *TaskHandler) loadRunJob(
	ctx context.Context,
	db store.FullDB,
	jobID int64,
) (*runJobRecord, error) {
	var job runJobRecord
	if err := db.QueryRow(ctx, selectRunJobSQL, jobID).Scan(
		&job.ID,
		&job.JobType,
		&job.Status,
		&job.PayloadJSON,
		&job.Operator,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: %d", ErrJobNotFound, jobID)
		}
		return nil, fmt.Errorf("load job %d: %w", jobID, err)
	}
	job.Status = strings.TrimSpace(job.Status)
	job.JobType = strings.TrimSpace(job.JobType)
	if job.JobType == "" {
		return nil, errRequired("jobs.job_type")
	}
	return &job, nil
}

func (handler *TaskHandler) claimJobRun(
	ctx context.Context,
	db store.FullDB,
	job runJobRecord,
	now time.Time,
) (int64, error) {
	if job.Status == "running" {
		var runID int64
		err := db.QueryRow(ctx, selectLatestJobRunSQL, job.ID).Scan(&runID)
		if err == nil {
			return runID, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf("load latest job run: %w", err)
		}
	}

	logExcerpt, err := json.Marshal(map[string]any{
		"stage":    "started",
		"progress": 5,
		"message":  "处理中：任务已启动",
	})
	if err != nil {
		return 0, fmt.Errorf("encode job progress: %w", err)
	}

	var runID int64
	if err := db.QueryRow(
		ctx,
		insertJobRunSQL,
		job.ID,
		now,
		job.Operator,
		string(logExcerpt),
	).Scan(&runID); err != nil {
		return 0, fmt.Errorf("create job run: %w", err)
	}
	if _, err := db.Exec(ctx, markJobRunningSQL, job.ID, now); err != nil {
		return runID, fmt.Errorf("mark job running: %w", err)
	}
	return runID, nil
}

func (handler *TaskHandler) executeRunJob(
	ctx context.Context,
	db store.FullDB,
	task *asynq.Task,
	job runJobRecord,
	runID int64,
	now time.Time,
) error {
	var envelope jobPayloadEnvelope
	if err := json.Unmarshal(job.PayloadJSON, &envelope); err != nil {
		return fmt.Errorf("decode jobs.payload_json: %w", err)
	}
	jobType := strings.TrimSpace(envelope.JobType)
	if jobType == "" {
		jobType = job.JobType
	}
	if jobType == productAnalysisReportJobType {
		return handler.executeProductAnalysisRunJob(ctx, db, task, job, runID, now, envelope)
	}
	if jobType != monthlyReportJobType {
		if jobType == "" {
			return errRequired("payload.job_type")
		}
		return fmt.Errorf("%w: %s", ErrUnsupportedJobType, jobType)
	}

	input, err := monthlyReportInputFromJob(envelope, job.ID)
	if err != nil {
		return err
	}
	reportID := input.ReportID
	var (
		loadedReportID     int64
		status             string
		existingResultPath string
		projectID          int64
		projectName        string
		country            string
		reportMonth        string
	)
	if err := db.QueryRow(ctx, selectMonthlyReportForJobSQL, reportID).Scan(
		&loadedReportID,
		&status,
		&existingResultPath,
		&projectID,
		&projectName,
		&country,
		&reportMonth,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("monthly report %d does not exist", reportID)
		}
		return fmt.Errorf("load monthly report %d: %w", reportID, err)
	}
	if loadedReportID != reportID {
		return fmt.Errorf("monthly report id mismatch: got %d, want %d", loadedReportID, reportID)
	}
	normalizedReportCountry, err := normalizeTaskCountry(country)
	if err != nil {
		return fmt.Errorf("monthly report %d country: %w", reportID, err)
	}
	if projectID != input.ProjectID ||
		strings.TrimSpace(projectName) != input.ProjectName ||
		normalizedReportCountry != input.Country ||
		strings.TrimSpace(reportMonth) != input.ReportMonth {
		return fmt.Errorf("monthly report %d metadata does not match job payload", reportID)
	}
	switch strings.TrimSpace(status) {
	case "pending", "running", "success", "completed":
	case "failed":
		return fmt.Errorf("monthly report %d is failed", reportID)
	default:
		return fmt.Errorf("monthly report %d has unsupported status %q", reportID, status)
	}

	resultPath := strings.TrimSpace(existingResultPath)
	transactionCount := 0
	alreadyFinalized := (strings.TrimSpace(status) == "success" ||
		strings.TrimSpace(status) == "completed") && resultPath != ""
	if !alreadyFinalized {
		if handler.config.MonthlyReportGenerator == nil {
			return fmt.Errorf("%w: monthly report generator", ErrDependencyNotConfigured)
		}
		if handler.config.MonthlyReportFinalizer == nil {
			return fmt.Errorf("%w: monthly report finalizer", ErrDependencyNotConfigured)
		}
		tag, runningErr := db.Exec(ctx, markMonthlyReportRunningSQL, reportID, now)
		if runningErr != nil {
			return fmt.Errorf("mark monthly report %d running: %w", reportID, runningErr)
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("monthly report %d is not runnable", reportID)
		}
		computed, generateErr := handler.config.MonthlyReportGenerator.Generate(ctx, MonthlyReportGenerationInput{
			JobID:             job.ID,
			ProjectID:         input.ProjectID,
			ProjectName:       input.ProjectName,
			Country:           input.Country,
			ReportMonth:       input.ReportMonth,
			TransactionFileID: input.TransactionFileID,
		})
		if generateErr != nil {
			_, _ = db.Exec(
				ctx,
				markMonthlyReportFailedSQL,
				reportID,
				generateErr.Error(),
				now,
			)
			return fmt.Errorf("generate monthly report %d: %w", reportID, generateErr)
		}
		if computed == nil || strings.TrimSpace(computed.ResultPath) == "" {
			missingResultErr := errors.New("monthly report generator returned no result path")
			_, _ = db.Exec(
				ctx,
				markMonthlyReportFailedSQL,
				reportID,
				missingResultErr.Error(),
				now,
			)
			return missingResultErr
		}
		if err := handler.config.MonthlyReportFinalizer.Finalize(
			ctx,
			reportID,
			job.ID,
			*computed,
		); err != nil {
			_, _ = db.Exec(ctx, markMonthlyReportFailedSQL, reportID, err.Error(), now)
			return fmt.Errorf("finalize monthly report %d: %w", reportID, err)
		}
		resultPath = computed.ResultPath
		transactionCount = len(computed.Transactions)
	}

	if _, err := db.Exec(ctx, markJobSuccessSQL, job.ID, now); err != nil {
		return fmt.Errorf("mark job success: %w", err)
	}
	logExcerpt, err := json.Marshal(map[string]any{
		"stage":    "completed",
		"progress": 100,
		"message":  "处理完成：报表已生成，可下载",
	})
	if err != nil {
		return fmt.Errorf("encode job completion: %w", err)
	}
	if _, err := db.Exec(
		ctx,
		finishJobRunSuccessSQL,
		runID,
		now,
		resultPath,
		string(logExcerpt),
	); err != nil {
		return fmt.Errorf("finish successful job run: %w", err)
	}
	return handler.writeResult(task, taskResult{
		TaskType: queue.TypeRunJob,
		Status:   "success",
		Data: map[string]any{
			"job_id":       job.ID,
			"report_id":    reportID,
			"result_path":  resultPath,
			"transactions": transactionCount,
		},
	})
}

type monthlyReportJobInput struct {
	ReportID          int64
	ProjectID         int64
	ProjectName       string
	Country           string
	ReportMonth       string
	TransactionFileID string
}

func monthlyReportInputFromJob(
	envelope jobPayloadEnvelope,
	jobID int64,
) (monthlyReportJobInput, error) {
	reportID, err := monthlyReportReportID(envelope.Params)
	if err != nil {
		return monthlyReportJobInput{}, err
	}
	projectID, err := monthlyReportInt64Param(envelope.Params, "project_id")
	if err != nil {
		return monthlyReportJobInput{}, err
	}
	projectName, err := monthlyReportStringParam(envelope.Params, "project_name")
	if err != nil {
		return monthlyReportJobInput{}, err
	}
	country, err := monthlyReportStringParam(envelope.Params, "country")
	if err != nil {
		return monthlyReportJobInput{}, err
	}
	reportMonth, err := monthlyReportStringParam(envelope.Params, "report_month")
	if err != nil {
		return monthlyReportJobInput{}, err
	}
	transactionFileID, err := monthlyReportTransactionFileID(envelope)
	if err != nil {
		return monthlyReportJobInput{}, err
	}
	normalized, err := validateMonthlyReportGenerationInput(MonthlyReportGenerationInput{
		JobID:             jobID,
		ProjectID:         projectID,
		ProjectName:       projectName,
		Country:           country,
		ReportMonth:       reportMonth,
		TransactionFileID: transactionFileID,
	})
	if err != nil {
		return monthlyReportJobInput{}, err
	}
	return monthlyReportJobInput{
		ReportID:          reportID,
		ProjectID:         normalized.ProjectID,
		ProjectName:       normalized.ProjectName,
		Country:           normalized.Country,
		ReportMonth:       normalized.ReportMonth,
		TransactionFileID: normalized.TransactionFileID,
	}, nil
}

func monthlyReportReportID(params map[string]json.RawMessage) (int64, error) {
	for _, key := range []string{"report_id", "monthly_report_id"} {
		if raw, ok := params[key]; ok && len(raw) > 0 && string(raw) != "null" {
			value, err := monthlyReportRawInt64(raw, key)
			if err != nil {
				return 0, err
			}
			if value <= 0 {
				return 0, errPositive("params." + key)
			}
			return value, nil
		}
	}
	return 0, errRequired("params.report_id")
}

func monthlyReportInt64Param(params map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := params[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return 0, errRequired("params." + key)
	}
	return monthlyReportRawInt64(raw, "params."+key)
}

func monthlyReportRawInt64(raw json.RawMessage, field string) (int64, error) {
	var number int64
	if err := json.Unmarshal(raw, &number); err == nil {
		return number, nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		text = strings.TrimSpace(text)
		number, parseErr := strconv.ParseInt(text, 10, 64)
		if parseErr == nil {
			return number, nil
		}
	}
	return 0, errInvalid(field, "must be an integer")
}

func monthlyReportStringParam(params map[string]json.RawMessage, key string) (string, error) {
	raw, ok := params[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return "", errRequired("params." + key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", errInvalid("params."+key, "must be a string")
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errRequired("params." + key)
	}
	return value, nil
}

func monthlyReportTransactionFileID(envelope jobPayloadEnvelope) (string, error) {
	if value, ok := envelope.Params["transaction_file_id"]; ok {
		var text string
		if err := json.Unmarshal(value, &text); err == nil {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				return trimmed, nil
			}
		}
	}
	if rawFileIDs, ok := envelope.Params["file_ids"]; ok {
		var fileIDs map[string]string
		if err := json.Unmarshal(rawFileIDs, &fileIDs); err == nil {
			if value := strings.TrimSpace(fileIDs["transaction_report"]); value != "" {
				return value, nil
			}
		}
	}
	if value := strings.TrimSpace(envelope.FileID); value != "" {
		return value, nil
	}
	if value := strings.TrimSpace(envelope.TransactionFileID); value != "" {
		return value, nil
	}
	return "", errRequired("params.transaction_file_id")
}

func (handler *TaskHandler) markRunJobFailedBestEffort(
	ctx context.Context,
	db store.FullDB,
	job runJobRecord,
	runID int64,
	now time.Time,
	runErr error,
) {
	message := runErr.Error()
	if runID > 0 {
		_, _ = db.Exec(ctx, finishJobRunFailedSQL, runID, now, message)
	}
	_, _ = db.Exec(ctx, markJobFailedSQL, job.ID, now)
}
